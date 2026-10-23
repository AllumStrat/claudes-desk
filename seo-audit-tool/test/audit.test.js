import test from 'node:test';
import assert from 'node:assert/strict';
import { runAudit, AuditError, clampLimits } from '../src/core/audit.js';
import { createJevClient } from '../src/core/jev.js';
import { fakeWeb, html } from './helpers.js';
import { goodPage, badPage } from './fixtures/pages.js';

const robotsOk = { status: 200, headers: { 'content-type': 'text/plain' }, body: 'User-agent: *\nAllow: /\nSitemap: https://shop.example.com/sitemap.xml' };
const sitemapOk = {
  status: 200,
  headers: { 'content-type': 'application/xml' },
  body: '<?xml version="1.0"?><urlset><url><loc>https://shop.example.com/brakes</loc></url></urlset>',
};
const secureHeaders = {
  'content-type': 'text/html; charset=utf-8',
  'content-encoding': 'br',
  'strict-transport-security': 'max-age=31536000',
  'content-security-policy': "default-src 'self'; frame-ancestors 'none'",
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'strict-origin-when-cross-origin',
};

function goodSite() {
  const page = (body, extra = {}) => ({ status: 200, headers: { ...secureHeaders, ...extra }, body });
  const variant = (title, desc) => goodPage.replace(/<title>.*<\/title>/, `<title>${title}</title>`).replace(/content="Fast, honest[^"]*"/, `content="${desc}"`);
  return fakeWeb({
    'https://shop.example.com/brakes': page(goodPage),
    'http://shop.example.com/brakes': { status: 301, headers: { location: 'https://shop.example.com/brakes' } },
    'https://shop.example.com/robots.txt': robotsOk,
    'https://shop.example.com/sitemap.xml': sitemapOk,
    'https://shop.example.com/': page(variant('Floorjack Auto Repair in Mesa, AZ | Brakes, Oil, Tires', 'Family-owned auto repair in Mesa, AZ with honest quotes, same-day service and a 24 month warranty. Book online today.')),
    'https://shop.example.com/services': page(variant('Auto Repair Services in Mesa, AZ | Floorjack Auto Repair', 'Brakes, oil changes, tires, diagnostics and AC repair in Mesa, AZ, done by certified technicians with clear pricing.')),
    'https://shop.example.com/about': page(variant('About Floorjack Auto Repair | Mesa, AZ Mechanics Since 2009', 'Meet the Floorjack team: certified Mesa mechanics serving the East Valley since 2009 with honest, warrantied work.')),
    'https://shop.example.com/contact': page(variant('Contact Floorjack Auto Repair | 123 Main St, Mesa, AZ', 'Call (480) 555-0142 or visit us at 123 Main St in Mesa, AZ. Open Monday to Friday, 8 to 5. Book your repair online.')),
    'https://shop.example.com/img/brakes.webp': { status: 200, headers: { 'content-type': 'image/webp', 'content-length': '48000' } },
    'https://maps.example.org/place': { status: 200, headers: { 'content-type': 'text/html' } },
  });
}

const ids = (report) => report.issues.map((i) => i.id);

test('a healthy local business page scores well with no high issues', async () => {
  const web = goodSite();
  const r = await runAudit('https://shop.example.com/brakes', web);
  assert.equal(r.counts.high, 0, `unexpected high issues: ${ids(r).join(', ')}`);
  assert.ok(r.score >= 90, `score ${r.score} with ${ids(r).join(', ')}`);
  assert.ok(r.categories.some((c) => c.key === 'local'));
  for (const i of r.issues) {
    for (const k of ['issue', 'impact', 'evidence', 'fix', 'priority']) assert.ok(i[k], `${i.id} missing ${k}`);
  }
  assert.ok(r.pagesCrawled <= 5);
});

test('a broken page surfaces the expected problems', async () => {
  const web = fakeWeb({ 'https://bad.example.com/': html(badPage) });
  const r = await runAudit('bad.example.com', web);
  const found = new Set(ids(r));
  for (const id of [
    'noindex', 'nofollow-page', 'canonical-cross-domain', 'title-missing', 'description-missing', 'h1-multiple',
    'headings-skip', 'headings-empty', 'viewport-missing', 'lang-missing', 'doctype-missing', 'img-alt-missing',
    'mixed-content', 'schema-invalid-json', 'render-blocking-js', 'content-very-thin', 'og-missing', 'sitemap-missing',
    'robots-missing', 'links-generic-text', 'links-no-text', 'crawl-errors', 'http-not-redirected',
  ]) {
    assert.ok(found.has(id), `expected ${id}; got ${[...found].join(', ')}`);
  }
  assert.ok(r.score < 50, `score ${r.score}`);
  const order = r.issues.map((i) => i.priority);
  assert.deepEqual(order, [...order].sort((a, b) => ['high', 'medium', 'low'].indexOf(a) - ['high', 'medium', 'low'].indexOf(b)));
});

