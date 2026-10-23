import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeBrief, BriefError, toInternalPath } from '../src/core/brief.js';
import { brief } from './helpers.js';

test('a brief is tidied: bare domain, paths, conversion page added', () => {
  const b = normalizeBrief(brief());
  assert.equal(b.site, 'example-auto.com');
  assert.equal(b.brand, 'Example Auto');
  assert.deepEqual(b.internal_pages.map((p) => p.url), ['/service/brakes/', '/deer-valley-auto-repair/', '/contact/']);
  assert.deepEqual(b.conversion, { action: 'Book a brake inspection', url: '/contact/' });
  assert.deepEqual(b.facts[1], { fact: 'Free brake inspection', source: '' });
  assert.deepEqual(b.competitors, ['rivalshop.com']);
});

test('missing or wrong fields give a plain error', () => {
  const bad = [
    [{ page: { type: 'landing' } }, /page.type/],
    [{ site: '' }, /site/],
    [{ site: 'localhost' }, /site/],
    [{ business: '' }, /business/],
    [{ page: { type: 'service' } }, /page.service/],
    [{ page: { type: 'location', service: 'brakes' } }, /page.place/],
    [{ page: { type: 'blog', topic: 'x', words_target: 'lots' } }, /words_target/],
  ];
  for (const [over, msg] of bad) assert.throws(() => normalizeBrief(brief(over)), (e) => e instanceof BriefError && msg.test(e.message));
});

test('internal pages on another host are refused', () => {
  assert.throws(() => normalizeBrief(brief({ internal_pages: ['https://rivalshop.com/brakes/'] })), /not on example-auto.com/);
  assert.equal(toInternalPath('https://www.example-auto.com/a/?b=1', 'example-auto.com'), '/a/?b=1');
});

test('external sources must be https', () => {
  const b = normalizeBrief(brief({ external_sources: ['http://plain.example/', 'https://www.nhtsa.gov/equipment/brakes'] }));
  assert.deepEqual(b.external_sources.map((s) => s.url), ['https://www.nhtsa.gov/equipment/brakes']);
});

test('a brief past its caps is refused with the field and the cap', async () => {
  const { LIMITS } = await import('../src/core/brief.js');
  const many = (n, f) => Array.from({ length: n }, (_, i) => f(i));
  const bad = [
    [{ external_sources: many(LIMITS.external_sources + 1, (i) => `https://s${i}.example.org/`) }, /external_sources has 11 entries; the most is 10/],
    [{ siblings: many(LIMITS.siblings + 1, (i) => ({ url: `https://example-auto.com/p${i}/` })) }, /siblings has 11 entries/],
    [{ internal_pages: many(LIMITS.internal_pages + 1, (i) => `/p${i}/`) }, /internal_pages has 301 entries/],
    [{ facts: many(LIMITS.facts + 1, (i) => `fact ${i}`) }, /facts has 101 entries/],
    [{ voice_of_customer: many(LIMITS.voice_of_customer + 1, (i) => `line ${i}`) }, /voice_of_customer has 101 entries/],
    [{ keywords: { variants: many(LIMITS.keywords + 1, (i) => `k${i}`) } }, /keywords.variants has 51 entries/],
    [{ business: 'B'.repeat(LIMITS.text + 1) }, /business is 2049 characters long; the most is 2048/],
    [{ facts: [{ fact: 'f'.repeat(LIMITS.text + 1), source: 'owner' }] }, /facts\[0\].fact is 2049 characters/],
    [{ voice_of_customer: ['ok', 'v'.repeat(LIMITS.text + 1)] }, /voice_of_customer\[1\]/],
    [{ page: { type: 'service', service: 'brakes', notes: 'n'.repeat(LIMITS.notes + 1) } }, /page.notes is 5001 characters/],
    [{ siblings: [{ name: 'old', markdown: 'm'.repeat(LIMITS.markdown + 1) }] }, /siblings\[0\].markdown is 60001 characters/],
    [{ keywords: { baseline: [{ kw: 'x'.repeat(LIMITS.text) }] } }, /keywords.baseline\[0\]/],
  ];
  for (const [over, msg] of bad) assert.throws(() => normalizeBrief(brief(over)), (e) => e instanceof BriefError && msg.test(e.message), String(msg));
  assert.doesNotThrow(() => normalizeBrief(brief({ external_sources: many(LIMITS.external_sources, (i) => `https://s${i}.example.org/`) })));
});

test('the client name is cut to a-z, 0-9 and dashes before it names a file', async () => {
  const { copyDocName } = await import('../src/core/copydoc.js');
  const b = normalizeBrief(brief({ client: '../../../Users/photography/.zshrc#' }));
  assert.equal(b.client, 'users-photography-zshrc');
  assert.equal(normalizeBrief(brief({ client: '../..' })).client, 'example-auto');
  assert.equal(copyDocName({ brief: b, plan: { slug: '/service/brakes/' } }), 'users-photography-zshrc-service-brakes-copy.md');
  assert.equal(copyDocName({ brief: { client: '/etc/x' }, plan: { slug: '/../../a/' } }), 'etc-x-a-copy.md');
});

test('the CLI writes only inside --out', async () => {
  const { outPath } = await import('../src/node/paths.js');
  const { resolve, join } = await import('node:path');
  assert.equal(outPath('out', 'a-copy.md'), join(resolve('out'), 'a-copy.md'));
  for (const name of ['../a-copy.md', '../../Users/x/.zshrc#-x-copy.md', '/etc/passwd', '', '.', 'sub/../../a.md']) {
    assert.throws(() => outPath('out', name), /outside the out folder/, name);
  }
});
