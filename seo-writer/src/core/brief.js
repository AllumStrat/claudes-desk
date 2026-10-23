// The page brief: everything the writer is allowed to know about the client.
// Facts outside the brief either come back tagged [CONFIRM] or stay out.

import { checkUrl } from './url-guard.js';

export class BriefError extends Error {
  constructor(message) {
    super(message);
    this.name = 'BriefError';
  }
}

const TYPES = ['service', 'location', 'blog'];
const str = (v) => (typeof v === 'string' ? v.trim() : '');
const list = (v) => (Array.isArray(v) ? v : v == null || v === '' ? [] : [v]);

function bareDomain(site) {
  const s = str(site).replace(/^https?:\/\//i, '').replace(/\/.*$/, '').toLowerCase();
  return s.startsWith('www.') ? s.slice(4) : s;
}

/**
 * Checks and tidies a brief. Throws BriefError with a plain message when a
 * required field is missing.
 *
 * Shape (see examples/brief.example.json):
 *   client, business, site, brand?              who the page is for
 *   page: { type, subtype?, service?, place?, primary?, slug?, words_target?, notes? }
 *   facts: [{ fact, source }]                   confirmed facts only
 *   voice_of_customer: [string]                 review lines, customer questions
 *   conversion: { action, url }                 the one thing a reader should do
 *   internal_pages: [{ url, title? }]           the only internal URLs it may link
 *   external_sources?: [{ url, claim?, quote? }] sources Jacob already trusts
 *   keywords?: { primary?, variants?, secondary?, baseline? }  search data he has
 *   competitors?: [domain]   never linked;  retired_names?: [string]  never used
 *   siblings?: [{ name, url? , markdown? }]     pages to check overlap against
 *   sitemap?: boolean                           also read the site's sitemap.xml
 */
export function normalizeBrief(input) {
  if (!input || typeof input !== 'object') throw new BriefError('The brief has to be a JSON object.');
  const page = input.page || {};
  const type = str(page.type).toLowerCase();
  if (!TYPES.includes(type)) throw new BriefError(`page.type must be one of ${TYPES.join(', ')}.`);
  const site = bareDomain(input.site);
  if (!site || !checkUrl(`https://${site}/`).ok) throw new BriefError('site must be the client domain, like example.com.');
  const business = str(input.business);
  if (!business) throw new BriefError('business (the client business name) is required.');
  if (!str(page.service) && !str(page.primary) && !str(page.topic)) {
    throw new BriefError('page.service, page.topic or page.primary is required so the writer knows the search.');
  }
  if (type === 'location' && !str(page.place)) throw new BriefError('A location page needs page.place.');

  const internal = list(input.internal_pages)
    .map((p) => (typeof p === 'string' ? { url: p } : p))
    .filter((p) => p && str(p.url))
    .map((p) => ({ url: toInternalPath(str(p.url), site), title: str(p.title) }));
  const conversion = input.conversion || {};
  const conv = str(conversion.url) ? { action: str(conversion.action) || 'Contact the business', url: toInternalPath(str(conversion.url), site) } : null;
  if (conv && !internal.some((p) => p.url === conv.url)) internal.push({ url: conv.url, title: conv.action });

  const facts = list(input.facts).map((f) => (typeof f === 'string' ? { fact: f, source: '' } : { fact: str(f.fact), source: str(f.source) })).filter((f) => f.fact);

  const wt = page.words_target == null ? null : Number(page.words_target);
  if (wt != null && !Number.isFinite(wt)) throw new BriefError('page.words_target must be a number.');

  return {
    client: str(input.client) || site.split('.')[0],
    business,
    brand: str(input.brand) || business,
    site,
    page: {
      type,
      subtype: str(page.subtype),
      service: str(page.service),
      topic: str(page.topic),
      place: str(page.place),
      primary: str(page.primary),
      slug: str(page.slug),
      words_target: wt,
      notes: str(page.notes),
    },
    facts,
    voice_of_customer: list(input.voice_of_customer).map(str).filter(Boolean),
    conversion: conv,
    internal_pages: dedupeBy(internal, (p) => p.url),
    external_sources: list(input.external_sources)
      .map((s) => (typeof s === 'string' ? { url: s } : s))
      .filter((s) => s && /^https:\/\//i.test(str(s.url)))
      .map((s) => ({ url: str(s.url), claim: str(s.claim), quote: str(s.quote) })),
    keywords: {
      primary: str(input.keywords?.primary),
      variants: list(input.keywords?.variants).map(str).filter(Boolean),
      secondary: list(input.keywords?.secondary).map(str).filter(Boolean),
      baseline: list(input.keywords?.baseline),
    },
    competitors: list(input.competitors).map(bareDomain).filter(Boolean),
    retired_names: list(input.retired_names).map(str).filter(Boolean),
    siblings: list(input.siblings).filter((s) => s && (str(s.url) || str(s.markdown))).map((s) => ({ name: str(s.name) || str(s.url), url: str(s.url), markdown: s.markdown || null })),
    sitemap: input.sitemap === true,
  };
}

/** Same-site absolute URLs become paths; other hosts are refused. */
export function toInternalPath(url, site) {
  if (url.startsWith('/')) return url;
  let u;
  try {
    u = new URL(url);
  } catch {
    throw new BriefError(`Not a valid internal URL: ${url}`);
  }
  if (bareDomain(u.host) !== site) throw new BriefError(`Internal page ${url} is not on ${site}.`);
  return u.pathname + u.search;
}

function dedupeBy(arr, key) {
  const seen = new Set();
  return arr.filter((x) => (seen.has(key(x)) ? false : seen.add(key(x))));
}
