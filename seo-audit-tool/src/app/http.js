import { parseIPv6 } from '../core/url-guard.js';

// HTTP helpers shared by the Worker and the local Node server.

// Headers sent with every response from the app.
export const SECURITY_HEADERS = {
  'content-security-policy':
    "default-src 'none'; script-src 'self' https://challenges.cloudflare.com; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-src https://challenges.cloudflare.com; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
  'permissions-policy': 'camera=(), microphone=(), geolocation=(), interest-cohort=()',
  'cross-origin-opener-policy': 'same-origin',
  'cross-origin-resource-policy': 'same-origin',
};

export function json(status, body, headers = {}) {
  const h = new Headers({ ...SECURITY_HEADERS, 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  for (const [k, v] of Object.entries(headers)) {
    if (Array.isArray(v)) for (const item of v) h.append(k, item);
    else h.set(k, v);
  }
  return new Response(JSON.stringify(body), { status, headers: h });
}

// Reads a request body up to max bytes. Returns null when it is larger,
// including chunked bodies that send no length up front.
export async function readCapped(request, max) {
  if (Number(request.headers.get('content-length') || 0) > max) return null;
  if (!request.body) return '';
  const reader = request.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const all = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    all.set(c, at);
    at += c.byteLength;
  }
  return new TextDecoder().decode(all);
}

export function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i < 1) continue;
    out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

export function sessionCookie(name, value, { maxAgeSec, secure }) {
  return [`${name}=${value}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${maxAgeSec}`, secure ? 'Secure' : null].filter(Boolean).join('; ');
}

// Cloudflare Turnstile server-side check. With `hostname`, the token must
// also have been made on that site, not on someone else's page that uses
// the same widget.
export function turnstileVerifier(secret, fetchImpl = globalThis.fetch, { hostname } = {}) {
  return async (token, ip) => {
    const form = new URLSearchParams({ secret, response: token });
    if (ip) form.set('remoteip', ip);
    const res = await fetchImpl('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      body: form,
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return false;
    const data = await res.json();
    return data.success === true && (!hostname || data.hostname === hostname);
  };
}

// The client address to key limits on. IPv6 users usually get a whole /64,
// so every address in it counts as one connection.
export function clientKey(ip) {
  const groups = parseIPv6(ip || '');
  if (!groups) return ip || '';
  if (groups.slice(0, 5).every((g) => g === 0) && groups[5] === 0xffff) return [groups[6] >> 8, groups[6] & 0xff, groups[7] >> 8, groups[7] & 0xff].join('.');
  return `${groups.slice(0, 4).map((g) => g.toString(16)).join(':')}::/64`;
}

// The visitor address behind the local server. TRUST_PROXY=1 takes the last
// X-Forwarded-For entry, the one your own proxy added (earlier entries come
// from the client and can be anything). TRUST_PROXY=cloudflare takes
// CF-Connecting-IP; use it only when the server accepts traffic from
// Cloudflare alone.
export function proxiedIp(mode, headers, socketIp) {
  if (mode === '1') {
    const hops = String(headers['x-forwarded-for'] || '').split(',').map((s) => s.trim()).filter(Boolean);
    return hops.at(-1) || socketIp;
  }
  if (mode === 'cloudflare') return String(headers['cf-connecting-ip'] || '').trim() || socketIp;
  return socketIp;
}
