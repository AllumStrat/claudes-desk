// The JS port must print exactly what the skill's check.py prints. This runs
// the real check.py (vendored in skill/) on the same drafts; it skips when
// python3 is not installed.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkDraft } from '../src/core/check.js';
import { RULES } from '../src/core/pipeline.js';
import { fixture } from './helpers.js';

const CHECK_PY = fileURLToPath(new URL('../skill/seo-writing/scripts/check.py', import.meta.url));
const hasPython = spawnSync('python3', ['--version']).status === 0;
const dir = mkdtempSync(join(tmpdir(), 'seo-writer-parity-'));

function python(file, siblings = []) {
  const r = spawnSync('python3', ['-I', CHECK_PY, file, ...(siblings.length ? ['--siblings', ...siblings] : [])], { encoding: 'utf8' });
  return { out: r.stdout.trimEnd(), code: r.status };
}

const green = fixture('green-draft.md');
const red = fixture('red-draft.md');
const redFile = join(dir, 'red-draft.md');
writeFileSync(redFile, red);

// Each case is a draft check.py should judge a particular way.
const cases = {
  green,
  red,
  'no FAQ': green.replace(/## Frequently asked questions[\s\S]*?(?=## Book)/, ''),
  'em dash and banned words': green.replace('Phoenix heat is hard on brakes.', 'Phoenix heat — a crucial factor — is hard on brakes. We delve into it.'),
  'title case heading': green.replace('## Why brakes wear faster here', '## Why Brakes Wear Faster Here'),
  'skipped heading level': green.replace('### How long does brake repair in Norterra take?', '#### How long does brake repair in Norterra take?'),
  'long paragraph': green.replace('Phoenix heat is hard on brakes.', 'Phoenix heat is hard on brakes. It is hot. It is very hot. Pads wear. Rotors warp.'),
  'competitor link': green.replace('[NHTSA\'s brake safety guidance](https://www.nhtsa.gov/equipment/brakes)', '[a rival brake guide](https://rivalshop.com/brakes/)'),
  'short and missing secondary': green.replace(/## Why brakes wear faster here[\s\S]*?(?=## Signs)/, '').replace(/squealing brakes/gi, 'noisy pads'),
  'bad meta and slug': green.replace(/^meta: .*$/m, 'meta: Short.').replace(/^slug: .*$/m, 'slug: /brakes-page/'),
  'placeholder left': green.replace('The inspection is free.', 'The inspection is free [TODO] lorem ipsum.'),
  'bare string lists': green.replace(/^variants: .*$/m, 'variants: brake service in norterra').replace(/^secondary: .*$/m, 'secondary: brake pad replacement'),
};

for (const [name, draft] of Object.entries(cases)) {
  test(`check.js matches check.py: ${name}`, { skip: !hasPython && 'python3 not installed' }, async () => {
    const file = join(dir, `${name.replace(/\W+/g, '-')}.md`);
    writeFileSync(file, draft);
    const py = python(file);
    const js = await checkDraft(draft, RULES);
    assert.equal(js.report, py.out);
    assert.equal(js.green ? 0 : 1, py.code);
  });
}

test('check.js matches check.py: overlap against a sibling file', { skip: !hasPython && 'python3 not installed' }, async () => {
  const file = join(dir, 'with-sibling.md');
  writeFileSync(file, green);
  const greenSib = join(dir, 'green-sibling.md');
  writeFileSync(greenSib, green);
  const py = python(file, [redFile, greenSib]);
  const js = await checkDraft(green, { ...RULES, siblings: [{ name: redFile, markdown: red }, { name: greenSib, markdown: green }] });
  assert.equal(js.report, py.out);
});

test('the fixtures stay what they claim to be', async () => {
  assert.equal((await checkDraft(green, RULES)).green, true);
  assert.equal((await checkDraft(red, RULES)).green, false);
});
