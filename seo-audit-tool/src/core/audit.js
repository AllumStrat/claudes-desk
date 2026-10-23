// Runs a full audit of one URL plus a small, bounded crawl of its site.
// Runtime-neutral: the caller supplies fetchImpl and resolveHost.

import { checkUrl, MAX_URL_LENGTH } from './url-guard.js';
import { safeFetch, FetchError } from './safe-fetch.js';
import { parseRobots, isAllowed } from './robots.js';
import { parseSitemap } from './sitemap.js';
import { extractPage } from './extract.js';
import { Results } from './findings.js';
import { scoreResults, sortIssues, capReport } from './report.js';
import { mapLimit, stripHash, looksLikePage, clip } from './util.js';
import { checkIndexing, normalize } from './checks/indexing.js';
import { checkOnPage } from './checks/onpage.js';
import { checkContent, checkImages, checkLinks } from './checks/content.js';
import { checkSocial, checkSchema, checkHreflang } from './checks/rich.js';
import { checkPerformance, checkSecurity } from './checks/tech.js';
import { checkLocal } from './checks/local.js';
import { checkSite } from './checks/site.js';
import { jevFindings } from './jev.js';

export const DEFAULT_LIMITS = Object.freeze({
  maxPages: 5, // start page included
  maxLinkChecks: 20,
  maxExternalLinkChecks: 8,
  maxImageChecks: 12,
  maxRedirects: 5,
  requestTimeoutMs: 8000,
  auditTimeoutMs: 45_000,
  maxHtmlBytes: 2_000_000,
  maxRobotsBytes: 512_000,
  maxSitemapBytes: 5_000_000,
  concurrency: 3,
});

// Crawled titles and descriptions are kept this long in the report.
const MAX_TITLE = 300;

// robots.txt checks made while picking pages to crawl.
const MAX_ROBOTS_CHECKS = 50;

// Hard ceilings a caller cannot raise.
const CEILINGS = { maxPages: 10, maxLinkChecks: 40, maxExternalLinkChecks: 15, maxImageChecks: 20, maxRedirects: 10, auditTimeoutMs: 60_000 };

export function clampLimits(overrides = {}) {
  const out = { ...DEFAULT_LIMITS };
  for (const [k, v] of Object.entries(overrides)) {
    if (!(k in out) || typeof v !== 'number' || !Number.isFinite(v) || v < 0) continue;
    out[k] = Math.floor(CEILINGS[k] !== undefined ? Math.min(v, CEILINGS[k]) : v);
  }
  return out;
}

const HTML_TYPE = /text\/html|application\/xhtml\+xml/;

// `reachedSite` is false when the start page never came back (bad address,
// DNS, refused, timed out). The app refunds the credit only in that case.
export class AuditError extends Error {
  constructor(code, message, { reachedSite = false } = {}) {
    super(message);
    this.code = code;
    this.reachedSite = reachedSite;
  }
}

/**
 * @param {string} input   user-supplied URL
 * @param {object} deps    { fetchImpl, resolveHost, jev?, limits?, userAgent? }
 */
