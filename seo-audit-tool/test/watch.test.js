import test from 'node:test';
import assert from 'node:assert/strict';
import { makeApp, client, stripeEvent, paidInvoice, GOOD_SITE } from './app-helpers.js';
import { html } from './helpers.js';
import { diffReports, hasChanges, freeReport } from '../src/app/plans.js';
import { watchEmail, createMailer } from '../src/app/email.js';

const DAY = 86_400_000;

async function proUser(ctx, email = 'pro@example.com') {
  const c = client(ctx);
  await c.signIn(email);
  await c.post('/api/billing/checkout');
  const user = await ctx.store.getUserByEmail(email);
  await stripeEvent(ctx, paidInvoice(user.stripe_customer_id, Math.floor(ctx.time.t / 1000) + 60 * 86400));
  return { c, user };
}

test('saving a site checks it on the next hourly run, then weekly, emailing only on change', async () => {
  const site = { current: GOOD_SITE };
  const ctx = makeApp({ env: { SESSION_DAYS: '90' }, routes: { 'https://ok.example.com/': () => new Response(site.current.body, { headers: site.current.headers }) } });
  const { c } = await proUser(ctx);
  const saved = await c.post('/api/watch', { url: 'ok.example.com' });
  assert.equal(saved.data.watchUrl, 'https://ok.example.com/');
  assert.equal((await c.get('/api/me')).data.user.watchUrl, 'https://ok.example.com/');

  // First run: a baseline, plus one email saying the check is on.
  assert.deepEqual(await ctx.app.scheduled(), ['checked']);
  assert.equal(ctx.mailer.sent.length - 1, 1); // minus the sign-in email
  assert.match(ctx.mailer.sent.at(-1).text, /First check saved/);

  // Not due again for a week.
  ctx.time.t += DAY;
  assert.deepEqual(await ctx.app.scheduled(), []);

  // A week later, nothing changed: no email.
  ctx.time.t += 6 * DAY;
  assert.deepEqual(await ctx.app.scheduled(), ['checked']);
  assert.equal(ctx.mailer.sent.length, 2);

  // The site loses its title: an email names the new problem.
  site.current = html('<!doctype html><html lang="en"><head></head><body><h1>Hi</h1><p>Some words here.</p></body></html>');
  ctx.time.t += 7 * DAY;
  assert.deepEqual(await ctx.app.scheduled(), ['checked']);
  const mail = ctx.mailer.sent.at(-1);
  assert.equal(mail.to, 'pro@example.com');
  assert.match(mail.text, /New problems/);
  assert.match(mail.subject, /^Weekly SEO check: https:\/\/ok\.example\.com\/$/);

  // Weekly checks do not use up runs, and show in history.
  assert.equal((await c.get('/api/me')).data.user.runsLeft, 20);
  const list = (await c.get('/api/audits')).data.audits;
  assert.equal(list.filter((a) => a.kind === 'weekly').length, 3);

  assert.equal((await c.post('/api/watch', { url: null })).data.watchUrl, null);
  ctx.time.t += 8 * DAY;
  assert.deepEqual(await ctx.app.scheduled(), []);
});

test('changing the saved site does not buy extra audits', async () => {
  const ctx = makeApp({ routes: { 'https://ok.example.com/': GOOD_SITE, 'https://other.example.com/': GOOD_SITE, 'https://third.example.com/': GOOD_SITE } });
  const { c, user } = await proUser(ctx);
  await c.post('/api/watch', { url: 'ok.example.com' });
  assert.deepEqual(await ctx.app.scheduled(), ['checked']);
  // A new site right after a check waits for the usual weekly slot.
  ctx.time.t += 3_600_000;
  const moved = await c.post('/api/watch', { url: 'other.example.com' });
  assert.equal(moved.status, 200);
  assert.equal(moved.data.nextCheckAt, ctx.time.t - 3_600_000 + 7 * DAY);
  assert.deepEqual(await ctx.app.scheduled(), []);
  // Saving the same site again changes nothing; changes are limited per day.
  assert.equal((await c.post('/api/watch', { url: 'other.example.com' })).data.nextCheckAt, undefined);
  const statuses = [];
  for (const url of ['third.example.com', 'ok.example.com', 'third.example.com', 'ok.example.com', 'third.example.com']) statuses.push((await c.post('/api/watch', { url })).status);
  // 5 changes a day (the first save counted); the last one is the site
  // already saved, so it is a no-op.
  assert.deepEqual(statuses, [200, 200, 200, 429, 200]);
  // Clearing and saving again keeps the weekly slot too.
  await c.post('/api/watch', { url: null });
  ctx.time.t += DAY;
  assert.equal((await c.post('/api/watch', { url: 'other.example.com' })).status, 200);
  assert.deepEqual(await ctx.app.scheduled(), []);
  ctx.time.t += 6 * DAY;
  assert.deepEqual(await ctx.app.scheduled(), ['checked']);
  assert.equal((await ctx.store.getUser(user.id)).watch_url, 'https://other.example.com/');
});

test('weekly checks obey the off switch and the shared limits', async () => {
  const ctx = makeApp({ env: { DAILY_AUDIT_CAP: '2' } });
  const { c, user } = await proUser(ctx);
  await c.post('/api/watch', { url: 'ok.example.com' });
  ctx.config.auditsEnabled = false;
  assert.deepEqual(await ctx.app.scheduled(), []);
  ctx.config.auditsEnabled = true;
  assert.equal((await c.post('/api/audit', { url: 'other.example.com' })).status, 200);
  assert.equal((await c.post('/api/audit', { url: 'other.example.com' })).status, 200);
  // The daily cap is full, so the weekly check waits a few hours.
  assert.deepEqual(await ctx.app.scheduled(), ['postponed']);
  assert.equal((await ctx.store.getUser(user.id)).watch_next_at, ctx.time.t + 6 * 3_600_000);
  ctx.time.t += DAY;
  assert.deepEqual(await ctx.app.scheduled(), ['checked']);
});

