// Cloudflare Worker entry (not deployed yet). Static files come from the
// assets binding (public/); this script only answers /api/audit.
// See SECURITY.md before deploying anywhere.

import { createAuditHandler, SECURITY_HEADERS, turnstileVerifier } from '../core/handler.js';
import { SlidingWindowLimiter, ConcurrencyGate } from '../core/rate-limit.js';
import { createDohResolver } from '../core/doh.js';
import { createJevFromEnv } from '../core/jev.js';
import { DEFAULT_USER_AGENT } from '../core/safe-fetch.js';

// Per-isolate fallbacks. Real limits must come from the Rate Limiting binding.
const localLimiter = new SlidingWindowLimiter({ limit: 5, windowMs: 10 * 60_000 });
const targetLimiter = new SlidingWindowLimiter({ limit: 10, windowMs: 60 * 60_000 });
const gate = new ConcurrencyGate(2);

export function bindingLimiter(binding) {
  return {
    async check(key) {
      const { success } = await binding.limit({ key });
      return { allowed: success, retryAfterSec: 60 };
    },
  };
}

async function readCapped(request, max) {
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

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname !== '/api/audit') {
      if (env.ASSETS) return env.ASSETS.fetch(request);
      return new Response('Not found', { status: 404, headers: SECURITY_HEADERS });
    }
    const bodyText = await readCapped(request, 4096);
    const fetchImpl = (u, init) => fetch(u, init);
    const jev = createJevFromEnv(env, { aiBinding: env.AI });
    const handle = createAuditHandler({
      auditDeps: () => ({
        fetchImpl,
        resolveHost: createDohResolver({ fetchImpl }),
        jev,
        userAgent: env.AUDIT_USER_AGENT || DEFAULT_USER_AGENT,
      }),
      limiter: env.AUDIT_RATE_LIMITER ? bindingLimiter(env.AUDIT_RATE_LIMITER) : localLimiter,
      targetLimiter,
      gate,
      verifyHuman: env.TURNSTILE_SECRET ? turnstileVerifier(env.TURNSTILE_SECRET) : undefined,
      allowedOrigins: env.ALLOWED_ORIGINS ? env.ALLOWED_ORIGINS.split(',').map((s) => s.trim()) : [],
      onError: (err) => console.error('audit error', err?.message),
    });
    const out =
      bodyText === null
        ? { status: 413, body: { error: 'Request is too large.' }, headers: {} }
        : await handle({
            method: request.method,
            host: url.host,
            origin: request.headers.get('origin') || '',
            contentType: request.headers.get('content-type') || '',
            ip: request.headers.get('cf-connecting-ip') || '',
            bodyText,
          });
    return new Response(JSON.stringify(out.body), {
      status: out.status,
      headers: { ...SECURITY_HEADERS, 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...out.headers },
    });
  },
};
