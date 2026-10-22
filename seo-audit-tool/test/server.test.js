import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from '../src/node/server.js';

async function withServer(env, fn) {
  const { server } = createServer({ AUDIT_RATE_LIMIT: '3', ...env });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await fn(base);
  } finally {
    server.close();
  }
}

test('serves the page with security headers', async () => {
  await withServer({}, async (base) => {
    const res = await fetch(`${base}/`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-security-policy'), /default-src 'none'/);
    assert.equal(res.headers.get('x-frame-options'), 'DENY');
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.equal((await fetch(`${base}/../package.json`)).status, 404);
    assert.equal((await fetch(`${base}/src/core/audit.js`)).status, 404);
  });
});

test('API rejects oversized bodies and rate limits', async () => {
  await withServer({}, async (base) => {
    const big = await fetch(`${base}/api/audit`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: 'x'.repeat(10_000) });
    assert.equal(big.status, 413);
    const post = () =>
      fetch(`${base}/api/audit`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url: 'http://127.0.0.1:22/' }) });
    const statuses = [];
    for (let i = 0; i < 4; i++) statuses.push((await post()).status);
    assert.deepEqual(statuses, [400, 400, 400, 429]);
  });
});
