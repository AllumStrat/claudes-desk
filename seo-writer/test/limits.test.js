// One request must stay small: a capped body, a capped brief, a capped
// number of fetches and only a few of them at a time.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handle, readBody, MAX_BODY_BYTES } from '../src/worker/index.js';
import { writePage } from '../src/core/pipeline.js';
import { mapLimit, limited } from '../src/core/limit.js';
import * as H from './helpers.js';

const TOKEN = 'a-long-random-token-for-the-tests-0123456789';
const env = { WRITER_TOKEN: TOKEN, ANTHROPIC_API_KEY: 'sk-test' };
const neverCalled = { async call() { throw new Error('the model should not be called'); } };

const stream = (bytes) =>
  new ReadableStream({
    pull(c) {
      if (bytes <= 0) return c.close();
      const n = Math.min(bytes, 64 * 1024);
      bytes -= n;
      c.enqueue(new Uint8Array(n).fill(32));
    },
  });
const post = (body, headers = {}) => new Request('https://writer.example/api/write', { method: 'POST', headers: { authorization: `Bearer ${TOKEN}`, ...headers }, body, duplex: 'half' });

test('a body over 256 KB is refused before it is parsed, whatever Content-Length says', async () => {
  const big = JSON.stringify({ brief: H.brief({ page: { type: 'service', service: 'x', notes: 'A'.repeat(20_000_000) } }) });
  for (const req of [
    post(big), // honest header
    post(big, { 'content-length': '100' }), // header that lies
    post(stream(MAX_BODY_BYTES + 1)), // no header at all
  ]) {
    const r = await handle(req, env, { llm: neverCalled, net: H.fakeNet() });
    assert.equal(r.status, 413);
  }
  assert.equal(await readBody(post(stream(MAX_BODY_BYTES))), ' '.repeat(MAX_BODY_BYTES));
});

test('a brief past its caps is a 400 from the Worker', async () => {
  const brief = H.brief({ external_sources: Array.from({ length: 300 }, (_, i) => `https://s${i}.example.org/`) });
  const r = await handle(post(JSON.stringify({ brief })), env, { llm: neverCalled, net: H.fakeNet() });
  assert.equal(r.status, 400);
  assert.match((await r.json()).error, /external_sources has 300 entries; the most is 10/);
});

test('model-proposed sources are capped and fetched a few at a time', async () => {
  let inFlight = 0;
  let peak = 0;
  const fetched = [];
  const net = {
    async fetchPage(url) {
      fetched.push(url);
      peak = Math.max(peak, ++inFlight);
      await new Promise((r) => setTimeout(r, 2));
      inFlight--;
      return { status: 404, url, body: '' };
    },
    async status() {
      return [200, null];
    },
  };
  const many = (n, host) => Array.from({ length: n }, (_, i) => ({ url: `https://${host}${i}.example.org/`, claim: 'c', quote: 'one two three four five', source_rank: 1 }));
  const llm = H.fakeLlm({ plan: H.plan({ external_candidates: many(300, 'plan') }), sources: { external_candidates: many(300, 'retry') }, draft: H.draftAnswer(), edit: H.editAnswer(), fix: { body: H.GREEN_BODY, title: '', meta: '', changes: [], warn_notes: [] } });
  const brief = H.brief({ external_sources: many(10, 'brief'), siblings: Array.from({ length: 10 }, (_, i) => ({ url: `https://example-auto.com/p${i}/` })) });
  await writePage(brief, { llm, net });
  // 10 from the brief + 4 from the plan + 4 replacements + 10 siblings
  assert.equal(fetched.length, 28);
  assert.ok(peak <= 4, `peak ${peak} fetches at once`);
});

test('the --live check fetches only allowed links, a few at a time', async () => {
  const body = H.GREEN_BODY.replace('Call the shop or book online', 'See [a spam page](https://spam.example.net/). Call the shop or book online');
  const asked = [];
  const net = { ...H.fakeNet(H.nhtsaPage), status: async (u) => (asked.push(u), [200, null]) };
  const llm = H.fakeLlm({ plan: H.plan(), draft: H.draftAnswer(body), edit: H.editAnswer(body), fix: { body: H.GREEN_BODY, title: '', meta: '', changes: [], warn_notes: [] } });
  await writePage(H.brief(), { llm, net, live: true });
  assert.ok(asked.length > 0);
  assert.ok(!asked.some((u) => u.includes('spam.example.net')));
});

test('mapLimit and limited keep to their limit and the input order', async () => {
  let active = 0;
  let peak = 0;
  const slow = async (x) => {
    peak = Math.max(peak, ++active);
    await new Promise((r) => setTimeout(r, 1));
    active--;
    return x * 2;
  };
  assert.deepEqual(await mapLimit([1, 2, 3, 4, 5, 6, 7], 3, slow), [2, 4, 6, 8, 10, 12, 14]);
  assert.equal(peak, 3);
  peak = 0;
  const f = limited(slow, 2);
  assert.deepEqual(await Promise.all([1, 2, 3, 4, 5].map((x) => f(x))), [2, 4, 6, 8, 10]);
  assert.equal(peak, 2);
});
