import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verifySources } from '../src/core/sources.js';
import { fakeNet, nhtsaPage, NHTSA, NHTSA_QUOTE } from './helpers.js';

const ctx = (pages) => ({ fetchPage: fakeNet(pages).fetchPage, site: 'example-auto.com', excluded: ['rivalshop.com', 'yelp.com'] });
const c = (url, quote = NHTSA_QUOTE) => ({ url, claim: 'c', quote, source_rank: 1 });

test('a source is kept only when it loads and holds the quote', async () => {
  const r = await verifySources([c(NHTSA), c('https://www.nhtsa.gov/missing'), c(NHTSA.replace('brakes', 'tires'))], ctx(nhtsaPage));
  assert.deepEqual(r.verified.map((v) => v.url), [NHTSA]);
  assert.equal(r.failed.length, 2);
});

test('a quote that is not on the page fails, even with curly quotes and case ignored', async () => {
  const page = { [NHTSA]: { body: '<p>Brakes don’t last FOREVER in the heat.</p>' } };
  const ok = await verifySources([c(NHTSA, "brakes don't last forever")], ctx(page));
  assert.equal(ok.verified.length, 1);
  const no = await verifySources([c(NHTSA, 'brakes last forever in the cold')], ctx(page));
  assert.match(no.failed[0].reason, /quote not found/);
});

test('the client, competitors, excluded sites, http and short quotes are refused', async () => {
  const r = await verifySources(
    [c('https://example-auto.com/brakes/'), c('https://www.rivalshop.com/x'), c('https://www.yelp.com/biz/x'), c('http://www.nhtsa.gov/'), c(NHTSA, 'too short')],
    ctx(nhtsaPage),
  );
  assert.equal(r.verified.length, 0);
  assert.equal(r.failed.length, 5);
});

test('redirects to an excluded site are refused, and the final URL is what gets linked', async () => {
  const pages = {
    'https://a.example/': { url: 'https://rivalshop.com/', body: `<p>${NHTSA_QUOTE}</p>` },
    'https://b.example/old': { url: 'https://b.example/new', body: `<p>${NHTSA_QUOTE}</p>` },
  };
  const r = await verifySources([c('https://a.example/'), c('https://b.example/old')], ctx(pages));
  assert.deepEqual(r.verified.map((v) => v.url), ['https://b.example/new']);
});

test('duplicates collapse and max is respected', async () => {
  const pages = Object.fromEntries(['1', '2', '3', '4'].map((n) => [`https://s${n}.example/`, { body: `<p>${NHTSA_QUOTE}</p>` }]));
  const r = await verifySources([c('https://s1.example/'), c('https://s1.example'), ...['2', '3', '4'].map((n) => c(`https://s${n}.example/`))], { ...ctx(pages), max: 3 });
  assert.equal(r.verified.length, 3);
  assert.equal(new Set(r.verified.map((v) => v.url)).size, 3);
});
