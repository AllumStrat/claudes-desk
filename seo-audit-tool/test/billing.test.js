import test from 'node:test';
import assert from 'node:assert/strict';
import { makeApp, client, stripeEvent, paidInvoice, subEvent, fakeStripe, ORIGIN, WEBHOOK_SECRET } from './app-helpers.js';
import { verifyStripeSignature, formEncode, createStripeClient, describeEvent, isTestKey } from '../src/app/stripe.js';
import { hmacSha256Hex } from '../src/app/crypto.js';
import { readConfig } from '../src/app/config.js';

const DAY = 86400;

async function signedIn(ctx, email = 'a@example.com') {
  const c = client(ctx);
  await c.signIn(email);
  const user = await ctx.store.getUserByEmail(email);
  return { c, user };
}

test('signature check: good, wrong secret, old, tampered, missing', async () => {
  const payload = '{"id":"evt_1"}';
  const t = 1_800_000_000;
  const sig = await hmacSha256Hex('whsec_x', `${t}.${payload}`);
  const nowMs = t * 1000;
  assert.equal(await verifyStripeSignature({ payload, header: `t=${t},v1=${sig}`, secret: 'whsec_x', nowMs }), true);
  assert.equal(await verifyStripeSignature({ payload, header: `t=${t},v1=${'0'.repeat(64)},v1=${sig}`, secret: 'whsec_x', nowMs }), true);
  assert.equal(await verifyStripeSignature({ payload, header: `t=${t},v1=${sig}`, secret: 'whsec_y', nowMs }), false);
  assert.equal(await verifyStripeSignature({ payload, header: `t=${t},v1=${sig}`, secret: 'whsec_x', nowMs: nowMs + 301_000 }), false);
  assert.equal(await verifyStripeSignature({ payload: payload + ' ', header: `t=${t},v1=${sig}`, secret: 'whsec_x', nowMs }), false);
  assert.equal(await verifyStripeSignature({ payload, header: `t=${t},v0=${sig}`, secret: 'whsec_x', nowMs }), false);
  assert.equal(await verifyStripeSignature({ payload, header: null, secret: 'whsec_x', nowMs }), false);
  assert.equal(await verifyStripeSignature({ payload, header: `t=${t},v1=${sig}`, secret: '', nowMs }), false);
});

test('webhook refuses bad signatures and the wrong mode', async () => {
  const ctx = makeApp();
  const ev = paidInvoice('cus_x', Math.floor(ctx.time.t / 1000) + 30 * DAY);
  assert.equal((await stripeEvent(ctx, ev, { secret: 'whsec_wrong' })).status, 400);
  assert.equal((await stripeEvent(ctx, ev, { tamper: true })).status, 400);
  assert.equal((await stripeEvent(ctx, ev, { t: Math.floor(ctx.time.t / 1000) - 3600 })).status, 400);
  assert.equal((await stripeEvent(ctx, { ...ev, livemode: true })).status, 400);
  const get = await ctx.app.fetch(new Request(`${ORIGIN}/api/stripe/webhook`));
  assert.equal(get.status, 405);
});

