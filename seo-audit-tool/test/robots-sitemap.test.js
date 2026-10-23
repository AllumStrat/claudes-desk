import test from 'node:test';
import assert from 'node:assert/strict';
import { parseRobots, isAllowed, blocksEverything } from '../src/core/robots.js';
import { parseSitemap } from '../src/core/sitemap.js';

const txt = `
# comment
User-agent: *
Disallow: /admin/
Allow: /admin/public
Disallow: /*.pdf$

User-agent: AllumSEOAudit
Disallow: /private

Sitemap: https://example.com/sitemap.xml
`;

test('robots rules: longest match wins, wildcards, specific agent group', () => {
  const r = parseRobots(txt);
  assert.deepEqual(r.sitemaps, ['https://example.com/sitemap.xml']);
  assert.equal(isAllowed(r, '/admin/x', '*'), false);
  assert.equal(isAllowed(r, '/admin/public/page', '*'), true);
  assert.equal(isAllowed(r, '/files/a.pdf', '*'), false);
  assert.equal(isAllowed(r, '/files/a.pdf?x=1', '*'), true);
  // Our own group replaces the * group
  assert.equal(isAllowed(r, '/admin/x'), true);
  assert.equal(isAllowed(r, '/private/thing'), false);
});

test('robots block-all detection', () => {
  assert.equal(blocksEverything(parseRobots('User-agent: *\nDisallow: /')), true);
  assert.equal(blocksEverything(parseRobots('User-agent: *\nDisallow:')), false);
  assert.equal(blocksEverything(parseRobots('User-agent: badbot\nDisallow: /')), false);
});

test('robots counts lines it does not understand', () => {
  assert.equal(parseRobots('User-agent: *\nDisalow: /x\nnonsense').invalidLines, 2);
});

test('sitemap parsing', () => {
  const ok = parseSitemap('<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>https://a.com/</loc></url><url><loc>https://a.com/b</loc></url></urlset>');
  assert.equal(ok.valid, true);
  assert.equal(ok.count, 2);
  const idx = parseSitemap('<sitemapindex><sitemap><loc>https://a.com/s1.xml</loc></sitemap></sitemapindex>');
  assert.equal(idx.kind, 'index');
  assert.equal(parseSitemap('<html><body>404</body></html>').valid, false);
  assert.equal(parseSitemap('').valid, false);
  assert.equal(parseSitemap('<urlset><url><loc>/relative</loc></url></urlset>').valid, false);
  assert.equal(parseSitemap('\u001f\u008b binary').valid, false);
});
