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

// Caps on what one brief may hold. A real brief is far inside them; they stop
// a pasted or hostile brief from fanning out into hundreds of fetches or a
// prompt the size of a book.
export const LIMITS = {
  external_sources: 10,
  siblings: 10,
  internal_pages: 300,
  facts: 100,
  voice_of_customer: 100,
  competitors: 50,
  retired_names: 50,
  keywords: 50, // each of keywords.variants, .secondary and .baseline
  text: 2048, // any one name, fact, review line, URL, claim or quote
  notes: 5000, // page.notes
  markdown: 60_000, // one sibling page given as Markdown
};

/** A trimmed string field, refused when it runs past its cap. */
function text(v, name, max = LIMITS.text) {
  const s = str(v);
  if (s.length > max) throw new BriefError(`${name} is ${s.length} characters long; the most is ${max}.`);
  return s;
}

/** A list field, refused when it has more entries than its cap. */
function capped(v, name, max = LIMITS[name]) {
  const xs = list(v);
  if (xs.length > max) throw new BriefError(`${name} has ${xs.length} entries; the most is ${max}.`);
  return xs;
}

/** The client's short name as it goes into file names: a-z, 0-9 and dashes only. */
export function clientSlug(v, max = 60) {
  return String(v || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max)
    .replace(/-+$/, '');
}

function bareDomain(site) {
  const s = str(site).replace(/^https?:\/\//i, '').replace(/\/.*$/, '').toLowerCase();
  return s.startsWith('www.') ? s.slice(4) : s;
}

/**
 * Checks and tidies a brief. Throws BriefError with a plain message when a
 * required field is missing.
 *
 * Shape (see examples/brief.example.json):
 *   client, business, site, brand?              who the page is for (client is cut to a-z, 0-9 and dashes)
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
  const type = text(page.type, 'page.type').toLowerCase();
  if (!TYPES.includes(type)) throw new BriefError(`page.type must be one of ${TYPES.join(', ')}.`);
  const site = bareDomain(text(input.site, 'site'));
  if (!site || !checkUrl(`https://${site}/`).ok) throw new BriefError('site must be the client domain, like example.com.');
  const business = text(input.business, 'business');
  if (!business) throw new BriefError('business (the client business name) is required.');
  const p = Object.fromEntries(['subtype', 'service', 'topic', 'place', 'primary', 'slug'].map((k) => [k, text(page[k], `page.${k}`)]));
  if (!p.service && !p.primary && !p.topic) {
    throw new BriefError('page.service, page.topic or page.primary is required so the writer knows the search.');
  }
  if (type === 'location' && !p.place) throw new BriefError('A location page needs page.place.');

  const internal = capped(input.internal_pages, 'internal_pages')
    .map((x) => (typeof x === 'string' ? { url: x } : x))
    .filter((x) => x && str(x.url))
    .map((x, i) => ({ url: toInternalPath(text(x.url, `internal_pages[${i}].url`), site), title: text(x.title, `internal_pages[${i}].title`) }));
  const conversion = input.conversion || {};
  const convUrl = text(conversion.url, 'conversion.url');
  const conv = convUrl ? { action: text(conversion.action, 'conversion.action') || 'Contact the business', url: toInternalPath(convUrl, site) } : null;
  if (conv && !internal.some((x) => x.url === conv.url)) internal.push({ url: conv.url, title: conv.action });

  const facts = capped(input.facts, 'facts')
    .map((f, i) => (typeof f === 'string' ? { fact: text(f, `facts[${i}]`), source: '' } : { fact: text(f?.fact, `facts[${i}].fact`), source: text(f?.source, `facts[${i}].source`) }))
    .filter((f) => f.fact);

  const wt = page.words_target == null ? null : Number(page.words_target);
  if (wt != null && !Number.isFinite(wt)) throw new BriefError('page.words_target must be a number.');

  const kws = input.keywords || {};
  const words = (k) => capped(kws[k], `keywords.${k}`, LIMITS.keywords).map((x, i) => text(x, `keywords.${k}[${i}]`)).filter(Boolean);
  const baseline = capped(kws.baseline, 'keywords.baseline', LIMITS.keywords);
  baseline.forEach((b, i) => text(typeof b === 'string' ? b : JSON.stringify(b) ?? '', `keywords.baseline[${i}]`));

  return {
    client: clientSlug(text(input.client, 'client')) || clientSlug(site.split('.')[0]) || 'client',
    business,
    brand: text(input.brand, 'brand') || business,
    site,
    page: { type, ...p, words_target: wt, notes: text(page.notes, 'page.notes', LIMITS.notes) },
    facts,
    voice_of_customer: capped(input.voice_of_customer, 'voice_of_customer').map((v, i) => text(v, `voice_of_customer[${i}]`)).filter(Boolean),
    conversion: conv,
    internal_pages: dedupeBy(internal, (x) => x.url),
    external_sources: capped(input.external_sources, 'external_sources')
      .map((x) => (typeof x === 'string' ? { url: x } : x))
      .filter((x) => x && /^https:\/\//i.test(str(x.url)))
      .map((x, i) => ({ url: text(x.url, `external_sources[${i}].url`), claim: text(x.claim, `external_sources[${i}].claim`), quote: text(x.quote, `external_sources[${i}].quote`) })),
    keywords: {
      primary: text(kws.primary, 'keywords.primary'),
      variants: words('variants'),
      secondary: words('secondary'),
      baseline,
    },
    competitors: capped(input.competitors, 'competitors').map((c, i) => bareDomain(text(c, `competitors[${i}]`))).filter(Boolean),
    retired_names: capped(input.retired_names, 'retired_names').map((n, i) => text(n, `retired_names[${i}]`)).filter(Boolean),
    siblings: capped(input.siblings, 'siblings')
      .filter((x) => x && (str(x.url) || str(x.markdown)))
      .map((x, i) => {
        const url = text(x.url, `siblings[${i}].url`);
        let markdown = null;
        if (typeof x.markdown === 'string' && x.markdown) {
          text(x.markdown, `siblings[${i}].markdown`, LIMITS.markdown);
          markdown = x.markdown;
        }
        return { name: text(x.name, `siblings[${i}].name`) || url, url, markdown };
      }),
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
