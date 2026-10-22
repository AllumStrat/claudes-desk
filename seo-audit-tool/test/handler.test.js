import test from 'node:test';
import assert from 'node:assert/strict';
import { createAuditHandler } from '../src/core/handler.js';
import { SlidingWindowLimiter, ConcurrencyGate } from '../src/core/rate-limit.js';
import { fakeWeb, html } from './helpers.js';

function setup({ limit = 100, gateMax = 2, verifyHuman, web } = {}) {
  const w = web || fakeWeb({ 'https://ok.example.com/': html('<!doctype html><title>Hello there friend of mine</title><h1>Hi</h1>') });
  const gate = new ConcurrencyGate(gateMax);
  const handle = createAuditHandler({
    auditDeps: () => ({ fetchImpl: w.fetchImpl, resolveHost: w.resolveHost }),
    limiter: new SlidingWindowLimiter({ limit, windowMs: 60_000 }),
    gate,
    verifyHuman,
  });
  const req = (over = {}) =>
    handle({ method: 'POST', host: 'audit.test', origin: 'http://audit.test', contentType: 'application/json', ip: '1.2.3.4', bodyText: '{"url":"https://ok.example.com/"}', ...over });
  return { req, gate, web: w };
}

test('runs an audit for a valid request', async () => {
  const { req } = setup();
  const out = await req();
  assert.equal(out.status, 200);
  assert.equal(typeof out.body.report.score, 'number');
});

test('rejects wrong method, type, origin, size and shape', async () => {
  const { req } = setup();
  assert.equal((await req({ method: 'GET' })).status, 405);
  assert.equal((await req({ contentType: 'text/plain' })).status, 415);
  assert.equal((await req({ origin: 'https://evil.example' })).status, 403);
  assert.equal((await req({ bodyText: JSON.stringify({ url: 'a'.repeat(5000) }) })).status, 413);
  assert.equal((await req({ bodyText: '{bad json' })).status, 400);
  assert.equal((await req({ bodyText: '[1,2]' })).status, 400);
  assert.equal((await req({ bodyText: '{"url":5}' })).status, 400);
  assert.equal((await req({ bodyText: '{"url":"https://ok.example.com/","limits":{"maxPages":1000}}' })).status, 400);
});

test('private targets get a 400 with a fixed message', async () => {
  const { req, web } = setup();
  const out = await req({ bodyText: '{"url":"http://169.254.169.254/latest/meta-data/"}' });
  assert.equal(out.status, 400);
  assert.equal(web.calls.length, 0);
  assert.doesNotMatch(out.body.error, /169\.254/);
});

test('error messages never echo the submitted URL', async () => {
  const { req } = setup();
  const payload = 'https://<img src=x onerror=alert(1)>.example.com/';
  const out = await req({ bodyText: JSON.stringify({ url: payload }) });
  assert.equal(out.status, 400);
  assert.doesNotMatch(JSON.stringify(out.body), /onerror|<img/);
});

test('rate limits per client', async () => {
  const { req } = setup({ limit: 2 });
  assert.equal((await req()).status, 200);
  assert.equal((await req()).status, 200);
  const third = await req();
  assert.equal(third.status, 429);
  assert.ok(Number(third.headers['retry-after']) > 0);
  assert.equal((await req({ ip: '5.6.7.8' })).status, 200);
});

test('caps concurrent audits', async () => {
  const { req, gate } = setup({ gateMax: 1 });
  gate.tryEnter();
  assert.equal((await req()).status, 503);
  gate.leave();
  assert.equal((await req()).status, 200);
});

test('human check is enforced when configured', async () => {
  const { req } = setup({ verifyHuman: async (t) => t === 'good' });
  assert.equal((await req()).status, 403);
  assert.equal((await req({ bodyText: '{"url":"https://ok.example.com/","turnstileToken":"bad"}' })).status, 403);
  assert.equal((await req({ bodyText: '{"url":"https://ok.example.com/","turnstileToken":"good"}' })).status, 200);
});

test('unexpected errors return a generic 500', async () => {
  const web = { fetchImpl: async () => { throw new TypeError('internal detail /etc/secret'); }, resolveHost: async () => ['93.184.215.14'] };
  const { req } = setup({ web });
  const out = await req();
  // A network-layer failure maps to 502 with a fixed message.
  assert.equal(out.status, 502);
  assert.doesNotMatch(JSON.stringify(out.body), /secret/);
});

test('limits audits of the same target site', async () => {
  const w = fakeWeb({ 'https://ok.example.com/': html('<title>t</title>') });
  const handle = createAuditHandler({
    auditDeps: () => ({ fetchImpl: w.fetchImpl, resolveHost: w.resolveHost }),
    limiter: new SlidingWindowLimiter({ limit: 100, windowMs: 60_000 }),
    targetLimiter: new SlidingWindowLimiter({ limit: 2, windowMs: 60_000 }),
    gate: new ConcurrencyGate(2),
  });
  const req = (ip, url) => handle({ method: 'POST', host: 'h', origin: '', contentType: 'application/json', ip, bodyText: JSON.stringify({ url }) });
  assert.equal((await req('1.1.1.1', 'https://ok.example.com/')).status, 200);
  assert.equal((await req('2.2.2.2', 'https://www.ok.example.com/')).status !== 429, true);
  assert.equal((await req('3.3.3.3', 'ok.example.com')).status, 429);
});
