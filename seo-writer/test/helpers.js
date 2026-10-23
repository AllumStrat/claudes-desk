// Shared test fixtures: a fictional brief, a fake model and a fake network.

import { readFileSync } from 'node:fs';
import { parseFrontmatter } from '../src/core/check.js';

export const fixture = (name) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');

export const GREEN_BODY = parseFrontmatter(fixture('green-draft.md')).body.trim();
export const NHTSA = 'https://www.nhtsa.gov/equipment/brakes';
export const NHTSA_QUOTE = 'Brakes are one of the most important safety features';

export function brief(over = {}) {
  return {
    client: 'example-auto',
    business: 'Example Auto',
    site: 'https://www.example-auto.com/',
    page: { type: 'location', service: 'brake repair', place: 'Norterra', words_target: 1000 },
    facts: [{ fact: 'Shop is on Happy Valley Road', source: 'owner' }, 'Free brake inspection'],
    voice_of_customer: ['my brakes squeal every morning'],
    conversion: { action: 'Book a brake inspection', url: 'https://example-auto.com/contact/' },
    internal_pages: [{ url: '/service/brakes/', title: 'Brake repair' }, '/deer-valley-auto-repair/'],
    competitors: ['rivalshop.com'],
    ...over,
  };
}

export const kw = (keyword, source = 'suggested, no search data') => ({ keyword, source });

export function plan(over = {}) {
  return {
    search: 'brake repair in Norterra',
    intent: 'local',
    subtype: 'location page for a service',
    ownership_line: 'No page on the site targets brake repair in Norterra.',
    proceed: true,
    stop_reason: '',
    slug: 'norterra-brake-repair',
    primary: kw('brake repair norterra', 'brief'),
    variants: [kw('brake service in norterra'), kw('norterra brake shop'), kw('brake work near norterra')],
    secondary: ['brake pad replacement', 'squealing brakes', 'brake inspection cost'].map((k) => ({ ...kw(k), shares_intent: true })),
    own_page_keywords: [],
    facts: [],
    confirm_questions: ['Starting price for front pads?'],
    voice_of_customer: [],
    conversion: { action: 'Book a brake inspection', url: '/contact/' },
    internal_links: [],
    external_candidates: [{ url: NHTSA, claim: 'worn brakes should be replaced', quote: NHTSA_QUOTE, source_rank: 1 }],
    outline: [],
    ...over,
  };
}

const opt = (text, recommended = false) => ({ text, reason: 'fits', recommended });
const TITLE = 'Brake repair in Norterra | Example Auto';
const META = 'Brake repair in Norterra from Example Auto on Happy Valley Road. ASE-certified techs, free brake inspection and pads, rotors and fluid done the same day.';

export function draftAnswer(body = GREEN_BODY) {
  return {
    body,
    title_options: [opt(TITLE, true), opt('Norterra brake repair | Example Auto')],
    meta: META,
    subhead_options: [opt('Same-day brakes near I-17', true)],
    cta_options: [opt('Book a free brake inspection', true)],
    inbound_edits: [{ page: '/service/brakes/', sentence: 'We also do brake repair in Norterra.', anchor: 'brake repair in Norterra' }],
  };
}

export function editAnswer(body = GREEN_BODY) {
  const d = draftAnswer(body);
  return {
    body,
    title: TITLE,
    meta: META,
    title_options: d.title_options,
    subhead_options: d.subhead_options,
    cta_options: d.cta_options,
    fixes: ['Cut "nestled" from the intro'],
    eeat: [{ signal: 'Location and contact', status: 'present', where: 'intro' }],
  };
}

const USAGE = { input_tokens: 1200, cache_creation_input_tokens: 0, cache_read_input_tokens: 10000, output_tokens: 3000 };

/** A fake llm.call. answers maps a step name (or its prefix, like 'fix') to data or a function of the request. */
export function fakeLlm(answers) {
  const calls = [];
  return {
    calls,
    async call(req) {
      calls.push(req);
      const key = Object.keys(answers).find((k) => req.step === k || req.step.startsWith(k + ' '));
      if (!key) throw new Error(`no fake answer for ${req.step}`);
      const a = answers[key];
      const data = typeof a === 'function' ? a(req, calls) : a;
      return { data: structuredClone(data), usage: { ...USAGE, cache_creation_input_tokens: calls.length === 1 ? 10000 : 0, cache_read_input_tokens: calls.length === 1 ? 0 : 10000 }, model: 'claude-sonnet-5-5' };
    },
  };
}

/** A fake network: pages maps URL to { status, body }; everything else 404s. */
export function fakeNet(pages = {}) {
  const fetched = [];
  return {
    fetched,
    async fetchPage(url) {
      fetched.push(url);
      const p = pages[url];
      if (!p) return { status: 404, url, body: '' };
      return { status: p.status ?? 200, url: p.url || url, body: p.body ?? '' };
    },
    async status(url) {
      const p = pages[url];
      return [p ? p.status ?? 200 : 404, null];
    },
  };
}

export const nhtsaPage = { [NHTSA]: { body: `<html><body><main><p>${NHTSA_QUOTE} on your vehicle.</p></main></body></html>` } };
