// Runs one page through the seo-writing skill, content-only tier:
//   plan (steps 1, 2, 4, 5) -> verify sources -> draft (6) -> edit (7)
//   -> check.py and fix until green (8) -> copy doc (9).
// The model writes; the program does everything mechanical: the length
// target, frontmatter, source checks, link rules and check.py.

import { SEO_WRITING_PARAMETERS, ANTI_AI_WRITING_SKILL } from './rules.generated.js';
import { checkDraft, parseParams, parseBanned, parseFrontmatter, stripMd, findLinks, findImages } from './check.js';
import { normalizeBrief } from './brief.js';
import { resolveConfig } from './config.js';
import { UsageLog } from './usage.js';
import { verifySources } from './sources.js';
import { readSitemap } from './net.js';
import { buildCopyDoc } from './copydoc.js';
import { limited } from './limit.js';
import * as P from './prompts.js';

export class WriterError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'WriterError';
    this.code = code;
  }
}

export const RULES = { params: parseParams(SEO_WRITING_PARAMETERS), banned: parseBanned(ANTI_AI_WRITING_SKILL) };

// Words that describe how a page looks. The copy doc stays silent on them;
// check.py does not look for them, so the writer adds a WARN.
const UI_WORDS = /\b(hero|above the fold|button|banner|carousel|slider|font|color scheme|colour|mobile layout|sticky (?:header|bar)|call-out box|sidebar|full-width)\b/i;

/** Length target for the content-only tier and where it came from. */
export function wordsTarget(brief, params, config) {
  const [lo, hi] = params.content.words;
  const raw = brief.page.words_target ?? config.lengthByType[brief.page.type];
  const n = Math.min(hi, Math.max(lo, Math.round(raw)));
  const from = brief.page.words_target != null ? 'the brief' : `the ${brief.page.type} default in config.js`;
  return { n, source: n !== Math.round(raw) ? `${from}, clamped to PARAMETERS.md content.words ${lo} to ${hi}` : from };
}

/**
 * @param {object} input   the page brief (see brief.js)
 * @param {object} deps
 * @param {{call:Function}} deps.llm        from createClaude, or a fake in tests
 * @param {{fetchPage:Function, status:Function}} [deps.net]  from createNet; without it, no source check, sitemap or live check
 * @param {object} [deps.config]            overrides for config.js
 * @param {boolean} [deps.live]             run check.py's --live link check
 * @param {(step:string, info?:object)=>void} [deps.onProgress]
 */
export async function writePage(input, deps) {
  const config = resolveConfig(deps.config);
  if (config.research !== 'content') {
    throw new WriterError('TIER_NOT_BUILT', `Research tier '${config.research}' is planned but not built yet; only 'content' runs.`);
  }
  const usage = new UsageLog(config.model);
  try {
    return await run(input, deps, config, usage);
  } catch (err) {
    err.usage = usage.totals();
    err.usageTable = usage.table();
    throw err;
  }
}

