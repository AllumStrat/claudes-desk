import { test } from 'node:test';
import assert from 'node:assert/strict';
import { costOf, UsageLog } from '../src/core/usage.js';

test('cost uses Sonnet 5.5 prices: $2 in, $10 out, cache write 1.25x, read 0.1x', () => {
  const c = costOf({ input_tokens: 1_000_000, output_tokens: 1_000_000, cache_creation_input_tokens: 1_000_000, cache_read_input_tokens: 1_000_000 }, 'claude-sonnet-5-5');
  assert.equal(c, 2 + 10 + 2.5 + 0.2);
  assert.equal(costOf({}, 'unknown-model'), null);
});

test('the log totals every call and prints a table', () => {
  const log = new UsageLog('claude-sonnet-5-5');
  log.add('plan', { input_tokens: 1000, cache_creation_input_tokens: 10_000, output_tokens: 2000, output_tokens_details: { thinking_tokens: 500 } });
  log.add('draft', { input_tokens: 1000, cache_read_input_tokens: 10_000, output_tokens: 4000 });
  const t = log.totals();
  assert.equal(t.calls, 2);
  assert.equal(t.output_tokens, 6000);
  assert.equal(t.thinking_tokens, 500);
  assert.ok(Math.abs(t.cost - (0.002 + 0.025 + 0.02 + 0.002 + 0.002 + 0.04)) < 1e-9);
  assert.match(log.table(), /\| plan \| 1000 \| 10000 \| 0 \| 2000 \(500\) \|/);
  assert.match(log.table(), /\*\*Total\*\*/);
});

test('after a server-side fallback every attempt is costed at its own model', () => {
  const log = new UsageLog('claude-sonnet-5-5');
  // Sonnet 5.5 declined mid-stream, Sonnet 5 answered. Top-level usage is the answering attempt only.
  const row = log.add(
    'draft',
    {
      input_tokens: 2000,
      output_tokens: 3000,
      iterations: [
        { type: 'message', model: 'claude-sonnet-5-5', input_tokens: 2000, cache_creation_input_tokens: 0, cache_read_input_tokens: 10_000, output_tokens: 1000 },
        { type: 'fallback_message', model: 'claude-sonnet-5', input_tokens: 2000, cache_creation_input_tokens: 10_000, cache_read_input_tokens: 0, output_tokens: 3000 },
      ],
    },
    'claude-sonnet-5',
  );
  assert.equal(row.fallback, true);
  assert.equal(row.output_tokens, 4000);
  const want = (2000 * 2 + 10_000 * 0.2 + 1000 * 10 + 2000 * 2 + 10_000 * 2.5 + 3000 * 10) / 1e6;
  assert.ok(Math.abs(row.cost - want) < 1e-12);
  assert.match(log.table(), /\| draft \(fallback\) \|/);
});

test('a model with no price is costed at the requested model, never at zero', () => {
  const row = new UsageLog('claude-sonnet-5-5').add('plan', { input_tokens: 1_000_000 }, 'claude-some-new-model');
  assert.equal(row.cost, 2);
});
