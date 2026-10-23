import test from 'node:test';
import assert from 'node:assert/strict';
import { parseRobots, isAllowed, blocksEverything, ruleMatches } from '../src/core/robots.js';
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

// The old regex matcher, unchanged, kept only as a reference for small inputs.
function referenceMatch(pattern, path) {
  let p = pattern;
  let anchored = false;
  if (p.endsWith('$')) {
    anchored = true;
    p = p.slice(0, -1);
  }
  const escaped = p.replace(/[.+?^{}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}${anchored ? '$' : ''}`).test(path);
}

test('robots wildcards match exactly like before, without backtracking', () => {
  const cases = [
    ['/', '/anything', true],
    ['/admin/', '/admin/x', true],
    ['/admin/', '/admin', false],
    ['/*.pdf$', '/files/a.pdf', true],
    ['/*.pdf$', '/files/a.pdf?x=1', false],
    ['/*.pdf', '/files/a.pdf?x=1', true],
    ['/fish*', '/fishheads/yummy.html', true],
    ['/fish*', '/Fish.asp', false],
    ['/*.php$', '/filename.php', true],
    ['/*.php$', '/filename.php/', false],
    ['/fish*.php', '/fishheads/catfish.php?parameters', true],
    ['/fish*.php', '/Fish.PHP', false],
    ['/a*b*c', '/abc', true],
    ['/a*b*c', '/acb', false],
    ['/a*b$', '/ab', true],
    ['/a*b$', '/abab', true],
    ['/a*ab$', '/ab', false],
    ['*', '/x', true],
    ['$', '/', false],
    ['/x.y', '/xzy', false],
    ['/a+b', '/a+b', true],
  ];
  for (const [pattern, path, want] of cases) {
    assert.equal(ruleMatches(pattern, path), want, `${pattern} vs ${path}`);
    assert.equal(referenceMatch(pattern, path), want, `reference ${pattern} vs ${path}`);
  }
  // Random patterns: same answers as the old regex matcher.
  let seed = 7;
  const rand = (n) => (seed = (seed * 1103515245 + 12345) % 2 ** 31) % n;
  const pick = (chars, len) => Array.from({ length: len }, () => chars[rand(chars.length)]).join('');
  for (let i = 0; i < 3000; i++) {
    const pattern = '/' + pick('ab*.', rand(7)) + (rand(3) === 0 ? '$' : '');
    const path = '/' + pick('ab.', rand(9));
    assert.equal(ruleMatches(pattern, path), referenceMatch(pattern, path), `${pattern} vs ${path}`);
  }
  // A "$" before the end is an ordinary character (RFC 9309), not an anchor.
  assert.equal(ruleMatches('/a$b', '/a$b'), true);
});

function timed(fn) {
  const t = performance.now();
  const out = fn();
  return { out, ms: performance.now() - t };
}

test('robots rules full of wildcards are fast', () => {
  for (const k of [10, 30, 1000]) {
    const robots = parseRobots('User-agent: *\nDisallow: /' + '*a'.repeat(k) + 'b\n');
    const { out, ms } = timed(() => isAllowed(robots, '/' + 'a'.repeat(2000)));
    assert.equal(out, true);
    assert.ok(ms < 200, `${k} wildcards took ${ms} ms`);
  }
  const many = parseRobots('User-agent: *\n' + 'Disallow: /x*y\n'.repeat(30_000));
  assert.ok(timed(() => isAllowed(many, '/abc')).ms < 500);
});
