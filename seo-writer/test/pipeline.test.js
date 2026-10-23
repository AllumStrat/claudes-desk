import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writePage, wordsTarget, normalizeSlug, RULES, WriterError } from '../src/core/pipeline.js';
import { normalizeBrief } from '../src/core/brief.js';
import { resolveConfig } from '../src/core/config.js';
import { LlmError } from '../src/core/llm.js';
import { parseFrontmatter } from '../src/core/check.js';
import { faqPairs } from '../src/core/copydoc.js';
import * as H from './helpers.js';

const answers = (over = {}) => ({ plan: H.plan(), draft: H.draftAnswer(), edit: H.editAnswer(), fix: () => assert.fail('no fix call expected'), ...over });
const net = () => H.fakeNet(H.nhtsaPage);
const steps = (llm) => llm.calls.map((c) => c.step);
const BROKEN = H.GREEN_BODY.replace('Phoenix heat is hard on brakes.', 'Phoenix heat — a crucial factor — is hard on brakes.');

test('a clean draft goes plan, draft, edit and comes out green', async () => {
  const llm = H.fakeLlm(answers());
  const r = await writePage(H.brief(), { llm, net: net() });
  assert.equal(r.status, 'green');
  assert.deepEqual(steps(llm), ['plan', 'draft', 'edit']);
  assert.equal(r.check.green, true);
  assert.deepEqual(r.sources.verified.map((s) => s.url), [H.NHTSA]);
  assert.deepEqual(r.confirms, ['does the owner want a starting price for front pads listed on the page?']);
  assert.equal(r.usage.calls, 3);
});

test('every call sends the same system prompt and effort, and caches the brief (and the plan once there is one)', async () => {
  const llm = H.fakeLlm(answers());
  await writePage(H.brief(), { llm, net: net() });
  const [plan, draft, edit] = llm.calls;
  assert.equal(new Set(llm.calls.map((c) => c.system)).size, 1);
  assert.deepEqual(plan.blocks.map((b) => Boolean(b.cache)), [true, false]);
  assert.deepEqual(draft.blocks.map((b) => Boolean(b.cache)), [true, true, false]);
  assert.equal(draft.blocks[0].text, edit.blocks[0].text);
  assert.equal(draft.blocks[1].text, edit.blocks[1].text);
  assert.deepEqual(llm.calls.map((c) => c.effort), ['medium', 'medium', 'medium']);
  assert.deepEqual(llm.calls.map((c) => c.key), ['plan', 'draft', 'edit']);
  assert.match(draft.blocks[2].text, /Answer in the "draft" field/);
});

test('the program writes the frontmatter from the plan and brief', async () => {
  const r = await writePage(H.brief(), { llm: H.fakeLlm(answers()), net: net() });
  const { fm, body } = parseFrontmatter(r.draft);
  assert.equal(fm.primary, 'brake repair norterra');
  assert.deepEqual(fm.variants, ['brake service in norterra', 'norterra brake shop', 'brake work near norterra']);
  assert.equal(fm.site, 'example-auto.com');
  assert.equal(fm.slug, '/norterra-brake-repair/');
  assert.equal(fm.title, 'Brake repair in Norterra | Example Auto');
  assert.equal(fm.words_target, '1000');
  assert.deepEqual(fm.competitors, ['rivalshop.com']);
  assert.ok(body.startsWith('# Brake repair in Norterra'));
});

test('FAILs go back to the model with the report until the check is green', async () => {
  const llm = H.fakeLlm(answers({ draft: H.draftAnswer(BROKEN), edit: H.editAnswer(BROKEN), fix: { body: H.GREEN_BODY, title: '', meta: '', changes: ['Removed the em dashes'], warn_notes: [] } }));
  const r = await writePage(H.brief(), { llm, net: net() });
  assert.deepEqual(steps(llm), ['plan', 'draft', 'edit', 'fix 1']);
  assert.match(llm.calls[3].blocks[2].text, /FAIL  voice\s+2 em dashes/);
  assert.equal(r.status, 'green');
  assert.equal(r.check.rounds, 1);
  assert.deepEqual(r.edits.changes, ['Removed the em dashes']);
  assert.equal(r.state.title, 'Brake repair in Norterra | Example Auto');
});

