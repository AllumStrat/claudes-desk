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
