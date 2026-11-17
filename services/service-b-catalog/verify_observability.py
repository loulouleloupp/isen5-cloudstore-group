import subprocess
import base64
import json
import time
import uuid
import urllib.request
import urllib.parse


def get(url, data=None, headers=None):
    if url.startswith("http://localhost:8082/"):
        options = {"headers": {"Content-Type": "application/json", **(headers or {})}}
        if data is not None:
            options.update(method="POST", body=json.dumps(data))
        code = "fetch(process.argv[1], JSON.parse(process.argv[2])).then(async r => {if (!r.ok) throw new Error('HTTP '+r.status); console.log(await r.text());}).catch(e => {console.error(e);process.exit(1)});"
        return json.loads(subprocess.check_output(["docker", "exec", "-e", "NODE_OPTIONS=", "cloudstore-service-b", "node", "-e", code, url, json.dumps(options)], text=True))
    request = urllib.request.Request(url, data=json.dumps(data).encode() if data is not None else None,
        headers={"Content-Type": "application/json", **(headers or {})})
    with urllib.request.urlopen(request, timeout=10) as response:
        return json.load(response)


def poll(label, check, timeout=45):
    deadline = time.monotonic() + timeout
    last_error = None
    while time.monotonic() < deadline:
        try:
            result = check()
            if result:
                print(label + ": OK", flush=True)
                return result
        except Exception as error:
            last_error = error
        time.sleep(2)
    raise AssertionError(label + ": FAILED " + str(last_error))

trace_id = uuid.uuid4().hex
headers = {"traceparent": "00-" + trace_id + "-0123456789abcdef-01"}
products = get("http://localhost:8082/products", headers=headers)
assert products and products[0]["id"]
reservation = get("http://localhost:8082/inventory/reserve", {"items": [{"product_id": products[0]["id"], "quantity": 1}]})
get("http://localhost:8082/inventory/release", {"reservation_id": reservation["reservation_id"]})
assert get("http://localhost:8082/products", headers=headers)[0]["stock"] == products[0]["stock"]
print("Catalogue reserve/release: OK", flush=True)

prom = "http://localhost:9090/api/v1/"
def query(expr):
    return get(prom + "query?" + urllib.parse.urlencode({"query": expr}))["data"]["result"]
poll("Prometheus target UP", lambda: any(x["value"][1] == "1" for x in query('up{job="service-b-catalog"}')))
poll("RED counter", lambda: query('http_requests_total{job="service-b-catalog",route="/products",status_code="200"}'))
poll("RED histogram", lambda: query('http_request_duration_seconds_bucket{job="service-b-catalog",route="/products",le="0.2"}'))
poll("Jaeger propagated trace + custom span", lambda: any(s["operationName"] == "catalog.list_products" for t in get("http://localhost:16686/api/traces/"+trace_id)["data"] for s in t["spans"]))
log_query = '{service_name="service-b-catalog"} | json | trace_id = "' + trace_id + '"'
poll("Loki correlated JSON log", lambda: get("http://localhost:3100/loki/api/v1/query_range?"+urllib.parse.urlencode({"query":log_query,"limit":10}))["data"]["result"])
poll("Prometheus exemplar", lambda: any(any(e["labels"].get("trace_id") == trace_id for e in series["exemplars"]) for series in get(prom + "query_exemplars?" + urllib.parse.urlencode({"query":'http_requests_total{job="service-b-catalog",route="/products"}',"start":str(time.time()-300),"end":str(time.time())}))["data"]))
auth = {"Authorization": "Basic " + base64.b64encode(b"admin:admin").decode()}
poll("Grafana health", lambda: get("http://localhost:3000/api/health")["database"] == "ok")
for uid in ["prometheus", "loki"]:
    health = get("http://localhost:3000/api/datasources/uid/"+uid+"/health", headers=auth)
    assert health["status"] == "OK", health
assert "service-b-catalog" in get("http://localhost:3000/api/datasources/proxy/uid/jaeger/api/services", headers=auth)["data"]
print("Grafana datasource queries: OK", flush=True)
assert len(get("http://localhost:3000/api/dashboards/uid/catalog-observability",headers=auth)["dashboard"]["panels"]) == 8
rules = get("http://localhost:3000/api/v1/provisioning/alert-rules", headers=auth)
assert {"catalog-down", "catalog-errors", "catalog-latency"}.issubset({r["uid"] for r in rules})
print("Grafana dashboard and 3 alert rules: OK", flush=True)
print("Verified trace ID: " + trace_id, flush=True)
