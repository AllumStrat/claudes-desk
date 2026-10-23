import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handle, sameToken } from '../src/worker/index.js';
import * as H from './helpers.js';

const TOKEN = 'secret-token-0123456789abcdef0123456789';
const env = { WRITER_TOKEN: TOKEN, ANTHROPIC_API_KEY: 'sk-test' };
const post = (body, token = TOKEN) =>
  new Request('https://writer.example/api/write', { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: typeof body === 'string' ? body : JSON.stringify(body) });
const deps = () => ({ llm: H.fakeLlm({ plan: H.plan(), draft: H.draftAnswer(), edit: H.editAnswer() }), net: H.fakeNet(H.nhtsaPage) });

test('the token is required and compared in full', async () => {
  assert.equal((await handle(post({}, 'wrong'), env, deps())).status, 401);
  assert.equal((await handle(post({}, `${TOKEN}-longer`), env, deps())).status, 401);
  assert.equal(sameToken('abc', 'abc'), true);
  assert.equal(sameToken('abc', 'abd'), false);
});

test('without secrets set it refuses to run', async () => {
  assert.equal((await handle(post({}), {}, deps())).status, 503);
});

test('only POST /api/write', async () => {
  assert.equal((await handle(new Request('https://writer.example/'), env)).status, 404);
  assert.equal((await handle(new Request('https://writer.example/api/write'), env)).status, 405);
});

test('a bad brief is a 400 with the reason', async () => {
  const r = await handle(post({ brief: { site: 'example-auto.com' } }), env, deps());
  assert.equal(r.status, 400);
  assert.match((await r.json()).error, /page.type/);
  assert.equal((await handle(post('not json'), env, deps())).status, 400);
});

test('a good brief returns the copy doc and the cost', async () => {
  const r = await handle(post({ brief: H.brief() }), env, deps());
  assert.equal(r.status, 200);
  const data = await r.json();
  assert.equal(data.status, 'green');
  assert.equal(data.name, 'example-auto-norterra-brake-repair-copy.md');
  assert.match(data.copyDoc, /## 5. Page copy/);
  assert.equal(data.usage.calls, 3);
});

test('a WRITER_TOKEN under 32 characters keeps the writer from starting', async () => {
  const r = await handle(post({ brief: H.brief() }, 'abc'), { ...env, WRITER_TOKEN: 'abc' }, deps());
  assert.equal(r.status, 503);
  assert.match((await r.json()).error, /at least 32 characters/);
  assert.equal((await handle(post({ brief: H.brief() }, 'x'.repeat(31)), { ...env, WRITER_TOKEN: 'x'.repeat(31) }, deps())).status, 503);
  assert.equal((await handle(post({ brief: H.brief() }, 'x'.repeat(32)), { ...env, WRITER_TOKEN: 'x'.repeat(32) }, deps())).status, 200);
});

test('WRITER_MAX_SPEND stops the run and the answer says what was spent', async () => {
  const r = await handle(post({ brief: H.brief() }), { ...env, WRITER_MAX_SPEND: '0.01' }, deps());
  assert.equal(r.status, 402);
  const data = await r.json();
  assert.equal(data.code, 'SPEND_CAP');
  assert.equal(data.usage.calls, 1);
  assert.ok(data.usage.cost > 0.01);
  assert.equal((await handle(post({ brief: H.brief() }), { ...env, WRITER_MAX_SPEND: 'lots' }, deps())).status, 503);
});

test('when the client disconnects, no further model calls are made', async () => {
  const controller = new AbortController();
  const d = deps();
  const llm = { calls: 0, async call(req) { this.calls++; controller.abort(); return d.llm.call(req); } };
  const req = new Request('https://writer.example/api/write', { method: 'POST', headers: { authorization: `Bearer ${TOKEN}` }, body: JSON.stringify({ brief: H.brief() }), signal: controller.signal });
  const r = await handle(req, env, { llm, net: d.net });
  assert.equal(llm.calls, 1);
  assert.equal(r.status, 499);
  assert.equal((await r.json()).usage.calls, 1);
});

const lines = async (r) => (await r.text()).trim().split('\n').map((l) => JSON.parse(l));

test('Accept: application/x-ndjson streams each step, then the answer', async () => {
  const req = post({ brief: H.brief() });
  req.headers.set('accept', 'application/x-ndjson');
  const r = await handle(req, env, deps());
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /ndjson/);
  const events = await lines(r);
  assert.deepEqual(events.filter((e) => e.type === 'step').map((e) => e.step), ['plan', 'draft', 'edit']);
  const done = events.at(-1);
  assert.equal(done.type, 'done');
  assert.equal(done.code, 200);
  assert.equal(done.data.status, 'green');
});

test('a streamed run that fails ends on its error and status code', async () => {
  const req = post({ brief: H.brief() });
  req.headers.set('accept', 'application/x-ndjson');
  const done = (await lines(await handle(req, { ...env, WRITER_MAX_SPEND: '0.01' }, deps()))).at(-1);
  assert.equal(done.code, 402);
  assert.equal(done.data.code, 'SPEND_CAP');
});

test('GET /api/status says whether the writer can run, with no secrets', async () => {
  const get = (e) => handle(new Request('https://writer.example/api/status'), e).then((r) => r.json());
  assert.deepEqual(await get({}).then((d) => [d.ready, d.demo]), [false, false]);
  const ok = await get(env);
  assert.equal(ok.ready, true);
  assert.equal(ok.model, 'claude-sonnet-5-5');
  assert.equal(ok.maxSpend, 1);
  assert.ok(!JSON.stringify(ok).includes(TOKEN));
  assert.equal((await get({ WRITER_DEMO: '1' })).ready, true);
  assert.equal((await handle(new Request('https://writer.example/api/status', { method: 'POST' }), env)).status, 405);
});

test('demo mode needs no token or key and never calls the real model', async () => {
  const demoEnv = { WRITER_DEMO: '1' };
  const req = new Request('https://writer.example/api/write', { method: 'POST', body: JSON.stringify({ brief: H.brief() }) });
  const r = await handle(req, demoEnv, { llm: (await import('../src/core/demo.js')).createDemoLlm({ delayMs: 0 }) });
  assert.equal(r.status, 200);
  const data = await r.json();
  assert.equal(data.demo, true);
  assert.equal(data.status, 'green');
  const bad = new Request('https://writer.example/api/write', { method: 'POST', body: JSON.stringify({ brief: { site: 'example.com' } }) });
  const b = await handle(bad, demoEnv);
  assert.equal(b.status, 400);
  assert.match((await b.json()).error, /page.type/);
});
