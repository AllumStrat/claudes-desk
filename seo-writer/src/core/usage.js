// Token usage per call and what it cost, so the price of a page is measured
// rather than guessed.

import { PRICING } from './config.js';

export function costOf(usage, model) {
  const p = PRICING[model];
  if (!p) return null;
  const m = 1_000_000;
  return (
    ((usage.input_tokens || 0) * p.input +
      (usage.cache_creation_input_tokens || 0) * p.cacheWrite +
      (usage.cache_read_input_tokens || 0) * p.cacheRead +
      (usage.output_tokens || 0) * p.output) /
    m
  );
}

export class UsageLog {
  constructor(model) {
    this.model = model;
    this.calls = [];
  }

  add(step, usage, model = this.model) {
    const row = {
      step,
      model,
      input_tokens: usage?.input_tokens || 0,
      cache_creation_input_tokens: usage?.cache_creation_input_tokens || 0,
      cache_read_input_tokens: usage?.cache_read_input_tokens || 0,
      output_tokens: usage?.output_tokens || 0,
      thinking_tokens: usage?.output_tokens_details?.thinking_tokens ?? null,
    };
    row.cost = costOf(row, model);
    this.calls.push(row);
    return row;
  }

  totals() {
    const t = { calls: this.calls.length, input_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 0, thinking_tokens: 0, cost: 0 };
    for (const c of this.calls) {
      for (const k of ['input_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens', 'output_tokens']) t[k] += c[k];
      t.thinking_tokens += c.thinking_tokens || 0;
      t.cost += c.cost || 0;
    }
    return t;
  }

  table() {
    const rows = ['| Step | Input | Cache write | Cache read | Output (thinking) | Cost |', '| --- | ---: | ---: | ---: | ---: | ---: |'];
    const fmt = (c) =>
      `| ${c.step} | ${c.input_tokens} | ${c.cache_creation_input_tokens} | ${c.cache_read_input_tokens} | ${c.output_tokens}${c.thinking_tokens != null ? ` (${c.thinking_tokens})` : ''} | $${(c.cost || 0).toFixed(4)} |`;
    for (const c of this.calls) rows.push(fmt(c));
    const t = this.totals();
    rows.push(fmt({ ...t, step: '**Total**', thinking_tokens: t.thinking_tokens || null }));
    return rows.join('\n');
  }
}
