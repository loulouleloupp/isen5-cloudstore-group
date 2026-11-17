// Regression: prom-client is the only metrics pipeline, even with OTLP env vars.
const assert = require('node:assert/strict');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const path = require('node:path');
(async () => {
  let requests = 0;
  const receiver = http.createServer((req, res) => {
    requests++;
    req.resume(); res.end();
  });
  receiver.listen(0, '127.0.0.1'); await once(receiver, 'listening');
  const endpoint = `http://127.0.0.1:${receiver.address().port}`;
  const child = spawn(process.execPath, ['-e', `
    const { telemetry } = require('./dist/instrumentation');
    const { metrics } = require('@opentelemetry/api');
    metrics.getMeter('regression').createCounter('probe').add(1);
    setTimeout(async () => { await telemetry.shutdown(); }, 1400);
  `], { cwd: path.resolve(__dirname, '..'),
    env: { ...process.env, OTEL_TRACES_EXPORTER: 'console',
      OTEL_METRICS_EXPORTER: 'otlp', OTEL_EXPORTER_OTLP_ENDPOINT: endpoint,
      OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: `${endpoint}/v1/metrics`,
      OTEL_EXPORTER_OTLP_METRICS_PROTOCOL: 'http/protobuf',
      OTEL_METRIC_EXPORT_INTERVAL: '200', OTEL_METRIC_EXPORT_TIMEOUT: '100' },
    stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  const timer = setTimeout(() => child.kill(), 30000);
  try {
    const [code] = await once(child, 'exit');
    assert.equal(code, 0, output);
    assert.equal(requests, 0, `Unexpected OTLP metrics exports: ${requests}`);
    console.log('PASS no implicit OTLP metrics exporter (7 accelerated export intervals)');
  } finally { clearTimeout(timer); receiver.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
