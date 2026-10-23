// Writer settings that are not SEO rules. Every SEO number (length limits,
// keyword density, metadata, links, overlap) lives in the skill's
// PARAMETERS.md and is read from there; nothing here repeats one.

export const MODEL = 'claude-sonnet-5-5';

// The models the writer has prices for. Pick one with config.model
// (--model on the CLI, WRITER_MODEL on the Worker).
// Dollars per million tokens. Cache writes use the 5-minute TTL (1.25x
// input); cache reads are 0.1x input. Haiku 5.5's rates are for prompts of
// 100K tokens or fewer, which every writer call is.
export const PRICING = {
  'claude-sonnet-5-5': { input: 2, output: 10, cacheWrite: 2.5, cacheRead: 0.2 },
  'claude-haiku-5-5': { input: 0.1, output: 0.5, cacheWrite: 0.125, cacheRead: 0.01 },
};

// Models the server-side refusal fallback works on. Haiku 5.5 has none.
export const FALLBACK_MODELS = new Set(['claude-sonnet-5-5']);

export const DEFAULTS = {
  model: MODEL,
  // Research tier. 'content' writes from the brief alone (SKILL.md steps 1, 2,
  // 4 to 9). 'competitors' would add step 3 (top-3 study, serp.py length
  // target); it is a planned premium tier and is not built yet.
  research: 'content',
  // Effort per call. Sonnet 5.5's default is high. An effort change between
  // requests invalidates the prompt cache, so every step runs at the same
  // level unless you choose otherwise and accept the cache misses.
  effort: { plan: 'medium', draft: 'medium', edit: 'medium', fix: 'medium', sources: 'medium' },
  maxTokens: 32000,
  // Rounds of "here is the check report, fix every FAIL" before giving up.
  maxFixRounds: 3,
  // One extra call to replace external sources that failed verification.
  sourceRetries: 1,
  // Server-side refusal fallback (beta). Sonnet 5.5 rarely declines SEO copy;
  // when it does, the API retries on its fallback model inside the same call.
  fallbacks: true,
  // Content-only length target per page type, used when the brief gives no
  // words_target. Clamped to PARAMETERS.md content.words. The competitors
  // tier replaces this with the top-3 median from serp.py.
  lengthByType: { service: 1200, location: 1100, blog: 1400 },
  // Dollars one page may spend. The writer checks the running cost before
  // each model call and stops once it reaches this, returning what was spent,
  // so a run can pass it by at most one call. --max-spend on the CLI,
  // WRITER_MAX_SPEND on the Worker. A typical page is $0.25 to $0.45.
  maxSpend: 1,
  // Cap on sitemap URLs handed to the planner.
  maxSitemapUrls: 300,
  // Most source candidates taken from the model per round (the plan, then
  // the replacement call). The brief's own external_sources are capped in
  // brief.js.
  maxCandidates: 4,
  // Fetches in flight at once: source checks and the --live link check.
  fetchConcurrency: 4,
};

export function resolveConfig(overrides = {}) {
  const model = overrides.model || DEFAULTS.model;
  if (!PRICING[model]) throw new Error(`Unknown model '${model}'. Use one of: ${Object.keys(PRICING).join(', ')}.`);
  if (overrides.maxSpend != null && !(Number.isFinite(overrides.maxSpend) && overrides.maxSpend > 0)) {
    throw new Error(`maxSpend must be a number of dollars above 0, not '${overrides.maxSpend}'.`);
  }
  return {
    ...DEFAULTS,
    ...overrides,
    effort: { ...DEFAULTS.effort, ...(overrides.effort || {}) },
    lengthByType: { ...DEFAULTS.lengthByType, ...(overrides.lengthByType || {}) },
  };
}
