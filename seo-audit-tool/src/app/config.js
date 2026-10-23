// Reads app settings from environment variables (Worker vars and secrets, or
// process.env locally). Secrets are only ever read here, never hard-coded.

import { isTestKey } from './stripe.js';

const num = (v, d) => (v === undefined || v === '' || !Number.isFinite(Number(v)) ? d : Number(v));
const on = (v, d) => (v === undefined || v === '' ? d : !/^(0|false|off|no)$/i.test(String(v)));

export function readConfig(env = {}, defaults = {}) {
  const appOrigin = String(env.APP_ORIGIN || defaults.appOrigin || '').replace(/\/+$/, '');
  if (!/^https?:\/\/[^/]+$/.test(appOrigin)) throw new Error('APP_ORIGIN must be set, like https://audit.example.com');
  const hashSalt = env.HASH_SALT || defaults.hashSalt || '';
  if (!hashSalt && appOrigin.startsWith('https:')) throw new Error('HASH_SALT must be set on a public deploy');
  const secureCookie = on(env.COOKIE_SECURE, defaults.secureCookie ?? appOrigin.startsWith('https:'));

  const stripeKey = env.STRIPE_SECRET_KEY || '';
  let billing = null;
  let billingProblem = null;
  if (stripeKey && env.STRIPE_PRICE_ID && env.STRIPE_WEBHOOK_SECRET) {
    if (!isTestKey(stripeKey) && env.STRIPE_ALLOW_LIVE !== 'yes') {
      // Test mode only until the owner says otherwise.
      billingProblem = 'live Stripe key refused (set STRIPE_ALLOW_LIVE=yes to allow it)';
    } else {
      billing = {
        secretKey: stripeKey,
        priceId: env.STRIPE_PRICE_ID,
        minAmount: num(env.STRIPE_PRICE_AMOUNT, 500), // cents a paid invoice must reach to grant runs
        webhookSecret: env.STRIPE_WEBHOOK_SECRET,
        testMode: isTestKey(stripeKey),
      };
    }
  }

  return {
    appName: env.APP_NAME || 'Allum SEO Audit',
    appOrigin,
    allowedOrigins: new Set([appOrigin, ...String(env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean), ...(defaults.extraOrigins || [])]),
    cookieName: secureCookie ? '__Host-sid' : 'sid',
    secureCookie,
    sessionDays: num(env.SESSION_DAYS, 30),
    loginMinutes: num(env.LOGIN_LINK_MINUTES, 15),
    hashSalt,
    auditsEnabled: on(env.AUDITS_ENABLED, true),
    signupsEnabled: on(env.SIGNUPS_ENABLED, true),
    turnstileSiteKey: env.TURNSTILE_SITE_KEY || '',
    turnstileSecret: env.TURNSTILE_SECRET || '',
    email: { provider: env.EMAIL_PROVIDER || defaults.emailProvider || 'log', from: env.EMAIL_FROM || 'Allum SEO Audit <audit@allumstrategies.com>', apiKey: env.RESEND_API_KEY || '' },
    billing,
    billingProblem,
    runsPerMonth: num(env.RUNS_PER_MONTH, 20),
    free: { issues: num(env.FREE_SHOW_ISSUES, 5), fixes: num(env.FREE_SHOW_FIXES, 1) },
    limits: {
      auditPerIp: num(env.AUDIT_RATE_LIMIT, 10), // per 10 minutes
      auditPerAccount: num(env.AUDITS_PER_HOUR_ACCOUNT, 10), // per hour
      auditPerTarget: num(env.AUDIT_TARGET_LIMIT, 10), // per hour, from anyone
      freePerIp: num(env.FREE_AUDITS_PER_IP_DAY, 3), // per day
      dailyCap: num(env.DAILY_AUDIT_CAP, 1000), // whole app, per day
      signinPerEmail: num(env.SIGNIN_PER_EMAIL, 3), // per 15 minutes
      signinPerIp: num(env.SIGNIN_PER_IP, 10), // per hour
      watchChangesPerDay: num(env.WATCH_CHANGES_PER_DAY, 5), // per account
      billingPerUser: num(env.BILLING_PER_10_MIN, 5), // checkout or portal, per account
      maxConcurrent: num(env.AUDIT_MAX_CONCURRENT, 2),
    },
    watch: { batch: num(env.WATCH_BATCH, 10), everyDays: 7 },
  };
}
