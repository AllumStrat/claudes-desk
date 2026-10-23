#!/usr/bin/env node
// The check.py port on its own, for a draft written by hand or by Claude Code:
//   npm run check -- draft.md [--live] [--siblings a.md b.md https://site/page/]
// Prints the same report check.py prints and exits 1 when it is red.

import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { checkDraft } from '../core/check.js';
import { RULES } from '../core/pipeline.js';
import { createNet } from '../core/net.js';
import { createNodeNetwork } from './net.js';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { live: { type: 'boolean', default: false }, siblings: { type: 'string', multiple: true, default: [] } },
});
const files = [...positionals];
const draftPath = files.shift();
if (!draftPath) {
  console.log('Usage: npm run check -- draft.md [--live] [--siblings a.md https://site/page/ ...]');
  process.exit(2);
}
// parseArgs takes one value per --siblings; extra positionals after the draft are siblings too.
const sibs = [...values.siblings, ...files];
const net = values.live || sibs.some((s) => /^https?:/.test(s)) ? createNet(createNodeNetwork()) : null;
const siblings = await Promise.all(
  sibs.map(async (s) => {
    if (!/^https?:/.test(s)) return { name: s, markdown: await readFile(s, 'utf8') };
    try {
      const r = await net.fetchPage(s);
      return r.status === 200 ? { name: s, html: r.body } : { name: s, error: `HTTP ${r.status}` };
    } catch (e) {
      return { name: s, error: e.message };
    }
  }),
);
const r = await checkDraft(await readFile(draftPath, 'utf8'), { ...RULES, status: values.live ? net.status : null, siblings });
console.log(r.report);
process.exit(r.green ? 0 : 1);
