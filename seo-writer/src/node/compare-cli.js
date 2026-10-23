#!/usr/bin/env node
// Write the same page on several models and compare:
//   npm run compare -- brief.json [--models claude-sonnet-5-5,claude-haiku-5-5] [--out out/compare] [--max-spend 2]
// Needs ANTHROPIC_API_KEY. Saves each model's copy doc and comparison.md.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { compareModels } from '../core/compare.js';
import { createClaude } from '../core/llm.js';
import { createNet } from '../core/net.js';
import { copyDocName } from '../core/copydoc.js';
import { PRICING } from '../core/config.js';
import { createNodeNetwork } from './net.js';
import { outPath } from './paths.js';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    models: { type: 'string', default: 'claude-sonnet-5-5,claude-haiku-5-5' },
    out: { type: 'string', default: 'out/compare' },
    'max-spend': { type: 'string', default: '2' },
  },
});
if (positionals.length !== 1) {
  console.log('Usage: npm run compare -- brief.json [--models a,b] [--out dir] [--max-spend dollars]');
  process.exit(2);
}
if (!process.env.ANTHROPIC_API_KEY) {
  console.error('ANTHROPIC_API_KEY is not set. The writer calls the Claude API, so it needs a key.');
  process.exit(2);
}
const models = values.models.split(',').map((m) => m.trim()).filter(Boolean);
const unknown = models.filter((m) => !PRICING[m]);
if (unknown.length) {
  console.error(`Unknown model: ${unknown.join(', ')}. Use: ${Object.keys(PRICING).join(', ')}`);
  process.exit(2);
}

const brief = JSON.parse(await readFile(resolve(positionals[0]), 'utf8'));
const { runs, summary } = await compareModels(brief, {
  models,
  makeLlm: (config) => createClaude({ config }),
  net: createNet(createNodeNetwork()),
  maxSpend: Number(values['max-spend']),
  onProgress: (model, step) => console.error(`… ${model}: ${step}`),
});
await mkdir(values.out, { recursive: true });
for (const r of runs) {
  if (!r.result) continue;
  await writeFile(outPath(values.out, `${r.model}-${copyDocName(r.result)}`), r.result.copyDoc);
}
await writeFile(join(values.out, 'comparison.md'), summary);
console.log(summary);
