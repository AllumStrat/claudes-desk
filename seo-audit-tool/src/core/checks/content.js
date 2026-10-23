import { issue, pass } from '../findings.js';
import { clip, listSample, plural } from '../util.js';

export function checkContent(ctx, r) {
  const { page } = ctx;
  const C = 'content';
  const wc = page.wordCount;
  if (wc < 150) {
    r.add(
      issue('content-very-thin', C, 'high', {
        issue: `Very little text on the page (${wc} words)`,
        impact: 'Pages with almost no text rarely rank because there is little for search engines to match against.',
        evidence: `${wc} visible words counted.`,
        fix: 'Add useful, specific copy: what you offer, who it is for, where, proof, and answers to common questions.',
      }),
    );
  } else if (wc < 300) {
    r.add(
      issue('content-thin', C, 'medium', {
        issue: `Thin content (${wc} words)`,
        impact: 'Short pages struggle to compete with fuller pages for the same searches.',
        evidence: `${wc} visible words counted.`,
        fix: 'Expand toward 500 or more words of specific, non-filler content.',
      }),
    );
  } else {
    r.add(pass('content-length', C, `${wc} words of visible text`));
  }
  if (ctx.main.truncated) {
    r.insight(C, 'Page size', 'The HTML was larger than the audit limit, so only the first part was checked.');
  }
}

export function checkImages(ctx, r) {
  const { page, imageResults = [] } = ctx;
  const C = 'images';
  const imgs = page.images.filter((i) => i.src && !i.src.startsWith('data:'));
  if (imgs.length === 0) {
    r.add(pass('images-none', C, 'No images to check'));
    return;
  }
  const noAlt = imgs.filter((i) => !i.hasAlt);
  if (noAlt.length) {
    r.add(
      issue('img-alt-missing', C, noAlt.length / imgs.length > 0.3 ? 'medium' : 'low', {
        issue: `${plural(noAlt.length, 'image')} missing alt text`,
        impact: 'Alt text is how search engines understand images and how screen readers describe them.',
        evidence: listSample(noAlt.map((i) => i.src)),
        fix: 'Add a short alt that describes each image. Use alt="" only for purely decorative images.',
      }),
    );
  } else {
    r.add(pass('img-alt', C, 'Every image has an alt attribute'));
  }
  const noDims = imgs.filter((i) => !i.width || !i.height);
  if (noDims.length) {
    r.add(
      issue('img-dimensions', C, 'low', {
        issue: `${plural(noDims.length, 'image')} without width and height`,
        impact: 'The layout jumps as images load, which hurts the layout stability score.',
        evidence: listSample(noDims.map((i) => i.src)),
        fix: 'Set width and height attributes (or a CSS aspect-ratio) on each image.',
      }),
    );
  }
  if (imgs.length > 3) {
    const lazy = imgs.filter((i) => i.loading === 'lazy').length;
    if (lazy === 0) {
      r.add(
        issue('img-lazy', C, 'low', {
          issue: 'No images are lazy loaded',
          impact: 'Images below the fold load straight away and slow the first view.',
          evidence: `${imgs.length} images, none with loading="lazy".`,
          fix: 'Add loading="lazy" to images below the fold. Leave the main hero image eager.',
        }),
      );
    }
  }
  const heavy = imageResults.filter((x) => x.bytes && x.bytes > 300_000);
  if (heavy.length) {
    r.add(
      issue('img-heavy', C, heavy.some((x) => x.bytes > 1_000_000) ? 'medium' : 'low', {
        issue: `${plural(heavy.length, 'large image')} (over 300 KB)`,
        impact: 'Heavy images are the most common reason pages load slowly on phones.',
        evidence: listSample(heavy.map((x) => `${x.url} (${Math.round(x.bytes / 1024)} KB)`)),
        fix: 'Resize to the displayed size and compress, ideally to WebP or AVIF.',
      }),
    );
  }
  const broken = imageResults.filter((x) => x.status >= 400);
  if (broken.length) {
    r.add(
      issue('img-broken', C, 'medium', {
        issue: `${plural(broken.length, 'broken image')}`,
        impact: 'Broken images look careless and waste crawl effort.',
        evidence: listSample(broken.map((x) => `${x.url} (${x.status})`)),
        fix: 'Fix the image paths or remove the images.',
      }),
    );
  }
  const legacy = imageResults.filter((x) => /image\/(jpeg|png|gif|bmp)/.test(x.type || '') && x.bytes > 100_000);
  if (legacy.length) {
    r.add(
      issue('img-format', C, 'low', {
        issue: 'Large images use older formats',
        impact: 'WebP and AVIF are usually 25 to 50 percent smaller at the same quality.',
        evidence: listSample(legacy.map((x) => `${x.url} (${x.type})`)),
        fix: 'Serve WebP or AVIF versions of these images.',
      }),
    );
  }
}

