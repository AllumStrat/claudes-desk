// Stripe over plain fetch (no SDK), so the same code runs in Node and Workers.
// Only the calls this app needs: create a customer, a Checkout Session and a
// customer portal session, plus webhook signature checks.

import { hmacSha256Hex, timingSafeEqual } from './crypto.js';

const API = 'https://api.stripe.com/v1';

export class StripeError extends Error {}

// Stripe expects form encoding with bracket keys: line_items[0][price]=...
export function formEncode(obj, prefix = '', out = new URLSearchParams()) {
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (typeof v === 'object') formEncode(v, key, out);
    else out.append(key, String(v));
  }
  return out;
}

export function isTestKey(key) {
  return /^(sk|rk)_test_/.test(key || '');
}

export function createStripeClient({ secretKey, fetchImpl = globalThis.fetch }) {
  async function call(path, params, { idempotencyKey } = {}) {
    const headers = { authorization: `Bearer ${secretKey}`, 'content-type': 'application/x-www-form-urlencoded' };
    if (idempotencyKey) headers['idempotency-key'] = idempotencyKey;
    const res = await fetchImpl(`${API}${path}`, {
      method: 'POST',
      headers,
      body: formEncode(params).toString(),
      signal: AbortSignal.timeout(10_000),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new StripeError(`Stripe ${path} failed (${res.status})`);
    return data;
  }
  return {
    createCustomer: ({ email, userId }) =>
      call('/customers', { email, metadata: { user_id: userId } }, { idempotencyKey: `customer-${userId}` }),
    createCheckoutSession: ({ customer, price, userId, successUrl, cancelUrl }) =>
      call('/checkout/sessions', {
        mode: 'subscription',
        customer,
        client_reference_id: userId,
        line_items: [{ price, quantity: 1 }],
        success_url: successUrl,
        cancel_url: cancelUrl,
        subscription_data: { metadata: { user_id: userId } },
      }),
    createPortalSession: ({ customer, returnUrl }) => call('/billing_portal/sessions', { customer, return_url: returnUrl }),
  };
}

// Checks the Stripe-Signature header: t=<unix seconds>,v1=<hex HMAC>[,v1=...].
// The signed text is "<t>.<raw body>" and the key is the whole whsec_ secret.
export async function verifyStripeSignature({ payload, header, secret, toleranceSec = 300, nowMs = Date.now() }) {
  if (!secret || typeof header !== 'string' || typeof payload !== 'string') return false;
  let t = null;
  const sigs = [];
  for (const part of header.split(',')) {
    const [k, v] = part.split('=', 2).map((s) => s?.trim());
    if (k === 't' && /^\d{1,12}$/.test(v || '')) t = Number(v);
    if (k === 'v1' && /^[0-9a-f]{64}$/.test(v || '')) sigs.push(v);
  }
  if (t === null || !sigs.length) return false;
  if (Math.abs(nowMs / 1000 - t) > toleranceSec) return false;
  const expected = await hmacSha256Hex(secret, `${t}.${payload}`);
  return sigs.some((s) => timingSafeEqual(s, expected));
}

const idOf = (v) => (typeof v === 'string' ? v : v && typeof v.id === 'string' ? v.id : null);

// Turns a verified Stripe event into one change for the store, or null.
export function describeEvent(event) {
  const obj = event?.data?.object || {};
  switch (event?.type) {
    case 'checkout.session.completed':
      return { kind: 'checkout', customer: idOf(obj.customer), subscription: idOf(obj.subscription), userId: obj.client_reference_id || null };
    case 'invoice.paid': {
      // Only subscription invoices grant runs. The paid period comes from the
      // subscription line, which is the same across Stripe API versions.
      const line = (obj.lines?.data || []).find((l) => l?.period?.end) || null;
      const periodEnd = line ? Number(line.period.end) * 1000 : null;
      const isSub = Boolean(obj.subscription || obj.parent?.subscription_details || /^subscription/.test(obj.billing_reason || ''));
      if (!isSub || !periodEnd) return null;
      return { kind: 'paid', customer: idOf(obj.customer), invoiceId: obj.id, periodEnd };
    }
    case 'customer.subscription.created':
    case 'customer.subscription.updated':
    case 'customer.subscription.deleted':
      return {
        kind: 'subscription',
        customer: idOf(obj.customer),
        subscription: obj.id,
        status: event.type === 'customer.subscription.deleted' ? 'canceled' : String(obj.status || ''),
        eventAt: Number(event.created || 0) * 1000,
      };
    default:
      return null;
  }
}
