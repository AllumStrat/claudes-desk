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