const GENERIC_ANCHORS = new Set(['click here', 'here', 'read more', 'learn more', 'more', 'this', 'link', 'click', 'go']);

export function checkLinks(ctx, r) {
  const { page, linkResults = [] } = ctx;
  const C = 'links';
  const web = page.links.filter((l) => l.scheme === 'http' || l.scheme === 'https');
  const internal = web.filter((l) => l.internal);
  const external = web.filter((l) => !l.internal);
  r.insight(C, 'Links found', `${internal.length} internal, ${external.length} external`);

  if (internal.length < 3) {
    r.add(
      issue('links-few-internal', C, 'medium', {
        issue: `Few internal links (${internal.length})`,
        impact: 'Internal links spread ranking value and help crawlers reach your other pages.',
        evidence: `${internal.length} links to the same site found.`,
        fix: 'Link to your key service, location and contact pages from this page.',
      }),
    );
  } else {
    r.add(pass('links-internal', C, `${internal.length} internal links`));
  }

  const broken = linkResults.filter((x) => !x.crawled && (x.status >= 400 || x.error));
  if (broken.length) {
    r.add(
      issue('links-broken', C, broken.some((b) => b.internal) ? 'high' : 'medium', {
        issue: `${plural(broken.length, 'broken link')} in the sample checked`,
        impact: 'Broken links waste crawl effort, leak link value and frustrate visitors.',
        evidence: listSample(broken.map((b) => `${b.url} (${b.status || b.error})`)),
        fix: 'Update or remove these links. Redirect removed internal pages to their replacements.',
      }),
    );
  } else if (linkResults.length) {
    r.add(pass('links-ok', C, `No broken links among ${linkResults.length} checked`));
  }

  const redirected = linkResults.filter((x) => x.internal && x.redirected && x.status < 400);
  if (redirected.length) {
    r.add(
      issue('links-redirected', C, 'low', {
        issue: `${plural(redirected.length, 'internal link')} go through a redirect`,
        impact: 'Linking to redirecting URLs adds a hop for every visit and crawl.',
        evidence: listSample(redirected.map((x) => x.url)),
        fix: 'Point these links straight at the final URL.',
      }),
    );
  }

  const nofollowInternal = internal.filter((l) => /\bnofollow\b/.test(l.rel));
  if (nofollowInternal.length) {
    r.add(
      issue('links-nofollow-internal', C, 'low', {
        issue: `${plural(nofollowInternal.length, 'internal link')} marked nofollow`,
        impact: 'Nofollow on your own links stops value flowing to your own pages.',
        evidence: listSample(nofollowInternal.map((l) => l.href)),
        fix: 'Remove rel="nofollow" from internal links.',
      }),
    );
  }

  const noText = web.filter((l) => !l.text);
  if (noText.length) {
    r.add(
      issue('links-no-text', C, 'low', {
        issue: `${plural(noText.length, 'link')} with no anchor text`,
        impact: 'Anchor text tells search engines what the target page is about.',
        evidence: listSample(noText.map((l) => l.href)),
        fix: 'Give each link visible text or an aria-label.',
      }),
    );
  }
  const generic = web.filter((l) => GENERIC_ANCHORS.has(l.text.toLowerCase()));
  if (generic.length) {
    r.add(
      issue('links-generic-text', C, 'low', {
        issue: `${plural(generic.length, 'link')} with generic text like "click here"`,
        impact: 'Generic anchors waste a chance to describe the linked page.',
        evidence: listSample(generic.map((l) => `"${l.text}" → ${clip(l.href, 60)}`)),
        fix: 'Use descriptive anchors such as "brake repair in Mesa".',
      }),
    );
  }
}
