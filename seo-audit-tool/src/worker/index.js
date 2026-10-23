// Cloudflare Worker entry (not deployed). Static files come from the assets
// binding (public/); this script answers /api/* and runs the hourly cron.
// See SECURITY.md before deploying anywhere.

import { createApp } from '../app/app.js';
import { readConfig } from '../app/config.js';
import { createMailer } from '../app/email.js';
import { createStripeClient } from '../app/stripe.js';
import { json, turnstileVerifier } from '../app/http.js';
import { ConcurrencyGate } from '../core/rate-limit.js';
import { createDohResolver } from '../core/doh.js';
import { createJevFromEnv } from '../core/jev.js';
import { DEFAULT_USER_AGENT } from '../core/safe-fetch.js';

// Audits running at once in this isolate.
const gate = new ConcurrencyGate(2);

export function buildApp(env) {
  const config = readConfig(env, { emailProvider: 'cloudflare' });
  const fetchImpl = (u, init) => fetch(u, init);
  const jev = createJevFromEnv(env, { aiBinding: env.AI });
  return createApp({
    db: env.DB,
    config,
    gate,
    auditDeps: () => ({ fetchImpl, resolveHost: createDohResolver({ fetchImpl }), jev, userAgent: env.AUDIT_USER_AGENT || DEFAULT_USER_AGENT }),
    mailer: createMailer({ ...config.email, binding: env.EMAIL }),
    stripe: config.billing ? createStripeClient({ secretKey: config.billing.secretKey }) : null,
    verifyHuman: config.turnstileSecret ? turnstileVerifier(config.turnstileSecret) : undefined,
    ipLimiter: env.IP_RATE_LIMITER,
    log: (...a) => console.error(...a),
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/')) {
      if (env.ASSETS) return env.ASSETS.fetch(request);
      return new Response('Not found', { status: 404 });
    }
    let app;
    try {
      app = buildApp(env);
    } catch (err) {
      console.error('config error', err?.message);
      return json(503, { error: 'The app is not set up yet.' });
    }
    return app.fetch(request, { ip: request.headers.get('cf-connecting-ip') || '' });
  },

  async scheduled(controller, env, ctx) {
    ctx.waitUntil(buildApp(env).scheduled());
  },
};
