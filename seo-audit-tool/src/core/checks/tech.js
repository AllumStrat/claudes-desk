// Page weight, speed signals and security.
import { issue, pass } from '../findings.js';
import { listSample, plural } from '../util.js';

export function checkPerformance(ctx, r) {
  const { page, main } = ctx;
  const C = 'performance';
  const kb = Math.round(main.bytes / 1024);
  r.insight(C, 'HTML size', `${kb} KB`);
  r.insight(C, 'Time to first byte', `${main.timing.ttfbMs} ms`);
  if (main.bytes > 500_000) {
    r.add(
      issue('html-heavy', C, 'medium', {
        issue: `The HTML is very large (${kb} KB)`,
        impact: 'Big HTML slows the first render, especially on phones, and can hide content from crawlers that stop early.',
        evidence: `${kb} KB of HTML before images, scripts and styles.`,
        fix: 'Remove inlined data, huge inline scripts and unused markup. Load heavy widgets on demand.',
      }),
    );
  } else if (main.bytes > 200_000) {
    r.add(
      issue('html-large', C, 'low', {
        issue: `The HTML is large (${kb} KB)`,
        impact: 'Larger HTML takes longer to download and parse.',
        evidence: `${kb} KB of HTML.`,
        fix: 'Trim inline scripts, styles and repeated markup.',
      }),
    );
  } else {
    r.add(pass('html-size', C, `HTML size is reasonable (${kb} KB)`));
  }
  const lim = page.parseLimited;
  if (lim) {
    const at = Math.round(lim.atByte / 1024);
    r.add(
      issue('html-too-complex', C, 'medium', {
        issue: lim.reason === 'depth' ? `The HTML is nested more than ${lim.maxDepth} levels deep` : `The HTML has more than ${lim.maxElements.toLocaleString('en-US')} elements`,
        impact: 'A huge or very deep page structure is slow for browsers to lay out and for crawlers to read. Unclosed tags are the usual cause.',
        evidence: `The audit stopped reading the HTML after ${at} KB and checked only that part.`,
        fix: 'Close every tag you open, and remove repeated wrapper elements. Validate the page with the W3C validator.',
      }),
    );
  }

  const ttfb = main.timing.ttfbMs;
  if (ttfb > 1500) {
    r.add(
      issue('ttfb-slow', C, 'medium', {
        issue: `Slow server response (${ttfb} ms to first byte)`,
        impact: 'Everything else waits on the first byte, so a slow server drags down every speed metric.',
        evidence: `Measured ${ttfb} ms from the audit server.`,
        fix: 'Add page caching or a CDN, and check for slow plugins or database queries.',
      }),
    );
  } else if (ttfb > 600) {
    r.add(
      issue('ttfb-meh', C, 'low', {
        issue: `Server response could be faster (${ttfb} ms to first byte)`,
        impact: 'Under about 600 ms is a good target.',
        evidence: `Measured ${ttfb} ms from the audit server. One measurement can vary.`,
        fix: 'Cache full pages at the edge where possible.',
      }),
    );
  } else {
    r.add(pass('ttfb-ok', C, `Fast server response (${ttfb} ms)`));
  }

  const blockingScripts = page.scripts.filter((s) => s.src && s.inHead && !s.async && !s.defer && !s.module && !s.dataOnly);
  if (blockingScripts.length) {
    r.add(
      issue('render-blocking-js', C, blockingScripts.length > 2 ? 'medium' : 'low', {
        issue: `${plural(blockingScripts.length, 'render-blocking script')} in the head`,
        impact: 'The browser stops drawing the page until each of these downloads and runs.',
        evidence: listSample(blockingScripts.map((s) => s.src)),
        fix: 'Add defer (or async for independent scripts), or move them to the end of the body.',
      }),
    );
  } else {
    r.add(pass('no-blocking-js', C, 'No render-blocking scripts in the head'));
  }
  const blockingCss = page.stylesheets.filter((s) => s.inHead && /^(all|screen)/.test(s.media));
  if (blockingCss.length > 3) {
    r.add(
      issue('render-blocking-css', C, 'low', {
        issue: `${blockingCss.length} separate stylesheets block rendering`,
        impact: 'Each stylesheet is a request the browser waits on before showing anything.',
        evidence: listSample(blockingCss.map((s) => s.href)),
        fix: 'Combine stylesheets, inline the critical CSS and load the rest without blocking.',
      }),
    );
  }

  const scriptFiles = page.scripts.filter((s) => s.src).length;
  const resources = scriptFiles + page.stylesheets.length + page.images.length + page.iframes;
  r.insight(C, 'Resources referenced', `${scriptFiles} scripts, ${page.stylesheets.length} stylesheets, ${page.images.length} images, ${page.iframes} iframes`);
  if (resources > 100) {
    r.add(
      issue('many-resources', C, 'medium', {
        issue: `The page references ${resources} files`,
        impact: 'Lots of requests slow loading, especially on mobile networks.',
        evidence: `${scriptFiles} scripts, ${page.stylesheets.length} stylesheets, ${page.images.length} images, ${page.iframes} iframes.`,
        fix: 'Remove unused plugins and tags, bundle scripts, and lazy load images.',
      }),
    );
  } else if (scriptFiles > 20) {
    r.add(
      issue('many-scripts', C, 'low', {
        issue: `${scriptFiles} script files`,
        impact: 'Each script costs download and processing time on the main thread.',
        evidence: `${scriptFiles} external scripts.`,
        fix: 'Audit tags and plugins and drop the ones you no longer use.',
      }),
    );
  }
  const inlineJs = page.scripts.reduce((n, s) => n + (s.dataOnly ? 0 : s.inlineBytes), 0);
  if (inlineJs > 100_000) {
    r.add(
      issue('inline-js-heavy', C, 'low', {
        issue: `${Math.round(inlineJs / 1024)} KB of inline JavaScript`,
        impact: 'Inline scripts cannot be cached and bloat every page load.',
        evidence: `${Math.round(inlineJs / 1024)} KB inside <script> tags.`,
        fix: 'Move large inline scripts into cached external files.',
      }),
    );
  }
  if (page.iframes > 3) {
    r.add(
      issue('many-iframes', C, 'low', {
        issue: `${page.iframes} embedded iframes`,
        impact: 'Each iframe loads a whole extra page.',
        evidence: `${page.iframes} <iframe> elements.`,
        fix: 'Lazy load embeds (loading="lazy") or swap them for click-to-load previews.',
      }),
    );
  }
  const enc = main.headers['content-encoding'];
  if (!enc && main.bytes > 20_000) {
    r.add(
      issue('no-compression', C, 'low', {
        issue: 'No text compression detected',
        impact: 'Uncompressed HTML is several times larger over the wire.',
        evidence: 'The response had no Content-Encoding header.',
        fix: 'Turn on gzip or brotli compression on the server or CDN.',
      }),
    );
  }
}

