import test from 'node:test';
import assert from 'node:assert/strict';
import { createJevClient, createJevFromEnv, validateAnswers, JEV_QUESTIONS, buildJevState, jevFindings } from '../src/core/jev.js';
import { extractPage } from '../src/core/extract.js';
import { Results } from '../src/core/findings.js';
import { goodPage } from './fixtures/pages.js';

const page = extractPage(goodPage, 'https://shop.example.com/brakes');

test('off by default', () => {
  assert.equal(createJevFromEnv({}), null);
  assert.equal(createJevFromEnv({ JEV_PROVIDER: 'off' }), null);
});

test('providers refuse to start without credentials', () => {
  assert.throws(() => createJevFromEnv({ JEV_PROVIDER: 'typesafe' }), /TYPESAFE_API_KEY/);
  assert.throws(() => createJevFromEnv({ JEV_PROVIDER: 'cloudflare' }), /CLOUDFLARE_ACCOUNT_ID/);
  assert.throws(() => createJevFromEnv({ JEV_PROVIDER: 'cloudflare', CLOUDFLARE_ACCOUNT_ID: '../x', CLOUDFLARE_API_TOKEN: 't' }), /account id/);
  assert.throws(() => createJevFromEnv({ JEV_PROVIDER: 'workers-ai' }), /AI binding/);
  assert.throws(() => createJevFromEnv({ JEV_PROVIDER: 'nope' }), /Unknown/);
});

test('typesafe provider sends the documented request', async () => {
  let seen;
  const fetchImpl = async (url, init) => {
    seen = { url, init, body: JSON.parse(init.body) };
    return Response.json({ model: 'jev-1', answers: { content_depth: { type: 'score', score: 3.2, confidence: 0.9 } }, usage: {} });
  };
  const jev = createJevClient({ provider: 'typesafe', apiKey: 'test-key', fetchImpl });
  const out = await jev.judge(page);
  assert.equal(seen.url, 'https://api.typesafe.ai/v1/systemone');
  assert.equal(seen.init.headers.authorization, 'Bearer test-key');
  assert.equal(seen.body.model, 'jev-latest');
  assert.ok(seen.body.state.text.length <= 12_000);
  assert.deepEqual(Object.keys(seen.body.questions), Object.keys(JEV_QUESTIONS));
  assert.equal(out.answers.content_depth.score, 3.2);
});

test('cloudflare REST provider sends model and input', async () => {
  let seen;
  const fetchImpl = async (url, init) => {
    seen = { url, body: JSON.parse(init.body), auth: init.headers.authorization };
    return Response.json({ success: true, result: { answers: { local_business: { type: 'noul', noul: 0.9 } } } });
  };
  const jev = createJevClient({ provider: 'cloudflare', accountId: 'a'.repeat(32), apiToken: 'tok', fetchImpl });
  const out = await jev.judge(page);
  assert.equal(seen.url, `https://api.cloudflare.com/client/v4/accounts/${'a'.repeat(32)}/ai/run`);
  assert.equal(seen.body.model, 'typesafe/jev');
  assert.ok(seen.body.input.state && seen.body.input.questions);
  assert.equal(out.answers.local_business.p, 0.9);
});

test('workers-ai provider calls the binding', async () => {
  let called;
  const ai = { run: async (model, input) => ((called = { model, input }), { answers: {} }) };
  const jev = createJevClient({ provider: 'workers-ai', aiBinding: ai });
  await jev.judge(page);
  assert.equal(called.model, 'typesafe/jev');
});

test('an HTTP error from the provider surfaces as an error', async () => {
  const jev = createJevClient({ provider: 'typesafe', apiKey: 'k', fetchImpl: async () => new Response('nope', { status: 401 }) });
  await assert.rejects(jev.judge(page), /401/);
});

test('malformed or out-of-range answers are dropped', () => {
  const out = validateAnswers(JEV_QUESTIONS, {
    answers: {
      content_depth: { type: 'score', score: 99, confidence: 0.9 },
      intent_match: { type: 'noul', noul: 1.5 },
      boilerplate: { type: 'choice', choice: 'x' },
      search_intent: { type: 'choice', choice: '<script>alert(1)</script>', confidence: 0.9 },
      local_business: { type: 'noul', noul: 0.2 },
      trust_signals: { type: 'score', score: 2, confidence: 'high' },
      unknown_question: { type: 'noul', noul: 0.5 },
    },
  });
  assert.deepEqual(Object.keys(out), ['local_business']);
  assert.throws(() => validateAnswers(JEV_QUESTIONS, { nothing: true }));
});

test('uncertain answers produce no findings', () => {
  const r = new Results();
  jevFindings(
    {
      intent_match: { type: 'noul', p: 0.5 },
      content_depth: { type: 'score', score: 0.2, confidence: 0.3, max: 4 },
    },
    r,
  );
  assert.equal(r.issues.length, 0);
});

test('state is built from the page and capped', () => {
  const big = extractPage(`<title>x</title><body>${'word '.repeat(10_000)}</body>`, 'https://a.example.com/');
  const s = buildJevState(big);
  assert.ok(s.text.length <= 12_000);
  assert.equal(s.title, 'x');
});
