// Node networking for the auditor. The address check runs a
// second time at connect time, inside the socket's DNS lookup, so a domain
// that changes its answer between check and connect (DNS rebinding) is still refused.

import dns from 'node:dns';
import { Agent, fetch as undiciFetch } from 'undici';
import { isBlockedIp } from '../core/url-guard.js';

export function createGuardedLookup(lookupFn = dns.lookup) {
  return function guardedLookup(hostname, options, callback) {
    if (typeof options === 'function') {
      callback = options;
      options = {};
    }
    lookupFn(hostname, { ...options, all: true, verbatim: true }, (err, addresses) => {
      if (err) return callback(err);
      const list = Array.isArray(addresses) ? addresses : [{ address: addresses, family: options.family || 4 }];
      if (list.length === 0 || list.some((a) => isBlockedIp(a.address))) {
        const e = new Error(`Refused to connect to a private address for ${hostname}`);
        e.code = 'EBLOCKED';
        return callback(e);
      }
      if (options.all) return callback(null, list);
      return callback(null, list[0].address, list[0].family);
    });
  };
}

export async function systemResolve(hostname) {
  const res = await dns.promises.lookup(hostname, { all: true, verbatim: true });
  return res.map((r) => r.address);
}

export function createNodeNetwork() {
  const dispatcher = new Agent({
    connect: { lookup: createGuardedLookup(), timeout: 8000 },
    headersTimeout: 10_000,
    bodyTimeout: 10_000,
    connections: 16,
  });
  const fetchImpl = (url, init = {}) => undiciFetch(url, { ...init, dispatcher });
  return { fetchImpl, resolveHost: systemResolve, mode: 'direct' };
}
