// Turns raw HTML into the page facts the checks work from.

import { load } from 'cheerio/slim';

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

export function extractPage(html, pageUrl) {
  const $ = load(html || '');
  const baseHref = $('base[href]').first().attr('href');
  const base = abs(baseHref, pageUrl) || pageUrl;
  const host = new URL(pageUrl).hostname.replace(/^www\./, '');

  const meta = (name) =>
    $(`meta[name="${name}" i]`).first().attr('content')?.trim() ?? null;
  const prop = (p) => $(`meta[property="${p}" i]`).first().attr('content')?.trim() ?? null;

  const titles = $('head title, title').map((_, el) => $(el).text().trim()).get();
  const descriptions = $('meta[name="description" i]').map((_, el) => ($(el).attr('content') || '').trim()).get();
  const canonicals = $('link[rel~="canonical" i]').map((_, el) => $(el).attr('href') || '').get();

  const headings = $('h1, h2, h3, h4, h5, h6')
    .map((_, el) => ({ level: Number(el.tagName.slice(1)), text: $(el).text().replace(/\s+/g, ' ').trim() }))
    .get();

  const images = $('img')
    .map((_, el) => {
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
    })
    .get();

  const links = $('a[href]')
    .map((_, el) => {
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
    })
    .get();

  const jsonld = $('script[type="application/ld+json" i]')
    .map((_, el) => {
      const raw = $(el).text();
      try {
        return { ok: true, data: JSON.parse(raw) };
      } catch (err) {
        return { ok: false, error: String(err.message || err).slice(0, 200), raw: raw.slice(0, 200) };
      }
    })
    .get();
  const microdataTypes = $('[itemscope][itemtype]').map((_, el) => $(el).attr('itemtype')).get();

  const hreflang = $('link[rel~="alternate" i][hreflang]')
    .map((_, el) => ({ lang: ($(el).attr('hreflang') || '').trim(), href: $(el).attr('href') || '', abs: abs($(el).attr('href'), base) }))
    .get();

  const scripts = $('script')
    .map((_, el) => {
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
    })
    .get();

  const stylesheets = $('link[rel~="stylesheet" i]')
    .map((_, el) => ({
      href: abs($(el).attr('href'), base),
      inHead: $(el).parents('head').length > 0,
      media: ($(el).attr('media') || 'all').toLowerCase(),
    }))
    .get();

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
  const $text = load(html || '');
  $text('script, style, noscript, template, svg, iframe').remove();
  const bodyText = $text('body').text().replace(/\s+/g, ' ').trim();
  const mainText = ($text('main').text() || $text('article').text() || '').replace(/\s+/g, ' ').trim();
  const words = bodyText ? bodyText.split(' ').filter((w) => /[\p{L}\p{N}]/u.test(w)) : [];

  const telLinks = $('a[href^="tel:" i]').map((_, el) => ($(el).attr('href') || '').slice(4)).get();
  const buttons = $('a, button')
    .map((_, el) => $(el).text().replace(/\s+/g, ' ').trim())
    .get()
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
    hasDoctype: /^\s*(?:<!--[\s\S]*?-->\s*)*<!doctype html/i.test(html || ''),
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
  };
}
