// The /api/audit endpoint, shared by the Node server and the Worker.
// Takes a plain request description and returns { status, body, headers }.

import { runAudit, AuditError } from './audit.js';
import { MAX_URL_LENGTH, checkUrl } from './url-guard.js';

export const MAX_BODY_BYTES = 4096;

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

const json = (status, body, headers = {}) => ({ status, body, headers });

/**
 * @param {object} cfg
 * @param {() => object} cfg.auditDeps         returns { fetchImpl, resolveHost, jev, limits, userAgent }
 * @param {{check: Function}} cfg.limiter      per-client limiter
 * @param {{check: Function}} [cfg.targetLimiter] per-target-site limiter, so the tool cannot be aimed at one site over and over
 * @param {{tryEnter: Function, leave: Function}} cfg.gate  global concurrency
 * @param {(token: string, ip: string) => Promise<boolean>} [cfg.verifyHuman]  e.g. Turnstile
 * @param {string[]} [cfg.allowedOrigins]
 */
export function createAuditHandler(cfg) {
  return async function handle(req) {
    if (req.method !== 'POST') return json(405, { error: 'Use POST.' }, { allow: 'POST' });

    if (req.origin) {
      const allowed = new Set([`https://${req.host}`, `http://${req.host}`, ...(cfg.allowedOrigins || [])]);
      if (!allowed.has(req.origin)) return json(403, { error: 'Requests from other sites are not allowed.' });
    }
    if (!/^application\/json\b/i.test(req.contentType || '')) return json(415, { error: 'Send JSON.' });
    if (typeof req.bodyText !== 'string' || byteLength(req.bodyText) > MAX_BODY_BYTES) {
      return json(413, { error: 'Request is too large.' });
    }

    let payload;
    try {
      payload = JSON.parse(req.bodyText);
    } catch {
      return json(400, { error: 'Request is not valid JSON.' });
    }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return json(400, { error: 'Request must be a JSON object.' });
    const extra = Object.keys(payload).filter((k) => k !== 'url' && k !== 'turnstileToken');
    if (extra.length) return json(400, { error: 'Unexpected fields in request.' });
    if (typeof payload.url !== 'string' || payload.url.length > MAX_URL_LENGTH) return json(400, { error: 'Send a "url" string.' });

    const verdict = cfg.limiter.check(req.ip || 'unknown');
    const limited = await verdict;
    if (!limited.allowed) {
      return json(429, { error: 'Too many audits from your connection. Try again later.' }, { 'retry-after': String(limited.retryAfterSec) });
    }

    if (cfg.targetLimiter) {
      const target = checkUrl(payload.url, { allowBareHost: true });
      if (target.ok) {
        const t = await cfg.targetLimiter.check(target.hostname.replace(/^www\./, ''));
        if (!t.allowed) {
          return json(429, { error: 'That site has been audited a lot recently. Try again later.' }, { 'retry-after': String(t.retryAfterSec) });
        }
      }
    }

    if (cfg.verifyHuman) {
      const token = typeof payload.turnstileToken === 'string' ? payload.turnstileToken.slice(0, 2048) : '';
      const human = token ? await cfg.verifyHuman(token, req.ip).catch(() => false) : false;
      if (!human) return json(403, { error: 'Please complete the check to show you are human.' });
    }

    if (!cfg.gate.tryEnter()) return json(503, { error: 'The audit tool is busy. Try again in a minute.' }, { 'retry-after': '30' });
    try {
      const report = await runAudit(payload.url, cfg.auditDeps());
      return json(200, { report });
    } catch (err) {
      if (err instanceof AuditError && USER_ERRORS[err.code]) {
        return json(USER_ERRORS[err.code], { error: err.message, code: err.code });
      }
      cfg.onError?.(err);
      return json(500, { error: 'Something went wrong running the audit.' });
    } finally {
      cfg.gate.leave();
    }
  };
}

function byteLength(s) {
  return new TextEncoder().encode(s).length;
}

// Cloudflare Turnstile server-side check.
export function turnstileVerifier(secret, fetchImpl = globalThis.fetch) {
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
    return data.success === true;
  };
}

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
