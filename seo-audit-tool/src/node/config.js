// Builds the audit dependencies and the app from environment variables.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createNodeNetwork } from './net.js';
import { LocalD1 } from './sqlite-d1.js';
import { createJevFromEnv } from '../core/jev.js';
import { DEFAULT_USER_AGENT } from '../core/safe-fetch.js';
import { createApp } from '../app/app.js';
import { readConfig } from '../app/config.js';
import { createMailer } from '../app/email.js';
import { createStripeClient } from '../app/stripe.js';
import { turnstileVerifier } from '../app/http.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

export function buildDeps(env = process.env) {
  const net = createNodeNetwork();
  const jev = createJevFromEnv(env);
  const limits = {};
  if (env.AUDIT_MAX_PAGES) limits.maxPages = Number(env.AUDIT_MAX_PAGES);
  return {
    net,
    jev,
    auditDeps: () => ({
      fetchImpl: net.fetchImpl,
      resolveHost: net.resolveHost,
      jev,
      limits,
      userAgent: env.AUDIT_USER_AGENT || DEFAULT_USER_AGENT,
    }),
  };
}

// The local app. Data goes in .data/local.db unless DB_FILE says otherwise
// (":memory:" keeps nothing). Sign-in links print to the terminal unless an
// email provider is set.
export function buildLocalApp(env = process.env, { port = 8787, overrides = {} } = {}) {
  const { auditDeps, net, jev } = buildDeps(env);
  const config = readConfig(env, {
    appOrigin: `http://127.0.0.1:${port}`,
    extraOrigins: [`http://localhost:${port}`],
    secureCookie: false,
    hashSalt: 'local-only',
    emailProvider: 'log',
  });
  const db = new LocalD1(env.DB_FILE || path.join(ROOT, '.data/local.db')).migrate();
  const mailer = overrides.mailer || createMailer({ ...config.email, binding: null });
  const stripe = config.billing ? createStripeClient({ secretKey: config.billing.secretKey }) : null;
  const app = createApp({
    db,
    config,
    auditDeps: overrides.auditDeps || auditDeps,
    mailer,
    stripe: overrides.stripe ?? stripe,
    verifyHuman: config.turnstileSecret ? turnstileVerifier(config.turnstileSecret, undefined, { hostname: new URL(config.appOrigin).hostname }) : undefined,
    log: (...a) => console.error('[app]', ...a),
  });
  return { app, config, db, net, jev, mailer };
}
