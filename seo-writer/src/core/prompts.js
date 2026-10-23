// Prompts and output schemas for each call. The system prompt is the skill
// text itself plus a short note on how this tier differs, and it is
// byte-identical on every call so the prompt cache serves it after the first.

import { SEO_WRITING_SKILL, SEO_WRITING_PARAMETERS, ANTI_AI_WRITING_SKILL, COPYWRITING_SKILL } from './rules.generated.js';

const TIER_NOTES = `You are the writing engine of Allum Strategies' SEO content writer. You write web page copy for local businesses by following the seo-writing skill below as written, with the changes listed here for the content-only tier.

How this run differs from the skill
- Content only. Step 3 (study the top 3) does not run: no SERP pull, no serp.py, no competitor teardown, no dethrone plan. Never claim anything about what competing pages cover. The request gives you the length target; it replaces the serp.py median.
- Step 1's SERP fit check does not run. Judge ownership only from the site's page list in the brief.
- Step 2: use the keyword data in the brief when it has any. Otherwise suggest variants and secondary keywords from how customers phrase the search, and give their source as "suggested, no search data".
- Facts come only from the brief. When the page needs something the brief does not support, write an inline [CONFIRM: question for the owner] tag and draft around it. Never invent prices, warranties, turnaround times, certifications, years in business, review counts or ratings, staff names, awards or service areas.
- Internal links go only to URLs in the brief's internal page list, written exactly as listed. External links go only to sources the request marks as verified.
- You run no tools. The program runs check.py on your draft and sends back its report.
- Everything you return says what the page contains, never how it looks: no layout, hero, button, image, font, color or mobile notes. The copywriting skill's page-structure advice applies only to the order and content of the words.
- When sources disagree, this order wins: confirmed facts, then PARAMETERS.md, then anti-ai-writing, then copywriting. The copywriting skill's own examples use em dashes and exclamation marks; anti-ai-writing overrides them.
- Answer with only JSON. The answer schema has one field per step (plan, sources, draft, edit, fix); fill only the field the request names and set every other field to null. One schema serves every call so the prompt cache stays valid between steps.

Draft format
The program writes the frontmatter (primary, variants, secondary, type, site, slug, title, meta, words_target, competitors). You write the body: it starts with the single H1 line ("# ...") and holds everything under it as Markdown. Use ## and ### headings, "- " or "1. " lists and [anchor](url) links. The FAQ is an H2 whose text includes "questions" or "FAQ", with each question as an H3 and each answer as a paragraph whose first sentence answers it.`;

export const SYSTEM_PROMPT = [
  TIER_NOTES,
  `<skill name="seo-writing" file="SKILL.md">\n${SEO_WRITING_SKILL}\n</skill>`,
  `<skill name="seo-writing" file="PARAMETERS.md">\n${SEO_WRITING_PARAMETERS}\n</skill>`,
  `<skill name="anti-ai-writing" file="SKILL.md">\n${ANTI_AI_WRITING_SKILL}\n</skill>`,
  `<skill name="copywriting" file="SKILL.md">\n${COPYWRITING_SKILL}\n</skill>`,
].join('\n\n');

// ---------- schemas (structured outputs: every field required, no extras) ----------

const S = (type, extra = {}) => ({ type, ...extra });
const obj = (properties) => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });
const arr = (items) => ({ type: 'array', items });
const str = S('string');

const option = obj({ text: str, reason: str, recommended: S('boolean') });
const keyword = obj({ keyword: str, source: str });
const sourceCandidate = obj({ url: str, claim: str, quote: str, source_rank: S('integer') });

export const PLAN_SCHEMA = obj({
  search: str,
  intent: S('string', { enum: ['informational', 'commercial', 'transactional', 'local'] }),
  subtype: str,
  ownership_line: str,
  proceed: S('boolean'),
  stop_reason: str,
  slug: str,
  primary: keyword,
  variants: arr(keyword),
  secondary: arr(obj({ keyword: str, source: str, shares_intent: S('boolean') })),
  own_page_keywords: arr(obj({ keyword: str, why: str })),
  facts: arr(obj({ fact: str, source: str })),
  confirm_questions: arr(str),
  voice_of_customer: arr(str),
  conversion: obj({ action: str, url: str }),
  internal_links: arr(obj({ url: str, anchor: str, role: str })),
  external_candidates: arr(sourceCandidate),
  outline: arr(obj({ level: S('integer'), heading: str, words: S('integer'), carries: arr(str), list: S('boolean'), links: arr(str) })),
});

export const SOURCES_SCHEMA = obj({ external_candidates: arr(sourceCandidate) });

export const DRAFT_SCHEMA = obj({
  body: str,
  title_options: arr(option),
  meta: str,
  subhead_options: arr(option),
  cta_options: arr(option),
  inbound_edits: arr(obj({ page: str, sentence: str, anchor: str })),
});

export const EDIT_SCHEMA = obj({
  body: str,
  title: str,
  meta: str,
  title_options: arr(option),
  subhead_options: arr(option),
  cta_options: arr(option),
  fixes: arr(str),
  eeat: arr(obj({ signal: str, status: S('string', { enum: ['present', 'confirm'] }), where: str })),
});

export const FIX_SCHEMA = obj({
  body: str,
  title: str,
  meta: str,
  changes: arr(str),
  warn_notes: arr(obj({ warning: str, action: str })),
});

