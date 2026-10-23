// Runs one brief on several models, one after another, and writes a side by
// side summary: status, fix rounds, calls, words, [CONFIRM] tags and what each
// run cost. Stops before the next model once the spend cap is reached.

import { writePage } from './pipeline.js';
import { resolveConfig } from './config.js';

/**
 * @param {object} brief
 * @param {object} o
 * @param {string[]} o.models
 * @param {(config:object)=>{call:Function}} o.makeLlm   one client per model
 * @param {object} [o.net]
 * @param {number} [o.maxSpend]   dollars; no new run starts once this much is spent
 * @param {object} [o.config]     shared overrides (effort and so on)
 * @param {(model:string, step:string)=>void} [o.onProgress]
 */
export async function compareModels(brief, { models, makeLlm, net = null, maxSpend = 2, config = {}, onProgress = () => {} }) {
  const runs = [];
  let spent = 0;
  for (const model of models) {
    if (spent >= maxSpend) {
      runs.push({ model, skipped: `the $${maxSpend.toFixed(2)} cap was reached` });
      continue;
    }
    const cfg = resolveConfig({ ...config, model });
    const started = Date.now();
    try {
      const result = await writePage(brief, { llm: makeLlm(cfg), net, config: cfg, onProgress: (step) => onProgress(model, step) });
      spent += result.usage.cost;
      runs.push({ model, result, seconds: Math.round((Date.now() - started) / 1000) });
    } catch (err) {
      spent += err.usage?.cost || 0;
      runs.push({ model, error: `${err.code ? `${err.code}: ` : ''}${err.message}`, usage: err.usage, seconds: Math.round((Date.now() - started) / 1000) });
    }
  }
  return { runs, spent, summary: summarize(runs, spent) };
}

function summarize(runs, spent) {
  const cell = (r, f) => (r.skipped ? 'skipped' : r.error ? 'failed' : f(r));
  const rows = [
    ['Result', (r) => r.result.status.replace(/_/g, ' ')],
    ['Fix rounds', (r) => String(r.result.check?.rounds ?? '-')],
    ['API calls', (r) => String(r.result.usage.calls)],
    ['Words', (r) => String(r.result.check?.stats.words ?? '-')],
    ['FAILs left', (r) => String(r.result.check?.fails ?? '-')],
    ['WARNs', (r) => String(r.result.check?.results.filter((x) => x[0] === 'WARN').length ?? '-')],
    ['[CONFIRM] tags', (r) => String(r.result.confirms?.length ?? '-')],
    ['External sources kept', (r) => String(r.result.sources?.verified.length ?? '-')],
    ['Output tokens', (r) => String(r.result.usage.output_tokens)],
    ['Cost', (r) => `$${r.result.usage.cost.toFixed(4)}`],
    ['Time', (r) => `${r.seconds}s`],
  ];
  const out = ['# Model comparison', '', `| | ${runs.map((r) => r.model).join(' | ')} |`, `| --- | ${runs.map(() => '---:').join(' | ')} |`];
  for (const [label, f] of rows) out.push(`| ${label} | ${runs.map((r) => cell(r, f)).join(' | ')} |`);
  out.push('', `Total spent: $${spent.toFixed(4)}`, '');
  for (const r of runs) {
    if (r.error) out.push(`${r.model} failed: ${r.error}`);
    if (r.skipped) out.push(`${r.model} was skipped: ${r.skipped}`);
  }
  return out.join('\n');
}
