// Integration test against an already running Service D + observability stack.
// Does not create/stop containers. Generates a few test payments on port 8084.
const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const dashboard = require('../observability/grafana/payment.json');
const alertConfig = require('../observability/grafana/alerts.json');
const grafanaUrl = process.env.GRAFANA_URL || 'http://localhost:3000';
const authFile = process.env.GRAFANA_AUTH_FILE;
const credentials = authFile
  ? JSON.parse(require('node:fs').readFileSync(authFile, 'utf8').replace(/^\uFEFF/, '')) : {};
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const traceId = randomBytes(16).toString('hex');
const basic = `Basic ${Buffer.from(`${credentials.user || process.env.GRAFANA_USER || 'admin'}:${credentials.password || process.env.GRAFANA_PASSWORD || 'admin'}`).toString('base64')}`;
async function json(url, headers = {}) {
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(10000) });
  assert.equal(response.status, 200, `${url}: HTTP ${response.status}`);
  return response.json();
}
async function eventually(label, check) {
  let error;
  for (let i = 0; i < 20; i++) {
    try { const value = await check(); console.log(`PASS ${label}`); return value; }
    catch (failure) { error = failure; await sleep(1500); }
  }
  throw error;
}
async function charge(body) {
  const response = await fetch('http://localhost:8084/payments/charge', {
    method: 'POST', headers: { 'Content-Type': 'application/json',
      traceparent: `00-${traceId}-abcdef1234567890-01` }, body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}
(async () => {
  const started = Date.now();
  const body = { order_id: 'DOCKER-TEST', amount_cents: 2500, idempotency_key: `docker-${traceId}` };
  const first = await charge(body);
  assert.equal(first.status, 200); assert.equal(first.body.status, 'SUCCESS');
  assert.deepEqual(await charge(body), first);
  assert.equal((await charge({ ...body, amount_cents: 0 })).status, 400);
  assert.equal((await charge({ ...body, amount_cents: 1 })).status, 409);
  console.log('PASS Docker payment, replay, validation and conflict');
  await eventually('Prometheus UP=1', async () => {
    const response = await json('http://localhost:9090/api/v1/query?query=' + encodeURIComponent('up{job="service-d-payment"}'));
    assert.ok(response.data.result.some(item => item.value[1] === '1'));
  });
  await eventually('Jaeger receives payment.process and payment.psp.simulate', async () => {
    const response = await json(`http://localhost:16686/api/traces/${traceId}`);
    const spans = response.data.flatMap(item => item.spans);
    assert.ok(spans.some(span => span.operationName === 'payment.process'));
    assert.ok(spans.some(span => span.operationName === 'payment.psp.simulate'));
  });
  const query = `{job="service-d-payment"} | json | trace_id="${traceId}"`;
  const queryPath = '/loki/api/v1/query_range?' + new URLSearchParams({ query, since: '10m', limit: '100' });
  await eventually('Loki receives correlated JSON logs from Docker', async () => {
    const response = await json('http://localhost:3100' + queryPath);
    assert.equal(response.status, 'success');
    const entries = response.data.result.flatMap(stream => stream.values).map(([,line]) => JSON.parse(line));
    assert.ok(entries.some(item => item.message === 'Payment succeeded.' && item.trace_id === traceId && item.span_id));
    assert.ok(entries.some(item => item.message === 'Payment validation failed.'));
    assert.ok(entries.some(item => item.message === 'Payment idempotency conflict.'));
  });
  const auth = { Authorization: basic };
  const provisioned = await eventually('Grafana dashboard is provisioned', async () => {
    const result = await json(`${grafanaUrl}/api/dashboards/uid/cloudstore-service-d`, auth);
    assert.equal(result.dashboard.panels.length, dashboard.panels.length);
    return result;
  });
  const datasources = await json(`${grafanaUrl}/api/datasources`, auth);
  const loki = datasources.find(item => item.type === 'loki');
  const prometheus = datasources.find(item => item.type === 'prometheus');
  const jaeger = datasources.find(item => item.type === 'jaeger');
  assert.ok(loki && prometheus);
  for (const name of ['Prometheus', 'Loki', 'Jaeger']) {
    assert.equal(datasources.filter(item => item.name === name).length, 1, `Duplicate datasource: ${name}`);
  }
  const search = await json(`${grafanaUrl}/api/search?query=CloudStore`, auth);
  assert.equal(search.filter(item => item.uid === dashboard.uid).length, 1);
  const viaGrafana = await json(`${grafanaUrl}/api/datasources/proxy/uid/${loki.uid}${queryPath}`, auth);
  assert.ok(viaGrafana.data.result.length > 0);
  console.log('PASS Grafana Loki datasource queries the collected payment logs');
  const rawLog = viaGrafana.data.result.flatMap(stream => stream.values).map(([,line]) => line)
    .find(line => JSON.parse(line).message === 'Payment succeeded.');
  assert.ok(rawLog);
  const lokiDetails = await json(`${grafanaUrl}/api/datasources/uid/${loki.uid}`, auth);
  const links = lokiDetails.jsonData.derivedFields;
  for (const name of ['PaymentUnifiedView', 'JaegerTrace']) {
    const link = links.find(item => item.name === name);
    assert.ok(link, name);
    const extracted = rawLog.match(new RegExp(link.matcherRegex))?.[1];
    assert.equal(extracted, traceId);
    const destination = link.url.replace('${__value.raw}', extracted);
    assert.ok(destination.includes(traceId), 'Must link this exact trace, not a generic search');
    const resolved = new URL(destination, grafanaUrl).toString();
    assert.equal((await fetch(resolved, { headers: auth })).status, 200);
    if (name === 'PaymentUnifiedView') {
      assert.equal(new URL(resolved).searchParams.get('var-trace_id'), traceId);
      const tracePanel = provisioned.dashboard.panels.find(item => item.type === 'traces');
      assert.equal(tracePanel.targets[0].query, '${trace_id}');
    }
  }
  const traceViaGrafana = await json(`${grafanaUrl}/api/datasources/proxy/uid/${jaeger.uid}/api/traces/${traceId}`, auth);
  assert.ok(traceViaGrafana.data.some(item => item.traceID === traceId));
  const jaegerDetails = await json(`${grafanaUrl}/api/datasources/uid/${jaeger.uid}`, auth);
  const backLink = jaegerDetails.jsonData.tracesToLogsV2;
  assert.equal(backLink.datasourceUid, loki.uid);
  const backQuery = backLink.query.replace('${__trace.traceId}', traceId);
  assert.ok((await json(`${grafanaUrl}/api/datasources/proxy/uid/${loki.uid}/loki/api/v1/query_range?` +
    new URLSearchParams({ query: backQuery, since: '10m' }), auth)).data.result.length > 0);
  console.log('PASS exact log-to-Jaeger and unified-view links, trace-to-Loki query, no duplicates');
  // Enough samples for the demo 20-requests/5m SLO guard; all are safe replays.
  for (let i = 0; i < 22; i++) assert.deepEqual(await charge(body), first);
  // Wait for at least two scrapes, with a payment between them.
  await sleep(6000); await charge(body); await sleep(6000);
  for (const panel of provisioned.dashboard.panels.filter(item => ['timeseries', 'stat'].includes(item.type))) {
    for (const target of panel.targets) {
      const expr = target.expr.replaceAll('$__rate_interval', '1m').replaceAll('$__range', '5m');
      const result = await json(`${grafanaUrl}/api/datasources/proxy/uid/${prometheus.uid}/api/v1/query?query=${encodeURIComponent(expr)}`, auth);
      assert.equal(result.status, 'success', panel.title);
      if (panel.fieldConfig.defaults.unit === 'percentunit') {
        assert.equal(panel.fieldConfig.defaults.max, 1);
        for (const item of result.data.result) {
          const value = Number(item.value[1]);
          assert.ok(!Number.isFinite(value) || (value >= 0 && value <= 1), panel.title);
        }
      }
      if (panel.title.includes('Duration p50')) assert.ok(result.data.result.some(item => Number.isFinite(Number(item.value[1]))), panel.title);
    }
  }
  console.log('PASS dashboard PromQL via Grafana, including finite p50/p95/p99');
  const rules = await json(`${grafanaUrl}/api/v1/provisioning/alert-rules`, auth);
  for (const expected of alertConfig.groups[0].rules) {
    const rule = rules.find(item => item.uid === expected.uid);
    assert.ok(rule, expected.title);
    assert.equal(rule.isPaused, false);
    assert.equal(rule.noDataState, expected.noDataState);
    assert.deepEqual(rule.notification_settings.mute_time_intervals, ['service-d-no-delivery']);
    assert.equal(rule.data[0].datasourceUid, prometheus.uid);
    assert.equal(rule.data[0].model.expr, expected.data[0].model.expr);
    const response = await json(`${grafanaUrl}/api/datasources/proxy/uid/${prometheus.uid}/api/v1/query?query=` +
      encodeURIComponent(rule.data[0].model.expr), auth);
    assert.equal(response.status, 'success');
    const absentExpr = rule.data[0].model.expr.replaceAll('job="service-d-payment"', 'job="service-d-no-such-test-target"');
    const noData = await json(`${grafanaUrl}/api/datasources/proxy/uid/${prometheus.uid}/api/v1/query?query=` +
      encodeURIComponent(absentExpr), auth);
    if (rule.uid === 'service-d-unavailable') {
      assert.equal(noData.data.result[0].value[1], '1', 'An absent scrape target must violate availability');
    } else {
      assert.equal(noData.data.result.length, 0, 'No traffic must not fabricate a healthy ratio or latency');
    }
  }
  const timings = await json(`${grafanaUrl}/api/v1/provisioning/mute-timings`, auth);
  const mute = timings.find(item => item.name === 'service-d-no-delivery');
  assert.ok(mute);
  assert.equal(mute.time_intervals[0].times[0].start_time, '00:00');
  assert.equal(mute.time_intervals[0].times[0].end_time, '24:00');
  console.log('PASS three provisioned SLO alerts, explicit no-data handling and always-muted delivery');
  // Observe more than two original 60-second export intervals.
  while (Date.now() - started < 125000) {
    await sleep(Math.min(10000, 125000 - (Date.now() - started)));
    console.log(`Monitoring periodic errors: ${Math.floor((Date.now() - started) / 1000)}s / 125s`);
  }
  const containerStarted = execFileSync('docker', ['inspect', '--format', '{{.State.StartedAt}}', 'cloudstore-service-d'], { encoding: 'utf8' }).trim();
  const logs = execFileSync('docker', ['logs', '--since', containerStarted, 'cloudstore-service-d'], { encoding: 'utf8' });
  assert.ok(!logs.includes('OpenTelemetry technical error'), 'Telemetry errors after restart');
  const evaluated = await json(`${grafanaUrl}/api/prometheus/grafana/api/v1/rules`, auth);
  const evaluatedRules = evaluated.data.groups.flatMap(group => group.rules);
  for (const expected of alertConfig.groups[0].rules) {
    const evaluatedRule = evaluatedRules.find(item => item.name === expected.title);
    assert.ok(evaluatedRule, `Not evaluated: ${expected.title}`);
    assert.ok(!evaluatedRule.lastError, `${expected.title}: ${evaluatedRule.lastError}`);
    assert.equal(evaluatedRule.health, 'ok', expected.title);
  }
  console.log('PASS Grafana alert scheduler has evaluated all three SLO rules without errors');
  assert.equal((await fetch('http://localhost:8084/healthz')).status, 200);
  console.log('PASS no OpenTelemetry technical error across 125 seconds, healthz remains OK');
  console.log(`Trace verified: ${traceId}`);
})().catch(error => { console.error(error); process.exitCode = 1; });
