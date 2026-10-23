import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handle, sameToken } from '../src/worker/index.js';
import * as H from './helpers.js';

const env = { WRITER_TOKEN: 'secret-token', ANTHROPIC_API_KEY: 'sk-test' };
const post = (body, token = 'secret-token') =>
  new Request('https://writer.example/api/write', { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: typeof body === 'string' ? body : JSON.stringify(body) });
const deps = () => ({ llm: H.fakeLlm({ plan: H.plan(), draft: H.draftAnswer(), edit: H.editAnswer() }), net: H.fakeNet(H.nhtsaPage) });

test('the token is required and compared in full', async () => {
  assert.equal((await handle(post({}, 'wrong'), env, deps())).status, 401);
  assert.equal((await handle(post({}, 'secret-token-longer'), env, deps())).status, 401);
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
