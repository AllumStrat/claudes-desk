import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/worker/index.js';
import { LocalD1 } from '../src/node/sqlite-d1.js';

const ORIGIN = 'https://audit.example.com';
const baseEnv = () => ({ DB: new LocalD1(':memory:').migrate(), APP_ORIGIN: ORIGIN, HASH_SALT: 'salt', EMAIL: { sent: [], async send(m) { this.sent.push(m); } } });
const post = (path, body, headers = {}) =>
  new Request(`${ORIGIN}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', origin: ORIGIN, ...headers }, body });

test('worker answers the API and refuses private targets without fetching', async () => {
  const env = baseEnv();
  const realFetch = globalThis.fetch;
  let fetched = 0;
  globalThis.fetch = async () => {
    fetched++;
    return new Response('{}');
  };
  try {
    const start = await worker.fetch(post('/api/auth/start', '{"email":"w@example.com"}', { 'cf-connecting-ip': '1.1.1.1' }), env);
    assert.equal(start.status, 200);
    const token = env.EMAIL.sent[0].text.match(/#signin=(\S+)/)[1];
    const verify = await worker.fetch(post('/api/auth/verify', JSON.stringify({ token })), env);
    const cookie = verify.headers.get('set-cookie').split(';')[0];
    assert.match(cookie, /^__Host-sid=/);
    const res = await worker.fetch(post('/api/audit', '{"url":"http://169.254.169.254/"}', { cookie }), env);
    assert.equal(res.status, 400);
    assert.equal(fetched, 0);
    assert.match(res.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('worker caps request bodies, including chunked ones', async () => {
  const env = baseEnv();
  assert.equal((await worker.fetch(post('/api/auth/start', 'x'.repeat(5000)), env)).status, 413);
  const stream = new ReadableStream({ pull(c) { c.enqueue(new Uint8Array(1024)); } });
  const chunked = new Request(`${ORIGIN}/api/auth/start`, { method: 'POST', headers: { 'content-type': 'application/json', origin: ORIGIN }, body: stream, duplex: 'half' });
  assert.equal((await worker.fetch(chunked, env)).status, 413);
});

test('worker checks the rate limiting binding first', async () => {
  const env = { ...baseEnv(), IP_RATE_LIMITER: { limit: async () => ({ success: false }) } };
  const res = await worker.fetch(post('/api/auth/start', '{"email":"w@example.com"}', { 'cf-connecting-ip': '9.9.9.9' }), env);
  assert.equal(res.status, 429);
  assert.equal(env.EMAIL.sent.length, 0);
});

test('a worker with missing settings says it is not set up', async () => {
  const res = await worker.fetch(new Request(`${ORIGIN}/api/me`), { DB: null });
  assert.equal(res.status, 503);
  const noSalt = await worker.fetch(new Request(`${ORIGIN}/api/me`), { ...baseEnv(), HASH_SALT: '' });
  assert.equal(noSalt.status, 503);
});

test('non-API paths go to static assets, and the cron runs', async () => {
  const env = { ...baseEnv(), ASSETS: { fetch: async () => new Response('page') } };
  const res = await worker.fetch(new Request(`${ORIGIN}/`), env);
  assert.equal(await res.text(), 'page');
  const waits = [];
  await worker.scheduled({}, env, { waitUntil: (p) => waits.push(p) });
  assert.deepEqual(await waits[0], []);
});

test('the per-IP limiter covers every API route except the Stripe webhook', async () => {
  const seen = [];
  const env = { ...baseEnv(), IP_RATE_LIMITER: { limit: async ({ key }) => (seen.push(key), { success: false }) } };
  assert.equal((await worker.fetch(new Request(`${ORIGIN}/api/me`, { headers: { 'cf-connecting-ip': '9.9.9.9' } }), env)).status, 429);
  assert.equal((await worker.fetch(post('/api/billing/portal', '{}', { 'cf-connecting-ip': '9.9.9.9' }), env)).status, 429);
  const hook = await worker.fetch(post('/api/stripe/webhook', '{}'), env);
  assert.equal(hook.status, 503); // billing is off here; the point is that it was not rate limited
  assert.deepEqual(seen, ['9.9.9.9', '9.9.9.9']);
});
