import test from 'node:test';
import assert from 'node:assert/strict';
import { makeApp, client, stripeEvent, paidInvoice, GOOD_SITE } from './app-helpers.js';
import { ConcurrencyGate } from '../src/core/rate-limit.js';

const many = { 'https://ok.example.com/': GOOD_SITE, 'https://other.example.com/': GOOD_SITE };

async function makePro(ctx, c, email = 'pro@example.com') {
  await c.signIn(email);
  const user = await ctx.store.getUserByEmail(email);
  await ctx.store.setStripeCustomer(user.id, `cus_${user.id}`);
  const end = Math.floor(ctx.time.t / 1000) + 30 * 86400;
  assert.equal((await stripeEvent(ctx, paidInvoice(`cus_${user.id}`, end))).status, 200);
  return ctx.store.getUser(user.id);
}

test('you have to sign up before the first audit', async () => {
  const ctx = makeApp();
  const res = await client(ctx).post('/api/audit', { url: 'ok.example.com' });
  assert.equal(res.status, 401);
  assert.equal(res.data.signIn, true);
  assert.equal(ctx.web.calls.length, 0);
});

test('the first audit is free and shows only the top issues', async () => {
  const ctx = makeApp();
  const c = client(ctx);
  await c.signIn('a@example.com');
  const res = await c.post('/api/audit', { url: 'ok.example.com' });
  assert.equal(res.status, 200);
  const r = res.data.report;
  assert.equal(r.limited, true);
  assert.ok(r.issues.length <= 5);
  assert.equal(typeof r.issues[0].fix, 'string');
  assert.ok(r.issues.slice(1).every((i) => i.fix === null && i.locked));
  assert.ok(r.lockedFixes > 0);
  assert.deepEqual(r.passed, []);
  // The locked fixes are not in the response at all.
  const full = await ctx.store.getAudit((await ctx.store.getUserByEmail('a@example.com')).id, res.data.auditId);
  const sent = JSON.stringify(res.data);
  const lockedOnly = full.report.issues.slice(1).map((i) => i.fix).filter((f) => f !== full.report.issues[0].fix);
  assert.ok(lockedOnly.length > 0);
  for (const f of lockedOnly) assert.ok(!sent.includes(JSON.stringify(f)), f);

  const second = await c.post('/api/audit', { url: 'other.example.com' });
  assert.equal(second.status, 402);
  assert.equal(second.data.upgrade, true);
  assert.equal((await c.get('/api/me')).data.user.freeUsed, true);
});

test('another spelling of the same inbox does not get a second free audit', async () => {
  const ctx = makeApp({ routes: many });
  const a = client(ctx);
  await a.signIn('jacob.smith@gmail.com');
  assert.equal((await a.post('/api/audit', { url: 'ok.example.com' })).status, 200);
  const b = client(ctx, { ip: '8.8.8.8' });
  await b.signIn('jacobsmith+again@gmail.com');
  const res = await b.post('/api/audit', { url: 'other.example.com' });
  assert.equal(res.status, 402);
});

test('free audits are capped per connection per day', async () => {
  const ctx = makeApp({ env: { FREE_AUDITS_PER_IP_DAY: '2', SIGNIN_PER_IP: '50' } });
  const statuses = [];
  for (const name of ['a', 'b', 'c']) {
    const c = client(ctx, { ip: '4.4.4.4' });
    await c.signIn(`${name}@example.com`);
    statuses.push((await c.post('/api/audit', { url: 'ok.example.com' })).status);
  }
  assert.deepEqual(statuses, [200, 200, 429]);
});

