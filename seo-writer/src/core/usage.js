// Token usage per call and what it cost, so the price of a page is measured
// rather than guessed.

import { PRICING, FALLBACK_PRICING } from './config.js';

const TOKENS = ['input_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens', 'output_tokens'];

export function costOf(usage, model) {
  const p = PRICING[model] || FALLBACK_PRICING[model];
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

  /**
   * After a server-side fallback, top-level usage covers only the attempt
   * that answered; usage.iterations has every attempt, each billed at its
   * own model's rates. So when iterations are there, they are what counts.
   */
  add(step, usage, model = this.model) {
    const price = (u, m) => costOf(u, m) ?? costOf(u, this.model) ?? 0;
    const attempts = (usage?.iterations || []).filter((it) => it && (it.type === 'message' || it.type === 'fallback_message'));
    const row = { step, model, thinking_tokens: usage?.output_tokens_details?.thinking_tokens ?? null };
    if (attempts.length) {
      for (const k of TOKENS) row[k] = attempts.reduce((n, it) => n + (it[k] || 0), 0);
      row.cost = attempts.reduce((n, it) => n + price(it, it.model || model), 0);
      if (attempts.some((it) => it.type === 'fallback_message')) row.fallback = true;
    } else {
      for (const k of TOKENS) row[k] = usage?.[k] || 0;
      row.cost = price(row, model);
    }
    this.calls.push(row);
    return row;
  }

  totals() {
    const t = { calls: this.calls.length, input_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 0, thinking_tokens: 0, cost: 0 };
    for (const c of this.calls) {
      for (const k of TOKENS) t[k] += c[k];
      t.thinking_tokens += c.thinking_tokens || 0;
      t.cost += c.cost || 0;
    }
    return t;
  }

  table() {
    const rows = ['| Step | Input | Cache write | Cache read | Output (thinking) | Cost |', '| --- | ---: | ---: | ---: | ---: | ---: |'];
    const fmt = (c) =>
      `| ${c.step}${c.fallback ? ' (fallback)' : ''} | ${c.input_tokens} | ${c.cache_creation_input_tokens} | ${c.cache_read_input_tokens} | ${c.output_tokens}${c.thinking_tokens != null ? ` (${c.thinking_tokens})` : ''} | $${(c.cost || 0).toFixed(4)} |`;
    for (const c of this.calls) rows.push(fmt(c));
    const t = this.totals();
    rows.push(fmt({ ...t, step: '**Total**', thinking_tokens: t.thinking_tokens || null }));
    return rows.join('\n');
  }
}
