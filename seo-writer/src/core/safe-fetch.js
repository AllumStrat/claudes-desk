// Copied unchanged from seo-audit-tool (claudes-desk, branch claude/project-thread-5eav50).
// Keep the two copies in step until they move to a shared package.

// One guarded HTTP fetch. Follows redirects by hand so every hop is checked,
// resolves each hostname and refuses private addresses, caps the body size,
// and times out. Works with any WHATWG fetch (Node/undici or Workers).

import { checkUrl, isBlockedIp, isIpLiteral } from './url-guard.js';

export const DEFAULT_USER_AGENT =
  'AllumSEOAudit/0.1 (+https://allumstrategies.com; site audit on request)';

export class FetchError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'FetchError';
    this.code = code;
    Object.assign(this, details);
  }
}

const REDIRECT_CODES = new Set([301, 302, 303, 307, 308]);

/**
 * @param {string} inputUrl
 * @param {object} opts
 * @param {typeof fetch} opts.fetchImpl
 * @param {(host: string) => Promise<string[]>} opts.resolveHost  returns IP addresses
 * @param {number} [opts.maxRedirects]
 * @param {number} [opts.timeoutMs]   per hop
 * @param {number} [opts.maxBytes]    body cap, counted after decompression
 * @param {boolean} [opts.readBody]
 * @param {'GET'|'HEAD'} [opts.method]
 * @param {AbortSignal} [opts.signal] overall audit deadline
 */
export async function safeFetch(inputUrl, opts) {
  const {
    fetchImpl,
    resolveHost,
    maxRedirects = 5,
    timeoutMs = 8000,
    maxBytes = 2_000_000,
    readBody = true,
    method = 'GET',
    accept = 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.5',
    userAgent = DEFAULT_USER_AGENT,
    signal,
  } = opts;
  if (typeof fetchImpl !== 'function') throw new TypeError('fetchImpl is required');
  if (typeof resolveHost !== 'function') throw new TypeError('resolveHost is required');

  const chain = [];
  const started = Date.now();
  let current = inputUrl;

  for (let hop = 0; hop <= maxRedirects; hop++) {
    const checked = checkUrl(current);
    if (!checked.ok) {
      throw new FetchError('BLOCKED_URL', checked.reason, { url: current, chain });
    }
    await assertPublicHost(checked.hostname, resolveHost, current, chain);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new FetchError('TIMEOUT', 'The request timed out.')), timeoutMs);
    const signals = signal ? [controller.signal, signal] : [controller.signal];
    const combined = signals.length > 1 ? AbortSignal.any(signals) : controller.signal;

    const hopStart = Date.now();
    let res;
    try {
      res = await fetchImpl(checked.url, {
        method,
        redirect: 'manual',
        signal: combined,
        headers: {
          'user-agent': userAgent,
          accept,
          'accept-language': 'en-US,en;q=0.8',
        },
      });
    } catch (err) {
      clearTimeout(timer);
      throw toFetchError(err, combined, checked.url, chain);
    }
    const ttfbMs = Date.now() - hopStart;

    if (REDIRECT_CODES.has(res.status)) {
      const location = res.headers.get('location');
      clearTimeout(timer);
      await discard(res);
      if (!location) {
        chain.push({ url: checked.url, status: res.status, location: null });
        return finish(res, checked.url, chain, null, ttfbMs, started, false, 0);
      }
      let next;
      try {
        next = new URL(location, checked.url).toString();
      } catch {
        throw new FetchError('BAD_REDIRECT', 'The site redirected to an invalid address.', { url: checked.url, chain });
      }
      chain.push({ url: checked.url, status: res.status, location: next });
      current = next;
      continue;
    }

    try {
      let body = null;
      let truncated = false;
      let bytes = 0;
      if (readBody && method !== 'HEAD') {
        ({ body, truncated, bytes } = await readCapped(res, maxBytes));
      } else {
        await discard(res);
      }
      chain.push({ url: checked.url, status: res.status, location: null });
      return finish(res, checked.url, chain, body, ttfbMs, started, truncated, bytes);
    } catch (err) {
      throw toFetchError(err, combined, checked.url, chain);
    } finally {
      clearTimeout(timer);
    }
  }
  throw new FetchError('TOO_MANY_REDIRECTS', `More than ${maxRedirects} redirects.`, { url: current, chain });
}

async function assertPublicHost(hostname, resolveHost, url, chain) {
  if (isIpLiteral(hostname)) return; // already judged by checkUrl
  let addresses;
  try {
    addresses = await resolveHost(hostname);
  } catch (err) {
    if (err instanceof FetchError) throw err;
    throw new FetchError('DNS_FAILED', 'That domain could not be found.', { url, chain });
  }
  if (!Array.isArray(addresses) || addresses.length === 0) {
    throw new FetchError('DNS_FAILED', 'That domain could not be found.', { url, chain });
  }
  // Refuse if ANY address is private: a mixed answer is a classic rebinding trick.
  if (addresses.some((a) => isBlockedIp(a))) {
    throw new FetchError('BLOCKED_ADDRESS', 'That domain points to a private or reserved address.', { url, chain });
  }
}

function finish(res, url, chain, body, ttfbMs, started, truncated, bytes) {
  const headers = {};
  res.headers.forEach((v, k) => {
    headers[k] = v;
  });
  return {
    url,
    status: res.status,
    ok: res.status >= 200 && res.status < 300,
    headers,
    contentType: (res.headers.get('content-type') || '').toLowerCase(),
    body,
    bytes,
    truncated,
    chain,
    timing: { ttfbMs, totalMs: Date.now() - started },
  };
}

async function readCapped(res, maxBytes) {
  if (!res.body) {
    const text = await res.text();
    return { body: text.slice(0, maxBytes), truncated: text.length > maxBytes, bytes: text.length };
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: false });
  let bytes = 0;
  let out = '';
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    const room = maxBytes - bytes;
    if (value.byteLength > room) {
      out += decoder.decode(value.subarray(0, Math.max(room, 0)), { stream: true });
      bytes += Math.max(room, 0);
      truncated = true;
      await reader.cancel().catch(() => {});
      break;
    }
    bytes += value.byteLength;
    out += decoder.decode(value, { stream: true });
  }
  out += decoder.decode();
  return { body: out, truncated, bytes };
}

async function discard(res) {
  try {
    await res.body?.cancel();
  } catch {
    /* ignore */
  }
}

function toFetchError(err, signal, url, chain) {
  if (err instanceof FetchError) return Object.assign(err, { url, chain });
  if (signal?.aborted) {
    const reason = signal.reason;
    if (reason instanceof FetchError) return Object.assign(reason, { url, chain });
    return new FetchError('TIMEOUT', 'The request timed out.', { url, chain });
  }
  const code = err?.cause?.code || err?.code;
  if (code === 'EBLOCKED') {
    return new FetchError('BLOCKED_ADDRESS', 'That domain points to a private or reserved address.', { url, chain });
  }
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
    return new FetchError('DNS_FAILED', 'That domain could not be found.', { url, chain });
  }
  return new FetchError('NETWORK', 'The site could not be reached.', { url, chain });
}
