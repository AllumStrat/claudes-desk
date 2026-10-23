// Guarded network helpers for the writer: reading the client's sitemap and
// sibling pages, checking that link targets load, and verifying sources.
// Every request goes through safeFetch (copied from the audit tool), which
// refuses private addresses and checks each redirect hop.

import { safeFetch } from './safe-fetch.js';

export const WRITER_USER_AGENT = 'AllumSEOWriter/0.1 (+https://allumstrategies.com; link and source check)';
const REDIRECTS = new Set([301, 302, 303, 307, 308]);

// A source check needs the quoted line, not a whole site: 500 KB holds any
// real article and keeps a hostile page from costing much to read.
export const PAGE_MAX_BYTES = 500_000;

/**
 * @param {object} o
 * @param {typeof fetch} o.fetchImpl
 * @param {(host:string)=>Promise<string[]>} o.resolveHost
 * @param {string} [o.userAgent]
 * @param {number} [o.maxBytes]   body cap for pages (sources, siblings, sitemaps)
 */
export function createNet({ fetchImpl, resolveHost, userAgent = WRITER_USER_AGENT, maxBytes = PAGE_MAX_BYTES }) {
  const base = { fetchImpl, resolveHost, userAgent, timeoutMs: 10_000 };
  return {
    /** GET a page, following redirects. Resolves to { status, url, body }. */
    async fetchPage(url) {
      const r = await safeFetch(url, { ...base, maxBytes });
      return { status: r.status, url: r.url, body: r.body, contentType: r.contentType };
    },
    /** The first hop's status, as check.py --live reports it: [code, location or error]. */
    async status(url) {
      for (const method of ['HEAD', 'GET']) {
        try {
          const r = await safeFetch(url, { ...base, method, readBody: false });
          const first = r.chain[0];
          if (first && REDIRECTS.has(first.status)) return [first.status, first.location];
          if (method === 'HEAD' && [403, 405, 501].includes(r.status)) continue;
          return [r.status, null];
        } catch (err) {
          if (method === 'GET') return [null, String(err?.message || err).slice(0, 80)];
        }
      }
      return [null, 'no response'];
    },
  };
}

/** Page paths listed in the site's sitemap.xml (one level of sitemap index). */
export async function readSitemap(net, site, max = 300) {
  const seen = new Set();
  const paths = [];
  const locs = (xml) => [...String(xml || '').matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map((m) => m[1].replace(/&amp;/g, '&'));
  const onSite = (u) => {
    try {
      const h = new URL(u).hostname.toLowerCase().replace(/^www\./, '');
      return h === site;
    } catch {
      return false;
    }
  };
  let first;
  try {
    first = await net.fetchPage(`https://${site}/sitemap.xml`);
  } catch {
    return [];
  }
  if (first.status !== 200) return [];
  let pages = locs(first.body);
  if (/<sitemapindex/i.test(first.body || '')) {
    const children = pages.filter(onSite).slice(0, 5);
    pages = [];
    for (const child of children) {
      try {
        const r = await net.fetchPage(child);
        if (r.status === 200) pages.push(...locs(r.body));
      } catch {
        /* skip a child sitemap that will not load */
      }
    }
  }
  for (const u of pages) {
    if (!onSite(u)) continue;
    const p = new URL(u).pathname;
    if (seen.has(p)) continue;
    seen.add(p);
    paths.push(p);
    if (paths.length >= max) break;
  }
  return paths;
}
