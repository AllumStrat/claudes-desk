// Turns raw HTML into the page facts the checks work from.

import { load } from 'cheerio/slim';
import { Parser } from 'htmlparser2';
import { DomHandler, Element } from 'domhandler';

// Caps on the tree one page can make the parser build. Selectors and .text()
// walk the tree, so a page nested thousands of levels deep made every check
// slow (quadratic) or overflowed the stack. Browsers stop nesting at 512
// levels and real pages stay far below these. Past a cap the parser stops and
// the audit checks the part it read, like the HTML size cap.
export const MAX_DEPTH = 256;
export const MAX_ELEMENTS = 30_000;
// JSON-LD blocks are parsed one by one; these keep one block from costing
// much memory or nesting deep enough to overflow a recursive walk.
export const MAX_JSONLD_BLOCKS = 20;
export const MAX_JSONLD_BYTES = 512_000;
export const MAX_JSONLD_DEPTH = 64;

const RESOURCE_ATTRS = [
  ['img', 'src'],
  ['img', 'srcset'],
  ['script', 'src'],
  ['link[rel~="stylesheet"]', 'href'],
  ['iframe', 'src'],
  ['video', 'src'],
  ['audio', 'src'],
  ['source', 'src'],
  ['source', 'srcset'],
  ['embed', 'src'],
  ['object', 'data'],
];

function abs(href, base) {
  if (!href) return null;
  try {
    return new URL(href.trim(), base).toString();
  } catch {
    return null;
  }
}

class StopParse extends Error {}

// DomHandler that refuses to open an element past the caps. The parser's own
// open-tag stack never grows past MAX_DEPTH either, so its per-tag stack work
// stays bounded too.
class CappedHandler extends DomHandler {
  constructor({ maxDepth, maxElements }) {
    super();
    this.maxDepth = maxDepth;
    this.maxElements = maxElements;
    this.elements = 0;
    this.limit = null;
  }
  onopentag(name, attribs) {
    const depth = this.tagStack.length; // the root counts as level 0
    if (depth > this.maxDepth) this.limit = 'depth';
    else if (++this.elements > this.maxElements) this.limit = 'elements';
    if (this.limit) throw new StopParse();
    super.onopentag(name, attribs);
  }
}

// Parses HTML the way cheerio/slim does (htmlparser2), within the caps.
// Returns the document and, when a cap stopped it, where.
export function parseHtml(html, { maxDepth = MAX_DEPTH, maxElements = MAX_ELEMENTS } = {}) {
  const handler = new CappedHandler({ maxDepth, maxElements });
  const parser = new Parser(handler);
  try {
    parser.end(html);
  } catch (err) {
    if (!(err instanceof StopParse)) throw err;
  }
  const limited = handler.limit ? { reason: handler.limit, maxDepth, maxElements, atByte: parser.startIndex } : null;
  // Cheerio starts every $(selector) from the document's top-level nodes and
  // de-duplicates them in quadratic time, so 20,000 tags at the top level made
  // each selector slow. One wrapper element keeps that list at one node. Its
  // name is not an HTML tag, so no selector the checks use can match it.
  const { root } = handler;
  const wrapper = new Element('x-audit-page', {}, root.children);
  for (const child of wrapper.children) child.parent = wrapper;
  wrapper.parent = root;
  root.children = [wrapper];
  return { root, limited };
}

// Linear check for <!doctype html> after any leading whitespace and comments.
// (A regex with a repeated comment group backtracked exponentially here.)
export function hasHtmlDoctype(html) {
  let i = 0;
  for (;;) {
    while (i < html.length && /\s/.test(html[i])) i++;
    if (!html.startsWith('<!--', i)) break;
    const end = html.indexOf('-->', i + 4);
    if (end === -1) return false;
    i = end + 3;
  }
  return html.slice(i, i + 14).toLowerCase() === '<!doctype html';
}

