import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { renderModule } from '../scripts/sync-skill.js';

test('rules.generated.js matches the skill files in skill/', () => {
  const read = (f) => readFileSync(new URL(`../skill/${f}`, import.meta.url), 'utf8');
  const generated = readFileSync(new URL('../src/core/rules.generated.js', import.meta.url), 'utf8');
  assert.equal(generated, renderModule(read), 'run `npm run sync-skill` after changing skill/');
});
