import test from 'node:test';
import assert from 'node:assert/strict';
import { safeFetch, FetchError } from '../src/core/safe-fetch.js';
import { fakeWeb, html } from './helpers.js';

const run = (web, url, extra = {}) => safeFetch(url, { fetchImpl: web.fetchImpl, resolveHost: web.resolveHost, ...extra });

async function rejectsWith(promise, code) {
  await assert.rejects(promise, (err) => {
    assert.ok(err instanceof FetchError, `expected FetchError, got ${err}`);
    assert.equal(err.code, code);
    return true;
  });
}

test('follows a normal redirect and records the chain', async () => {
  const web = fakeWeb({
    'http://a.example.com/': { status: 301, headers: { location: 'https://a.example.com/' } },
    'https://a.example.com/': html('<p>ok</p>'),
  });
  const res = await run(web, 'http://a.example.com/');
  assert.equal(res.status, 200);
  assert.equal(res.url, 'https://a.example.com/');
  assert.equal(res.chain.length, 2);
  assert.equal(res.body, '<p>ok</p>');
});

test('refuses a redirect to a private IP literal', async () => {
  const web = fakeWeb({ 'https://a.example.com/': { status: 302, headers: { location: 'http://169.254.169.254/latest/meta-data/' } } });
  await rejectsWith(run(web, 'https://a.example.com/'), 'BLOCKED_URL');
  assert.equal(web.calls.length, 1, 'must not contact the metadata address');
});

test('refuses a redirect to a host that resolves privately', async () => {
  const web = fakeWeb(
    { 'https://a.example.com/': { status: 302, headers: { location: 'https://evil.example.com/' } } },
    { 'evil.example.com': ['10.0.0.7'] },
  );
  await rejectsWith(run(web, 'https://a.example.com/'), 'BLOCKED_ADDRESS');
  assert.equal(web.calls.length, 1);
});

test('refuses a host with mixed public and private answers', async () => {
  const web = fakeWeb({ 'https://mixed.example.com/': html('x') }, { 'mixed.example.com': ['93.184.215.14', '127.0.0.1'] });
  await rejectsWith(run(web, 'https://mixed.example.com/'), 'BLOCKED_ADDRESS');
  assert.equal(web.calls.length, 0);
});

test('refuses a host that resolves to a mapped IPv6 loopback', async () => {
  const web = fakeWeb({ 'https://v6.example.com/': html('x') }, { 'v6.example.com': ['::ffff:127.0.0.1'] });
  await rejectsWith(run(web, 'https://v6.example.com/'), 'BLOCKED_ADDRESS');
});

test('refuses redirects to other schemes and to credentials', async () => {
  const web = fakeWeb({
    'https://a.example.com/1': { status: 301, headers: { location: 'file:///etc/passwd' } },
    'https://a.example.com/2': { status: 301, headers: { location: 'https://user:pw@b.example.com/' } },
    'https://a.example.com/3': { status: 301, headers: { location: 'https://a.example.com:2375/' } },
  });
  await rejectsWith(run(web, 'https://a.example.com/1'), 'BLOCKED_URL');
  await rejectsWith(run(web, 'https://a.example.com/2'), 'BLOCKED_URL');
  await rejectsWith(run(web, 'https://a.example.com/3'), 'BLOCKED_URL');
});

test('caps redirect loops', async () => {
  const web = fakeWeb({
    'https://a.example.com/x': { status: 302, headers: { location: '/y' } },
    'https://a.example.com/y': { status: 302, headers: { location: '/x' } },
  });
  await rejectsWith(run(web, 'https://a.example.com/x', { maxRedirects: 4 }), 'TOO_MANY_REDIRECTS');
  assert.equal(web.calls.length, 5);
});

test('caps the body size and flags truncation', async () => {
  const web = fakeWeb({ 'https://big.example.com/': html('a'.repeat(50_000)) });
  const res = await run(web, 'https://big.example.com/', { maxBytes: 1000 });
  assert.equal(res.truncated, true);
  assert.equal(res.body.length, 1000);
  assert.equal(res.bytes, 1000);
});

test('stops reading an endless body at the cap', async () => {
  let pulls = 0;
  const endless = new ReadableStream({
    pull(c) {
      pulls++;
      c.enqueue(new Uint8Array(4096).fill(97));
    },
  });
  const web = fakeWeb({ 'https://inf.example.com/': () => new Response(endless, { headers: { 'content-type': 'text/html' } }) });
  const res = await run(web, 'https://inf.example.com/', { maxBytes: 10_000 });
  assert.equal(res.truncated, true);
  assert.ok(pulls < 10);
});

test('times out a slow server', async () => {
  const web = fakeWeb({
    'https://slow.example.com/': (url, init) =>
      new Promise((resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(init.signal.reason));
      }),
  });
  await rejectsWith(run(web, 'https://slow.example.com/', { timeoutMs: 50 }), 'TIMEOUT');
});

test('reports DNS failures', async () => {
  const web = fakeWeb({}, { 'nx.example.com': [] });
  await rejectsWith(run(web, 'https://nx.example.com/'), 'DNS_FAILED');
});

test('sends the audit user agent', async () => {
  let ua;
  const web = fakeWeb({ 'https://a.example.com/': (u, init) => ((ua = init.headers['user-agent']), new Response('ok')) });
  await run(web, 'https://a.example.com/');
  assert.match(ua, /AllumSEOAudit/);
});