async function run(input, { llm, net = null, live = false, onProgress = () => {} }, config, usage) {
  const { params, banned } = RULES;
  const brief = normalizeBrief(input);
  const target = wordsTarget(brief, params, config);

  let sitemapUrls = [];
  if (brief.sitemap && net) {
    onProgress('sitemap');
    sitemapUrls = await readSitemap(net, brief.site, config.maxSitemapUrls);
  }
  const ctx = { brief, params, wordsTarget: target.n, sitemapUrls };
  const briefText = { text: P.briefBlock(brief, ctx), cache: true };

  const call = async (step, key, blocks, effort) => {
    onProgress(step);
    const r = await llm.call({ step, key, system: P.SYSTEM_PROMPT, blocks, effort });
    usage.add(step, r.usage, r.model);
    return r.data;
  };

  // ---- plan: steps 1, 2, 4, 5
  const plan = await call('plan', 'plan', [briefText, { text: P.planTask(ctx) }], config.effort.plan);
  plan.slug = normalizeSlug(brief.page.slug || plan.slug);
  if (!plan.proceed) {
    const result = { status: 'needs_decision', brief, target, plan, usage: usage.totals(), usageTable: usage.table() };
    result.copyDoc = buildCopyDoc(result);
    return result;
  }

  // ---- sources: keep only pages that load and hold the quoted line
  const excluded = [...brief.competitors, ...params.serp_exclude];
  const want = params.content.external_links[0];
  let sources = { verified: [], failed: [], checked: Boolean(net) };
  if (net) {
    const fromModel = (list) => (Array.isArray(list) ? list.slice(0, config.maxCandidates) : []);
    const candidates = [...brief.external_sources.map((s) => ({ ...s, source_rank: 0 })), ...fromModel(plan.external_candidates)];
    const opts = { fetchPage: net.fetchPage, site: brief.site, excluded, concurrency: config.fetchConcurrency };
    const v = await verifySources(candidates, { ...opts, max: params.content.external_links[1] });
    sources = { ...sources, ...v };
    for (let i = 0; i < config.sourceRetries && sources.verified.length < want && sources.failed.length; i++) {
      const more = await call('sources', 'sources', [briefText, { text: P.sourcesTask(sources.failed) }], config.effort.sources);
      const known = new Set(sources.verified.map((s) => s.url));
      const r = await verifySources(fromModel(more.external_candidates), { ...opts, max: params.content.external_links[1] - sources.verified.length });
      sources.verified.push(...r.verified.filter((s) => !known.has(s.url)));
      sources.failed.push(...r.failed);
    }
  }
  const planText = { text: P.planBlock(plan, sources.verified), cache: true };

  // ---- draft: step 6
  const d = await call('draft', 'draft', [briefText, planText, { text: P.draftTask(ctx) }], config.effort.draft);
  const state = {
    body: d.body,
    title: pick(d.title_options) || '',
    meta: d.meta,
    title_options: d.title_options,
    subhead_options: d.subhead_options,
    cta_options: d.cta_options,
  };

  // ---- edit: step 7
  const e = await call('edit', 'edit', [briefText, planText, { text: P.editTask(state) }], config.effort.edit);
  Object.assign(state, { body: e.body, title: e.title || state.title, meta: e.meta, title_options: e.title_options, subhead_options: e.subhead_options, cta_options: e.cta_options });

  // ---- check: step 8
  const siblings = await loadSiblings(brief, net);
  const allowed = allowedLinks(brief, sitemapUrls, sources.verified);
  const unfixable = unfixableChecks(brief, sources, sitemapUrls);
  // The --live check fetches only links that are allowed anyway, a few at a time.
  const liveStatus = live && net ? liveChecker(net.status, brief, allowed, config.fetchConcurrency) : null;
  const changes = [];
  const warnNotes = [];
  const safe = dropUnsafe(state, d.inbound_edits);
  const notes = safe.dropped ? [`dropped ${safe.dropped} title, subhead, CTA or inbound-edit option${safe.dropped === 1 ? '' : 's'} that held HTML or a URL`] : [];
  let check;
  for (let round = 0; ; round++) {
    const draft = assemble(brief, plan, state, target.n);
    check = await runChecks(draft, { params, banned, live: liveStatus, siblings, brief, allowed, notes });
    const fixable = check.results.filter((r) => r[0] === 'FAIL' && !isUnfixable(r, unfixable));
    check.unfixable = check.results.filter((r) => r[0] === 'FAIL' && isUnfixable(r, unfixable));
    check.rounds = round;
    if (!fixable.length || round >= config.maxFixRounds) break;
    const f = await call(`fix ${round + 1}`, 'fix', [briefText, planText, { text: P.fixTask({ ...state }, check.report, unfixable.map((u) => u.why)) }], config.effort.fix);
    Object.assign(state, { body: f.body, title: f.title || state.title, meta: f.meta || state.meta });
    changes.push(...f.changes);
    warnNotes.splice(0, warnNotes.length, ...f.warn_notes);
  }

  const draft = assemble(brief, plan, state, target.n);
  const greenOrRed = check.results.some((r) => r[0] === 'FAIL') ? (check.results.every((r) => r[0] !== 'FAIL' || isUnfixable(r, unfixable)) ? 'green_except_unfixable' : 'red') : 'green';
  const result = {
    status: greenOrRed,
    brief,
    target,
    plan,
    sources,
    draft,
    state,
    edits: { fixes: e.fixes, eeat: e.eeat, changes, warnNotes },
    inboundEdits: safe.edits,
    check,
    confirms: [...draft.matchAll(/\[CONFIRM:\s*([^\]]+)\]/gi)].map((m) => m[1].trim()),
    usage: usage.totals(),
    usageTable: usage.table(),
  };
  result.copyDoc = buildCopyDoc(result);
  return result;
}