export async function runAudit(input, deps) {
  const started = Date.now();
  const limits = clampLimits(deps.limits);
  const checked = checkUrl(input, { allowBareHost: true });
  if (!checked.ok) throw new AuditError('INVALID_URL', checked.reason);

  const deadline = new AbortController();
  const deadlineTimer = setTimeout(() => deadline.abort(new FetchError('TIMEOUT', 'The audit ran out of time.')), limits.auditTimeoutMs);
  const notes = [];
  let requests = 0;

  const fetchOpts = (extra = {}) => ({
    fetchImpl: deps.fetchImpl,
    resolveHost: deps.resolveHost,
    maxRedirects: limits.maxRedirects,
    timeoutMs: limits.requestTimeoutMs,
    userAgent: deps.userAgent,
    signal: deadline.signal,
    ...extra,
  });
  const get = (url, extra) => {
    requests++;
    return safeFetch(url, fetchOpts(extra));
  };
  // Optional fetches never sink the audit.
  const tryGet = async (url, extra) => {
    try {
      return await get(url, extra);
    } catch (err) {
      return { error: err.code || 'NETWORK', message: err.message, url, status: 0 };
    }
  };

  try {
    let main;
    try {
      main = await get(checked.url, { maxBytes: limits.maxHtmlBytes });
    } catch (err) {
      if (err instanceof FetchError) throw new AuditError(err.code, err.message);
      throw err;
    }

    const isHtml = HTML_TYPE.test(main.contentType) || (!main.contentType && /<html/i.test(main.body || ''));
    const page = isHtml && main.body ? extractPage(main.body, main.url) : null;
    const origin = new URL(main.url).origin;

    // robots.txt, sitemap and the http→https probe run side by side.
    const robotsUrl = `${origin}/robots.txt`;
    const httpUrl = main.url.startsWith('https:') ? main.url.replace(/^https:/, 'http:') : null;
    const [robotsRes, httpRes] = await Promise.all([
      tryGet(robotsUrl, { maxBytes: limits.maxRobotsBytes, accept: 'text/plain,*/*;q=0.5' }),
      httpUrl ? tryGet(httpUrl, { readBody: false }) : null,
    ]);
    const robots = robotsRes.error
      ? { url: robotsUrl, error: robotsRes.message }
      : {
          url: robotsUrl,
          status: robotsRes.status,
          parsed: robotsRes.status === 200 && !/text\/html/.test(robotsRes.contentType) ? parseRobots(robotsRes.body) : null,
        };
    const httpProbe = httpRes ? { requested: httpUrl, url: httpRes.url, status: httpRes.status, error: httpRes.error } : null;

    const sitemap = await findSitemap(origin, robots.parsed, main.url, tryGet, limits);

    const ctx = { input, main, page, robots, sitemap, httpProbe, crawl: [], linkResults: [], imageResults: [] };
    const r = new Results();

    if (!page) {
      checkIndexing(ctx, r);
      if (main.status < 300) {
        notes.push({ category: 'content', label: 'Not an HTML page', value: `The URL returned ${main.contentType || 'an unknown type'}, so page checks were skipped.` });
      }
      return finalize({ r, ctx, started, limits, notes, requests, checked, jevInfo: null });
    }

    // Bounded crawl of same-site pages linked from the start page, respecting robots.txt.
    // Stops looking once it has enough pages, and after a fixed number of
    // robots.txt checks, since the site writes both the rules and the links.
    const seen = new Set([normalize(main.url), normalize(checked.url)]);
    const toCrawl = [];
    const wanted = Math.max(0, limits.maxPages - 1);
    let robotsChecks = 0;
    for (const l of page.links) {
      if (toCrawl.length >= wanted || robotsChecks >= MAX_ROBOTS_CHECKS) break;
      if (!l.internal || !l.abs || !/^https?:/.test(l.abs) || l.abs.length > MAX_URL_LENGTH || !looksLikePage(l.abs)) continue;
      const u = stripHash(l.abs);
      const key = normalize(u);
      if (seen.has(key)) continue;
      seen.add(key);
      if (/nofollow/.test(l.rel)) continue;
      if (robots.parsed) {
        robotsChecks++;
        if (!isAllowed(robots.parsed, new URL(u).pathname + new URL(u).search)) continue;
      }
      toCrawl.push(u);
    }
    const crawl = await mapLimit(toCrawl, limits.concurrency, async (u) => {
      const res = await tryGet(u, { maxBytes: limits.maxHtmlBytes });
      if (res.error) return { url: u, status: 0, error: res.error };
      const html = HTML_TYPE.test(res.contentType);
      let p = null;
      try {
        p = html && res.body ? extractPage(res.body, res.url) : null;
      } catch {
        return { url: u, status: 0, error: 'PARSE_FAILED' };
      }
      return {
        url: u,
        finalUrl: res.url,
        status: res.status,
        isHtml: html,
        title: p?.title == null ? null : clip(p.title, MAX_TITLE),
        description: p?.description == null ? null : clip(p.description, MAX_TITLE),
        h1Count: p ? p.headings.filter((h) => h.level === 1).length : 0,
        wordCount: p?.wordCount ?? 0,
        noindex: p ? /noindex/.test(p.robotsMeta || '') || /noindex/i.test(res.headers['x-robots-tag'] || '') : false,
      };
    });
    ctx.crawl = [
      {
        url: main.url,
        status: main.status,
        isHtml: true,
        title: page.title == null ? null : clip(page.title, MAX_TITLE),
        description: page.description == null ? null : clip(page.description, MAX_TITLE),
        h1Count: page.headings.filter((h) => h.level === 1).length,
        wordCount: page.wordCount,
      },
      ...crawl,
    ];

    // Sample links for broken-link checks (pages already crawled count as checked).
    const crawledMap = new Map(crawl.map((c) => [normalize(c.url), c]));
    const internalSample = [];
    const externalSample = [];
    const seenLinks = new Set();
    for (const l of page.links) {
      if (!l.abs || !/^https?:/.test(l.abs)) continue;
      const u = stripHash(l.abs);
      const key = normalize(u);
      if (seenLinks.has(key) || key === normalize(main.url)) continue;
      seenLinks.add(key);
      if (l.internal) internalSample.push(u);
      else externalSample.push(u);
    }
    const externalPicked = externalSample.slice(0, limits.maxExternalLinkChecks);
    const internalPicked = internalSample.slice(0, Math.max(0, limits.maxLinkChecks - externalPicked.length));
    const linkTargets = [...internalPicked.map((u) => [u, true]), ...externalPicked.map((u) => [u, false])];
    ctx.linkResults = await mapLimit(linkTargets, limits.concurrency, async ([u, internal]) => {
      // Crawled pages are reported by the crawl checks, so only note redirects here.
      const done = crawledMap.get(normalize(u));
      if (done) return { url: u, internal, crawled: true, status: done.status, error: done.error, redirected: done.finalUrl && normalize(done.finalUrl) !== normalize(u) };
      let res = await tryGet(u, { method: 'HEAD', readBody: false });
      if (!res.error && (res.status === 405 || res.status === 501 || res.status === 403)) res = await tryGet(u, { readBody: false });
      // Sites that block bots answer 403/429 to anything automated; that is not a broken link.
      const status = res.status === 403 || res.status === 429 || res.status === 999 ? 0 : res.status;
      const error = res.error && res.error !== 'BLOCKED_URL' && res.error !== 'BLOCKED_ADDRESS' ? res.error : null;
      return { url: u, internal, status, error, redirected: !res.error && res.chain?.length > 1 };
    });
    ctx.linkResults = ctx.linkResults.filter((x) => x.status || x.error);

    // Image weight sample.
    const imgUrls = [...new Set(page.images.map((i) => i.abs).filter((u) => u && /^https?:/.test(u)))].slice(0, limits.maxImageChecks);
    ctx.imageResults = await mapLimit(imgUrls, limits.concurrency, async (u) => {
      const res = await tryGet(u, { method: 'HEAD', readBody: false, accept: 'image/*,*/*;q=0.5' });
      if (res.error) return { url: u, error: res.error };
      const len = Number(res.headers['content-length']);
      return { url: u, status: res.status, bytes: Number.isFinite(len) ? len : null, type: (res.headers['content-type'] || '').toLowerCase() };
    });

    checkIndexing(ctx, r);
    checkHreflang(ctx, r);
    checkOnPage(ctx, r);
    checkContent(ctx, r);
    checkImages(ctx, r);
    checkLinks(ctx, r);
    checkSchema(ctx, r);
    checkSocial(ctx, r);
    checkPerformance(ctx, r);
    checkSecurity(ctx, r);
    checkLocal(ctx, r);
    checkSite(ctx, r);

    let jevInfo = null;
    if (deps.jev) {
      try {
        const { answers, model } = await deps.jev.judge(page);
        jevFindings(answers, r);
        jevInfo = { used: true, answered: Object.keys(answers).length };
        void model;
      } catch (err) {
        jevInfo = { used: false, error: 'The AI judgment step failed, so only rule-based checks are shown.' };
        void err;
      }
    }

    return finalize({ r, ctx, started, limits, notes, requests, checked, jevInfo });
  } finally {
    clearTimeout(deadlineTimer);
  }
}