// One response format for every call. Changing output_config.format between
// requests breaks the prompt cache, so each step fills its own field and
// leaves the others null.
const nullable = (schema) => ({ anyOf: [schema, { type: 'null' }] });
export const STEP_SCHEMAS = { plan: PLAN_SCHEMA, sources: SOURCES_SCHEMA, draft: DRAFT_SCHEMA, edit: EDIT_SCHEMA, fix: FIX_SCHEMA };
export const RESPONSE_SCHEMA = obj(Object.fromEntries(Object.entries(STEP_SCHEMAS).map(([k, v]) => [k, nullable(v)])));

const answerIn = (key) => `\n\nAnswer in the "${key}" field and set every other field to null.`;

// ---------- per-call user content ----------

export function briefBlock(brief, ctx) {
  return [
    'Page brief (JSON). Everything you may state about the business is in here.',
    '```json',
    JSON.stringify({ ...brief, sitemap_urls: ctx.sitemapUrls || [] }, null, 2),
    '```',
    `Length target: ${ctx.wordsTarget} words (content.words limits ${ctx.params.content.words.join(' to ')}, tolerance ${ctx.params.length.tolerance}).`,
  ].join('\n');
}

export function planTask(ctx) {
  return `Run steps 1, 2, 4 and 5 of the seo-writing skill for this brief and return the plan.

- Set proceed to false only when a page in the internal page list or sitemap already targets this search (the job may be a rewrite) or the brief cannot support a page of this type; say why in stop_reason. Otherwise proceed is true and stop_reason is "".
- slug: ${ctx.brief.page.slug ? `use "${ctx.brief.page.slug}"` : "build it from the primary keyword's words in the site's existing URL pattern"}.
- Keywords: ${ctx.params.keywords.variants.join(' to ')} variants and ${ctx.params.keywords.secondary.join(' to ')} secondary keywords. List any secondary with its own intent under own_page_keywords instead.
- internal_links: the required targets for a ${ctx.brief.page.type} page from PARAMETERS.md, picked from the internal page list only, each with a descriptive anchor of ${ctx.params.internal.anchor_words.join(' to ')} words.
- external_candidates: up to 4 sources for claims the page will make, best rank first in PARAMETERS.md's source order. Only real pages you are confident exist, at their exact URL, with quote copied word for word from that page (under 15 words). The program fetches each one and keeps only those that load and contain the quote.${ctx.brief.external_sources.length ? ' Include the brief\'s external_sources first.' : ''}
- outline: every H2 and H3 with its word budget (budgets sum to the length target), the keywords it carries and its link URLs. Put an FAQ of the pair count PARAMETERS.md sets for this type.${answerIn('plan')}`;
}

export function sourcesTask(failed) {
  return `These external sources failed the program's check (the page did not load, or the quote was not on it):
${failed.map((f) => `- ${f.url}: ${f.reason}`).join('\n')}

Propose up to 3 replacement sources for the same claims, under the same rules: real pages at their exact URL, a quote copied word for word, PARAMETERS.md source order.${answerIn('sources')}`;
}

export function planBlock(plan, verified) {
  return [
    'The approved plan (JSON):',
    '```json',
    JSON.stringify(plan, null, 2),
    '```',
    verified.length
      ? `Verified external sources (the only external links allowed):\n${verified.map((s) => `- ${s.url} supports "${s.claim}" (quote: "${s.quote}")`).join('\n')}`
      : 'No external source passed verification. Write no external links; put a [CONFIRM: source for ...] tag on the one claim that most needs a source.',
  ].join('\n');
}

export function draftTask(ctx) {
  return `Run step 6 of the seo-writing skill: write the full page body from the plan, in the draft format.

- Land within ${ctx.params.length.tolerance * 100}% of ${ctx.wordsTarget} words of body copy.
- Return 2 or 3 options each for the title (at most ${ctx.params.metadata.title_max} characters, primary keyword in the first half, ending with " | ${ctx.brief.brand}"), the subhead and the main CTA sentence, each with a one-line reason and exactly one marked recommended.
- meta: ${ctx.params.metadata.meta.join(' to ')} characters of checkable facts with the primary keyword in it.
- inbound_edits: at least ${ctx.params.internal.inbound_min} existing pages from the internal page list that should link to this page, each with a sentence to add or change and the anchor to wrap. Never the conversion page.${answerIn('draft')}`;
}

export function draftBlock(label, d) {
  return [`${label}:`, `title: ${d.title}`, `meta: ${d.meta}`, '', d.body].join('\n');
}

export function editTask(draft) {
  return `${draftBlock('Draft to edit', draft)}

Current options (JSON): ${JSON.stringify({ title_options: draft.title_options, subhead_options: draft.subhead_options, cta_options: draft.cta_options })}

Run step 7 of the seo-writing skill: put every word through the anti-ai-writing skill (title, meta, headings, body, lists, FAQ, anchors), working its if/then checks paragraph by paragraph, then recheck the options. Keep the keywords, links, heading structure, [CONFIRM] tags and length. Return the edited body, the recommended title and the meta, the revised options, and a short list of the notable fixes.

Then, for step 8, mark each E-E-A-T signal (first-hand experience, expertise, authority, trust: who does the work, credentials, how long, proof, contact and location details) as present on the page, saying where, or as confirm when it rests on a [CONFIRM] tag.${answerIn('edit')}`;
}

export function fixTask(draft, report, unfixable) {
  return `${draftBlock('Current draft', draft)}

check.py report:
\`\`\`
${report}
\`\`\`

Step 8: fix every FAIL in the body, title or meta and return the whole corrected body. For each WARN, fix it or give the reason it stands in warn_notes. Keep everything that passes as it is.${
    unfixable.length ? `\nThese cannot be fixed by editing the copy; leave them and do not add links to get around them: ${unfixable.join('; ')}.` : ''
  }${answerIn('fix')}`;
}
