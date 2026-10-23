import test from 'node:test';
import assert from 'node:assert/strict';
import { makeApp, client, ORIGIN } from './app-helpers.js';
import { normalizeEmail, freeKeyFor } from '../src/app/app.js';
import { parseCookies } from '../src/app/http.js';

test('email checks and free-audit keys', () => {
  assert.equal(normalizeEmail('  Jo@Example.COM '), 'jo@example.com');
  for (const bad of ['', 'no-at', 'a@b', 'a b@c.co', 'a@b.co\r\nBcc: x@y.z', 'a@b.co,c@d.co', '<a@b.co>', 5, null, `${'a'.repeat(250)}@b.co`]) {
    assert.equal(normalizeEmail(bad), null, String(bad));
  }
  assert.equal(freeKeyFor('j.o.e+audit@gmail.com'), 'joe@gmail.com');
  assert.equal(freeKeyFor('joe@googlemail.com'), 'joe@gmail.com');
  assert.equal(freeKeyFor('j.oe+x@work.com'), 'j.oe@work.com');
});

test('magic link sign-in sets a session cookie and works once', async () => {
  const ctx = makeApp();
  const c = client(ctx);
  assert.equal((await c.get('/api/me')).data.user, null);
  const { token, mail } = await c.signIn('Jacob@Example.com');
  assert.equal(mail.to, 'jacob@example.com');
  assert.match(mail.text, new RegExp(`^${ORIGIN}/#signin=`, 'm'));
  assert.doesNotMatch(mail.html, /<script|<a /);
  const me = await c.get('/api/me');
  assert.equal(me.data.user.email, 'jacob@example.com');
  assert.equal(me.data.user.plan, 'free');
  assert.equal(me.data.billingEnabled, true);

  // The same link cannot be used again, from anywhere.
  const other = client(ctx, { ip: '9.9.9.9' });
  const again = await other.post('/api/auth/verify', { token });
  assert.equal(again.status, 400);
  assert.equal(other.cookie, '');
});

