// Checks across the small set of pages crawled from the start page.
import { issue, pass } from '../findings.js';
import { listSample, plural } from '../util.js';

function dupes(pages, key) {
  const map = new Map();
  for (const p of pages) {
    const original = (p[key] || '').trim();
    const v = original.toLowerCase();
    if (!v) continue;
    if (!map.has(v)) map.set(v, { text: original, urls: [] });
    map.get(v).urls.push(p.url);
  }
  return [...map.values()].filter((d) => d.urls.length > 1).map((d) => [d.text, d.urls]);
}

export function checkSite(ctx, r) {
  const errors = (ctx.crawl || []).filter((p) => p.status >= 400 || p.error);
  if (errors.length) {
    r.add(
      issue('crawl-errors', 'links', 'high', {
        issue: `${plural(errors.length, 'internal link')} lead to error pages`,
        impact: 'Internal links to error pages waste crawl budget and send visitors to dead ends.',
        evidence: listSample(errors.map((p) => `${p.url} (${p.status || p.error})`)),
        fix: 'Fix these pages or update the links pointing to them.',
      }),
    );
  }
  const pages = (ctx.crawl || []).filter((p) => p.status >= 200 && p.status < 300 && p.isHtml);
  if (pages.length < 2) return;
  const titleDupes = dupes(pages, 'title');
  if (titleDupes.length) {
    r.add(
      issue('dup-titles', 'onpage', 'medium', {
        issue: `Duplicate titles across ${plural(titleDupes.reduce((n, [, u]) => n + u.length, 0), 'page')}`,
        impact: 'Pages with the same title compete with each other and look identical in search results.',
        evidence: titleDupes.slice(0, 3).map(([t, urls]) => `"${t.slice(0, 60)}" on ${listSample(urls, 3)}`).join(' | '),
        fix: 'Give every page its own title that names its specific topic.',
      }),
    );
  } else {
    r.add(pass('unique-titles', 'onpage', `Titles are unique across ${pages.length} crawled pages`));
  }
  const descDupes = dupes(pages, 'description');
  if (descDupes.length) {
    r.add(
      issue('dup-descriptions', 'onpage', 'low', {
        issue: 'Duplicate meta descriptions across pages',
        impact: 'Repeated descriptions are usually ignored and replaced with page text.',
        evidence: descDupes.slice(0, 3).map(([d, urls]) => `"${d.slice(0, 60)}" on ${listSample(urls, 3)}`).join(' | '),
        fix: 'Write a unique description for each page.',
      }),
    );
  }
  const noTitle = pages.filter((p) => !p.title);
  if (noTitle.length) {
    r.add(
      issue('crawl-no-title', 'onpage', 'medium', {
        issue: `${plural(noTitle.length, 'crawled page')} with no title`,
        impact: 'Pages without titles rank poorly and show a bare URL in results.',
        evidence: listSample(noTitle.map((p) => p.url)),
        fix: 'Add a unique title to each of these pages.',
      }),
    );
  }
  const noH1 = pages.filter((p) => p.h1Count === 0);
  if (noH1.length) {
    r.add(
      issue('crawl-no-h1', 'onpage', 'low', {
        issue: `${plural(noH1.length, 'crawled page')} with no H1`,
        impact: 'Each page needs a main heading that states its topic.',
        evidence: listSample(noH1.map((p) => p.url)),
        fix: 'Add one H1 per page.',
      }),
    );
  }
  const thin = pages.filter((p) => p.wordCount < 200);
  if (thin.length) {
    r.add(
      issue('crawl-thin', 'content', 'low', {
        issue: `${plural(thin.length, 'crawled page')} with thin content`,
        impact: 'Thin pages across a site can drag down how search engines judge its overall quality.',
        evidence: listSample(thin.map((p) => `${p.url} (${p.wordCount} words)`)),
        fix: 'Expand, merge or noindex pages that have little unique content.',
      }),
    );
  }
  const noindex = pages.filter((p) => p.noindex);
  if (noindex.length) {
    r.insight('indexing', 'Noindex pages in crawl', listSample(noindex.map((p) => p.url)));
  }
}
