// Minimal XML sitemap validation.
import { load } from 'cheerio/slim';

export function parseSitemap(xml) {
  const text = String(xml || '').trim();
  if (!text) return { valid: false, problem: 'The file is empty.' };
  if (!text.startsWith('<')) return { valid: false, problem: 'The file is not XML (it may be compressed or an HTML page).' };
  if (/<html[\s>]/i.test(text.slice(0, 2000))) return { valid: false, problem: 'An HTML page was returned instead of XML.' };
  const $ = load(text, { xml: true });
  const urlset = $('urlset');
  const index = $('sitemapindex');
  if (urlset.length) {
    const locs = $('urlset > url > loc').map((_, el) => $(el).text().trim()).get();
    const badLocs = locs.filter((l) => !/^https?:\/\//i.test(l));
    if (badLocs.length) return { valid: false, problem: `${badLocs.length} <loc> entries are not absolute URLs.` };
    return { valid: true, kind: 'urlset', count: locs.length, locs };
  }
  if (index.length) {
    const locs = $('sitemapindex > sitemap > loc').map((_, el) => $(el).text().trim()).get();
    return { valid: true, kind: 'index', count: locs.length, locs };
  }
  return { valid: false, problem: 'No <urlset> or <sitemapindex> root element.' };
}
