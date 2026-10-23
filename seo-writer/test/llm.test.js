import { test } from 'node:test';
import assert from 'node:assert/strict';
import Anthropic from '@anthropic-ai/sdk';
import { buildRequest, readAnswer, createClaude, LlmError } from '../src/core/llm.js';
import { resolveConfig } from '../src/core/config.js';
import { SYSTEM_PROMPT, RESPONSE_SCHEMA, STEP_SCHEMAS } from '../src/core/prompts.js';

const config = resolveConfig();
const req = () => buildRequest({ system: SYSTEM_PROMPT, blocks: [{ text: 'brief', cache: true }, { text: 'plan', cache: true }, { text: 'task' }], effort: 'medium', config });

test('requests use Sonnet 5.5 with adaptive thinking and a JSON schema', () => {
  const r = req();
  assert.equal(r.model, 'claude-sonnet-5-5');
  assert.deepEqual(r.thinking, { type: 'adaptive' });
  assert.equal(r.output_config.effort, 'medium');
  assert.deepEqual(r.output_config.format, { type: 'json_schema', schema: RESPONSE_SCHEMA });
  assert.equal(r.tool_choice, undefined);
  assert.equal(r.temperature, undefined);
});

test('the rules prefix and stable blocks carry cache breakpoints, at most 4', () => {
  const r = req();
  assert.deepEqual(r.system[0].cache_control, { type: 'ephemeral' });
  const marks = r.messages[0].content.map((b) => Boolean(b.cache_control));
  assert.deepEqual(marks, [true, true, false]);
  assert.ok(1 + marks.filter(Boolean).length <= 4);
});

test('one response schema serves every step, each field nullable', () => {
  assert.deepEqual(Object.keys(RESPONSE_SCHEMA.properties), Object.keys(STEP_SCHEMAS));
  assert.deepEqual(RESPONSE_SCHEMA.required, Object.keys(STEP_SCHEMAS));
  for (const [k, v] of Object.entries(STEP_SCHEMAS)) assert.deepEqual(RESPONSE_SCHEMA.properties[k].anyOf, [v, { type: 'null' }]);
});

test('the system prompt is identical on every call and long enough to cache', () => {
  assert.equal(req().system[0].text, req().system[0].text);
  // Sonnet 5.5 caches prefixes of 512 tokens or more; the skills run far past that.
  assert.ok(SYSTEM_PROMPT.length > 20_000);
});

test('fallbacks are on by default and can be turned off', () => {
  assert.deepEqual(req().betas, ['server-side-fallback-2026-07-01']);
  assert.equal(req().fallbacks, 'default');
  const off = buildRequest({ system: 's', blocks: [{ text: 't' }], effort: 'low', config: resolveConfig({ fallbacks: false }) });
  assert.equal(off.betas, undefined);
  assert.equal(off.fallbacks, undefined);
});

test('readAnswer parses the JSON text', () => {
  assert.deepEqual(readAnswer({ stop_reason: 'end_turn', content: [{ type: 'thinking', thinking: '' }, { type: 'text', text: '{"a":1}' }] }), { a: 1 });
});

test('readAnswer reads only the text after the last fallback block', () => {
  const msg = { stop_reason: 'end_turn', content: [{ type: 'text', text: '{"partial":' }, { type: 'fallback' }, { type: 'text', text: '{"b":2}' }] };
  assert.deepEqual(readAnswer(msg), { b: 2 });
});

test('readAnswer turns refusals, truncation and bad JSON into LlmErrors', () => {
  assert.throws(() => readAnswer({ stop_reason: 'refusal', stop_details: { category: 'cyber' }, content: [] }), (e) => e instanceof LlmError && e.code === 'REFUSED');
  assert.throws(() => readAnswer({ stop_reason: 'max_tokens', content: [] }), (e) => e.code === 'TRUNCATED');
  assert.throws(() => readAnswer({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'not json' }] }), (e) => e.code === 'BAD_JSON');
});

function fakeClient(result) {
  const sent = [];
  const options = [];
  return {
    sent,
    options,
    beta: {
      messages: {
        stream(params, opts) {
          sent.push(params);
          options.push(opts);
          return {
            finalMessage: async () => {
              if (result instanceof Error) throw result;
              return result;
            },
          };
        },
      },
    },
  };
}

test('createClaude streams the request and returns data, usage and model', async () => {
  const client = fakeClient({ stop_reason: 'end_turn', model: 'claude-sonnet-5-5', usage: { input_tokens: 5, output_tokens: 7 }, content: [{ type: 'text', text: '{"ok":true}' }] });
  const llm = createClaude({ config, client });
  const r = await llm.call({ step: 'plan', system: 'sys', blocks: [{ text: 'b' }], effort: 'low' });
  assert.deepEqual(r, { data: { ok: true }, usage: { input_tokens: 5, output_tokens: 7 }, model: 'claude-sonnet-5-5' });
  assert.equal(client.sent[0].output_config.effort, 'low');
});

test('createClaude returns the step field and refuses an empty one', async () => {
  const msg = (o) => ({ stop_reason: 'end_turn', usage: {}, content: [{ type: 'text', text: JSON.stringify(o) }] });
  const llm = createClaude({ config, client: fakeClient(msg({ plan: null, draft: { body: '# Hi' } })) });
  assert.deepEqual((await llm.call({ step: 'draft', key: 'draft', system: 's', blocks: [{ text: 'b' }], effort: 'medium' })).data, { body: '# Hi' });
  await assert.rejects(llm.call({ step: 'plan', key: 'plan', system: 's', blocks: [{ text: 'b' }], effort: 'medium' }), (e) => e.code === 'BAD_JSON');
});

test('createClaude maps API errors to plain codes', async () => {
  const cases = [
    [new Anthropic.AuthenticationError(401, {}, 'bad key', new Headers()), 'AUTH'],
    [new Anthropic.RateLimitError(429, {}, 'slow down', new Headers()), 'RATE_LIMIT'],
    [new Anthropic.BadRequestError(400, {}, 'bad', new Headers()), 'BAD_REQUEST'],
    [new Anthropic.InternalServerError(500, {}, 'oops', new Headers()), 'API'],
  ];
  for (const [err, code] of cases) {
    const llm = createClaude({ config, client: fakeClient(err) });
    await assert.rejects(llm.call({ step: 'draft', system: 's', blocks: [{ text: 'b' }], effort: 'low' }), (e) => e.code === code && e.step === 'draft');
  }
});

test('createClaude passes the abort signal to the stream and reports a cancel as ABORTED', async () => {
  const controller = new AbortController();
  const ok = fakeClient({ stop_reason: 'end_turn', usage: {}, content: [{ type: 'text', text: '{"a":1}' }] });
  await createClaude({ config, client: ok }).call({ step: 'plan', system: 's', blocks: [{ text: 'b' }], effort: 'low', signal: controller.signal });
  assert.equal(ok.options[0].signal, controller.signal);
  const cancelled = fakeClient(new Anthropic.APIUserAbortError());
  await assert.rejects(createClaude({ config, client: cancelled }).call({ step: 'draft', system: 's', blocks: [{ text: 'b' }], effort: 'low', signal: controller.signal }), (e) => e.code === 'ABORTED');
});
