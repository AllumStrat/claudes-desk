// Hostile pages and robots.txt files. Each of these used to take seconds to
// hours, or crashed the audit; the time limits are loose on purpose.
import test from 'node:test';
import assert from 'node:assert/strict';
import { extractPage, parseHtml, hasHtmlDoctype, jsonDepth, MAX_DEPTH, MAX_ELEMENTS } from '../src/core/extract.js';
import { flattenSchema } from '../src/core/checks/rich.js';
import { runAudit } from '../src/core/audit.js';
import { fakeWeb, html } from './helpers.js';
import { capReport, MAX_REPORT_BYTES } from '../src/core/report.js';

const URL0 = 'https://a.example.com/';

function timed(fn) {
  const t = performance.now();
  const out = fn();
  return { out, ms: performance.now() - t };
}

test('the doctype check is linear (comments before it used to backtrack)', () => {
  for (const n of [30, 40, 5000]) {
    const { out, ms } = timed(() => extractPage('<!---->'.repeat(n) + '<html><body>x</body></html>', URL0));
    assert.equal(out.hasDoctype, false);
    assert.ok(ms < 1000, `${n} comments took ${ms} ms`);
  }
  assert.equal(hasHtmlDoctype('<!doctype html><html>'), true);
  assert.equal(hasHtmlDoctype('  \n<!-- a -->\n<!-- b --> <!DOCTYPE HTML PUBLIC "x">'), true);
  assert.equal(hasHtmlDoctype('﻿<!doctype html>'), true);
  assert.equal(hasHtmlDoctype('<!-- never closed <!doctype html>'), false);
  assert.equal(hasHtmlDoctype('<!--> --><!doctype html>'), true);
  assert.equal(hasHtmlDoctype('<html><!doctype html>'), false);
  assert.equal(hasHtmlDoctype(''), false);
});

test('deeply nested or huge pages finish fast and say they were cut short', () => {
  for (const unit of ['<div>', '<button>', '<a href=x>', '<h2>', '<span>']) {
    const { out, ms } = timed(() => extractPage(unit.repeat(20_000), URL0));
    assert.ok(ms < 1500, `${unit} x20000 took ${ms} ms`);
    // A new <button> closes the open one, so those end up side by side.
    assert.equal(Boolean(out.parseLimited), unit !== '<button>', unit);
  }
  const deep = parseHtml('<div>'.repeat(MAX_DEPTH + 50));
  assert.equal(deep.limited.reason, 'depth');
  const wide = parseHtml('<p>x</p>'.repeat(MAX_ELEMENTS + 10));
  assert.equal(wide.limited.reason, 'elements');
  // A closing-tag flood against a deep stack stays fast too.
  const { ms } = timed(() => extractPage('<div>'.repeat(MAX_DEPTH) + '</span>'.repeat(200_000), URL0));
  assert.ok(ms < 1500, `closing flood took ${ms} ms`);
});

test('a normal page is not cut short and reads the same', () => {
  const page = extractPage('<!doctype html><html lang="en"><head><title>T</title></head><body><h1>Hi</h1><a href="/x">Go</a><button>Buy</button></body></html>', URL0);
  assert.equal(page.parseLimited, null);
  assert.equal(page.hasDoctype, true);
  assert.equal(page.lang, 'en');
  assert.equal(page.title, 'T');
  assert.deepEqual(page.headings, [{ level: 1, text: 'Hi' }]);
  assert.deepEqual(page.buttons, ['Go', 'Buy']);
  assert.equal(page.links[0].abs, 'https://a.example.com/x');
  // A page with no <html> tag at all still works.
  const bare = extractPage('<title>Bare</title><meta name="description" content="d"><p>one two</p>', URL0);
  assert.equal(bare.title, 'Bare');
  assert.equal(bare.description, 'd');
});

test('deep JSON-LD is skipped, not a crash', () => {
  for (const depth of [5000, 500_000]) {
    const page = extractPage(`<script type="application/ld+json">${'['.repeat(depth)}${']'.repeat(depth)}</script>`, URL0);
    assert.equal(page.jsonld[0].ok, false);
    assert.match(page.jsonld[0].error, depth > 100_000 ? /over 512 KB/ : /nested over 64 levels/);
  }
  assert.equal(jsonDepth('{"a":"[[[[[[","b":[{"c":"\\"]"}]}'), 3);
  // flattenSchema itself no longer recurses.
  let data = { '@type': 'Thing' };
  for (let i = 0; i < 100_000; i++) data = [data];
  assert.deepEqual(flattenSchema([{ ok: true, data }]), []);
  const graph = { '@graph': [{ '@type': 'A' }, [{ '@type': 'B' }, { '@type': 'C', '@graph': [{ '@type': 'D' }] }]] };
  assert.deepEqual(flattenSchema([{ ok: true, data: graph }, { ok: false }, { ok: true, data: { '@type': 'E' } }]).map((n) => n['@type']), ['A', 'B', 'C', 'D', 'E']);
});

test('a hostile page gets a normal report with a complexity issue', async () => {
  const web = fakeWeb({ 'https://h.example.com/': html('<a href="/x">'.repeat(20_000)) });
  const t = performance.now();
  const r = await runAudit('https://h.example.com/', web);
  assert.ok(performance.now() - t < 3000);
  assert.ok(r.issues.some((i) => i.id === 'html-too-complex'));
});

test('huge crawled titles and long link URLs do not bloat the stored report', async () => {
  const big = (n) => html(`<title>${String(n).repeat(390_000)}</title><p>x</p>`);
  const links = ['/a', '/b', '/c', '/d'].map((p) => `<a href="${p}">x</a>`).join('') + `<a href="/${'z'.repeat(5000)}">long</a>`;
  const web = fakeWeb({
    'https://t.example.com/': html(`<title>${'t'.repeat(390_000)}</title>${links}`),
    'https://t.example.com/a': big(1),
    'https://t.example.com/b': big(2),
    'https://t.example.com/c': big(3),
    'https://t.example.com/d': big(4),
  });
  const r = await runAudit('https://t.example.com/', web);
  assert.equal(r.pages.length, 5);
  for (const p of r.pages) assert.ok(p.title.length <= 300, p.url);
  assert.ok(JSON.stringify(r).length < 64 * 1024);
  assert.ok(!web.calls.some((c) => c.url.includes('zzzz')));
});

test('an oversized report is cut down to the cap', () => {
  const issue = (n) => ({ id: `i${n}`, issue: 'x'.repeat(1500), evidence: 'e'.repeat(5000), fix: 'f'.repeat(1500), priority: 'low' });
  const report = { score: 1, issues: Array.from({ length: 400 }, (_, n) => issue(n)), passed: [{ label: 'p' }], insights: [{ label: 'l', value: 'v'.repeat(10_000) }], pages: [] };
  const out = capReport(report);
  assert.ok(JSON.stringify(out).length <= MAX_REPORT_BYTES);
  assert.equal(out.trimmed, true);
  assert.ok(out.issues.length >= 10);
  assert.equal(capReport({ a: 'short', b: ['y'.repeat(3000)] }).b[0].length, 2000);
});