test('a failed weekly check tries again the next day', async () => {
  const ctx = makeApp({ routes: { 'https://ok.example.com/': () => { throw new TypeError('down'); } } });
  const { c, user } = await proUser(ctx);
  await c.post('/api/watch', { url: 'ok.example.com' });
  assert.deepEqual(await ctx.app.scheduled(), ['failed']);
  assert.equal((await ctx.store.getUser(user.id)).watch_next_at, ctx.time.t + DAY);
});

test('a lapsed plan stops the weekly check', async () => {
  const ctx = makeApp();
  const { c, user } = await proUser(ctx);
  await c.post('/api/watch', { url: 'ok.example.com' });
  await ctx.db.prepare('UPDATE users SET period_end = ? WHERE id = ?').bind(ctx.time.t - 10 * DAY, user.id).run();
  assert.deepEqual(await ctx.app.scheduled(), ['dropped']);
  assert.equal((await ctx.store.getUser(user.id)).watch_url, null);
});

test('the watch URL goes through the same address checks', async () => {
  const ctx = makeApp();
  const { c } = await proUser(ctx);
  assert.equal((await c.post('/api/watch', { url: 'http://169.254.169.254/' })).status, 400);
  assert.equal((await c.post('/api/watch', { url: 5 })).status, 400);
});

test('cleanup removes old tokens, sessions, counters and extra audits', async () => {
  const ctx = makeApp();
  const { c, user } = await proUser(ctx);
  for (let i = 0; i < 3; i++) await ctx.store.saveAudit({ userId: user.id, url: 'https://ok.example.com/', kind: 'manual', report: { score: i, issues: [] }, now: ctx.time.t + i });
  ctx.time.t += 40 * DAY;
  await ctx.store.cleanup(ctx.time.t, { keepAudits: 2 });
  const count = async (t) => (await ctx.db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).first()).n;
  assert.equal(await count('login_tokens'), 0);
  assert.equal(await count('sessions'), 0);
  assert.equal(await count('counters'), 0);
  assert.equal(await count('stripe_events'), 0);
  assert.equal(await count('audits'), 2);
  void c;
});

test('audits of free accounts expire after 30 days; paid ones stay', async () => {
  const ctx = makeApp();
  const { user: pro } = await proUser(ctx);
  const free = await ctx.store.upsertUser('free@example.com', ctx.time.t);
  for (const u of [pro, free]) await ctx.store.saveAudit({ userId: u.id, url: 'https://ok.example.com/', kind: 'manual', report: { score: 1, issues: [] }, now: ctx.time.t });
  ctx.time.t += 29 * DAY;
  await ctx.store.cleanup(ctx.time.t);
  assert.equal((await ctx.db.prepare('SELECT COUNT(*) AS n FROM audits').first()).n, 2);
  ctx.time.t += 2 * DAY;
  await ctx.store.cleanup(ctx.time.t);
  const left = await ctx.db.prepare('SELECT user_id FROM audits').all();
  assert.deepEqual(left.results.map((r) => r.user_id), [pro.id]);
  await assert.rejects(ctx.store.saveAudit({ userId: pro.id, url: 'u', kind: 'manual', report: { x: 'y'.repeat(300_000) }, now: 1 }), /too large/);
});

test('report diffs and the free cut', () => {
  const a = { score: 80, issues: [{ id: 'x', issue: 'X', priority: 'high' }, { id: 'y', issue: 'Y', priority: 'low' }] };
  const b = { score: 70, issues: [{ id: 'y', issue: 'Y', priority: 'low' }, { id: 'z', issue: 'Z', priority: 'medium' }] };
  const d = diffReports(a, b);
  assert.deepEqual([d.scoreBefore, d.scoreAfter, d.newIssues.map((i) => i.id), d.fixedIssues.map((i) => i.id)], [80, 70, ['z'], ['x']]);
  assert.equal(hasChanges(diffReports(a, a)), false);
  assert.equal(hasChanges(diffReports(null, a)), true);
  const text = watchEmail({ appName: 'A', appOrigin: 'https://a.test', url: 'https://s.test/', diff: d }).text;
  assert.match(text, /down 10 from 80/);
  assert.match(text, /Fixed since last time \(1\)/);

  const full = { score: 50, issues: Array.from({ length: 8 }, (_, i) => ({ id: `i${i}`, issue: `I${i}`, fix: `F${i}`, priority: 'high' })), passed: [{ id: 'p' }], insights: [{ label: 'l' }], pages: [{ url: 'u', title: 't', status: 200 }] };
  const cut = freeReport(full, { issues: 3, fixes: 1 });
  assert.deepEqual(cut.issues.map((i) => i.fix), ['F0', null, null]);
  assert.equal(cut.lockedIssues, 5);
  assert.equal(cut.lockedFixes, 7);
  assert.deepEqual(cut.pages, [{ url: 'u', status: 200, error: undefined }]);
});

test('email HTML is escaped text', async () => {
  const diff = { scoreBefore: 1, scoreAfter: 2, newIssues: [{ issue: '<img src=x onerror=alert(1)>', priority: 'high' }], fixedIssues: [] };
  const mailer = createMailer({ provider: 'mock', from: 'a@b.co' });
  await mailer.send({ to: 'x@y.co', ...watchEmail({ appName: 'A', appOrigin: 'https://a.test', url: 'https://s.test/', diff }) });
  assert.doesNotMatch(mailer.sent[0].html, /<img/);
  assert.match(mailer.sent[0].html, /&lt;img src=x onerror=alert\(1\)&gt;/);
});