test('the crawl respects robots.txt and the page cap', async () => {
  const links = Array.from({ length: 30 }, (_, i) => `<a href="/p${i}">Page ${i}</a>`).join(' ');
  const routes = {
    'https://site.example.com/': html(`<!doctype html><html><head><title>Home page of the example site for tests</title></head><body><h1>Hi</h1>${links}<a href="/private/x">Secret</a></body></html>`),
    'https://site.example.com/robots.txt': { status: 200, headers: { 'content-type': 'text/plain' }, body: 'User-agent: *\nDisallow: /p1\nDisallow: /private' },
  };
  for (let i = 0; i < 30; i++) routes[`https://site.example.com/p${i}`] = html(`<title>Page ${i}</title>`);
  const web = fakeWeb(routes);
  const r = await runAudit('https://site.example.com/', { ...web, limits: { maxPages: 4, maxLinkChecks: 0, maxExternalLinkChecks: 0 } });
  const crawled = r.pages.map((p) => p.url);
  assert.equal(crawled.length, 4);
  assert.ok(!crawled.some((u) => /\/p1\d*$|private/.test(u.replace('https://site.example.com', ''))), crawled.join(','));
  const fetched = web.calls.map((c) => c.url);
  assert.ok(!fetched.some((u) => u.includes('/private')), 'disallowed URL was fetched');
});

test('request volume stays bounded on a link-heavy page', async () => {
  const links = Array.from({ length: 500 }, (_, i) => `<a href="https://ext${i}.example.net/">x${i}</a><a href="/in${i}">in${i}</a><img src="/i${i}.png" alt="">`).join('');
  const web = fakeWeb({ 'https://heavy.example.com/': html(`<title>t</title>${links}`) });
  const r = await runAudit('https://heavy.example.com/', web);
  // page + robots + http probe + 2 sitemap guesses + 4 crawl + 20 links + 12 images (+ GET retries)
  assert.ok(web.calls.length <= 60, `made ${web.calls.length} requests`);
  assert.ok(r.requestsMade <= 60);
});

test('limits cannot be raised past the hard ceilings', () => {
  const l = clampLimits({ maxPages: 1000, maxLinkChecks: 1e6, auditTimeoutMs: 1e9, bogus: 5, maxImageChecks: -1 });
  assert.equal(l.maxPages, 10);
  assert.equal(l.maxLinkChecks, 40);
  assert.equal(l.auditTimeoutMs, 60_000);
  assert.equal(l.maxImageChecks, 12);
  assert.equal('bogus' in l, false);
});

test('invalid and private inputs are rejected before any fetch', async () => {
  const web = fakeWeb({});
  for (const u of ['', 'not a url', 'http://127.0.0.1/', 'file:///etc/passwd', 'http://169.254.169.254/']) {
    await assert.rejects(runAudit(u, web), AuditError);
  }
  assert.equal(web.calls.length, 0);
});

test('a site that redirects to a private address fails safely', async () => {
  const web = fakeWeb({ 'https://trap.example.com/': { status: 302, headers: { location: 'http://10.0.0.1/admin' } } });
  await assert.rejects(runAudit('https://trap.example.com/', web), (err) => err.code === 'BLOCKED_URL');
});

test('links on the page that point to private hosts are never fetched', async () => {
  const web = fakeWeb(
    { 'https://ok.example.com/': html('<title>Fine</title><a href="http://127.0.0.1/">a</a><a href="http://inside.example.com/">b</a><img src="http://169.254.169.254/x.png" alt="">') },
    { 'inside.example.com': ['192.168.1.20'] },
  );
  await runAudit('https://ok.example.com/', web);
  const fetched = web.calls.map((c) => c.url);
  assert.ok(!fetched.some((u) => /127\.0\.0\.1|169\.254|inside\.example/.test(u)), fetched.join('\n'));
});

test('non-HTML responses are reported without page checks', async () => {
  const web = fakeWeb({ 'https://pdf.example.com/doc.pdf': { status: 200, headers: { 'content-type': 'application/pdf' }, body: '%PDF' } });
  const r = await runAudit('https://pdf.example.com/doc.pdf', web);
  assert.ok(r.insights.some((n) => n.label === 'Not an HTML page'));
});

test('the mock Jev provider adds judgment findings marked as such', async () => {
  const web = fakeWeb({ 'https://bad.example.com/': html(badPage) });
  const r = await runAudit('https://bad.example.com/', { ...web, jev: createJevClient({ provider: 'mock' }) });
  assert.equal(r.judgment.used, true);
  const j = r.issues.filter((i) => i.source === 'judgment');
  assert.ok(j.length > 0);
  for (const i of j) assert.ok(i.confidence > 0 && i.confidence <= 1);
});

test('a failing Jev provider does not break the audit', async () => {
  const web = fakeWeb({ 'https://bad.example.com/': html(badPage) });
  const jev = { provider: 'typesafe', judge: async () => { throw new Error('boom 401 secret-key-123'); } };
  const r = await runAudit('https://bad.example.com/', { ...web, jev });
  assert.equal(r.judgment.used, false);
  assert.doesNotMatch(JSON.stringify(r), /secret-key-123/);
});

test('report never names third-party tools', async () => {
  const web = fakeWeb({ 'https://bad.example.com/': html(badPage) });
  const r = await runAudit('https://bad.example.com/', { ...web, jev: createJevClient({ provider: 'mock' }) });
  const text = JSON.stringify({ issues: r.issues, passed: r.passed, insights: r.insights });
  assert.doesNotMatch(text, /screaming frog|semrush|ahrefs|moz\b|pagespeed|lighthouse|search console|search atlas|jev|typesafe|cheerio|haiku/i);
});
