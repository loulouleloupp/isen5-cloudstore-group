const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { once } = require('node:events');

const base = 'http://127.0.0.1:8084';
const valid = { order_id: 'ORD-123', amount_cents: 2500, idempotency_key: 'payment-123' };
async function charge(body) {
  const response = await fetch(`${base}/payments/charge`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}
async function withServer(mode, test) {
  const child = spawn(process.execPath, ['dist/server.js'], {
    cwd: require('node:path').resolve(__dirname, '..'),
    env: { ...process.env, PORT: '8084', PAYMENT_SIMULATION_RESULT: mode },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Server startup timed out')), 30000);
      child.once('error', (error) => { clearTimeout(timer); reject(error); });
      child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`Server exited: ${code}`)); });
      child.stdout.once('data', () => { clearTimeout(timer); resolve(); });
    });
    await test();
  } finally {
    if (child.exitCode === null) {
      const exited = once(child, 'exit');
      child.kill();
      await exited;
    }
  }
}

(async () => {
  await withServer('success', async () => {
    const first = await charge(valid);
    assert.equal(first.status, 200);
    assert.equal(first.body.status, 'SUCCESS');
    assert.match(first.body.transaction_id, /^TXN-/);
    console.log('PASS valid payment');
    for (const body of [[], {}, { ...valid, order_id: ' ' }, { ...valid, order_id: 123 },
      { ...valid, amount_cents: 0 }, { ...valid, amount_cents: -1 },
      { ...valid, amount_cents: 1.5 }, { ...valid, amount_cents: '2500' },
      { ...valid, idempotency_key: ' ' }, { ...valid, idempotency_key: 123 }]) {
      const result = await charge(body);
      assert.equal(result.status, 400);
      assert.ok(result.body.message);
    }
    console.log('PASS invalid data (10 cases)');
    assert.deepEqual(await charge(valid), first);
    assert.deepEqual(await charge({ ...valid, order_id: ' ORD-123 ', idempotency_key: ' payment-123 ' }), first);
    console.log('PASS replay and normalized data');
    assert.equal((await charge({ ...valid, amount_cents: 2501 })).status, 409);
    assert.equal((await charge({ ...valid, order_id: 'ORD-other' })).status, 409);
    console.log('PASS conflicts for amount and order');
    const concurrent = { ...valid, idempotency_key: 'concurrent' };
    const [a, b, conflict] = await Promise.all([
      charge(concurrent), charge(concurrent), charge({ ...concurrent, amount_cents: 1 }),
    ]);
    assert.equal(a.status, 200);
    assert.deepEqual(a, b);
    assert.equal(conflict.status, 409);
    console.log('PASS concurrent replay and conflict');
    const health = await fetch(`${base}/healthz`);
    assert.equal(health.status, 200);
    assert.equal((await health.json()).service, 'service-d-payment');
    assert.equal((await fetch(`${base}/metrics`)).status, 200);
    console.log('PASS healthz and metrics');
  });
  await withServer('declined', async () => {
    const declined = await charge(valid);
    assert.equal(declined.status, 402);
    assert.equal(declined.body.status, 'FAILED_DECLINED');
    assert.deepEqual(await charge(valid), declined);
    console.log('PASS declined payment and replay');
  });
})().catch((error) => { console.error(error); process.exitCode = 1; });
