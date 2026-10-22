// Builds the audit dependencies from environment variables.
import { createNodeNetwork } from './net.js';
import { createJevFromEnv } from '../core/jev.js';
import { DEFAULT_USER_AGENT } from '../core/safe-fetch.js';

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