// ---------- helpers ----------

function pick(options = []) {
  return (options.find((o) => o.recommended) || options[0])?.text;
}

export function normalizeSlug(slug) {
  let s = String(slug || '').trim();
  try {
    if (/^https?:\/\//i.test(s)) s = new URL(s).pathname;
  } catch {
    /* keep as typed */
  }
  s = s.toLowerCase().replace(/[^a-z0-9/-]+/g, '-').replace(/-+/g, '-');
  if (!s.startsWith('/')) s = '/' + s;
  if (!s.endsWith('/')) s += '/';
  return s.replace(/\/-+|-+\//g, '/').replace(/\/{2,}/g, '/');
}

/** check.py's frontmatter reader splits lists on commas, so list values must not hold one. */
const fmList = (xs) => `[${xs.map((x) => String(x).replace(/[,\n]/g, ' ').trim()).filter(Boolean).join(', ')}]`;
const fmLine = (s) => String(s || '').replace(/\n/g, ' ').trim();

/** Frontmatter is written by code, from the plan and the brief, then the body follows. */
export function assemble(brief, plan, state, target) {
  const fm = [
    '---',
    `primary: ${fmLine(plan.primary.keyword)}`,
    `variants: ${fmList(plan.variants.map((k) => k.keyword))}`,
    `secondary: ${fmList(plan.secondary.filter((k) => k.shares_intent !== false).map((k) => k.keyword))}`,
    `type: ${brief.page.type}`,
    `site: ${brief.site}`,
    `slug: ${plan.slug}`,
    `title: ${fmLine(state.title)}`,
    `meta: ${fmLine(state.meta)}`,
    `words_target: ${target}`,
    `competitors: ${fmList(brief.competitors)}`,
    '---',
    '',
  ];
  return fm.join('\n') + String(state.body || '').trim() + '\n';
}

export function allowedLinks(brief, sitemapUrls, verified) {
  const key = (u) => u.replace(/[?#].*$/, '').replace(/\/+$/, '').toLowerCase();
  return {
    internal: new Set([...brief.internal_pages.map((p) => p.url), ...sitemapUrls].map(key)),
    external: new Set(verified.map((s) => key(s.url))),
    key,
  };
}

/** FAILs that editing the copy cannot clear, with the reason given to the model. */
function unfixableChecks(brief, sources, sitemapUrls) {
  const out = [];
  if (!sources.verified.length) {
    out.push({ check: 'content', match: /external links/, why: `no external source passed verification${sources.checked ? '' : ' (no network for the check)'}, so the page carries no external link` });
  }
  const internalPages = new Set([...brief.internal_pages.map((p) => p.url), ...sitemapUrls]);
  if (internalPages.size < 3) {
    out.push({ check: 'content', match: /internal links/, why: `the brief lists only ${internalPages.size} internal pages to link` });
  }
  return out;
}

const isUnfixable = (r, list) => list.some((u) => u.check === r[1] && u.match.test(r[2]));

// ---------- what may reach the copy ----------
// The copy is pasted into a client's site, so the only links in it are
// Markdown links to the brief's pages and the verified sources, and it holds
// no HTML at all. Raw tags (<a href>, <script>, <img onerror>), autolinks
// (<https://...>), bare URLs, reference-style link definitions ([r1]: url)
// and images all fail, whatever the URL, so the fix loop asks the model to
// take them out. A link to anything not on the allowed list fails too.

const HTML_TAG = /<\/?[A-Za-z][A-Za-z0-9:-]*(?=[\s/>]|$)|<!--|<![A-Za-z[]|<\?[A-Za-z]/g;
const AUTOLINK = /<[A-Za-z][A-Za-z0-9+.-]{1,31}:[^\s<>]*>|<[^\s<>@]+@[^\s<>]+>/g;
const BARE_URL = /\b[A-Za-z][A-Za-z0-9+.-]{0,31}:\/\/[^\s<>()]*|\bwww\.[^\s<>()]+|(?<![\w/])\/\/[A-Za-z0-9-]+\.[A-Za-z][^\s<>()]*/g;
const REF_DEF = /^ {0,3}\[[^\]\n]+\]:.*$/gm;
const SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/;

/** text with each [start, end) span replaced. */
function cut(text, spans, fn) {
  let out = '';
  let last = 0;
  for (const sp of spans) {
    out += text.slice(last, sp.start) + fn(sp);
    last = sp.end;
  }
  return out + text.slice(last);
}

const snip = (s) => {
  const t = String(s).replace(/\s+/g, ' ').trim();
  return t.length > 60 ? `${t.slice(0, 57)}...` : t;
};

/** Raw HTML, autolinks and bare URLs in a piece of text (links already taken out), as FAIL messages. */
function unsafeText(text, where) {
  const out = [];
  for (const m of text.matchAll(AUTOLINK)) out.push(`URL in angle brackets in the ${where}: '${snip(m[0])}'; write it as a [descriptive anchor](url) link to an allowed page or drop it`);
  const rest = text.replace(AUTOLINK, ' ');
  for (const m of rest.matchAll(HTML_TAG)) {
    const gt = rest.indexOf('>', m.index);
    const tag = rest.slice(m.index, gt !== -1 && gt - m.index < 60 ? gt + 1 : m.index + 60);
    out.push(`raw HTML in the ${where}: '${snip(tag)}'; the copy is plain Markdown, remove every HTML tag`);
  }
  for (const m of rest.matchAll(BARE_URL)) out.push(`bare URL in the ${where}: '${snip(m[0])}'; link only allowed pages, as [descriptive anchor](url)`);
  return out;
}

/** Where a link in the copy points, checked against the allowed lists. Returns a FAIL message or null. */
function linkProblem(url, brief, allowed) {
  if (/^(mailto:|tel:|#)/i.test(url)) return null;
  const abs = url.startsWith('//') ? `https:${url}` : url;
  if (SCHEME.test(abs) && !/^https?:\/\//i.test(abs)) return `link to ${snip(url)} uses a scheme the copy may not link`;
  if (/^https?:\/\//i.test(abs)) {
    let u;
    try {
      u = new URL(abs);
    } catch {
      return `link ${snip(url)} is not a valid URL`;
    }
    const host = u.hostname.toLowerCase().replace(/^www\./, '');
    const onSite = (host === brief.site || host.endsWith('.' + brief.site)) && !u.username && !u.password;
    if (!onSite) return allowed.external.has(allowed.key(abs)) ? null : `external link ${url} is not a verified source`;
    return allowed.internal.has(allowed.key(u.pathname)) ? null : `internal link ${url} is not in the brief's page list`;
  }
  return allowed.internal.has(allowed.key(url)) ? null : `internal link ${url} is not in the brief's page list`;
}

/** net.status for check.py's --live step: allowed URLs only, at most n at once. */
function liveChecker(status, brief, allowed, n) {
  const run = limited(status, n);
  return (url) => (linkProblem(url, brief, allowed) ? Promise.resolve([null, 'not on the allowed lists, so not fetched']) : run(url));
}

/** Every FAIL for content that must not reach the copy: in the body, title and meta. */
export function contentProblems(draft, { brief, allowed }) {
  const { fm, body } = parseFrontmatter(draft);
  const out = [];
  for (const img of findImages(body)) out.push(`image in the body: '${snip(body.slice(img.start, img.end))}'; the copy holds no images`);
  const noImages = cut(body, findImages(body), () => ' ');
  const links = findLinks(noImages);
  for (const l of links) {
    const p = linkProblem(l.url.trim(), brief, allowed);
    if (p) out.push(p);
  }
  for (const m of noImages.matchAll(REF_DEF)) out.push(`footnote-style link definition: '${snip(m[0])}'; write links inline as [anchor](url), to allowed pages only`);
  out.push(...unsafeText(cut(noImages, links, (l) => ` ${l.anchor} `), 'body'));
  for (const k of ['title', 'meta']) out.push(...unsafeText(String(fm[k] || ''), k));
  return out;
}

/** Title, subhead and CTA options and inbound edits that hold HTML or a URL are dropped, not pasted. */
function dropUnsafe(state, inbound) {
  let dropped = 0;
  const ok = (...texts) => {
    const bad = texts.some((t) => unsafeText(String(t ?? ''), 'option').length);
    if (bad) dropped++;
    return !bad;
  };
  for (const k of ['title_options', 'subhead_options', 'cta_options']) state[k] = (state[k] || []).filter((o) => ok(o.text));
  const edits = (inbound || []).filter((r) => ok(r.sentence, r.anchor));
  return { edits, dropped };
}

/** check.py plus the writer's own rules: what may reach the copy, retired names, UI words. */
async function runChecks(draft, { params, banned, live, siblings, brief, allowed, notes = [] }) {
  const base = await checkDraft(draft, { params, banned, status: live, siblings });
  const extra = [];
  const { body } = parseFrontmatter(draft);
  const unsafe = contentProblems(draft, { brief, allowed });
  for (const msg of unsafe.slice(0, 12)) extra.push(['FAIL', 'writer', msg]);
  if (unsafe.length > 12) extra.push(['FAIL', 'writer', `${unsafe.length - 12} more links, URLs or HTML tags like these`]);
  for (const n of notes) extra.push(['WARN', 'writer', n]);
  const plain = stripMd(body);
  for (const name of brief.retired_names) {
    if (new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(plain)) {
      extra.push(['FAIL', 'writer', `retired name '${name}' appears`]);
    }
  }
  const ui = body.split('\n').find((l) => UI_WORDS.test(l));
  if (ui) extra.push(['WARN', 'writer', `layout word in copy: '${ui.match(UI_WORDS)[0]}' (the copy doc says nothing about design)`]);
  const results = [...extra, ...base.results];
  const order = { FAIL: 0, WARN: 1, INFO: 2, PASS: 3 };
  results.sort((a, b) => order[a[0]] - order[b[0]]);
  const fails = results.filter((r) => r[0] === 'FAIL').length;
  const report = results.map(([l, c, m]) => `${l.padEnd(5)} ${c.padEnd(12)} ${m}`).join('\n') + (fails ? `\n\nRED: ${fails} FAIL` : '\n\nGREEN');
  return { results, fails, green: fails === 0, report, stats: base.stats, unsafe: unsafe.length };
}

async function loadSiblings(brief, net) {
  const out = [];
  for (const s of brief.siblings) {
    if (s.markdown != null) {
      out.push({ name: s.name, markdown: s.markdown });
    } else if (net) {
      try {
        const r = await net.fetchPage(s.url);
        out.push(r.status === 200 ? { name: s.name, html: r.body } : { name: s.name, error: `HTTP ${r.status}` });
      } catch (err) {
        out.push({ name: s.name, error: err?.message || 'did not load' });
      }
    } else {
      out.push({ name: s.name, error: 'no network to fetch it' });
    }
  }
  return out;
}
