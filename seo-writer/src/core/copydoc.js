// Step 9: the copy doc, in the order SKILL.md sets. It says what the page
// contains and nothing about how it looks: no layout, hero, button, image,
// font or color notes.

import { parseFrontmatter, stripMd, findLinks } from './check.js';
import { clientSlug } from './brief.js';

const esc = (s) => String(s ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
const table = (head, rows) => (rows.length ? [`| ${head.join(' | ')} |`, `| ${head.map(() => '---').join(' | ')} |`, ...rows.map((r) => `| ${r.map(esc).join(' | ')} |`)].join('\n') : '_None._');
const fence = (text, lang = '') => {
  const ticks = '`'.repeat(Math.max(3, ...[...String(text).matchAll(/`{3,}/g)].map((m) => m[0].length + 1)));
  return `${ticks}${lang}\n${String(text).trimEnd()}\n${ticks}`;
};

/** [client]-[slug]-copy.md, made only of a-z, 0-9 and dashes, so it is always a bare file name. */
export function copyDocName(result) {
  const slug = clientSlug((result.plan?.slug || '/page/').replace(/\//g, '-'), 200) || 'home';
  return `${clientSlug(result.brief.client) || 'client'}-${slug}-copy.md`;
}

/**
 * The copy doc is Markdown that may one day be shown as HTML. Model text
 * outside the fenced blocks (plan notes, fixes, options, questions) is
 * written with '<' escaped, so nothing in it can render as a tag.
 */
export function escapeOutsideFences(doc) {
  let fenceTicks = 0;
  return doc
    .split('\n')
    .map((line) => {
      const m = /^(`{3,})/.exec(line);
      if (fenceTicks) {
        if (m && m[1].length >= fenceTicks && line.trim() === m[1]) fenceTicks = 0;
        return line;
      }
      if (m) {
        fenceTicks = m[1].length;
        return line;
      }
      return line.replace(/</g, '&lt;');
    })
    .join('\n');
}

export function buildCopyDoc(result) {
  return escapeOutsideFences(copyDocText(result));
}

function copyDocText(result) {
  const { brief, plan, target } = result;
  const out = [];
  const primary = plan.primary?.keyword || brief.page.primary;
  out.push(`# ${brief.business}: ${primary} (copy doc)`, '');
  out.push(`Written by the Allum SEO writer, content-only tier: the page is built from the brief alone, with no competitor study. ${statusLine(result)}`, '');

  // 1. step 1
  out.push('## 1. Search, intent and page type', '');
  out.push(`- Search: ${plan.search}`);
  out.push(`- Intent: ${plan.intent}${plan.subtype ? ` (${plan.subtype})` : ''}`);
  out.push(`- Page type: ${brief.page.type}`);
  out.push(`- Ownership: ${plan.ownership_line}`);
  out.push('- SERP fit: not checked in the content-only tier.', '');
  if (result.status === 'needs_decision') {
    out.push('## Stopped before drafting', '', plan.stop_reason || 'The planner flagged a decision before drafting.', '');
    out.push(...keywordSection(brief, plan), ...costSection(result));
    return out.join('\n');
  }

  // 2. step 2
  out.push(...keywordSection(brief, plan));

  // 3. step 3
  out.push('## 3. Top 3 study', '');
  out.push(`Skipped in the content-only tier: no teardowns, serp.py table or dethrone plan. Length target ${target.n} words, from ${target.source}.`, '');

  // 4. metadata options
  const s = result.state;
  out.push('## 4. Metadata options', '');
  out.push(`Recommended title (${s.title.length} characters): ${s.title}`, '');
  out.push(`Meta description (${s.meta.length} characters): ${s.meta}`, '');
  for (const [label, opts] of [
    ['Title options', s.title_options],
    ['Subhead options', s.subhead_options],
    ['Main CTA options', s.cta_options],
  ]) {
    out.push(`${label}:`, '');
    for (const o of opts || []) out.push(`- ${o.recommended ? '(recommended) ' : ''}${o.text}. ${o.reason}`);
    out.push('');
  }

  // 5. page copy
  out.push('## 5. Page copy', '', fence(result.draft, 'markdown'), '');

  // 6. link plan
  const { body } = parseFrontmatter(result.draft);
  const links = findLinks(body).map((l) => [l.anchor, l.url]);
  const internal = links.filter(([, u]) => !/^https?:\/\//i.test(u) || u.includes(`//${brief.site}`) || u.includes(`.${brief.site}`));
  const verified = result.sources?.verified || [];
  const used = new Set(links.map(([, u]) => u.replace(/\/+$/, '').toLowerCase()));
  out.push('## 6. Link plan', '', 'Internal links out:', '');
  out.push(table(['Anchor', 'URL'], internal), '');
  out.push('External links, each with the claim it supports and the line on the source that supports it:', '');
  out.push(
    table(
      ['URL', 'Claim', 'Supporting line', 'On the page'],
      verified.map((v) => [v.url, v.claim, `"${v.quote}"`, used.has(v.url.replace(/\/+$/, '').toLowerCase()) ? 'yes' : 'no']),
    ),
    '',
  );
  if (!result.sources?.checked) out.push('Sources were not checked (no network), so the page carries no external link.', '');
  if (result.sources?.failed?.length) {
    out.push('Sources proposed but dropped:', '');
    for (const f of result.sources.failed) out.push(`- ${f.url}: ${f.reason}`);
    out.push('');
  }
  out.push('Inbound edits (existing pages to change so they link here):', '');
  out.push(table(['Page', 'Sentence', 'Anchor to wrap'], (result.inboundEdits || []).map((r) => [r.page, r.sentence, r.anchor])), '');

  // 7. schema notes
  out.push('## 7. Schema notes', '', ...schemaNotes(result, body), '');

  // 8. anti-ai-writing fixes and check report
  out.push('## 8. Anti-AI-writing fixes and check report', '');
  for (const f of result.edits.fixes) out.push(`- ${f}`);
  if (result.edits.changes.length) {
    out.push('', 'Changes made to clear the check:', '');
    for (const c of result.edits.changes) out.push(`- ${c}`);
  }
  if (result.edits.warnNotes.length) {
    out.push('', 'Warnings that stand:', '');
    for (const w of result.edits.warnNotes) out.push(`- ${w.warning}: ${w.action}`);
  }
  out.push('', 'E-E-A-T signals:', '');
  out.push(table(['Signal', 'Status', 'Where'], (result.edits.eeat || []).map((x) => [x.signal, x.status === 'present' ? 'present' : '[CONFIRM]', x.where])), '');
  out.push(`check.py report (after ${result.check.rounds} fix round${result.check.rounds === 1 ? '' : 's'}):`, '', fence(result.check.report), '');
  if (result.check.unfixable.length) {
    out.push('These FAILs cannot be cleared by editing the copy:', '');
    for (const r of result.check.unfixable) out.push(`- ${r[2]}`);
    out.push('');
  }

  out.push('## Open [CONFIRM] questions', '');
  if (result.confirms.length) for (const c of result.confirms) out.push(`- ${c}`);
  else out.push('_None._');
  out.push('', ...costSection(result));
  return out.join('\n');
}

function statusLine(result) {
  if (result.status === 'needs_decision') return 'It stopped at the plan: a decision is needed before drafting.';
  if (result.status === 'green') return 'check.py is green.';
  if (result.status === 'green_except_unfixable') return 'check.py is green except for FAILs the copy cannot fix (listed in section 8).';
  const red = `check.py is still red after ${result.check.rounds} fix rounds; see section 8.`;
  return result.check.unsafe ? `${red} **Do not paste this copy:** it still holds raw HTML, a bare URL or a link that is not in the brief or the verified sources.` : red;
}

function keywordSection(brief, plan) {
  const rows = [
    ['Primary', plan.primary.keyword, plan.primary.source],
    ...plan.variants.map((k) => ['Variant', k.keyword, k.source]),
    ...plan.secondary.map((k) => ['Secondary', k.keyword, k.source]),
  ];
  const out = ['## 2. Keywords', '', table(['Role', 'Keyword', 'Source'], rows), ''];
  const base = brief.keywords.baseline;
  out.push(`Baseline: ${base.length ? base.map((b) => (typeof b === 'string' ? b : JSON.stringify(b))).join('; ') : 'none in the brief.'}`, '');
  if (plan.own_page_keywords.length) {
    out.push('Keywords that want their own page:', '');
    for (const k of plan.own_page_keywords) out.push(`- ${k.keyword}: ${k.why}`);
    out.push('');
  }
  return out;
}

function costSection(result) {
  return ['## Cost of this page', '', result.usageTable, ''];
}

/** FAQ pairs as they appear on the page, for FAQPage text identical to the copy. */
export function faqPairs(body) {
  const lines = body.split('\n');
  const pairs = [];
  let inFaq = false;
  let q = null;
  let a = [];
  const flush = () => {
    if (q) pairs.push({ q, a: stripMd(a.join('\n')).replace(/\s+/g, ' ').trim() });
    q = null;
    a = [];
  };
  for (const l of lines) {
    const h = /^(#{1,6})\s+(.*)$/.exec(l);
    if (h) {
      if (h[1].length <= 2) {
        flush();
        inFaq = h[1].length === 2 && /faq|frequently asked|questions/i.test(h[2]);
      } else if (inFaq && h[1].length === 3) {
        flush();
        q = h[2].trim();
      }
    } else if (q) a.push(l);
  }
  flush();
  return pairs;
}

function schemaNotes(result, body) {
  const { brief, plan } = result;
  const out = [];
  const type = brief.page.type === 'blog' ? 'BlogPosting' : 'Service';
  out.push(`- \`${type}\` for this ${brief.page.type} page${type === 'Service' ? `, with the provider ${brief.business}${brief.page.place ? ` and areaServed ${brief.page.place}` : ''}` : `, with ${brief.business} as publisher`}.`);
  const segs = plan.slug.split('/').filter(Boolean);
  const titleFor = (path) => brief.internal_pages.find((p) => p.url.replace(/\/+$/, '') === path.replace(/\/+$/, ''))?.title;
  const crumbs = ['Home (/)'];
  segs.forEach((seg, i) => {
    const path = '/' + segs.slice(0, i + 1).join('/') + '/';
    const name = i === segs.length - 1 ? body.match(/^#\s+(.+)$/m)?.[1]?.trim() : titleFor(path) || seg.replace(/-/g, ' ');
    crumbs.push(`${name} (${path})`);
  });
  out.push(`- \`BreadcrumbList\`: ${crumbs.join(' > ')}. Match it to the site's real menu if a parent page has another name.`);
  const pairs = faqPairs(body);
  if (pairs.length) {
    out.push(`- \`FAQPage\` with the ${pairs.length} questions below, text identical to the visible copy:`, '');
    const ld = {
      '@context': 'https://schema.org',
      '@type': 'FAQPage',
      mainEntity: pairs.map((p) => ({ '@type': 'Question', name: p.q, acceptedAnswer: { '@type': 'Answer', text: p.a } })),
    };
    out.push(fence(JSON.stringify(ld, null, 2), 'json'));
  } else {
    out.push('- No FAQ on the page, so no `FAQPage`.');
  }
  return out;
}
