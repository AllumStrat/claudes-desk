// Copied unchanged from seo-audit-tool (claudes-desk, branch claude/project-thread-5eav50).
// Keep the two copies in step until they move to a shared package.

// DNS over HTTPS lookup, for runtimes with no DNS API (Cloudflare Workers).
// Returns every A and AAAA address so safeFetch can refuse private answers.

const DOH_ENDPOINT = 'https://cloudflare-dns.com/dns-query';

export function createDohResolver({ fetchImpl, endpoint = DOH_ENDPOINT, timeoutMs = 4000 } = {}) {
  const fetcher = fetchImpl || globalThis.fetch;
  return async function resolveHost(hostname) {
    const lookups = await Promise.all([
      query(fetcher, endpoint, hostname, 'A', 1, timeoutMs),
      query(fetcher, endpoint, hostname, 'AAAA', 28, timeoutMs),
    ]);
    return lookups.flat();
  };
}

async function query(fetcher, endpoint, name, type, typeCode, timeoutMs) {
  const url = `${endpoint}?name=${encodeURIComponent(name)}&type=${type}`;
  const res = await fetcher(url, {
    headers: { accept: 'application/dns-json' },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`DNS lookup failed (${res.status})`);
  const data = await res.json();
  if (!Array.isArray(data.Answer)) return [];
  return data.Answer.filter((a) => a && a.type === typeCode && typeof a.data === 'string').map((a) => a.data);
}