test('it stops after maxFixRounds and reports red', async () => {
  const llm = H.fakeLlm(answers({ edit: H.editAnswer(BROKEN), fix: { body: BROKEN, title: '', meta: '', changes: [], warn_notes: [] } }));
  const r = await writePage(H.brief(), { llm, net: net(), config: { maxFixRounds: 2 } });
  assert.deepEqual(steps(llm), ['plan', 'draft', 'edit', 'fix 1', 'fix 2']);
  assert.equal(r.status, 'red');
  assert.match(r.copyDoc, /still red after 2 fix rounds/);
});

test('a plan that says the site already owns the search stops before drafting', async () => {
  const llm = H.fakeLlm(answers({ plan: H.plan({ proceed: false, stop_reason: '/service/brakes/ already targets this search; this may be a rewrite.' }) }));
  const r = await writePage(H.brief(), { llm, net: net() });
  assert.equal(r.status, 'needs_decision');
  assert.deepEqual(steps(llm), ['plan']);
  assert.match(r.copyDoc, /Stopped before drafting/);
  assert.match(r.copyDoc, /already targets this search/);
});

test('failed sources get one retry call for replacements', async () => {
  const replacement = 'https://www.energy.gov/brakes';
  const pages = { [replacement]: { body: `<main><p>${H.NHTSA_QUOTE} for safety.</p></main>` } };
  const body = H.GREEN_BODY.replace(H.NHTSA, replacement);
  const llm = H.fakeLlm(
    answers({
      sources: { external_candidates: [{ url: replacement, claim: 'brakes matter', quote: H.NHTSA_QUOTE, source_rank: 1 }] },
      draft: H.draftAnswer(body),
      edit: H.editAnswer(body),
    }),
  );
  const r = await writePage(H.brief(), { llm, net: H.fakeNet(pages) });
  assert.deepEqual(steps(llm), ['plan', 'sources', 'draft', 'edit']);
  assert.match(llm.calls[1].blocks[1].text, /nhtsa\.gov.*returned 404/);
  assert.deepEqual(r.sources.verified.map((s) => s.url), [replacement]);
  assert.match(llm.calls[2].blocks[1].text, /Verified external sources/);
  assert.equal(r.status, 'green');
});

