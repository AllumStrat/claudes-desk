// Checks the external sources the planner proposed. A source is kept only if
// its page loads with a 200 and the quoted line is really on it, so the copy
// never links a made-up URL or a claim the page does not make.

import { domain, htmlMainText } from './check.js';
import { mapLimit } from './limit.js';

export const norm = (s) =>
  s
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[^a-z0-9']+/g, ' ')
    .trim();

/**
 * @param {Array<{url:string, claim:string, quote:string, source_rank?:number}>} candidates
 * @param {object} ctx
 * @param {(url:string)=>Promise<{status:number, url:string, body:string|null, contentType?:string}>} ctx.fetchPage
 * @param {string} ctx.site            client domain (never an external source)
 * @param {string[]} ctx.excluded      competitors and serp_exclude domains
 * @param {number} [ctx.max]           keep at most this many
 * @param {number} [ctx.concurrency]   fetches in flight at once
 * @returns {Promise<{verified:Array, failed:Array<{url:string, reason:string}>}>}
 */
export async function verifySources(candidates, { fetchPage, site, excluded = [], max = 3, concurrency = 4 }) {
  const verified = [];
  const failed = [];
  const seen = new Set();
  const blocked = (d) => d === site || d.endsWith('.' + site) || excluded.some((x) => d === x || d.endsWith('.' + x));

  const check = async (c) => {
    const url = String(c.url || '').trim();
    if (!/^https:\/\//i.test(url)) return { c, reason: 'not an https URL' };
    const d = domain(url);
    if (blocked(d)) return { c, reason: `${d} is the client, a competitor or an excluded site` };
    const words = norm(c.quote || '').split(' ').filter(Boolean);
    if (words.length < 4) return { c, reason: 'quote too short to check' };
    let res;
    try {
      res = await fetchPage(url);
    } catch (err) {
      return { c, reason: `did not load (${err?.code || err?.message || 'error'})` };
    }
    if (res.status !== 200) return { c, reason: `returned ${res.status}` };
    if (blocked(domain(res.url || url))) return { c, reason: 'redirected to an excluded site' };
    const text = norm(htmlMainText(res.body || ''));
    if (!text.includes(words.join(' '))) return { c, reason: 'quote not found on the page' };
    return { c, ok: true, finalUrl: res.url || url };
  };

  for (const r of await mapLimit(candidates, concurrency, check)) {
    if (!r.ok) {
      failed.push({ url: r.c.url, reason: r.reason });
      continue;
    }
    const key = r.finalUrl.replace(/\/+$/, '').toLowerCase();
    if (seen.has(key) || verified.length >= max) continue;
    seen.add(key);
    verified.push({ url: r.finalUrl, claim: r.c.claim, quote: r.c.quote, source_rank: r.c.source_rank ?? null });
  }
  return { verified, failed };
}
