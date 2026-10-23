// Builds the paid app on an in-memory database with a fake web, a mock
// mailer and a fake Stripe, and gives tests a small browser-like client.

import { LocalD1 } from '../src/node/sqlite-d1.js';
import { createApp } from '../src/app/app.js';
import { readConfig } from '../src/app/config.js';
import { createMailer } from '../src/app/email.js';
import { hmacSha256Hex } from '../src/app/crypto.js';
import { fakeWeb, html } from './helpers.js';

export const ORIGIN = 'https://audit.test';
export const WEBHOOK_SECRET = 'whsec_test_secret';

export const GOOD_SITE = html(
  '<!doctype html><html lang="en"><head><title>Hello there friend of mine, welcome</title></head><body><h1>Hi</h1><img src="/a.png"><p>Some words here.</p></body></html>',
);

export function fakeStripe() {
  const calls = [];
  let n = 0;
  return {
    calls,
    async createCustomer(args) {
      calls.push(['customer', args]);
      return { id: `cus_${++n}` };
    },
    async createCheckoutSession(args) {
      calls.push(['checkout', args]);
      return { url: 'https://checkout.stripe.com/c/pay/cs_test_123' };
    },
    async createPortalSession(args) {
      calls.push(['portal', args]);
      return { url: 'https://billing.stripe.com/p/session/test_123' };
    },
    charges: {},
    async retrieveCharge(id) {
      calls.push(['charge', id]);
      return this.charges[id] || { id, customer: null };
    },
  };
}

export function makeApp({ env = {}, routes, verifyHuman, stripe = fakeStripe(), clock, gate } = {}) {
  const db = new LocalD1(':memory:').migrate();
  const config = readConfig({
    APP_ORIGIN: ORIGIN,
    HASH_SALT: 'test-salt',
    STRIPE_SECRET_KEY: 'sk_test_abc',
    STRIPE_PRICE_ID: 'price_test_5',
    STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET,
    ...env,
  });
  const web = fakeWeb(routes || { 'https://ok.example.com/': GOOD_SITE, 'https://other.example.com/': GOOD_SITE });
  const mailer = createMailer({ provider: 'mock', from: config.email.from });
  const time = clock || { t: Date.UTC(2026, 9, 22, 12) };
  const logs = [];
  const app = createApp({
    db,
    config,
    mailer,
    stripe,
    verifyHuman,
    gate,
    auditDeps: () => ({ fetchImpl: web.fetchImpl, resolveHost: web.resolveHost }),
    now: () => time.t,
    log: (...a) => logs.push(a.join(' ')),
  });
  return { app, db, config, web, mailer, stripe, time, logs, store: app.store };
}

export function client(ctx, { ip = '1.2.3.4', origin = ORIGIN } = {}) {
  let cookie = '';
  const send = async (method, path, body, headers = {}) => {
    const h = { ...headers };
    if (cookie) h.cookie = cookie;
    if (method === 'POST') {
      if (origin) h.origin = origin;
      h['content-type'] ??= 'application/json';
    }
    const req = new Request(`${ORIGIN}${path}`, { method, headers: h, body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body) });
    const res = await ctx.app.fetch(req, { ip });
    const set = res.headers.getSetCookie()[0];
    if (set) {
      const [pair] = set.split(';');
      cookie = /=$/.test(pair) ? '' : pair;
    }
    const text = await res.text();
    let data = null;
    try {
      data = JSON.parse(text);
    } catch {}
    return { status: res.status, data, headers: res.headers, setCookie: set };
  };
  return {
    get: (path, headers) => send('GET', path, undefined, headers),
    post: (path, body = {}, headers) => send('POST', path, body, headers),
    get cookie() {
      return cookie;
    },
    // Signs in through the emailed link, like a person would.
    async signIn(email) {
      const before = ctx.mailer.sent.length;
      const start = await send('POST', '/api/auth/start', { email });
      if (start.status !== 200) throw new Error(`sign-in start failed ${start.status} ${JSON.stringify(start.data)}`);
      const mail = ctx.mailer.sent[before];
      const token = mail.text.match(/#signin=([A-Za-z0-9_-]{43})/)[1];
      const verify = await send('POST', '/api/auth/verify', { token });
      if (verify.status !== 200) throw new Error('verify failed');
      return { token, mail };
    },
  };
}

export async function stripeEvent(ctx, event, { secret = WEBHOOK_SECRET, t = Math.floor(ctx.time.t / 1000), tamper } = {}) {
  const payload = JSON.stringify({ livemode: false, created: t, ...event });
  const sig = await hmacSha256Hex(secret, `${t}.${payload}`);
  const body = tamper ? payload.replace('"', ' "') : payload;
  const res = await ctx.app.fetch(
    new Request(`${ORIGIN}/api/stripe/webhook`, { method: 'POST', headers: { 'stripe-signature': `t=${t},v1=${sig}`, 'content-type': 'application/json' }, body }),
    { ip: '3.3.3.3' },
  );
  return { status: res.status, data: await res.json() };
}

let eventN = 0;
export const paidInvoice = (customer, periodEndSec, extra = {}) => ({
  id: `evt_${++eventN}`,
  type: 'invoice.paid',
  data: {
    object: {
      id: `in_${eventN}`,
      customer,
      billing_reason: 'subscription_cycle',
      amount_paid: 500,
      lines: { data: [{ price: { id: 'price_test_5' }, period: { start: periodEndSec - 2_592_000, end: periodEndSec } }] },
      ...extra,
    },
  },
});

export const subEvent = (type, customer, status, created, subId = 'sub_1') => ({
  id: `evt_${++eventN}`,
  type,
  created,
  data: { object: { id: subId, customer, status } },
});