const SEC_HEADERS = [
  ['strict-transport-security', 'Strict-Transport-Security'],
  ['content-security-policy', 'Content-Security-Policy'],
  ['x-content-type-options', 'X-Content-Type-Options'],
  ['referrer-policy', 'Referrer-Policy'],
];

export function checkSecurity(ctx, r) {
  const { page, main } = ctx;
  const C = 'security';
  const h = main.headers;
  const missing = SEC_HEADERS.filter(([k]) => !h[k]).map(([, label]) => label);
  if (!main.url.startsWith('https:')) {
    const i = missing.indexOf('Strict-Transport-Security');
    if (i !== -1) missing.splice(i, 1);
  }
  const framing = h['x-frame-options'] || /frame-ancestors/i.test(h['content-security-policy'] || '');
  if (!framing) missing.push('X-Frame-Options (or CSP frame-ancestors)');
  if (missing.length) {
    r.add(
      issue('security-headers', C, missing.length >= 4 ? 'medium' : 'low', {
        issue: `${plural(missing.length, 'security header')} missing`,
        impact: 'Security headers protect visitors from clickjacking, content sniffing and downgrade attacks, and show the site is well maintained.',
        evidence: `Missing: ${missing.join(', ')}.`,
        fix: 'Add these headers at the server or CDN. Start with HSTS and X-Content-Type-Options: nosniff.',
      }),
    );
  } else {
    r.add(pass('security-headers', C, 'Key security headers are present'));
  }
  const leaks = [];
  if (h['x-powered-by']) leaks.push(`X-Powered-By: ${h['x-powered-by']}`);
  if (h.server && /\d/.test(h.server)) leaks.push(`Server: ${h.server}`);
  if (leaks.length) {
    r.add(
      issue('version-leak', C, 'low', {
        issue: 'The server reveals software versions',
        impact: 'Version numbers help attackers find known holes.',
        evidence: leaks.join('; ').slice(0, 200),
        fix: 'Hide version numbers in the Server and X-Powered-By headers.',
      }),
    );
  }
  if (page && page.mixed.length) {
    r.add(
      issue('mixed-content', C, 'high', {
        issue: `${plural(page.mixed.length, 'resource')} loaded over insecure http`,
        impact: 'Browsers block or warn about insecure files on a secure page, which can break the layout and the padlock.',
        evidence: listSample(page.mixed),
        fix: 'Change these URLs to https, or remove them.',
      }),
    );
  } else if (main.url.startsWith('https:')) {
    r.add(pass('no-mixed-content', C, 'No insecure http resources on the page'));
  }
}