test('with no verified source the page links nothing external and that FAIL is not sent for fixing', async () => {
  const body = H.GREEN_BODY.replace(/\[NHTSA's brake safety guidance\]\([^)]+\)/, "NHTSA's brake safety guidance");
  const llm = H.fakeLlm(answers({ draft: H.draftAnswer(body), edit: H.editAnswer(body) }));
  const r = await writePage(H.brief(), { llm, net: null });
  assert.deepEqual(steps(llm), ['plan', 'draft', 'edit']);
  assert.match(llm.calls[1].blocks[1].text, /No external source passed verification/);
  assert.equal(r.status, 'green_except_unfixable');
  assert.match(r.check.unfixable[0][2], /0 external links/);
  assert.match(r.copyDoc, /Sources were not checked/);
});

test('the writer adds its own checks: links outside the brief, retired names, layout words', async () => {
  const body = H.GREEN_BODY.replace('Call the shop or book online', 'Click the hero button or visit [our tire page](/service/tires/). Example Brake & Muffler is now Example Auto. Call the shop or book online').replace(
    "[NHTSA's brake safety guidance](https://www.nhtsa.gov/equipment/brakes)",
    '[a made-up brake study](https://brakes.example/study)',
  );
  const llm = H.fakeLlm(answers({ edit: H.editAnswer(body), fix: { body: H.GREEN_BODY, title: '', meta: '', changes: ['fixed'], warn_notes: [] } }));
  const r = await writePage(H.brief({ retired_names: ['Example Brake & Muffler'] }), { llm, net: net() });
  const report = llm.calls[3].blocks[2].text;
  assert.match(report, /FAIL  writer\s+external link https:\/\/brakes\.example\/study is not a verified source/);
  assert.match(report, /FAIL  writer\s+internal link \/service\/tires\/ is not in the brief's page list/);
  assert.match(report, /FAIL  writer\s+retired name 'Example Brake & Muffler' appears/);
  assert.match(report, /WARN  writer\s+layout word in copy: 'hero'/);
  assert.equal(r.status, 'green');
});

test('sitemap pages count as internal pages the copy may link', async () => {
  const sitemap = '<urlset><url><loc>https://www.example-auto.com/service/tires/</loc></url><url><loc>https://other.example/x/</loc></url></urlset>';
  const body = H.GREEN_BODY.replace('Call the shop or book online', 'Ask about [tire rotation service](/service/tires/) too. Call the shop or book online');
  const llm = H.fakeLlm(answers({ draft: H.draftAnswer(body), edit: H.editAnswer(body) }));
  const r = await writePage(H.brief({ sitemap: true }), { llm, net: H.fakeNet({ ...H.nhtsaPage, 'https://example-auto.com/sitemap.xml': { body: sitemap } }) });
  assert.match(llm.calls[0].blocks[0].text, /"sitemap_urls": \[\n\s+"\/service\/tires\/"\n\s+\]/);
  assert.ok(!r.check.report.includes('writer'));
});

test('the competitor tier is planned, not built', async () => {
  await assert.rejects(writePage(H.brief(), { llm: H.fakeLlm(answers()), config: { research: 'competitors' } }), (e) => e instanceof WriterError && e.code === 'TIER_NOT_BUILT');
});

test('a failed call still reports what was spent', async () => {
  const llm = H.fakeLlm(answers({ draft: () => { throw new LlmError('REFUSED', 'declined'); } }));
  await assert.rejects(writePage(H.brief(), { llm, net: net() }), (e) => e.code === 'REFUSED' && e.usage.calls === 1 && /\| plan \|/.test(e.usageTable));
});

test('the length target comes from the brief or the type default, clamped to PARAMETERS.md', () => {
  const cfg = resolveConfig();
  const t = (page) => wordsTarget(normalizeBrief(H.brief({ page: { type: 'service', service: 'brakes', ...page } })), RULES.params, cfg);
  assert.deepEqual(t({ words_target: 1500 }), { n: 1500, source: 'the brief' });
  assert.equal(t({}).n, 1200);
  assert.equal(t({ words_target: 400 }).n, 900);
  assert.match(t({ words_target: 9000 }).source, /clamped to PARAMETERS.md content.words 900 to 2500/);
});

test('slugs are normalized to /a-b/', () => {
  assert.equal(normalizeSlug('Norterra Brake Repair'), '/norterra-brake-repair/');
  assert.equal(normalizeSlug('https://x.com/service/brakes'), '/service/brakes/');
  assert.equal(normalizeSlug('/a//b/'), '/a/b/');
});

test('the copy doc follows step 9 order and says nothing about design', async () => {
  const r = await writePage(H.brief(), { llm: H.fakeLlm(answers()), net: net() });
  const heads = [...r.copyDoc.matchAll(/^## (.+)$/gm)].map((m) => m[1]).filter((h) => /^\d\./.test(h));
  assert.deepEqual(heads, [
    '1. Search, intent and page type',
    '2. Keywords',
    '3. Top 3 study',
    '4. Metadata options',
    '5. Page copy',
    '6. Link plan',
    '7. Schema notes',
    '8. Anti-AI-writing fixes and check report',
  ]);
  const outsideCopy = r.copyDoc.replace(/````?markdown[\s\S]*?````?\n/, '');
  assert.doesNotMatch(outsideCopy, /\b(hero|layout|button|font|colou?r|mobile)\b/i);
  assert.match(r.copyDoc, /`Service`.*provider Example Auto and areaServed Norterra/);
  assert.match(r.copyDoc, /BreadcrumbList`: Home \(\/\) > Brake repair in Norterra \(\/norterra-brake-repair\/\)/);
  assert.match(r.copyDoc, /\| \/service\/brakes\/ \| We also do brake repair in Norterra\. \| brake repair in Norterra \|/);
  assert.match(r.copyDoc, /## Cost of this page/);
});

test('FAQPage answers match the visible copy', () => {
  const pairs = faqPairs(H.GREEN_BODY);
  assert.equal(pairs.length, 5);
  assert.deepEqual(pairs[1], { q: 'Do you work on trucks and SUVs?', a: 'Yes. We work on light trucks and SUVs, including half-ton pickups and three-row crossovers.' });
});
