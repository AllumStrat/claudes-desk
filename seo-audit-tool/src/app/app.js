// The paid audit app: sign-in by emailed link, one free audit, then a $5 a
// month plan with 20 audits per paid period, history and a weekly re-check.
// Runs the same way on a Cloudflare Worker and on the local Node server.

import { runAudit, AuditError } from '../core/audit.js';
import { checkUrl, MAX_URL_LENGTH } from '../core/url-guard.js';
import { ConcurrencyGate } from '../core/rate-limit.js';
import { mapLimit } from '../core/util.js';
import { createStore } from './store.js';
import { createDbLimiter } from './limits.js';
import { randomToken, sha256Hex } from './crypto.js';
import { json, readCapped, parseCookies, sessionCookie } from './http.js';
import { signInEmail, watchEmail } from './email.js';
import { verifyStripeSignature, describeEvent } from './stripe.js';
import { freeReport, diffReports, hasChanges } from './plans.js';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const BODY_MAX = 4096;
const WEBHOOK_MAX = 256 * 1024;
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
const AUDIT_ID_RE = /^[A-Za-z0-9_-]{22}$/;
const EMAIL_RE = /^[^\s@<>()[\]\\,;:"]{1,64}@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

const USER_ERRORS = {
  INVALID_URL: 400,
  BLOCKED_URL: 400,
  BLOCKED_ADDRESS: 400,
  DNS_FAILED: 422,
  TIMEOUT: 504,
  TOO_MANY_REDIRECTS: 422,
  BAD_REDIRECT: 422,
  NETWORK: 502,
};

export function normalizeEmail(input) {
  if (typeof input !== 'string') return null;
  const email = input.trim().toLowerCase();
  if (email.length > 254 || !EMAIL_RE.test(email)) return null;
  return email;
}

// The same inbox under another spelling (name+tag@, or dots in a Gmail
// address) maps to one key, so it only gets one free audit.
export function freeKeyFor(email) {
  let [local, domain] = email.split('@');
  local = local.split('+')[0];
  if (domain === 'gmail.com' || domain === 'googlemail.com') {
    domain = 'gmail.com';
    local = local.replace(/\./g, '');
  }
  return `${local}@${domain}`;
}

/**
 * @param {object} deps
 * @param {object} deps.db            D1 database (or the local stand-in)
 * @param {object} deps.config        from readConfig()
 * @param {() => object} deps.auditDeps  { fetchImpl, resolveHost, jev, limits, userAgent }
 * @param {object} deps.mailer        from createMailer()
 * @param {object} [deps.stripe]      from createStripeClient(); null when billing is off
 * @param {Function} [deps.verifyHuman]  Turnstile check (token, ip) => boolean
 * @param {object} [deps.ipLimiter]   optional Cloudflare Rate Limiting binding, checked first
 * @param {ConcurrencyGate} [deps.gate]
 * @param {() => number} [deps.now]
 */
export function createApp(deps) {
  const { db, config, mailer } = deps;
  const now = deps.now || (() => Date.now());
  const log = deps.log || ((...a) => console.error(...a));
  const store = createStore(db, { runsPerPeriod: config.runsPerMonth });
  const counters = createDbLimiter(db, now);
  const gate = deps.gate || new ConcurrencyGate(config.limits.maxConcurrent);
  const L = config.limits;

  const hash = (s) => sha256Hex(`${config.hashSalt}|${s}`);
  const tooMany = (msg, retry) => json(429, { error: msg }, { 'retry-after': String(retry) });

  async function limit(key, max, windowMs, message) {
    const r = await counters.hit(key, max, windowMs);
    return r.allowed ? null : tooMany(message, r.retryAfterSec);
  }

  async function bindingLimit(ip) {
    if (!deps.ipLimiter) return null;
    const { success } = await deps.ipLimiter.limit({ key: ip || 'unknown' });
    return success ? null : tooMany('Too many requests from your connection. Try again in a minute.', 60);
  }

  async function currentUser(request) {
    const sid = parseCookies(request.headers.get('cookie'))[config.cookieName];
    if (!sid || !TOKEN_RE.test(sid)) return null;
    return store.getSessionUser(await sha256Hex(sid), now());
  }

  function publicUser(user) {
    if (!user) return null;
    const pro = store.isPro(user, now());
    return {
      email: user.email,
      plan: pro ? 'pro' : 'free',
      freeUsed: Boolean(user.free_used),
      runsLeft: pro ? user.runs_left : 0,
      runsPerMonth: config.runsPerMonth,
      periodEnd: pro ? user.period_end : null,
      watchUrl: pro ? user.watch_url : null,
      hasBilling: Boolean(user.stripe_customer_id),
    };
  }

  async function readJson(request, fields) {
    if (!/^application\/json\b/i.test(request.headers.get('content-type') || '')) return { error: json(415, { error: 'Send JSON.' }) };
    const text = await readCapped(request, BODY_MAX);
    if (text === null) return { error: json(413, { error: 'Request is too large.' }) };
    let body;
    try {
      body = text ? JSON.parse(text) : {};
    } catch {
      return { error: json(400, { error: 'Request is not valid JSON.' }) };
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) return { error: json(400, { error: 'Request must be a JSON object.' }) };
    if (Object.keys(body).some((k) => !fields.includes(k))) return { error: json(400, { error: 'Unexpected fields in request.' }) };
    return { body };
  }

  // Limits every audit counts against, manual or weekly: audits of one site
  // per hour from anyone, and the whole app per day.
  const siteKey = (hostname) => hostname.replace(/^www\./, '');
  async function sharedLimits(hostname) {
    return (
      (await limit(`audit-target:${siteKey(hostname)}`, L.auditPerTarget, HOUR, 'That site has been audited a lot recently. Try again later.')) ||
      (await limit('audit-day', L.dailyCap, DAY, 'The audit tool is at its daily limit. Try again tomorrow.'))
    );
  }

  async function humanCheck(body, ip) {
    if (!deps.verifyHuman) return null;
    const token = typeof body.turnstileToken === 'string' ? body.turnstileToken.slice(0, 2048) : '';
    const ok = token ? await deps.verifyHuman(token, ip).catch(() => false) : false;
    return ok ? null : json(403, { error: 'Please complete the check to show you are human.', human: true });
  }

  // --- routes -------------------------------------------------------------

  async function me(request) {
    const user = await currentUser(request);
    return json(200, {
      user: publicUser(user),
      turnstileSiteKey: config.turnstileSiteKey || null,
      billingEnabled: Boolean(deps.stripe && config.billing),
      runsPerMonth: config.runsPerMonth,
    });
  }

  async function authStart(request, ip) {
    const { body, error } = await readJson(request, ['email', 'turnstileToken']);
    if (error) return error;
    const email = normalizeEmail(body.email);
    if (!email) return json(400, { error: 'Enter a valid email address.' });
    const ipHash = await hash(`ip:${ip}`);
    const limited =
      (await bindingLimit(ip)) ||
      (await limit(`signin-ip:${ipHash}`, L.signinPerIp, HOUR, 'Too many sign-in attempts from your connection. Try again later.')) ||
      (await humanCheck(body, ip)) ||
      (await limit(`signin-email:${await hash(email)}`, L.signinPerEmail, 15 * MIN, 'We just sent a link to that address. Check your inbox, or try again in a few minutes.'));
    if (limited) return limited;

    const done = json(200, { ok: true, message: 'Check your email for a sign-in link.' });
    if (!config.signupsEnabled && !(await store.getUserByEmail(email))) return done;

    const token = randomToken();
    await store.saveLoginToken(await sha256Hex(token), email, now(), config.loginMinutes * MIN);
    // The token goes after #, so it is never sent to a server or written to logs.
    const link = `${config.appOrigin}/#signin=${token}`;
    try {
      await mailer.send({ to: email, ...signInEmail({ appName: config.appName, link, minutes: config.loginMinutes }) });
    } catch (err) {
      log('sign-in email failed', err?.message);
      return json(502, { error: 'We could not send the email just now. Try again in a minute.' });
    }
    return done;
  }

  async function authVerify(request, ip) {
    const { body, error } = await readJson(request, ['token']);
    if (error) return error;
    const limited = await limit(`verify-ip:${await hash(`ip:${ip}`)}`, 30, HOUR, 'Too many sign-in attempts. Try again later.');
    if (limited) return limited;
    if (typeof body.token !== 'string' || !TOKEN_RE.test(body.token)) return json(400, { error: 'That sign-in link is not valid.' });
    const email = await store.useLoginToken(await sha256Hex(body.token), now());
    if (!email) return json(400, { error: 'That sign-in link has expired or was already used. Ask for a new one.' });
    const user = await store.upsertUser(email, now());
    const sid = randomToken();
    const ttl = config.sessionDays * DAY;
    await store.createSession(await sha256Hex(sid), user.id, now(), ttl);
    return json(200, { ok: true, user: publicUser(user) }, { 'set-cookie': sessionCookie(config.cookieName, sid, { maxAgeSec: ttl / 1000, secure: config.secureCookie }) });
  }

  async function authLogout(request) {
    const sid = parseCookies(request.headers.get('cookie'))[config.cookieName];
    if (sid && TOKEN_RE.test(sid)) await store.deleteSession(await sha256Hex(sid));
    return json(200, { ok: true }, { 'set-cookie': sessionCookie(config.cookieName, '', { maxAgeSec: 0, secure: config.secureCookie }) });
  }

  async function deleteAccount(request) {
    const user = await currentUser(request);
    if (!user) return json(401, { error: 'Sign in first.' });
    if (store.isPro(user, now()) && user.sub_status !== 'canceled') return json(409, { error: 'Cancel your plan in Billing first, then delete the account.' });
    await store.deleteUser(user.id);
    return json(200, { ok: true }, { 'set-cookie': sessionCookie(config.cookieName, '', { maxAgeSec: 0, secure: config.secureCookie }) });
  }

  async function audit(request, ip) {
    const user = await currentUser(request);
    if (!user) return json(401, { error: 'Sign up or sign in to run an audit. Your first one is free.', signIn: true });
    if (!config.auditsEnabled) return json(503, { error: 'Audits are paused right now. Try again later.' });
    const { body, error } = await readJson(request, ['url', 'turnstileToken']);
    if (error) return error;
    if (typeof body.url !== 'string' || body.url.length > MAX_URL_LENGTH) return json(400, { error: 'Send a "url" string.' });
    const target = checkUrl(body.url, { allowBareHost: true });
    if (!target.ok) return json(400, { error: 'Enter a public website address, like example.com.' });

    const pro = store.isPro(user, now());
    const ipHash = await hash(`ip:${ip}`);
    // Limits on the person asking come first. The limits shared with other
    // people (per site, whole app per day) are counted further down, only for
    // audits that will really run, so refused requests cannot use them up.
    const limited =
      (await bindingLimit(ip)) ||
      (await limit(`audit-ip:${ipHash}`, L.auditPerIp, 10 * MIN, 'Too many audits from your connection. Try again in a few minutes.')) ||
      (await limit(`audit-user:${user.id}`, L.auditPerAccount, HOUR, 'You have run a lot of audits in the last hour. Try again later.')) ||
      (pro ? null : await humanCheck(body, ip));
    if (limited) return limited;

    // Spend the credit before the audit runs, and give it back if the audit
    // could not reach the site.
    let refund;
    let runsLeft = null;
    if (pro) {
      const claim = await store.claimRun(user);
      if (!claim.ok) {
        const renews = new Date(user.period_end).toISOString().slice(0, 10);
        return json(402, { error: `You have used this month's ${config.runsPerMonth} audits. They reset when your plan renews (${renews}).` });
      }
      runsLeft = claim.runsLeft;
      refund = () => store.refundRun(user);
    } else {
      if (user.free_used) return json(402, { error: 'Your free audit is used. Get 20 audits a month for $5.', upgrade: true });
      const freeIp = await limit(`free-ip:${ipHash}`, L.freePerIp, DAY, 'Too many free audits from your connection today.');
      if (freeIp) return freeIp;
      const emailKey = await hash(`free:${freeKeyFor(user.email)}`);
      if (!(await store.claimFree(user, emailKey, now()))) {
        return json(402, { error: 'A free audit was already used with this email address. Get 20 audits a month for $5.', upgrade: true });
      }
      refund = () => store.refundFree(user, emailKey);
    }

    const shared = await sharedLimits(target.hostname);
    if (shared) {
      await refund();
      return shared;
    }

    if (!gate.tryEnter()) {
      await refund();
      return json(503, { error: 'The audit tool is busy. Try again in a minute.' }, { 'retry-after': '30' });
    }
    // Refund rule: the credit comes back only when the start page never
    // arrived (bad address, DNS, refused, timeout), when the server is busy,
    // or when saving fails on our side. Once the site has sent its page, the
    // credit is spent even if the audit then crashes, so a page built to
    // crash or stall the parser does not get free runs.
    let report;
    try {
      report = await runAudit(target.url, deps.auditDeps());
    } catch (err) {
      const known = err instanceof AuditError && USER_ERRORS[err.code];
      if (known && !err.reachedSite) await refund().catch(() => {});
      if (known) return json(USER_ERRORS[err.code], { error: err.message, code: err.code });
      log('audit failed after the page arrived', err?.message);
      return json(500, { error: "Something went wrong while checking this site's page. The run still counts, because the page was read." });
    } finally {
      gate.leave();
    }
    let auditId;
    try {
      auditId = await store.saveAudit({ userId: user.id, url: target.url, kind: 'manual', report, now: now() });
    } catch (err) {
      await refund().catch(() => {});
      log('saving an audit failed', err?.message);
      return json(500, { error: 'Something went wrong saving the audit. Your run was not used.' });
    }
    return json(200, { auditId, runsLeft, report: pro ? report : freeReport(report, config.free) });
  }

  async function listAudits(request) {
    const user = await currentUser(request);
    if (!user) return json(401, { error: 'Sign in first.' });
    if (!store.isPro(user, now())) return json(402, { error: 'Audit history comes with the $5 plan.', upgrade: true });
    return json(200, { audits: await store.listAudits(user.id) });
  }

  async function getAudit(request, id) {
    const user = await currentUser(request);
    if (!user) return json(401, { error: 'Sign in first.' });
    if (!AUDIT_ID_RE.test(id)) return json(404, { error: 'Audit not found.' });
    const row = await store.getAudit(user.id, id);
    if (!row) return json(404, { error: 'Audit not found.' });
    const pro = store.isPro(user, now());
    return json(200, { auditId: row.id, report: pro ? row.report : freeReport(row.report, config.free) });
  }

  async function setWatch(request) {
    const user = await currentUser(request);
    if (!user) return json(401, { error: 'Sign in first.' });
    if (!store.isPro(user, now())) return json(402, { error: 'The weekly check comes with the $5 plan.', upgrade: true });
    const { body, error } = await readJson(request, ['url']);
    if (error) return error;
    if (body.url === null || body.url === '') {
      await store.setWatch(user.id, null, null);
      return json(200, { ok: true, watchUrl: null });
    }
    if (typeof body.url !== 'string' || body.url.length > MAX_URL_LENGTH) return json(400, { error: 'Send a "url" string.' });
    const target = checkUrl(body.url, { allowBareHost: true });
    if (!target.ok) return json(400, { error: 'Enter a public website address, like example.com.' });
    if (target.url === user.watch_url) return json(200, { ok: true, watchUrl: target.url });
    const limited = await limit(`watch:${user.id}`, L.watchChangesPerDay, DAY, 'You have changed the saved site a lot today. Try again tomorrow.');
    if (limited) return limited;
    // A new site is checked at the next hourly run only if no weekly check
    // ran in the last week; otherwise it waits for the usual weekly slot, so
    // changing the saved site cannot buy extra audits.
    const last = await store.lastWeeklyAt(user.id);
    const nextAt = Math.max(now(), last ? last + config.watch.everyDays * DAY : 0);
    await store.setWatch(user.id, target.url, nextAt);
    return json(200, { ok: true, watchUrl: target.url, nextCheckAt: nextAt });
  }

  async function checkout(request) {
    const user = await currentUser(request);
    if (!user) return json(401, { error: 'Sign in first.' });
    if (!deps.stripe || !config.billing) return json(503, { error: 'Payments are not set up yet.' });
    if (store.isPro(user, now())) return json(409, { error: 'You already have the plan. Use Billing to manage it.' });
    let fresh = user;
    if (!fresh.stripe_customer_id) {
      const customer = await deps.stripe.createCustomer({ email: user.email, userId: user.id });
      fresh = await store.setStripeCustomer(user.id, customer.id);
    }
    const session = await deps.stripe.createCheckoutSession({
      customer: fresh.stripe_customer_id,
      price: config.billing.priceId,
      userId: user.id,
      successUrl: `${config.appOrigin}/?paid=1`,
      cancelUrl: `${config.appOrigin}/`,
    });
    if (!isStripeUrl(session.url)) throw new Error('unexpected checkout url');
    return json(200, { url: session.url });
  }

  async function portal(request) {
    const user = await currentUser(request);
    if (!user) return json(401, { error: 'Sign in first.' });
    if (!deps.stripe || !config.billing) return json(503, { error: 'Payments are not set up yet.' });
    if (!user.stripe_customer_id) return json(404, { error: 'There is no billing account yet.' });
    const session = await deps.stripe.createPortalSession({ customer: user.stripe_customer_id, returnUrl: `${config.appOrigin}/` });
    if (!isStripeUrl(session.url)) throw new Error('unexpected portal url');
    return json(200, { url: session.url });
  }

  async function webhook(request) {
    if (!config.billing) return json(503, { error: 'Payments are not set up.' });
    const payload = await readCapped(request, WEBHOOK_MAX);
    if (payload === null) return json(413, { error: 'Too large.' });
    const ok = await verifyStripeSignature({
      payload,
      header: request.headers.get('stripe-signature'),
      secret: config.billing.webhookSecret,
      nowMs: now(),
    });
    if (!ok) return json(400, { error: 'Bad signature.' });
    let event;
    try {
      event = JSON.parse(payload);
    } catch {
      return json(400, { error: 'Bad payload.' });
    }
    if (typeof event?.id !== 'string') return json(400, { error: 'Bad payload.' });
    // A test-mode app never acts on live-mode events, and the other way round.
    if (Boolean(event.livemode) === config.billing.testMode) return json(400, { error: 'Wrong mode.' });
    if (!(await store.markEvent(event.id, now()))) return json(200, { received: true, duplicate: true });
    try {
      const change = describeEvent(event);
      if (change?.kind === 'checkout') await store.linkCheckout(change);
      if (change?.kind === 'paid' && change.customer) await store.applyPaidInvoice(change);
      if (change?.kind === 'subscription' && change.customer) await store.applySubscriptionStatus(change);
    } catch (err) {
      // Let Stripe retry later.
      await store.forgetEvent(event.id).catch(() => {});
      throw err;
    }
    return json(200, { received: true });
  }

  // --- entry points -------------------------------------------------------

  async function fetch(request, { ip = '' } = {}) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;
    try {
      if (path === '/api/stripe/webhook') return method === 'POST' ? await webhook(request) : json(405, { error: 'Use POST.' });

      if (method === 'GET') {
        if (path === '/api/me') return await me(request);
        if (path === '/api/audits') return await listAudits(request);
        if (path.startsWith('/api/audits/')) return await getAudit(request, path.slice('/api/audits/'.length));
        return json(404, { error: 'Not found.' });
      }
      if (method !== 'POST') return json(405, { error: 'Use GET or POST.' });
      // Every other POST must come from this site's own pages.
      if (!config.allowedOrigins.has(request.headers.get('origin') || '')) return json(403, { error: 'Requests from other sites are not allowed.' });

      switch (path) {
        case '/api/auth/start':
          return await authStart(request, ip);
        case '/api/auth/verify':
          return await authVerify(request, ip);
        case '/api/auth/logout':
          return await authLogout(request);
        case '/api/account/delete':
          return await deleteAccount(request);
        case '/api/audit':
          return await audit(request, ip);
        case '/api/watch':
          return await setWatch(request);
        case '/api/billing/checkout':
          return await checkout(request);
        case '/api/billing/portal':
          return await portal(request);
        default:
          return json(404, { error: 'Not found.' });
      }
    } catch (err) {
      log('request failed', path, err?.message);
      return json(500, { error: 'Something went wrong.' });
    }
  }

  // Hourly: weekly re-checks that are due, then housekeeping.
  async function scheduled() {
    const t = now();
    // Paused: due checks stay due and run once audits are switched back on.
    const due = config.auditsEnabled ? await store.dueWatches(t, config.watch.batch) : [];
    const results = await mapLimit(due, 2, async (user) => {
      if (!store.isPro(user, t)) {
        await store.setWatch(user.id, null, null);
        return 'dropped';
      }
      if (!(await store.claimWatch(user.id, user.watch_next_at, t + config.watch.everyDays * DAY))) return 'taken';
      const url = user.watch_url;
      // Weekly checks count against the same per-site and daily limits as
      // manual audits. When one is full, try again in a few hours.
      if (await sharedLimits(new URL(url).hostname)) {
        await store.setWatch(user.id, url, t + 6 * HOUR);
        return 'postponed';
      }
      try {
        const before = await store.lastAuditFor(user.id, url);
        const report = await runAudit(url, deps.auditDeps());
        await store.saveAudit({ userId: user.id, url, kind: 'weekly', report, now: now() });
        const diff = diffReports(before?.report, report);
        if (hasChanges(diff)) await mailer.send({ to: user.email, ...watchEmail({ appName: config.appName, appOrigin: config.appOrigin, url, diff }) });
        return 'checked';
      } catch (err) {
        log('weekly check failed', err?.message);
        await store.setWatch(user.id, url, t + DAY); // try again tomorrow
        return 'failed';
      }
    });
    await store.cleanup(t);
    return results;
  }

  return { fetch, scheduled, store };
}

function isStripeUrl(u) {
  try {
    const url = new URL(u);
    return url.protocol === 'https:' && (url.hostname === 'checkout.stripe.com' || url.hostname === 'billing.stripe.com');
  } catch {
    return false;
  }
}
