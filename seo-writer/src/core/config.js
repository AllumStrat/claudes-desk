// Writer settings that are not SEO rules. Every SEO number (length limits,
// keyword density, metadata, links, overlap) lives in the skill's
// PARAMETERS.md and is read from there; nothing here repeats one.

export const MODEL = 'claude-sonnet-5-5';

// Dollars per million tokens for MODEL. Cache writes use the 5-minute TTL
// (1.25x input); cache reads are 0.1x input.
export const PRICING = {
  'claude-sonnet-5-5': { input: 2, output: 10, cacheWrite: 2.5, cacheRead: 0.2 },
};

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
  // Cap on sitemap URLs handed to the planner.
  maxSitemapUrls: 300,
};

export function resolveConfig(overrides = {}) {
  return {
    ...DEFAULTS,
    ...overrides,
    effort: { ...DEFAULTS.effort, ...(overrides.effort || {}) },
    lengthByType: { ...DEFAULTS.lengthByType, ...(overrides.lengthByType || {}) },
  };
}