test('free audits need the human check when it is on; paid ones do not', async () => {
  const ctx = makeApp({ verifyHuman: async (t) => t === 'human' });
  const c = client(ctx);
  await c.post('/api/auth/start', { email: 'a@example.com', turnstileToken: 'human' });
  const token = ctx.mailer.sent[0].text.match(/#signin=(\S+)/)[1];
  await c.post('/api/auth/verify', { token });
  assert.equal((await c.post('/api/audit', { url: 'ok.example.com' })).status, 403);
  assert.equal((await c.post('/api/audit', { url: 'ok.example.com', turnstileToken: 'human' })).status, 200);
});

test('a refused URL does not use up the free audit', async () => {
  const ctx = makeApp();
  const c = client(ctx);
  await c.signIn('a@example.com');
  const blocked = await c.post('/api/audit', { url: 'http://10.0.0.1/' });
  assert.equal(blocked.status, 400);
  assert.equal((await c.get('/api/me')).data.user.freeUsed, false);
  assert.equal((await c.post('/api/audit', { url: 'ok.example.com' })).status, 200);
});

test('a site that cannot be reached refunds the credit', async () => {
  const ctx = makeApp({ routes: { 'https://ok.example.com/': () => { throw new TypeError('fetch failed'); } } });
  const c = client(ctx);
  await c.signIn('a@example.com');
  const res = await c.post('/api/audit', { url: 'ok.example.com' });
  assert.equal(res.status, 502);
  assert.equal((await c.get('/api/me')).data.user.freeUsed, false);
});

test('a crash after the page arrived still uses the credit', async () => {
  // A response whose header value throws when the checks read it, so the
  // audit fails after the site has sent its page.
  const poisoned = () => ({
    status: 200,
    headers: { get: (k) => (k === 'content-type' ? 'text/html' : null), forEach: (cb) => cb({ toString() { throw new Error('boom'); } }, 'x-robots-tag') },
    body: null,
    text: async () => '<title>x</title>',
  });
  const ctx = makeApp({ routes: { 'https://ok.example.com/': poisoned } });
  const c = client(ctx);
  await c.signIn('a@example.com');
  const res = await c.post('/api/audit', { url: 'ok.example.com' });
  assert.equal(res.status, 500);
  assert.match(res.data.error, /still counts/);
  assert.equal((await c.get('/api/me')).data.user.freeUsed, true);
  assert.ok(ctx.logs.some((l) => /after the page arrived/.test(l)));
});

test('a failed save gives the credit back', async () => {
  const ctx = makeApp();
  const c = client(ctx);
  await c.signIn('a@example.com');
  ctx.store.saveAudit = async () => {
    throw new Error('disk full');
  };
  const res = await c.post('/api/audit', { url: 'ok.example.com' });
  assert.equal(res.status, 500);
  assert.equal((await c.get('/api/me')).data.user.freeUsed, false);
});

test('the paid plan gives 20 full audits a period', async () => {
  const ctx = makeApp({ env: { AUDITS_PER_HOUR_ACCOUNT: '100', AUDIT_TARGET_LIMIT: '100', AUDIT_RATE_LIMIT: '100' } });
  const c = client(ctx);
  await makePro(ctx, c);
  const me = (await c.get('/api/me')).data.user;
  assert.equal(me.plan, 'pro');
  assert.equal(me.runsLeft, 20);
  const first = await c.post('/api/audit', { url: 'ok.example.com' });
  assert.equal(first.status, 200);
  assert.equal(first.data.report.limited, undefined);
  assert.ok(first.data.report.issues.every((i) => typeof i.fix === 'string'));
  assert.equal(first.data.runsLeft, 19);
  for (let i = 0; i < 19; i++) assert.equal((await c.post('/api/audit', { url: 'ok.example.com' })).status, 200);
  const out = await c.post('/api/audit', { url: 'ok.example.com' });
  assert.equal(out.status, 402);
  assert.match(out.data.error, /reset when your plan renews/);
});

test('two audits at once cannot both spend the last run', async () => {
  const ctx = makeApp();
  const c = client(ctx);
  const user = await makePro(ctx, c);
  await ctx.db.prepare('UPDATE users SET runs_left = 1 WHERE id = ?').bind(user.id).run();
  const results = await Promise.all([ctx.store.claimRun(user), ctx.store.claimRun(user), ctx.store.claimRun(user)]);
  assert.equal(results.filter((r) => r.ok).length, 1);
  assert.equal((await ctx.store.getUser(user.id)).runs_left, 0);
});

test('history and the weekly check are paid features', async () => {
  const ctx = makeApp();
  const c = client(ctx);
  await c.signIn('free@example.com');
  const res = await c.post('/api/audit', { url: 'ok.example.com' });
  assert.equal((await c.get('/api/audits')).status, 402);
  assert.equal((await c.post('/api/watch', { url: 'ok.example.com' })).status, 402);
  // The free audit can still be reopened, still cut down.
  const again = await c.get(`/api/audits/${res.data.auditId}`);
  assert.equal(again.data.report.limited, true);

  // After paying, the same audit opens in full.
  const user = await ctx.store.getUserByEmail('free@example.com');
  await ctx.store.setStripeCustomer(user.id, 'cus_free');
  await stripeEvent(ctx, paidInvoice('cus_free', Math.floor(ctx.time.t / 1000) + 86400 * 30));
  const full = await c.get(`/api/audits/${res.data.auditId}`);
  assert.equal(full.data.report.limited, undefined);
  const list = await c.get('/api/audits');
  assert.equal(list.data.audits.length, 1);
  assert.equal(list.data.audits[0].report, undefined);
});

test("you cannot open someone else's audit", async () => {
  const ctx = makeApp();
  const a = client(ctx);
  await a.signIn('a@example.com');
  const res = await a.post('/api/audit', { url: 'ok.example.com' });
  const b = client(ctx, { ip: '6.6.6.6' });
  await b.signIn('b@example.com');
  assert.equal((await b.get(`/api/audits/${res.data.auditId}`)).status, 404);
  assert.equal((await b.get('/api/audits/../../etc')).status, 404);
  assert.equal((await client(ctx).get(`/api/audits/${res.data.auditId}`)).status, 401);
});

test('per-account, per-site and daily limits', async () => {
  const ctx = makeApp({ env: { AUDITS_PER_HOUR_ACCOUNT: '3', AUDIT_TARGET_LIMIT: '2', DAILY_AUDIT_CAP: '1000', AUDIT_RATE_LIMIT: '100' }, routes: many });
  const c = client(ctx);
  await makePro(ctx, c);
  assert.equal((await c.post('/api/audit', { url: 'ok.example.com' })).status, 200);
  assert.equal((await c.post('/api/audit', { url: 'www.ok.example.com' })).status !== 429, true);
  assert.equal((await c.post('/api/audit', { url: 'ok.example.com' })).status, 429); // same site
  assert.equal((await c.post('/api/audit', { url: 'other.example.com' })).status, 429); // account hour cap (4th try)
  ctx.time.t += 61 * 60_000;
  assert.equal((await c.post('/api/audit', { url: 'other.example.com' })).status, 200);

  const capped = makeApp({ env: { DAILY_AUDIT_CAP: '1' } });
  const a = client(capped);
  await a.signIn('a@example.com');
  assert.equal((await a.post('/api/audit', { url: 'ok.example.com' })).status, 200);
  const b = client(capped, { ip: '2.2.2.2' });
  await b.signIn('b@example.com');
  const res = await b.post('/api/audit', { url: 'ok.example.com' });
  assert.equal(res.status, 429);
  assert.match(res.data.error, /daily limit/);
  assert.equal((await b.get('/api/me')).data.user.freeUsed, false);
});

test('refused audits do not count toward the daily cap or the per-site limit', async () => {
  const ctx = makeApp({ verifyHuman: async (t) => t === 'human', env: { AUDIT_RATE_LIMIT: '100', AUDITS_PER_HOUR_ACCOUNT: '100' } });
  const c = client(ctx);
  await c.post('/api/auth/start', { email: 'a@example.com', turnstileToken: 'human' });
  await c.post('/api/auth/verify', { token: ctx.mailer.sent[0].text.match(/#signin=(\S+)/)[1] });
  assert.equal((await c.post('/api/audit', { url: 'ok.example.com', turnstileToken: 'human' })).status, 200);
  for (let i = 0; i < 5; i++) assert.equal((await c.post('/api/audit', { url: 'ok.example.com' })).status, 403); // no human check
  for (let i = 0; i < 5; i++) assert.equal((await c.post('/api/audit', { url: 'ok.example.com', turnstileToken: 'human' })).status, 402); // free audit used
  const count = async (key) => (await ctx.db.prepare('SELECT SUM(count) AS n FROM counters WHERE key = ?').bind(key).first()).n;
  assert.equal(await count('audit-day'), 1);
  assert.equal(await count('audit-target:ok.example.com'), 1);
});

test('domains that redirect to one site share its per-site limit', async () => {
  const routes = { 'https://victim.example.org/': GOOD_SITE };
  for (const n of [1, 2, 3]) routes[`https://a${n}.example.com/`] = { status: 301, headers: { location: 'https://victim.example.org/' } };
  const ctx = makeApp({ routes, env: { AUDIT_TARGET_LIMIT: '2', AUDIT_RATE_LIMIT: '100', AUDITS_PER_HOUR_ACCOUNT: '100' } });
  const c = client(ctx);
  await makePro(ctx, c);
  const statuses = [];
  for (const n of [1, 2, 3]) statuses.push((await c.post('/api/audit', { url: `a${n}.example.com` })).status);
  assert.deepEqual(statuses, [200, 200, 429]);
  assert.equal((await c.get('/api/me')).data.user.runsLeft, 18); // the refused one was refunded
});

test('the off switch pauses audits', async () => {
  const ctx = makeApp({ env: { AUDITS_ENABLED: '0' } });
  const c = client(ctx);
  await c.signIn('a@example.com');
  assert.equal((await c.post('/api/audit', { url: 'ok.example.com' })).status, 503);
  assert.equal(ctx.web.calls.length, 0);
});

test('a busy server gives the credit back', async () => {
  const gate = new ConcurrencyGate(1);
  const ctx = makeApp({ gate });
  const c = client(ctx);
  await c.signIn('a@example.com');
  gate.tryEnter();
  const res = await c.post('/api/audit', { url: 'ok.example.com' });
  assert.equal(res.status, 503);
  assert.equal((await c.get('/api/me')).data.user.freeUsed, false);
  gate.leave();
  assert.equal((await c.post('/api/audit', { url: 'ok.example.com' })).status, 200);
});

test('error messages never echo the submitted URL', async () => {
  const ctx = makeApp();
  const c = client(ctx);
  await c.signIn('a@example.com');
  const res = await c.post('/api/audit', { url: 'https://<img src=x onerror=alert(1)>.example.com/' });
  assert.equal(res.status, 400);
  assert.doesNotMatch(JSON.stringify(res.data), /onerror|<img/);
});

test('private targets are refused before any fetch or charge', async () => {
  const ctx = makeApp();
  const c = client(ctx);
  await c.signIn('a@example.com');
  for (const url of ['http://169.254.169.254/latest/meta-data/', 'localhost:8080', 'http://[::1]/', 'file:///etc/passwd']) {
    const res = await c.post('/api/audit', { url });
    assert.equal(res.status, 400, url);
  }
  assert.equal(ctx.web.calls.length, 0);
  assert.equal((await c.get('/api/me')).data.user.freeUsed, false);
  assert.equal((await c.post('/api/audit', { url: 'ok.example.com', limits: { maxPages: 99 } })).status, 400);
});