// Deepest [ or { nesting in a JSON text, ignoring brackets inside strings.
export function jsonDepth(text) {
  let depth = 0;
  let max = 0;
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (inString) {
      if (c === 92) i++; // backslash: skip the escaped character
      else if (c === 34) inString = false;
    } else if (c === 34) inString = true;
    else if (c === 91 || c === 123) max = Math.max(max, ++depth);
    else if (c === 93 || c === 125) depth--;
  }
  return max;
}

function readJsonLd(raw) {
  if (raw.length > MAX_JSONLD_BYTES) return { ok: false, error: `The block is over ${MAX_JSONLD_BYTES / 1000} KB, so it was not read.`, raw: raw.slice(0, 200) };
  if (jsonDepth(raw) > MAX_JSONLD_DEPTH) return { ok: false, error: `The block is nested over ${MAX_JSONLD_DEPTH} levels deep, so it was not read.`, raw: raw.slice(0, 200) };
  try {
    return { ok: true, data: JSON.parse(raw) };
  } catch (err) {
    return { ok: false, error: String(err.message || err).slice(0, 200), raw: raw.slice(0, 200) };
  }
}

// Lists use toArray().map(), not Cheerio's .map(), which copies its result
// array once per element (quadratic on a page with many links).
export function extractPage(html, pageUrl) {
  const parsed = parseHtml(html || '');
  const $ = load(parsed.root);
  const baseHref = $('base[href]').first().attr('href');
  const base = abs(baseHref, pageUrl) || pageUrl;
  const host = new URL(pageUrl).hostname.replace(/^www\./, '');

  const meta = (name) =>
    $(`meta[name="${name}" i]`).first().attr('content')?.trim() ?? null;
  const prop = (p) => $(`meta[property="${p}" i]`).first().attr('content')?.trim() ?? null;

  const titles = $('head title, title').toArray().map((el) => $(el).text().trim());
  const descriptions = $('meta[name="description" i]').toArray().map((el) => ($(el).attr('content') || '').trim());
  const canonicals = $('link[rel~="canonical" i]').toArray().map((el) => $(el).attr('href') || '');

  const headings = $('h1, h2, h3, h4, h5, h6')
    .toArray()
    .map((el) => ({ level: Number(el.tagName.slice(1)), text: $(el).text().replace(/\s+/g, ' ').trim() }));

  const images = $('img')
    .toArray()
    .map((el) => {
      const $el = $(el);
      const src = $el.attr('src') || $el.attr('data-src') || '';
      return {
        src,
        abs: abs(src, base),
        hasAlt: $el.attr('alt') !== undefined,
        alt: ($el.attr('alt') || '').trim(),
        width: $el.attr('width') || null,
        height: $el.attr('height') || null,
        loading: ($el.attr('loading') || '').toLowerCase() || null,
      };
    });

  const links = $('a[href]')
    .toArray()
    .map((el) => {
      const $el = $(el);
      const href = ($el.attr('href') || '').trim();
      const absolute = abs(href, base);
      let internal = false;
      let scheme = null;
      if (absolute) {
        const u = new URL(absolute);
        scheme = u.protocol.replace(':', '');
        internal = u.hostname.replace(/^www\./, '') === host;
      }
      const text = $el.text().replace(/\s+/g, ' ').trim() || ($el.find('img[alt]').attr('alt') || '').trim() || ($el.attr('aria-label') || '').trim();
      return { href, abs: absolute, scheme, internal, text, rel: ($el.attr('rel') || '').toLowerCase() };
    });

  const jsonld = $('script[type="application/ld+json" i]')
    .slice(0, MAX_JSONLD_BLOCKS)
    .toArray()
    .map((el) => readJsonLd($(el).text()));
  const microdataTypes = $('[itemscope][itemtype]').toArray().map((el) => $(el).attr('itemtype'));

  const hreflang = $('link[rel~="alternate" i][hreflang]')
    .toArray()
    .map((el) => ({ lang: ($(el).attr('hreflang') || '').trim(), href: $(el).attr('href') || '', abs: abs($(el).attr('href'), base) }));

  const scripts = $('script')
    .toArray()
    .map((el) => {
      const $el = $(el);
      const type = ($el.attr('type') || '').toLowerCase();
      return {
        src: $el.attr('src') ? abs($el.attr('src'), base) : null,
        async: $el.attr('async') !== undefined,
        defer: $el.attr('defer') !== undefined,
        module: type === 'module',
        dataOnly: type !== '' && !/javascript|module|ecmascript/.test(type),
        inHead: $el.parents('head').length > 0,
        inlineBytes: $el.attr('src') ? 0 : $el.text().length,
      };
    });

  const stylesheets = $('link[rel~="stylesheet" i]')
    .toArray()
    .map((el) => ({
      href: abs($(el).attr('href'), base),
      inHead: $(el).parents('head').length > 0,
      media: ($(el).attr('media') || 'all').toLowerCase(),
    }));

  // Resources loaded over plain http on an https page (mixed content).
  const mixed = [];
  if (pageUrl.startsWith('https:')) {
    for (const [sel, attr] of RESOURCE_ATTRS) {
      $(sel).each((_, el) => {
        const v = ($(el).attr(attr) || '').trim();
        const candidates = attr === 'srcset' ? v.split(',').map((s) => s.trim().split(/\s+/)[0]) : [v];
        for (const c of candidates) if (/^http:\/\//i.test(c)) mixed.push(c);
      });
    }
  }

  const htmlTag = $('html').first();
  const charsetMeta =
    $('meta[charset]').first().attr('charset') ||
    ($('meta[http-equiv="content-type" i]').attr('content') || '').match(/charset=([\w-]+)/i)?.[1] ||
    null;

  // Visible text: drop non-content elements before counting words.
  const $text = load(parseHtml(html || '').root);
  $text('script, style, noscript, template, svg, iframe').remove();
  const bodyText = $text('body').text().replace(/\s+/g, ' ').trim();
  const mainText = ($text('main').text() || $text('article').text() || '').replace(/\s+/g, ' ').trim();
  const words = bodyText ? bodyText.split(' ').filter((w) => /[\p{L}\p{N}]/u.test(w)) : [];

  const telLinks = $('a[href^="tel:" i]').toArray().map((el) => ($(el).attr('href') || '').slice(4));
  const buttons = $('a, button')
    .toArray()
    .map((el) => $(el).text().replace(/\s+/g, ' ').trim())
    .filter((t) => t && t.length <= 40);

  return {
    url: pageUrl,
    titles,
    title: titles[0] ?? null,
    descriptions,
    description: descriptions[0] ?? null,
    canonicals,
    robotsMeta: [meta('robots'), meta('googlebot')].filter(Boolean).join(', ').toLowerCase() || null,
    headings,
    images,
    links,
    og: {
      title: prop('og:title'),
      description: prop('og:description'),
      image: prop('og:image'),
      url: prop('og:url'),
      type: prop('og:type'),
      siteName: prop('og:site_name'),
    },
    twitter: {
      card: meta('twitter:card') || prop('twitter:card'),
      title: meta('twitter:title') || prop('twitter:title'),
      description: meta('twitter:description') || prop('twitter:description'),
      image: meta('twitter:image') || prop('twitter:image'),
    },
    jsonld,
    microdataTypes,
    hreflang,
    lang: htmlTag.attr('lang')?.trim() || null,
    viewport: meta('viewport'),
    charset: charsetMeta,
    hasDoctype: hasHtmlDoctype(html || ''),
    favicon: $('link[rel~="icon" i], link[rel="shortcut icon" i], link[rel~="apple-touch-icon" i]').length > 0,
    scripts,
    stylesheets,
    iframes: $('iframe').length,
    fontPreloads: $('link[rel~="preload" i][as="font" i]').length,
    mixed,
    bodyText,
    mainText,
    wordCount: words.length,
    telLinks,
    buttons,
    htmlBytes: (html || '').length,
    parseLimited: parsed.limited,
  };
}