test('checkout makes one Stripe customer per user and a subscription session', async () => {
  const ctx = makeApp();
  const { c, user } = await signedIn(ctx);
  const res = await c.post('/api/billing/checkout');
  assert.equal(res.status, 200);
  assert.match(res.data.url, /^https:\/\/checkout\.stripe\.com\//);
  await c.post('/api/billing/checkout');
  const customers = ctx.stripe.calls.filter(([k]) => k === 'customer');
  assert.equal(customers.length, 1);
  assert.deepEqual(customers[0][1], { email: 'a@example.com', userId: user.id });
  const [, session] = ctx.stripe.calls.find(([k]) => k === 'checkout');
  assert.equal(session.customer, 'cus_1');
  assert.equal(session.price, 'price_test_5');
  assert.equal(session.successUrl, `${ORIGIN}/?paid=1`);
  assert.equal((await client(ctx).post('/api/billing/checkout')).status, 401);
});

test('a checkout URL that is not Stripe is never passed on', async () => {
  const stripe = fakeStripe();
  stripe.createCheckoutSession = async () => ({ url: 'https://evil.example/pay' });
  const ctx = makeApp({ stripe });
  const { c } = await signedIn(ctx);
  const res = await c.post('/api/billing/checkout');
  assert.equal(res.status, 500);
  assert.doesNotMatch(JSON.stringify(res.data), /evil/);
});

test('billing is off without keys, and live keys are refused', async () => {
  const off = makeApp({ env: { STRIPE_SECRET_KEY: '' }, stripe: null });
  const { c } = await signedIn(off);
  assert.equal((await c.get('/api/me')).data.billingEnabled, false);
  assert.equal((await c.post('/api/billing/checkout')).status, 503);
  assert.equal((await stripeEvent(off, paidInvoice('cus_1', 1))).status, 503);

  const base = { APP_ORIGIN: 'https://a.test', HASH_SALT: 's', STRIPE_PRICE_ID: 'price_1', STRIPE_WEBHOOK_SECRET: 'whsec_1' };
  const live = readConfig({ ...base, STRIPE_SECRET_KEY: 'sk_live_123' });
  assert.equal(live.billing, null);
  assert.match(live.billingProblem, /live Stripe key refused/);
  assert.equal(readConfig({ ...base, STRIPE_SECRET_KEY: 'sk_live_123', STRIPE_ALLOW_LIVE: 'yes' }).billing.testMode, false);
  assert.equal(readConfig({ ...base, STRIPE_SECRET_KEY: 'rk_test_1' }).billing.testMode, true);
  assert.equal(isTestKey('sk_test_'), true);
  assert.throws(() => readConfig({ APP_ORIGIN: 'https://a.test' }), /HASH_SALT/);
  assert.throws(() => readConfig({}), /APP_ORIGIN/);
});

test('a paid invoice turns the plan on with 20 runs; a new period resets to 20', async () => {
  const ctx = makeApp({ env: { SESSION_DAYS: '90' } });
  const { c } = await signedIn(ctx);
  await c.post('/api/billing/checkout');
  const now = Math.floor(ctx.time.t / 1000);
  assert.equal((await stripeEvent(ctx, { id: 'evt_co', type: 'checkout.session.completed', data: { object: { customer: 'cus_1', subscription: 'sub_1', client_reference_id: (await ctx.store.getUserByEmail('a@example.com')).id } } })).status, 200);
  assert.equal((await stripeEvent(ctx, paidInvoice('cus_1', now + 30 * DAY))).status, 200);
  let me = (await c.get('/api/me')).data.user;
  assert.equal(me.plan, 'pro');
  assert.equal(me.runsLeft, 20);
  await c.post('/api/audit', { url: 'ok.example.com' });
  await c.post('/api/audit', { url: 'ok.example.com' });
  assert.equal((await c.get('/api/me')).data.user.runsLeft, 18);

  // Next month: back to 20, not 38.
  ctx.time.t += 30 * DAY * 1000;
  await stripeEvent(ctx, paidInvoice('cus_1', now + 60 * DAY));
  me = (await c.get('/api/me')).data.user;
  assert.equal(me.runsLeft, 20);
  const user = await ctx.store.getUserByEmail('a@example.com');
  assert.equal(user.stripe_subscription_id, 'sub_1');
});

test('a replayed event, or the same invoice again, does not add runs', async () => {
  const ctx = makeApp();
  const { c } = await signedIn(ctx);
  await c.post('/api/billing/checkout');
  const end = Math.floor(ctx.time.t / 1000) + 30 * DAY;
  const ev = paidInvoice('cus_1', end);
  await stripeEvent(ctx, ev);
  await c.post('/api/audit', { url: 'ok.example.com' });
  const dup = await stripeEvent(ctx, ev);
  assert.equal(dup.data.duplicate, true);
  await stripeEvent(ctx, { ...ev, id: 'evt_other_id_same_invoice' });
  assert.equal((await c.get('/api/me')).data.user.runsLeft, 19);
});

test('cancelling drops access and the weekly check; a late old event cannot undo it', async () => {
  const ctx = makeApp();
  const { c } = await signedIn(ctx);
  await c.post('/api/billing/checkout');
  const now = Math.floor(ctx.time.t / 1000);
  await stripeEvent(ctx, subEvent('customer.subscription.created', 'cus_1', 'active', now));
  await stripeEvent(ctx, paidInvoice('cus_1', now + 30 * DAY));
  assert.equal((await c.post('/api/watch', { url: 'ok.example.com' })).status, 200);
  await stripeEvent(ctx, subEvent('customer.subscription.deleted', 'cus_1', 'canceled', now + 100));
  let me = (await c.get('/api/me')).data.user;
  assert.equal(me.plan, 'free');
  assert.equal(me.runsLeft, 0);
  assert.equal(me.watchUrl, null);
  // An "active" update created before the cancel arrives late and is ignored.
  await stripeEvent(ctx, subEvent('customer.subscription.updated', 'cus_1', 'active', now + 50));
  // The same period's invoice arriving late does not turn the plan back on.
  await stripeEvent(ctx, paidInvoice('cus_1', now + 30 * DAY));
  me = (await c.get('/api/me')).data.user;
  assert.equal(me.plan, 'free');
  // Back on the free plan: only the free audit, cut down.
  assert.equal((await c.post('/api/audit', { url: 'ok.example.com' })).data.report.limited, true);
});

test('a late "deleted" for an old subscription does not end a new one', async () => {
  const ctx = makeApp();
  const { c } = await signedIn(ctx);
  await c.post('/api/billing/checkout');
  const now = Math.floor(ctx.time.t / 1000);
  await stripeEvent(ctx, subEvent('customer.subscription.created', 'cus_1', 'active', now + 10, 'sub_new'));
  await stripeEvent(ctx, paidInvoice('cus_1', now + 30 * DAY));
  await stripeEvent(ctx, subEvent('customer.subscription.deleted', 'cus_1', 'canceled', now + 20, 'sub_old'));
  assert.equal((await c.get('/api/me')).data.user.plan, 'pro');
});

test('unpaid ends access; paying the invoice brings it back', async () => {
  const ctx = makeApp({ env: { SESSION_DAYS: '90' } });
  const { c } = await signedIn(ctx);
  await c.post('/api/billing/checkout');
  const now = Math.floor(ctx.time.t / 1000);
  await stripeEvent(ctx, subEvent('customer.subscription.created', 'cus_1', 'active', now));
  await stripeEvent(ctx, paidInvoice('cus_1', now + 30 * DAY));
  ctx.time.t += 31 * DAY * 1000;
  await stripeEvent(ctx, subEvent('customer.subscription.updated', 'cus_1', 'past_due', now + 31 * DAY));
  assert.equal((await c.get('/api/me')).data.user.plan, 'pro'); // inside the grace days
  ctx.time.t += 4 * DAY * 1000;
  assert.equal((await c.get('/api/me')).data.user.plan, 'free'); // grace is over
  await stripeEvent(ctx, subEvent('customer.subscription.updated', 'cus_1', 'unpaid', now + 35 * DAY));
  await stripeEvent(ctx, paidInvoice('cus_1', now + 60 * DAY));
  const me = (await c.get('/api/me')).data.user;
  assert.equal(me.plan, 'pro');
  assert.equal(me.runsLeft, 20);
});

test('the portal opens only for users with a billing account', async () => {
  const ctx = makeApp();
  const { c } = await signedIn(ctx);
  assert.equal((await c.post('/api/billing/portal')).status, 404);
  await c.post('/api/billing/checkout');
  const res = await c.post('/api/billing/portal');
  assert.equal(res.status, 200);
  assert.match(res.data.url, /^https:\/\/billing\.stripe\.com\//);
});

test('a paid user cannot start a second subscription or delete the account mid-plan', async () => {
  const ctx = makeApp();
  const { c } = await signedIn(ctx);
  await c.post('/api/billing/checkout');
  await stripeEvent(ctx, paidInvoice('cus_1', Math.floor(ctx.time.t / 1000) + 30 * DAY));
  assert.equal((await c.post('/api/billing/checkout')).status, 409);
  assert.equal((await c.post('/api/account/delete')).status, 409);
});

test('the Stripe client sends form-encoded calls with the key in a header', async () => {
  const sent = [];
  const stripe = createStripeClient({
    secretKey: 'sk_test_123',
    fetchImpl: async (url, init) => {
      sent.push({ url, init });
      return Response.json({ id: 'cs_1', url: 'https://checkout.stripe.com/c/pay/x' });
    },
  });
  await stripe.createCheckoutSession({ customer: 'cus_1', price: 'price_1', userId: 'u1', successUrl: 'https://a/?paid=1', cancelUrl: 'https://a/' });
  const body = new URLSearchParams(sent[0].init.body);
  assert.equal(sent[0].url, 'https://api.stripe.com/v1/checkout/sessions');
  assert.equal(sent[0].init.headers.authorization, 'Bearer sk_test_123');
  assert.equal(body.get('mode'), 'subscription');
  assert.equal(body.get('line_items[0][price]'), 'price_1');
  assert.equal(body.get('line_items[0][quantity]'), '1');
  assert.equal(body.get('subscription_data[metadata][user_id]'), 'u1');
  await stripe.createCustomer({ email: 'a@b.co', userId: 'u1' });
  assert.equal(sent[1].init.headers['idempotency-key'], 'customer-u1');
  assert.equal(formEncode({ a: { b: [1, 2] } }).toString(), 'a%5Bb%5D%5B0%5D=1&a%5Bb%5D%5B1%5D=2');

  const failing = createStripeClient({ secretKey: 'sk_test_1', fetchImpl: async () => new Response('{}', { status: 400 }) });
  await assert.rejects(failing.createCustomer({ email: 'a@b.co', userId: 'u' }), /failed \(400\)/);
});

test('event parsing works across Stripe API versions', () => {
  const oldShape = { type: 'invoice.paid', data: { object: { id: 'in_1', customer: 'cus_1', subscription: 'sub_1', lines: { data: [{ period: { end: 100 } }] } } } };
  const newShape = { type: 'invoice.paid', data: { object: { id: 'in_1', customer: { id: 'cus_1' }, parent: { subscription_details: { subscription: 'sub_1' } }, lines: { data: [{ period: { end: 100 } }] } } } };
  for (const e of [oldShape, newShape]) assert.deepEqual(describeEvent(e), { kind: 'paid', customer: 'cus_1', invoiceId: 'in_1', periodEnd: 100_000 });
  assert.equal(describeEvent({ type: 'invoice.paid', data: { object: { id: 'in_2', customer: 'cus_1', billing_reason: 'manual', lines: { data: [] } } } }), null);
  assert.equal(describeEvent({ type: 'charge.succeeded', data: { object: {} } }), null);
  assert.equal(describeEvent(null), null);
});

test('unknown event types are acknowledged and change nothing', async () => {
  const ctx = makeApp();
  const res = await stripeEvent(ctx, { id: 'evt_unknown', type: 'payment_intent.created', data: { object: {} } });
  assert.equal(res.status, 200);
  void WEBHOOK_SECRET;
});
