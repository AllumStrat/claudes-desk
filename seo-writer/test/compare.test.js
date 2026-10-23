import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compareModels } from '../src/core/compare.js';
import { resolveConfig } from '../src/core/config.js';
import { buildRequest } from '../src/core/llm.js';
import { costOf } from '../src/core/usage.js';
import * as H from './helpers.js';

const answers = () => ({ plan: H.plan(), draft: H.draftAnswer(), edit: H.editAnswer() });

test('one brief runs on each model and the summary sets them side by side', async () => {
  const seen = [];
  const r = await compareModels(H.brief(), {
    models: ['claude-sonnet-5-5', 'claude-haiku-5-5'],
    makeLlm: (config) => {
      seen.push(config.model);
      return H.fakeLlm(answers());
    },
    net: H.fakeNet(H.nhtsaPage),
  });
  assert.deepEqual(seen, ['claude-sonnet-5-5', 'claude-haiku-5-5']);
  assert.equal(r.runs.length, 2);
  assert.match(r.summary, /\| \| claude-sonnet-5-5 \| claude-haiku-5-5 \|/);
  assert.match(r.summary, /\| Result \| green \| green \|/);
  assert.match(r.summary, /\| Fix rounds \| 0 \| 0 \|/);
});

test('no new run starts once the spend cap is reached', async () => {
  const r = await compareModels(H.brief(), { models: ['claude-sonnet-5-5', 'claude-haiku-5-5'], makeLlm: () => H.fakeLlm(answers()), net: H.fakeNet(H.nhtsaPage), maxSpend: 0.01 });
  assert.ok(r.runs[0].result);
  assert.match(r.runs[1].skipped, /cap/);
  assert.match(r.summary, /claude-haiku-5-5 was skipped/);
});

test('a failed run is reported and the next one still runs', async () => {
  let n = 0;
  const r = await compareModels(H.brief(), {
    models: ['claude-sonnet-5-5', 'claude-haiku-5-5'],
    makeLlm: () => (n++ === 0 ? H.fakeLlm({ plan: () => { throw new Error('boom'); } }) : H.fakeLlm(answers())),
    net: H.fakeNet(H.nhtsaPage),
  });
  assert.match(r.runs[0].error, /boom/);
  assert.equal(r.runs[1].result.status, 'green');
});

test('Haiku 5.5 is priced and gets no server-side fallback', () => {
  const haiku = resolveConfig({ model: 'claude-haiku-5-5' });
  const req = buildRequest({ system: 's', blocks: [{ text: 't' }], effort: 'medium', config: haiku });
  assert.equal(req.model, 'claude-haiku-5-5');
  assert.equal(req.fallbacks, undefined);
  assert.equal(req.betas, undefined);
  assert.equal(costOf({ input_tokens: 1e6, output_tokens: 1e6 }, 'claude-haiku-5-5'), 0.6);
  assert.throws(() => resolveConfig({ model: 'claude-made-up' }), /Unknown model/);
});