async function findSitemap(origin, robotsParsed, pageUrl, tryGet, limits) {
  const listed = (robotsParsed?.sitemaps || []).filter((s) => {
    try {
      return new URL(s).origin === origin; // only follow sitemaps on the same site
    } catch {
      return false;
    }
  });
  const tried = [];
  const candidates = listed.length ? listed.slice(0, 2) : [`${origin}/sitemap.xml`, `${origin}/sitemap_index.xml`];
  for (const url of candidates) {
    tried.push(url);
    const res = await tryGet(url, { maxBytes: limits.maxSitemapBytes, accept: 'application/xml,text/xml;q=0.9,*/*;q=0.5' });
    if (res.error || res.status !== 200) continue;
    const parsed = parseSitemap(res.body);
    if (!parsed.valid) return { found: true, valid: false, url, problem: parsed.problem, tried };
    let containsPage;
    if (parsed.kind === 'urlset') {
      const key = normalize(pageUrl);
      containsPage = parsed.locs.some((l) => normalize(l) === key);
    }
    return { found: true, valid: true, url, kind: parsed.kind, count: parsed.count, containsPage, truncated: res.truncated, tried };
  }
  return { found: false, tried };
}

function finalize({ r, ctx, started, limits, notes, requests, checked, jevInfo }) {
  const { score, grade, categories } = scoreResults(r);
  const issues = sortIssues(r.issues);
  const counts = {
    high: issues.filter((i) => i.priority === 'high').length,
    medium: issues.filter((i) => i.priority === 'medium').length,
    low: issues.filter((i) => i.priority === 'low').length,
    passed: r.passed.length,
  };
  const pages = (ctx.crawl.length ? ctx.crawl : [{ url: ctx.main.url, status: ctx.main.status }]).map((p) => ({
    url: p.url,
    status: p.status,
    title: p.title ?? null,
    words: p.wordCount ?? null,
    error: p.error ?? null,
  }));
  return capReport({
    tool: 'Allum Strategies SEO audit',
    version: '0.1.0',
    url: checked.url,
    finalUrl: ctx.main.url,
    auditedAt: new Date().toISOString(),
    durationMs: Date.now() - started,
    score,
    grade,
    counts,
    categories,
    issues,
    passed: r.passed,
    insights: [...r.insights, ...notes],
    pages,
    pagesCrawled: pages.length,
    redirectChain: ctx.main.chain,
    requestsMade: requests,
    judgment: jevInfo,
    limits: { maxPages: limits.maxPages, maxLinkChecks: limits.maxLinkChecks, maxImageChecks: limits.maxImageChecks },
  });
}
