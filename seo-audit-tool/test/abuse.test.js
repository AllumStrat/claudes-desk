// The human check, client addresses and throwaway inboxes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeApp, client } from './app-helpers.js';
import { readConfig } from '../src/app/config.js';
import { turnstileVerifier, clientKey, proxiedIp } from '../src/app/http.js';
import { isDisposableEmail } from '../src/app/disposable.js';

test('a public deploy refuses to start without a real Turnstile secret', () => {
  const base = { APP_ORIGIN: 'https://a.test', HASH_SALT: 's' };
  assert.throws(() => readConfig(base), /TURNSTILE_SECRET/);
  assert.throws(() => readConfig({ ...base, TURNSTILE_SECRET: 'x' }), /TURNSTILE_SECRET/); // no site key
  assert.throws(() => readConfig({ ...base, TURNSTILE_SITE_KEY: '1x00000000000000000000AA', TURNSTILE_SECRET: '1x0000000000000000000000000000000AA' }), /TURNSTILE_SECRET/);
  assert.equal(readConfig({ ...base, TURNSTILE_SITE_KEY: '0x4AAA', TURNSTILE_SECRET: '0x4AAAsecret' }).turnstileSecret, '0x4AAAsecret');
  assert.equal(readConfig({ ...base, TURNSTILE_BYPASS: 'dev' }).turnstileBypass, true);
  assert.throws(() => readConfig({ ...base, TURNSTILE_BYPASS: 'yes' }), /TURNSTILE_SECRET/);
  // The local http server may run without it.
  assert.equal(readConfig({ APP_ORIGIN: 'http://127.0.0.1:8787', HASH_SALT: 's' }).turnstileSecret, '');
});

test('Turnstile tokens must come from this site', async () => {
  const answer = { success: true, hostname: 'audit.example.com' };
  const fetchImpl = async (url, init) => {
    assert.equal(url, 'https://challenges.cloudflare.com/turnstile/v0/siteverify');
    assert.equal(new URLSearchParams(init.body).get('remoteip'), '1.2.3.4');
    return Response.json(answer);
  };
  assert.equal(await turnstileVerifier('s', fetchImpl, { hostname: 'audit.example.com' })('t', '1.2.3.4'), true);
  assert.equal(await turnstileVerifier('s', fetchImpl, { hostname: 'other.example.com' })('t', '1.2.3.4'), false);
  answer.success = false;
  assert.equal(await turnstileVerifier('s', fetchImpl, { hostname: 'audit.example.com' })('t', '1.2.3.4'), false);
});

test('client addresses: IPv6 counts per /64, proxies are trusted only at the last hop', () => {
  assert.equal(clientKey('2001:db8:1:2:aaaa::1'), '2001:db8:1:2::/64');
  assert.equal(clientKey('2001:db8:1:2:ffff:ffff:ffff:ffff'), '2001:db8:1:2::/64');
  assert.equal(clientKey('::ffff:8.8.8.8'), '8.8.8.8');
  assert.equal(clientKey('8.8.4.4'), '8.8.4.4');
  assert.equal(clientKey(''), '');
  const h = { 'x-forwarded-for': '6.6.6.6, 7.7.7.7', 'cf-connecting-ip': '9.9.9.9' };
  assert.equal(proxiedIp('1', h, '127.0.0.1'), '7.7.7.7');
  assert.equal(proxiedIp('cloudflare', h, '127.0.0.1'), '9.9.9.9');
  assert.equal(proxiedIp('', h, '127.0.0.1'), '127.0.0.1');
  assert.equal(proxiedIp('1', {}, '127.0.0.1'), '127.0.0.1');
});

test('throwaway inboxes can sign in but get no free audit', async () => {
  assert.equal(isDisposableEmail('a@mailinator.com'), true);
  assert.equal(isDisposableEmail('a@x.yopmail.com'), true);
  assert.equal(isDisposableEmail('a@gmail.com'), false);
  assert.equal(isDisposableEmail('a@notmailinator.com'), false);
  const ctx = makeApp();
  const c = client(ctx);
  await c.signIn('bot@mailinator.com');
  const res = await c.post('/api/audit', { url: 'ok.example.com' });
  assert.equal(res.status, 402);
  assert.match(res.data.error, /permanent email/);
  assert.equal((await c.get('/api/me')).data.user.freeUsed, false);
  assert.equal(ctx.web.calls.length, 0);
});

test('free audits are capped per connection per week, and per IPv6 /64', async () => {
  const ctx = makeApp({ env: { FREE_AUDITS_PER_IP_DAY: '10', FREE_AUDITS_PER_IP_WEEK: '2', SIGNIN_PER_IP: '50' } });
  const statuses = [];
  for (const [n, ip] of [[1, '2001:db8:5:5::1'], [2, '2001:db8:5:5::2'], [3, '2001:db8:5:5:abcd::9']]) {
    const c = client(ctx, { ip });
    await c.signIn(`user${n}@example.com`);
    statuses.push((await c.post('/api/audit', { url: 'ok.example.com' })).status);
    ctx.time.t += 86_400_000;
  }
  assert.deepEqual(statuses, [200, 200, 429]);
});