test('session cookie is HttpOnly, Secure and SameSite on https', async () => {
  const ctx = makeApp();
  const c = client(ctx);
  const start = await c.post('/api/auth/start', { email: 'a@example.com' });
  const token = ctx.mailer.sent[0].text.match(/#signin=(\S+)/)[1];
  const res = await c.post('/api/auth/verify', { token });
  assert.match(res.setCookie, /^__Host-sid=[A-Za-z0-9_-]{43}; Path=\/; HttpOnly; SameSite=Lax; Max-Age=\d+; Secure$/);
  assert.equal(start.data.message, 'Check your email for a sign-in link.');
});

test('links expire', async () => {
  const ctx = makeApp();
  const c = client(ctx);
  await c.post('/api/auth/start', { email: 'a@example.com' });
  const token = ctx.mailer.sent[0].text.match(/#signin=(\S+)/)[1];
  ctx.time.t += 16 * 60_000;
  assert.equal((await c.post('/api/auth/verify', { token })).status, 400);
});

test('only the hash of tokens and sessions is stored', async () => {
  const ctx = makeApp();
  const c = client(ctx);
  const { token } = await c.signIn('a@example.com');
  const sid = parseCookies(c.cookie)['__Host-sid'];
  const dump = JSON.stringify([
    await ctx.db.prepare('SELECT * FROM login_tokens').all(),
    await ctx.db.prepare('SELECT * FROM sessions').all(),
  ]);
  assert.ok(!dump.includes(token));
  assert.ok(!dump.includes(sid));
});

test('sign out ends the session on the server', async () => {
  const ctx = makeApp();
  const c = client(ctx);
  await c.signIn('a@example.com');
  const old = c.cookie;
  await c.post('/api/auth/logout');
  const res = await ctx.app.fetch(new Request(`${ORIGIN}/api/me`, { headers: { cookie: old } }));
  assert.equal((await res.json()).user, null);
});

test('POSTs need this site as Origin, and JSON', async () => {
  const ctx = makeApp();
  assert.equal((await client(ctx, { origin: 'https://evil.example' }).post('/api/auth/start', { email: 'a@b.co' })).status, 403);
  assert.equal((await client(ctx, { origin: '' }).post('/api/auth/start', { email: 'a@b.co' })).status, 403);
  const c = client(ctx);
  assert.equal((await c.post('/api/auth/start', '{"email":"a@b.co"}', { 'content-type': 'text/plain' })).status, 415);
  assert.equal((await c.post('/api/auth/start', { email: 'a@b.co', admin: true })).status, 400);
  assert.equal((await c.post('/api/auth/start', 'x'.repeat(10_000))).status, 413);
  assert.equal((await c.post('/api/auth/start', '{nope')).status, 400);
  assert.equal(ctx.mailer.sent.length, 0);
});

test('sign-in emails are limited per address and per connection', async () => {
  const ctx = makeApp({ env: { SIGNIN_PER_EMAIL: '2', SIGNIN_PER_IP: '4' } });
  const c = client(ctx);
  assert.equal((await c.post('/api/auth/start', { email: 'a@example.com' })).status, 200);
  assert.equal((await c.post('/api/auth/start', { email: 'a@example.com' })).status, 200);
  assert.equal((await c.post('/api/auth/start', { email: 'a@example.com' })).status, 429);
  assert.equal((await c.post('/api/auth/start', { email: 'b@example.com' })).status, 200);
  const blocked = await c.post('/api/auth/start', { email: 'c@example.com' });
  assert.equal(blocked.status, 429);
  assert.ok(Number(blocked.headers.get('retry-after')) > 0);
  assert.equal((await client(ctx, { ip: '5.5.5.5' }).post('/api/auth/start', { email: 'c@example.com' })).status, 200);
  assert.equal(ctx.mailer.sent.length, 4);
});

test('the human check is required to send a sign-in email when configured', async () => {
  const ctx = makeApp({ verifyHuman: async (t) => t === 'human' });
  const c = client(ctx);
  assert.equal((await c.post('/api/auth/start', { email: 'a@example.com' })).status, 403);
  assert.equal((await c.post('/api/auth/start', { email: 'a@example.com', turnstileToken: 'bot' })).status, 403);
  assert.equal((await c.post('/api/auth/start', { email: 'a@example.com', turnstileToken: 'human' })).status, 200);
  assert.equal(ctx.mailer.sent.length, 1);
});

test('a failed email send says so and does not crash', async () => {
  const ctx = makeApp();
  ctx.mailer.send = async () => {
    throw new Error('provider down');
  };
  const res = await client(ctx).post('/api/auth/start', { email: 'a@example.com' });
  assert.equal(res.status, 502);
  assert.doesNotMatch(JSON.stringify(res.data), /provider down/);
});

test('turning sign-ups off still lets existing users in, quietly', async () => {
  const ctx = makeApp();
  await client(ctx).signIn('old@example.com');
  ctx.config.signupsEnabled = false;
  const c = client(ctx, { ip: '7.7.7.7' });
  assert.equal((await c.post('/api/auth/start', { email: 'new@example.com' })).status, 200);
  assert.equal(ctx.mailer.sent.length, 1);
  await c.signIn('old@example.com');
});

test('bad cookies and unknown routes', async () => {
  const ctx = makeApp();
  const res = await ctx.app.fetch(new Request(`${ORIGIN}/api/me`, { headers: { cookie: '__Host-sid=../../etc; x=1' } }));
  assert.equal((await res.json()).user, null);
  assert.equal((await client(ctx).get('/api/nope')).status, 404);
  assert.equal((await client(ctx).post('/api/nope')).status, 404);
  const put = await ctx.app.fetch(new Request(`${ORIGIN}/api/me`, { method: 'PUT' }));
  assert.equal(put.status, 405);
  assert.match(put.headers.get('content-security-policy'), /frame-ancestors 'none'/);
});

test('account deletion removes the user, but not the free-audit claim', async () => {
  const ctx = makeApp();
  const c = client(ctx);
  await c.signIn('a@example.com');
  assert.equal((await c.post('/api/audit', { url: 'ok.example.com' })).status, 200);
  assert.equal((await c.post('/api/account/delete')).status, 200);
  assert.equal((await c.get('/api/me')).data.user, null);
  assert.equal((await ctx.db.prepare('SELECT COUNT(*) AS n FROM audits').first()).n, 0);
  const again = client(ctx);
  await again.signIn('a@example.com');
  assert.equal((await again.post('/api/audit', { url: 'ok.example.com' })).status, 402);
});
