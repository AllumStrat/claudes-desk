import { issue, pass } from '../findings.js';
import { isAllowed, blocksEverything } from '../robots.js';
import { clip, listSample } from '../util.js';

const C = 'indexing';

export function checkIndexing(ctx, r) {
  const { main, page, robots, sitemap, httpProbe } = ctx;
  const finalUrl = main.url;

  // Status
  if (main.status >= 200 && main.status < 300) {
    r.add(pass('status-ok', C, `Page returns ${main.status}`));
  } else {
    r.add(
      issue('status-error', C, 'high', {
        issue: `The page returns HTTP ${main.status}`,
        impact: 'Search engines drop pages that do not return a 200 status, so this page cannot rank.',
        evidence: `${finalUrl} answered with status ${main.status}.`,
        fix: 'Make the URL return 200 with the real page, or redirect it with a 301 to the page that replaced it.',
      }),
    );
  }

  // Redirect chain
  const hops = main.chain.filter((h) => h.location);
  if (hops.length === 0) {
    r.add(pass('redirects-none', C, 'No redirects before the page loads'));
  } else {
    const temp = hops.filter((h) => h.status === 302 || h.status === 307);
    const path = [...hops.map((h) => `${h.url} (${h.status})`), finalUrl].join(' → ');
    if (hops.length > 1) {
      r.add(
        issue('redirect-chain', C, hops.length > 2 ? 'medium' : 'low', {
          issue: `The URL goes through ${hops.length} redirects`,
          impact: 'Each extra hop slows the page and can leak link value. Crawlers may give up on long chains.',
          evidence: clip(path, 400),
          fix: 'Point links and the old URL straight at the final address with a single 301 redirect.',
        }),
      );
    } else {
      r.add(pass('redirect-single', C, 'Only one redirect before the page loads'));
    }
    if (temp.length) {
      r.add(
        issue('redirect-temporary', C, 'low', {
          issue: 'A temporary redirect is used',
          impact: 'A 302 or 307 tells search engines the move is temporary, so they may keep the old URL indexed.',
          evidence: listSample(temp.map((h) => `${h.url} (${h.status})`)),
          fix: 'Use a 301 or 308 redirect if the move is permanent.',
        }),
      );
    }
  }

  // HTTPS
  if (finalUrl.startsWith('https:')) {
    r.add(pass('https', C, 'Page is served over HTTPS'));
    if (httpProbe) {
      if (httpProbe.error) {
        // Could not reach the http version at all; that is fine.
      } else if (!httpProbe.url.startsWith('https:')) {
        r.add(
          issue('http-not-redirected', C, 'medium', {
            issue: 'The http version of the page does not redirect to https',
            impact: 'Two copies of the site can be indexed, splitting ranking signals, and visitors can land on the insecure copy.',
            evidence: `${httpProbe.requested} answered ${httpProbe.status} without moving to https.`,
            fix: 'Add a site-wide 301 redirect from http to https.',
          }),
        );
      } else {
        r.add(pass('http-redirects', C, 'The http version redirects to https'));
      }
    }
  } else {
    r.add(
      issue('no-https', C, 'high', {
        issue: 'The page is not served over HTTPS',
        impact: 'Browsers mark the site as "Not secure" and HTTPS is a ranking signal. Visitors are less likely to trust it or submit forms.',
        evidence: `Final URL is ${finalUrl}.`,
        fix: 'Install a TLS certificate and 301 redirect every http URL to its https version.',
      }),
    );
  }

  if (!page) return;

  // Canonical
  const canon = page.canonicals.filter(Boolean);
  if (canon.length === 0) {
    r.add(
      issue('canonical-missing', C, 'medium', {
        issue: 'No canonical tag',
        impact: 'Without a canonical, search engines guess which version of the URL to index when tracking parameters or duplicates exist.',
        evidence: 'No <link rel="canonical"> found in the page.',
        fix: `Add <link rel="canonical" href="${finalUrl}"> to the head.`,
      }),
    );
  } else if (canon.length > 1 && new Set(canon).size > 1) {
    r.add(
      issue('canonical-multiple', C, 'high', {
        issue: 'More than one canonical tag, and they disagree',
        impact: 'Conflicting canonicals are usually ignored, so the page loses control over which URL is indexed.',
        evidence: listSample(canon),
        fix: 'Keep exactly one canonical tag pointing at the preferred URL.',
      }),
    );
  } else {
    let target = null;
    try {
      target = new URL(canon[0], finalUrl);
    } catch {
      /* invalid */
    }
    if (!target) {
      r.add(
        issue('canonical-invalid', C, 'high', {
          issue: 'The canonical tag is not a valid URL',
          impact: 'Search engines ignore a broken canonical.',
          evidence: clip(canon[0]),
          fix: 'Use a full absolute URL in the canonical tag.',
        }),
      );
    } else {
      const same = normalize(target.toString()) === normalize(finalUrl);
      if (!/^https?:\/\//i.test(canon[0])) {
        r.add(
          issue('canonical-relative', C, 'low', {
            issue: 'The canonical tag uses a relative URL',
            impact: 'Relative canonicals work but are easy to break when pages are copied or served on other hosts.',
            evidence: clip(canon[0]),
            fix: `Use the full URL: ${target.toString()}`,
          }),
        );
      }
      if (same) {
        r.add(pass('canonical-self', C, 'Canonical points at this page'));
      } else if (target.hostname.replace(/^www\./, '') !== new URL(finalUrl).hostname.replace(/^www\./, '')) {
        r.add(
          issue('canonical-cross-domain', C, 'high', {
            issue: 'The canonical points to a different domain',
            impact: 'This tells search engines to index the other site instead of this page.',
            evidence: `Canonical is ${clip(target.toString())}`,
            fix: 'Point the canonical at this page unless the content truly lives on that other domain.',
          }),
        );
      } else {
        r.add(
          issue('canonical-other', C, 'medium', {
            issue: 'The canonical points to a different URL',
            impact: 'Search engines will index the canonical target instead of this URL. That is right for duplicates and wrong for unique pages.',
            evidence: `Page ${clip(finalUrl)} has canonical ${clip(target.toString())}`,
            fix: 'If this page has its own content, make the canonical point at itself.',
          }),
        );
      }
    }
  }

  // Robots meta and X-Robots-Tag
  const xrt = (main.headers['x-robots-tag'] || '').toLowerCase();
  const directives = `${page.robotsMeta || ''}, ${xrt}`;
  if (/\bnoindex\b|\bnone\b/.test(directives)) {
    r.add(
      issue('noindex', C, 'high', {
        issue: 'The page tells search engines not to index it',
        impact: 'A noindex page will not appear in search results at all.',
        evidence: [page.robotsMeta && `meta robots: ${page.robotsMeta}`, xrt && `X-Robots-Tag: ${xrt}`].filter(Boolean).join('; '),
        fix: 'Remove noindex from the robots meta tag and the X-Robots-Tag header if this page should rank.',
      }),
    );
  } else {
    r.add(pass('indexable', C, 'Page allows indexing'));
  }
  if (/\bnofollow\b/.test(directives)) {
    r.add(
      issue('nofollow-page', C, 'medium', {
        issue: 'The page tells search engines not to follow its links',
        impact: 'Internal pages linked from here get no crawl path or link value from this page.',
        evidence: [page.robotsMeta && `meta robots: ${page.robotsMeta}`, xrt && `X-Robots-Tag: ${xrt}`].filter(Boolean).join('; '),
        fix: 'Remove nofollow from the page-level robots directives.',
      }),
    );
  }

  // robots.txt
  if (robots.error) {
    r.add(
      issue('robots-unreachable', C, 'low', {
        issue: 'robots.txt could not be checked',
        impact: 'If robots.txt fails with a server error, crawlers may pause crawling the whole site.',
        evidence: robots.error,
        fix: 'Make /robots.txt return 200 (or a plain 404 if you have no rules).',
      }),
    );
  } else if (robots.status >= 500) {
    r.add(
      issue('robots-5xx', C, 'high', {
        issue: `robots.txt returns a server error (${robots.status})`,
        impact: 'Crawlers treat a failing robots.txt as "do not crawl" and can stop crawling the site.',
        evidence: `${robots.url} answered ${robots.status}.`,
        fix: 'Fix the server so /robots.txt returns 200.',
      }),
    );
  } else if (robots.status !== 200 || !robots.parsed) {
    r.add(
      issue('robots-missing', C, 'low', {
        issue: 'No robots.txt file',
        impact: 'Not harmful by itself, but you lose an easy place to point crawlers at your sitemap.',
        evidence: `${robots.url} answered ${robots.status}.`,
        fix: 'Add /robots.txt with "User-agent: *", "Allow: /" and a Sitemap: line.',
      }),
    );
  } else {
    r.add(pass('robots-present', C, 'robots.txt is present'));
    const path = new URL(finalUrl).pathname + new URL(finalUrl).search;
    if (blocksEverything(robots.parsed)) {
      r.add(
        issue('robots-blocks-all', C, 'high', {
          issue: 'robots.txt blocks all crawlers from the whole site',
          impact: 'Search engines cannot crawl any page, so the site will drop out of results.',
          evidence: 'The rules for "User-agent: *" disallow "/".',
          fix: 'Remove "Disallow: /" from the User-agent: * group unless the site should be hidden.',
        }),
      );
    } else if (!isAllowed(robots.parsed, path, 'googlebot') || !isAllowed(robots.parsed, path, '*')) {
      r.add(
        issue('robots-blocks-page', C, 'high', {
          issue: 'robots.txt blocks this page',
          impact: 'Search engines will not crawl this page, so its content cannot rank.',
          evidence: `A Disallow rule in robots.txt matches ${path}.`,
          fix: 'Adjust the Disallow rules so this path is allowed.',
        }),
      );
    }
    if (robots.parsed.invalidLines > 0) {
      r.add(
        issue('robots-invalid-lines', C, 'low', {
          issue: 'robots.txt has lines crawlers will not understand',
          impact: 'Unknown lines are ignored, so rules you meant to apply may not be applied.',
          evidence: `${robots.parsed.invalidLines} line(s) are not valid robots.txt directives.`,
          fix: 'Keep to User-agent, Allow, Disallow and Sitemap lines.',
        }),
      );
    }
    if (robots.parsed.sitemaps.length === 0) {
      r.add(
        issue('robots-no-sitemap', C, 'low', {
          issue: 'robots.txt does not list a sitemap',
          impact: 'A Sitemap line helps every crawler find all your pages without being told separately.',
          evidence: 'No "Sitemap:" line in robots.txt.',
          fix: 'Add a line like "Sitemap: https://yourdomain.com/sitemap.xml".',
        }),
      );
    }
  }

  // Sitemap
  if (!sitemap || !sitemap.found) {
    r.add(
      issue('sitemap-missing', C, 'medium', {
        issue: 'No XML sitemap found',
        impact: 'A sitemap helps search engines discover every page, especially new or deep pages with few links.',
        evidence: sitemap?.tried?.length ? `Checked ${listSample(sitemap.tried)}.` : 'No sitemap location was available to check.',
        fix: 'Generate /sitemap.xml listing every indexable page and reference it in robots.txt.',
      }),
    );
  } else if (!sitemap.valid) {
    r.add(
      issue('sitemap-invalid', C, 'medium', {
        issue: 'The sitemap is not a valid XML sitemap',
        impact: 'Search engines will ignore a sitemap they cannot parse.',
        evidence: `${sitemap.url}: ${sitemap.problem}`,
        fix: 'Serve the sitemap as XML with a <urlset> or <sitemapindex> root and <loc> entries.',
      }),
    );
  } else {
    r.add(pass('sitemap-valid', C, `Sitemap found with ${sitemap.count} ${sitemap.kind === 'index' ? 'child sitemaps' : 'URLs'}`));
    if (sitemap.kind === 'urlset' && sitemap.count === 0) {
      r.add(
        issue('sitemap-empty', C, 'medium', {
          issue: 'The sitemap lists no pages',
          impact: 'An empty sitemap gives crawlers nothing to work with.',
          evidence: sitemap.url,
          fix: 'Make sure the sitemap generator includes your pages.',
        }),
      );
    }
    if (sitemap.kind === 'urlset' && sitemap.containsPage === false && !sitemap.truncated) {
      r.add(
        issue('sitemap-page-missing', C, 'low', {
          issue: 'This page is not listed in the sitemap',
          impact: 'Pages missing from the sitemap are found more slowly.',
          evidence: `${clip(finalUrl)} is not in ${sitemap.url}.`,
          fix: 'Add the page to the sitemap if it should be indexed.',
        }),
      );
    }
  }
}

export function normalize(u) {
  try {
    const x = new URL(u);
    x.hash = '';
    let s = x.toString();
    if (s.endsWith('/') && x.pathname !== '/') s = s.slice(0, -1);
    return s.toLowerCase();
  } catch {
    return u;
  }
}
