const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const path = require('node:path');
const base = 'http://127.0.0.1:8084';
const traceId = '1234567890abcdef1234567890abcdef';
const parentId = 'abcdef1234567890';
const payload = { order_id: 'PRIVATE-ORDER', amount_cents: 2500, idempotency_key: 'PRIVATE-KEY' };
async function charge(body, traced = false) {
  const response = await fetch(`${base}/payments/charge`, { method: 'POST',
    headers: { 'Content-Type': 'application/json',
      ...(traced ? { traceparent: `00-${traceId}-${parentId}-01` } : {}) },
    body: JSON.stringify(body) });
  return { status: response.status, body: await response.json() };
}
async function metrics() {
  const response = await fetch(`${base}/metrics`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /text\/plain.*version=0\.0\.4/);
  return response.text();
}
async function run(env, test) {
  const logs = [];
  let output = '';
  const child = spawn(process.execPath, ['dist/server.js'], {
    cwd: path.resolve(__dirname, '..'),
    env: { ...process.env, PORT: '8084', OTEL_EXPORTER_OTLP_ENDPOINT: '',
      OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: '', OTEL_TRACES_EXPORTER: 'console',
      OTEL_PROPAGATORS: 'tracecontext,baggage', PAYMENT_SIMULATION_RESULT: 'success', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let buffer = '';
  child.stdout.on('data', (chunk) => {
    output += chunk;
    buffer += chunk;
    let end;
    while ((end = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, end).trim(); buffer = buffer.slice(end + 1);
      if (line) logs.push(JSON.parse(line));
    }
  });
  child.stderr.on('data', (chunk) => { output += chunk; });
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Startup timeout: ${output}`)), 30000);
      const check = () => { if (logs.some((entry) => entry.message === 'Service listening.')) {
        clearTimeout(timer); child.stdout.off('data', check); resolve();
      } };
      child.stdout.on('data', check);
      child.once('error', (error) => { clearTimeout(timer); reject(error); });
      child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`Exited ${code}: ${output}`)); });
    });
    await test(logs);
    assert.ok(!output.includes(payload.order_id) && !output.includes(payload.idempotency_key));
  } finally {
    if (child.exitCode === null) { const exited = once(child, 'exit'); child.kill(); await exited; }
  }
}
function count(text, code, expected) {
  assert.ok(text.includes(`http_requests_total{method="POST",route="/payments/charge",status_code="${code}"} ${expected}`), text);
}
(async () => {
  await run({}, async (logs) => {
    const first = await charge(payload, true);
    assert.equal(first.status, 200);
    assert.equal(first.body.status, 'SUCCESS');
    assert.deepEqual(await charge(payload), first);
    assert.equal((await charge({ ...payload, amount_cents: 0 })).status, 400);
    assert.equal((await charge({ ...payload, amount_cents: 1 })).status, 409);
    const text = await metrics();
    assert.match(text, /# TYPE http_requests_total counter/);
    assert.match(text, /# TYPE http_request_duration_seconds histogram/);
    count(text, 200, 2); count(text, 400, 1); count(text, 409, 1);
    assert.match(text, /http_request_duration_seconds_count\{method="POST",route="\/payments\/charge",status_code="200"\} 2/);
    const sum = text.match(/http_request_duration_seconds_sum\{method="POST",route="\/payments\/charge",status_code="200"\} ([\d.e+-]+)/);
    assert.ok(Number(sum?.[1]) >= 0.14);
    assert.match(text, /http_request_duration_seconds_bucket\{[^\n]*le="\+Inf"[^\n]*\} 2/);
    assert.equal(await metrics(), text, 'Scrapes must not change metrics');
    await fetch(`${base}/unknown/PRIVATE-1`);
    await fetch(`${base}/unknown/PRIVATE-2`);
    const unmatched = await metrics();
    assert.ok(unmatched.includes('route="unmatched",status_code="404"} 2'));
    assert.ok(!unmatched.includes('PRIVATE') && !unmatched.includes('trace_id'));
    // Export is synchronous in console mode; allow stdout pipe delivery.
    await new Promise((resolve) => setTimeout(resolve, 100));
    for (const entry of logs) {
      assert.ok(!Number.isNaN(Date.parse(entry.timestamp)));
      assert.ok(['info', 'warn', 'error'].includes(entry.level));
      assert.equal(entry.service, 'service-d-payment');
      assert.equal(typeof entry.message, 'string');
    }
    for (const message of ['Payment processing started.', 'Payment succeeded.',
      'Payment validation failed.', 'Payment idempotency conflict.']) {
      const entry = logs.find((item) => item.message === message);
      assert.ok(entry, message);
      assert.match(entry.trace_id, /^[a-f0-9]{32}$/);
      assert.match(entry.span_id, /^[a-f0-9]{16}$/);
    }
    const spans = logs.filter((entry) => entry.message === 'trace.export');
    const psp = spans.filter((entry) => entry.name === 'payment.psp.simulate');
    const processing = spans.filter((entry) => entry.name === 'payment.process');
    assert.equal(processing.length, 4);
    assert.deepEqual(processing.map((entry) => entry.attributes['payment.outcome']).sort(),
      ['CONFLICT', 'INVALID', 'SUCCESS', 'SUCCESS']);
    assert.equal(psp.length, 1, 'Replay must not create a second PSP span');
    assert.equal(psp[0].trace_id, traceId);
    assert.ok(psp[0].duration_seconds >= 0.14);
    assert.equal(psp[0].attributes['payment.status'], 'SUCCESS');
    const http = spans.find((entry) => entry.trace_id === traceId && entry.kind === 1);
    assert.ok(http, 'Incoming HTTP server span');
    assert.equal(http.parent_span_id, parentId);
    const express = spans.find((entry) => entry.trace_id === traceId && entry.attributes['express.type'] === 'request_handler');
    assert.ok(express, 'Express instrumentation span');
    let current = psp[0]; const visited = new Set();
    while (current.span_id !== http.span_id) {
      assert.ok(!visited.has(current.span_id)); visited.add(current.span_id);
      current = spans.find((entry) => entry.span_id === current.parent_span_id);
      assert.ok(current, 'PSP must descend from incoming HTTP span');
      assert.equal(current.trace_id, traceId);
    }
    assert.equal(logs.find((entry) => entry.message === 'Payment processing started.').trace_id, traceId);
    console.log('PASS Prometheus format, counters, durations, scrapes and cardinality');
    console.log('PASS JSON logs, privacy, HTTP/Express/PSP spans and W3C parent hierarchy');
  });
  await run({ PAYMENT_SIMULATION_RESULT: 'declined' }, async (logs) => {
    const first = await charge(payload);
    assert.equal(first.status, 402);
    assert.equal(first.body.status, 'FAILED_DECLINED');
    assert.deepEqual(await charge(payload), first);
    count(await metrics(), 402, 2);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.ok(logs.some((entry) => entry.message === 'Payment declined.' && entry.trace_id));
    assert.equal(logs.filter((entry) => entry.name === 'payment.psp.simulate').length, 1);
    console.log('PASS declined payment metrics, logs, spans and idempotence');
  });
  await run({ OTEL_TRACES_EXPORTER: 'otlp', OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:1' }, async () => {
    assert.equal((await charge(payload)).status, 200);
    await new Promise((resolve) => setTimeout(resolve, 2500));
    assert.equal((await fetch(`${base}/healthz`)).status, 200);
    assert.deepEqual((await charge(payload)).body.status, 'SUCCESS');
    assert.equal((await fetch(`${base}/metrics`)).status, 200);
    console.log('PASS unavailable OTLP collector: startup, payment, replay, health and metrics');
  });
})().catch((error) => { console.error(error); process.exitCode = 1; });
