import { issue, pass } from '../findings.js';
import { clip, listSample } from '../util.js';

const C = 'onpage';

export function checkOnPage(ctx, r) {
  const { page } = ctx;

  // Title
  const title = page.title;
  if (!title) {
    r.add(
      issue('title-missing', C, 'high', {
        issue: 'The page has no title tag',
        impact: 'The title is the headline of the search result and one of the strongest on-page ranking signals.',
        evidence: 'No <title> text found.',
        fix: 'Add a unique title of about 50 to 60 characters with the main keyword and the brand.',
      }),
    );
  } else {
    if (page.titles.length > 1) {
      r.add(
        issue('title-multiple', C, 'low', {
          issue: 'More than one title tag',
          impact: 'Search engines pick one, and it may not be the one you wanted.',
          evidence: listSample(page.titles),
          fix: 'Keep a single <title> in the head.',
        }),
      );
    }
    const len = title.length;
    if (len < 30) {
      r.add(
        issue('title-short', C, 'medium', {
          issue: `The title is short (${len} characters)`,
          impact: 'A short title wastes space in the search result and usually leaves out the service or location people search for.',
          evidence: `"${clip(title, 120)}"`,
          fix: 'Expand it to about 50 to 60 characters: main service, location if local, then brand.',
        }),
      );
    } else if (len > 60) {
      r.add(
        issue('title-long', C, 'low', {
          issue: `The title is long (${len} characters)`,
          impact: 'Search results cut titles off after about 60 characters, hiding the end.',
          evidence: `"${clip(title, 120)}"`,
          fix: 'Trim to about 60 characters and put the most important words first.',
        }),
      );
    } else {
      r.add(pass('title-length', C, `Title length is good (${len} characters)`));
    }
  }

  // Meta description
  const desc = page.description;
  if (!desc) {
    r.add(
      issue('description-missing', C, 'medium', {
        issue: 'No meta description',
        impact: 'Search engines write their own snippet from page text, which is often less persuasive and lowers click-through.',
        evidence: 'No <meta name="description"> found.',
        fix: 'Write a unique 120 to 160 character description that sells the click.',
      }),
    );
  } else {
    const len = desc.length;
    if (page.descriptions.length > 1) {
      r.add(
        issue('description-multiple', C, 'low', {
          issue: 'More than one meta description',
          impact: 'Search engines may use either one, or neither.',
          evidence: `${page.descriptions.length} description tags found.`,
          fix: 'Keep exactly one meta description.',
        }),
      );
    }
    if (len < 70) {
      r.add(
        issue('description-short', C, 'low', {
          issue: `The meta description is short (${len} characters)`,
          impact: 'A short description leaves room unused and is often replaced by the search engine.',
          evidence: `"${clip(desc, 200)}"`,
          fix: 'Aim for 120 to 160 characters with the offer and a reason to click.',
        }),
      );
    } else if (len > 160) {
      r.add(
        issue('description-long', C, 'low', {
          issue: `The meta description is long (${len} characters)`,
          impact: 'Descriptions are cut off at around 160 characters.',
          evidence: `"${clip(desc, 200)}"`,
          fix: 'Trim to about 155 characters and front-load the key message.',
        }),
      );
    } else {
      r.add(pass('description-length', C, `Meta description length is good (${len} characters)`));
    }
  }

  // Headings
  const h1s = page.headings.filter((h) => h.level === 1);
  if (h1s.length === 0) {
    r.add(
      issue('h1-missing', C, 'high', {
        issue: 'The page has no H1 heading',
        impact: 'The H1 tells search engines and visitors what the page is about.',
        evidence: 'No <h1> found.',
        fix: 'Add one H1 that names the page topic, ideally matching the main search phrase.',
      }),
    );
  } else if (h1s.length > 1) {
    r.add(
      issue('h1-multiple', C, 'medium', {
        issue: `The page has ${h1s.length} H1 headings`,
        impact: 'Several H1s blur the main topic of the page.',
        evidence: listSample(h1s.map((h) => `"${h.text}"`)),
        fix: 'Keep one H1 and turn the others into H2s.',
      }),
    );
  } else {
    r.add(pass('h1-single', C, 'One H1 heading'));
  }
  const empty = page.headings.filter((h) => !h.text);
  if (empty.length) {
    r.add(
      issue('headings-empty', C, 'low', {
        issue: `${empty.length} empty heading tag(s)`,
        impact: 'Empty headings confuse screen readers and the page outline.',
        evidence: listSample(empty.map((h) => `H${h.level}`)),
        fix: 'Remove empty headings or give them text.',
      }),
    );
  }
  const skips = [];
  let prev = 0;
  for (const h of page.headings) {
    if (prev && h.level > prev + 1) skips.push(`H${prev} → H${h.level} ("${clip(h.text, 40)}")`);
    prev = h.level;
  }
  if (skips.length) {
    r.add(
      issue('headings-skip', C, 'low', {
        issue: 'Heading levels are skipped',
        impact: 'A broken outline makes the page structure harder for search engines and assistive tech to follow.',
        evidence: listSample(skips, 3),
        fix: 'Step down one level at a time (H1, then H2, then H3).',
      }),
    );
  } else if (page.headings.length > 1) {
    r.add(pass('headings-order', C, 'Heading levels are in order'));
  }

  // lang, viewport, charset, doctype, favicon
  if (!page.lang) {
    r.add(
      issue('lang-missing', C, 'low', {
        issue: 'The html tag has no lang attribute',
        impact: 'Search engines and screen readers have to guess the page language.',
        evidence: 'No lang on <html>.',
        fix: 'Add lang="en-US" (or the right language) to the <html> tag.',
      }),
    );
  } else {
    r.add(pass('lang', C, `Language is declared (${page.lang})`));
  }
  if (!page.viewport) {
    r.add(
      issue('viewport-missing', C, 'high', {
        issue: 'No viewport meta tag',
        impact: 'Phones render the page zoomed out, which fails mobile-friendliness and hurts mobile rankings.',
        evidence: 'No <meta name="viewport"> found.',
        fix: 'Add <meta name="viewport" content="width=device-width, initial-scale=1">.',
      }),
    );
  } else if (!/width\s*=\s*device-width/i.test(page.viewport)) {
    r.add(
      issue('viewport-fixed', C, 'medium', {
        issue: 'The viewport is not set to the device width',
        impact: 'The page may not adapt to phone screens.',
        evidence: `viewport: ${clip(page.viewport)}`,
        fix: 'Use content="width=device-width, initial-scale=1".',
      }),
    );
  } else {
    r.add(pass('viewport', C, 'Mobile viewport is set'));
  }
  if (/user-scalable\s*=\s*(no|0)|maximum-scale\s*=\s*1(\.0)?\b/i.test(page.viewport || '')) {
    r.add(
      issue('viewport-zoom', C, 'low', {
        issue: 'The viewport stops visitors from zooming',
        impact: 'This is an accessibility failure for people who need to enlarge text.',
        evidence: `viewport: ${clip(page.viewport)}`,
        fix: 'Remove user-scalable=no and maximum-scale=1.',
      }),
    );
  }
  if (!page.charset && !/charset=/i.test(ctx.main.contentType)) {
    r.add(
      issue('charset-missing', C, 'low', {
        issue: 'No character encoding declared',
        impact: 'Browsers may show garbled characters.',
        evidence: 'No <meta charset> and no charset in the Content-Type header.',
        fix: 'Add <meta charset="utf-8"> as the first thing in the head.',
      }),
    );
  }
  if (!page.hasDoctype) {
    r.add(
      issue('doctype-missing', C, 'low', {
        issue: 'No HTML doctype',
        impact: 'Without <!doctype html> browsers use quirks mode, which can break layout.',
        evidence: 'The document does not start with <!doctype html>.',
        fix: 'Add <!doctype html> as the first line.',
      }),
    );
  }
  if (!page.favicon) {
    r.add(
      issue('favicon-missing', C, 'low', {
        issue: 'No favicon declared',
        impact: 'Search results on mobile show the site icon next to the result. A missing one looks unfinished.',
        evidence: 'No <link rel="icon"> found.',
        fix: 'Add a favicon and reference it with <link rel="icon">.',
      }),
    );
  }
}
