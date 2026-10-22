import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { SlidingWindowLimiter } from '../src/core/rate-limit.js';
import { mdEscape, toMarkdown } from '../src/core/report.js';
import { createDohResolver } from '../src/core/doh.js';
import { runAudit } from '../src/core/audit.js';
import { fakeWeb, html } from './helpers.js';

test('sliding window limiter resets after the window and caps memory', () => {
  const l = new SlidingWindowLimiter({ limit: 2, windowMs: 1000, maxKeys: 3 });
  assert.equal(l.check('a', 0).allowed, true);
  assert.equal(l.check('a', 10).allowed, true);
  assert.equal(l.check('a', 20).allowed, false);
  assert.equal(l.check('a', 1500).allowed, true);
  for (let i = 0; i < 10; i++) l.check(`k${i}`, 2000);
  assert.ok(l.hits.size <= 3);
});

test('markdown output escapes page text', async () => {
  assert.equal(mdEscape('<script>x</script>'), '&lt;script&gt;x&lt;/script&gt;');
  assert.equal(mdEscape('[link](javascript:x)'), '\\[link\\](javascript:x)');
  const web = fakeWeb({ 'https://x.example.com/': html('<title><img src=x onerror=alert(1)> **bold**</title>') });
  const md = toMarkdown(await runAudit('https://x.example.com/', web));
  assert.doesNotMatch(md, /<img/);
});

test('front end never writes HTML from data', async () => {
  const js = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.doesNotMatch(js, /innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(|new Function/);
  const page = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  assert.doesNotMatch(page, /<script>(?!<\/script>)|\son[a-z]+=/i, 'no inline scripts or handlers (CSP)');
});

test('DNS over HTTPS resolver returns A and AAAA records', async () => {
  const fetchImpl = async (url) => {
    const type = new URL(url).searchParams.get('type');
    const Answer = type === 'A' ? [{ type: 5, data: 'alias.example.' }, { type: 1, data: '93.184.215.14' }] : [{ type: 28, data: '2606:2800::1' }];
    return Response.json({ Status: 0, Answer });
  };
  const resolve = createDohResolver({ fetchImpl });
  assert.deepEqual(await resolve('example.com'), ['93.184.215.14', '2606:2800::1']);
});
