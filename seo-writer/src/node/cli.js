#!/usr/bin/env node
// Write one page from a brief:
//   npm run write -- brief.json [--out dir] [--live] [--effort draft=high] [--no-fallbacks]
// Needs ANTHROPIC_API_KEY in the environment. Writes the copy doc and a
// usage log to the out folder and prints the check report and cost.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { writePage } from '../core/pipeline.js';
import { createClaude } from '../core/llm.js';
import { resolveConfig } from '../core/config.js';
import { createNet } from '../core/net.js';
import { copyDocName } from '../core/copydoc.js';
import { createNodeNetwork } from './net.js';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    out: { type: 'string', default: 'out' },
    live: { type: 'boolean', default: false },
    offline: { type: 'boolean', default: false },
    effort: { type: 'string', multiple: true, default: [] },
    'max-fix-rounds': { type: 'string' },
    'no-fallbacks': { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h', default: false },
  },
});

if (values.help || positionals.length !== 1) {
  console.log(`Usage: npm run write -- brief.json [--out dir] [--live] [--offline]
  --live               also check that every link in the copy loads (check.py --live)
  --offline            no network: no sitemap, sibling or source checks (and no external links)
  --effort step=level  per-step effort, e.g. --effort draft=high (plan, draft, edit, fix, sources)
  --max-fix-rounds n   check-and-fix rounds before giving up (default 3)
  --no-fallbacks       turn off the server-side refusal fallback
Needs ANTHROPIC_API_KEY.`);
  process.exit(values.help ? 0 : 2);
}

if (!process.env.ANTHROPIC_API_KEY) {
  console.error('ANTHROPIC_API_KEY is not set. The writer calls the Claude API, so it needs a key.');
  process.exit(2);
}

const effort = Object.fromEntries(values.effort.map((e) => e.split('=')));
const config = resolveConfig({
  effort,
  ...(values['max-fix-rounds'] ? { maxFixRounds: Number(values['max-fix-rounds']) } : {}),
  ...(values['no-fallbacks'] ? { fallbacks: false } : {}),
});

const brief = JSON.parse(await readFile(resolve(positionals[0]), 'utf8'));
const net = values.offline ? null : createNet(createNodeNetwork());
const llm = createClaude({ config });
const started = Date.now();

try {
  const r = await writePage(brief, { llm, net, live: values.live, config, onProgress: (step) => console.error(`… ${step}`) });
  await mkdir(values.out, { recursive: true });
  const name = copyDocName(r);
  await writeFile(join(values.out, name), r.copyDoc);
  await writeFile(join(values.out, name.replace(/-copy\.md$/, '-usage.json')), JSON.stringify({ model: config.model, seconds: Math.round((Date.now() - started) / 1000), ...r.usage, usageTable: r.usageTable }, null, 2));
  if (r.check) console.log(r.check.report);
  console.log(`\n${r.status === 'needs_decision' ? `Stopped before drafting: ${r.plan.stop_reason}` : `Status: ${r.status}`}`);
  console.log(`Copy doc: ${join(values.out, name)}`);
  console.log(`Cost: $${r.usage.cost.toFixed(4)} over ${r.usage.calls} calls (${Math.round((Date.now() - started) / 1000)}s)`);
  process.exit(r.status === 'red' ? 1 : 0);
} catch (err) {
  console.error(`Failed${err.code ? ` (${err.code})` : ''}: ${err.message}`);
  if (err.usageTable) console.error(`\nSpent before the failure:\n${err.usageTable}`);
  process.exit(1);
}
