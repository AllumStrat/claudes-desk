// The one-pass scanners in check.js must match exactly what check.py's
// regexes match, and finish fast on pages built to make those regexes
// backtrack. The regexes below are the ones check.py uses.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findLinks, findImages, stripTags, stripMd, htmlMainText, htmlUnescape } from '../src/core/check.js';
import { fixture } from './helpers.js';

const LINK = /(?<!!)\[([^\]]+)\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g;
const IMAGE = /!\[[^\]]*\]\([^)]*\)/g;
const TAG = /<[^>]+>/g;

function refStripMd(text) {
  text = text.replace(/```[\s\S]*?```/g, ' ');
  text = text.replace(IMAGE, ' ');
  text = text.replace(LINK, (_, a) => a);
  text = text.replace(TAG, ' ');
  return text.replace(/[*_`>|#]/g, ' ');
}

function refHtmlMainText(raw) {
  raw = raw.replace(/<(script|style|noscript|svg|header|footer|nav)\b[\s\S]*?<\/\1>/gi, ' ');
  const m = /<main\b[\s\S]*?<\/main>/i.exec(raw);
  if (m) raw = m[0];
  return htmlUnescape(raw.replace(TAG, ' '));
}

// A small seeded generator, so a failure can be replayed.
function rng(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function gen(pieces, n, seed) {
  const r = rng(seed);
  return Array.from({ length: n }, () => pieces[Math.floor(r() * pieces.length)]).join('');
}

const MD = ['[', ']', '(', ')', '<', '>', '!', '"', ' ', '\n', 'a', 'b', '/x', '](', '](<', '![', '[a]', '(u)', ' "t"', '```', '*', '\t'];
const HTML = ['<script>', '</script>', '<SCRIPT ', '</Script>', '<style>', '</style>', '<nav>', '</nav>', '<header x>', '</header>', '<svg', '</svg>', '<noscript>', '</noscript>', '<footer>', '</footer>', '<main>', '<MAIN id=1>', '</main>', '</MAIN>', '<mainx>', '<scripts>', '<', '>', '<>', 'text ', '&amp;', '&#39;', '&nbsp;', '<p>', '</p>', '\n'];

test('findLinks and findImages match the regexes on random Markdown', () => {
  for (let seed = 1; seed <= 3000; seed++) {
    const s = gen(MD, 1 + (seed % 40), seed);
    const want = [...s.matchAll(LINK)].map((m) => ({ start: m.index, end: m.index + m[0].length, anchor: m[1], url: m[2] }));
    assert.deepEqual(findLinks(s), want, JSON.stringify(s));
    assert.deepEqual(findImages(s), [...s.matchAll(IMAGE)].map((m) => ({ start: m.index, end: m.index + m[0].length })), JSON.stringify(s));
    assert.equal(stripTags(s), s.replace(TAG, ' '), JSON.stringify(s));
    assert.equal(stripMd(s), refStripMd(s), JSON.stringify(s));
  }
});

test('htmlMainText matches the regex version on random HTML', () => {
  for (let seed = 1; seed <= 3000; seed++) {
    const s = gen(HTML, 1 + (seed % 30), seed);
    assert.equal(htmlMainText(s), refHtmlMainText(s), JSON.stringify(s));
  }
});

test('the scanners match the regexes on real drafts and pages', () => {
  const drafts = [fixture('green-draft.md'), fixture('red-draft.md')];
  for (const d of drafts) assert.equal(stripMd(d), refStripMd(d));
  const page = `<!doctype html><html><head><style>p{}</style><script>var a="</p>";</script></head><body><header><nav><a href="/">Home</a></nav></header>
<main id="c"><h1>Brakes</h1><p>Brakes are one of the most important safety features &amp; more.</p><svg><path d="M0"/></svg><noscript>x</noscript></main><footer>(c)</footer></body></html>`;
  assert.equal(htmlMainText(page), refHtmlMainText(page));
  assert.match(htmlMainText(page), /most important safety features & more/);
});

test('a 3 MB hostile page or draft is read in well under a second', () => {
  const hostile = ['<script ', '<main ', '<style ', '<', '<a', '<main <script <style x', '[', '[a](', '![', '![a](', '[a](x ', '[a](x "'];
  for (const p of hostile) {
    const s = p.repeat(Math.ceil(3_000_000 / p.length));
    const t = Date.now();
    htmlMainText(s);
    stripMd(s);
    findLinks(s);
    const ms = Date.now() - t;
    assert.ok(ms < 1000, `${JSON.stringify(p)} x 3 MB took ${ms} ms`);
  }
});
