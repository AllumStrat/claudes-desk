import test from 'node:test';
import assert from 'node:assert/strict';
import worker, { bindingLimiter } from '../src/worker/index.js';

const post = (body, headers = {}) =>
  new Request('https://audit.example.com/api/audit', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body });

test('worker refuses private targets without fetching', async () => {
  const realFetch = globalThis.fetch;
  let fetched = 0;
  globalThis.fetch = async () => {
    fetched++;
    return new Response('{}');
  };
  try {
    const res = await worker.fetch(post('{"url":"http://169.254.169.254/"}'), {});
    assert.equal(res.status, 400);
    assert.equal(fetched, 0);
    assert.match(res.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('worker caps request bodies, including chunked ones', async () => {
  const res = await worker.fetch(post('x'.repeat(5000)), {});
  assert.equal(res.status, 413);
  const stream = new ReadableStream({ pull(c) { c.enqueue(new Uint8Array(1024)); } });
  const chunked = new Request('https://audit.example.com/api/audit', { method: 'POST', headers: { 'content-type': 'application/json' }, body: stream, duplex: 'half' });
  assert.equal((await worker.fetch(chunked, {})).status, 413);
});

test('worker uses the rate limiting binding when present', async () => {
  const env = { AUDIT_RATE_LIMITER: { limit: async () => ({ success: false }) } };
  const res = await worker.fetch(post('{"url":"https://example.com/"}', { 'cf-connecting-ip': '9.9.9.9' }), env);
  assert.equal(res.status, 429);
  assert.equal((await bindingLimiter({ limit: async ({ key }) => ({ success: key === 'a' }) }).check('a')).allowed, true);
});

test('non-API paths go to static assets', async () => {
  const env = { ASSETS: { fetch: async () => new Response('page') } };
  const res = await worker.fetch(new Request('https://audit.example.com/'), env);
  assert.equal(await res.text(), 'page');
});
