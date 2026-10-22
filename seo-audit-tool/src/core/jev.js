// Optional judgment layer using Jev (TypeSafe AI's System One model).
// Jev returns typed answers only (probabilities, picks, scores), never text,
// so page content sent to it cannot make the tool print anything new.
// The audit works fully without it. It is off unless JEV_PROVIDER is set.
//
// API reference used (checked Oct 2026):
//   Direct:   POST https://api.typesafe.ai/v1/systemone, Authorization: Bearer <key>
//             body { model, state, questions } → { model, answers, usage }
//   Workers:  env.AI.run('typesafe/jev', { state, questions })
//   CF REST:  POST https://api.cloudflare.com/client/v4/accounts/<id>/ai/run
//             body { model: 'typesafe/jev', input: { state, questions } }

import { issue, pass } from './findings.js';

const TYPESAFE_URL = 'https://api.typesafe.ai/v1/systemone';
const MAX_STATE_TEXT = 12_000; // characters of page text, well inside the 32k token window

export const JEV_QUESTIONS = {
  content_depth: {
    type: 'score',
    instructions:
      'Judge the main content of this web page. How specific, useful and in-depth is it for a visitor who arrived from a search?',
    criteria: [
      'Empty or placeholder content',
      'Thin: a few generic sentences',
      'Basic: covers the topic but stays shallow',
      'Solid: specific, useful detail',
      'Comprehensive: deep, specific and clearly expert',
    ],
  },
  intent_match: {
    type: 'noul',
    instructions: 'Do the page title and main heading accurately describe what the body content actually delivers?',
    criteria: {
      true: 'The title and heading promise what the content delivers',
      false: 'The title or heading promises something the content does not deliver',
    },
  },
  boilerplate: {
    type: 'noul',
    instructions:
      'Is most of the main content generic boilerplate that could appear on any similar business site with only the name changed?',
  },
  trust_signals: {
    type: 'score',
    instructions:
      'How strong are the trust signals on this page (named people or credentials, reviews or testimonials, real contact details, specific proof of experience)?',
    criteria: [
      'No trust signals',
      'Weak: a contact detail at most',
      'Some: contact details plus reviews, an about section or credentials',
      'Strong: named people, credentials, reviews and real contact details',
    ],
  },
  cta_clarity: {
    type: 'score',
    instructions: 'How clear is the main call to action, the next step the page wants the visitor to take?',
    criteria: [
      'No call to action',
      'Vague or buried call to action',
      'Clear call to action',
      'Clear, specific call to action offered where the visitor needs it',
    ],
  },
  search_intent: {
    type: 'choice',
    instructions: 'Which kind of search is this page best suited to answer?',
    criteria: {
      informational: 'Learning about a topic or answering a question',
      commercial: 'Comparing options before buying',
      transactional: 'Ready to buy, book or sign up now',
      local: 'Finding a nearby business or service provider',
      navigational: 'Looking for this specific brand or page',
    },
  },
  local_business: {
    type: 'noul',
    instructions: 'Is this page for a business that serves customers in a specific city or region?',
  },
};

const INTENT_LABELS = {
  informational: 'Informational (learning)',
  commercial: 'Commercial (comparing options)',
  transactional: 'Transactional (ready to act)',
  local: 'Local (finding a nearby provider)',
  navigational: 'Navigational (looking for this brand)',
};

export function buildJevState(page) {
  const h1 = page.headings.find((h) => h.level === 1)?.text || '';
  return {
    url: page.url,
    title: page.title || '',
    meta_description: page.description || '',
    main_heading: h1,
    headings: page.headings.slice(0, 25).map((h) => `H${h.level}: ${h.text.slice(0, 120)}`),
    word_count: page.wordCount,
    buttons_and_links: [...new Set(page.buttons)].slice(0, 25),
    text: (page.mainText || page.bodyText).slice(0, MAX_STATE_TEXT),
  };
}

// Throws unless the response has a well-formed answer for each question asked.
export function validateAnswers(questions, data) {
  const answers = data && typeof data === 'object' ? data.answers ?? data.result?.answers : null;
  if (!answers || typeof answers !== 'object') throw new Error('Jev response had no answers');
  const out = {};
  const prob = (x) => typeof x === 'number' && Number.isFinite(x) && x >= 0 && x <= 1;
  for (const [name, q] of Object.entries(questions)) {
    const a = answers[name];
    if (!a || a.type !== q.type) continue;
    if (q.type === 'noul' && prob(a.noul)) out[name] = { type: 'noul', p: a.noul };
    if (q.type === 'score' && typeof a.score === 'number' && Number.isFinite(a.score) && prob(a.confidence)) {
      const max = q.criteria.length - 1;
      if (a.score >= 0 && a.score <= max) out[name] = { type: 'score', score: a.score, confidence: a.confidence, max };
    }
    if (q.type === 'choice' && typeof a.choice === 'string' && Object.hasOwn(q.criteria, a.choice) && prob(a.confidence)) {
      out[name] = { type: 'choice', choice: a.choice, confidence: a.confidence };
    }
  }
  return out;
}

export function createJevClient(config = {}) {
  const { provider = 'off', apiKey, model = 'jev-latest', aiBinding, accountId, apiToken, timeoutMs = 10_000 } = config;
  const fetchImpl = config.fetchImpl || globalThis.fetch;

  if (provider === 'off' || !provider) return null;

  const post = async (url, headers, body) => {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) throw new Error(`Jev request failed (${res.status})`);
    return res.json();
  };

  let ask;
  if (provider === 'typesafe') {
    if (!apiKey) throw new Error('JEV_PROVIDER=typesafe needs TYPESAFE_API_KEY');
    ask = (state, questions) => post(TYPESAFE_URL, { authorization: `Bearer ${apiKey}` }, { model, state, questions });
  } else if (provider === 'cloudflare') {
    if (!accountId || !apiToken) throw new Error('JEV_PROVIDER=cloudflare needs CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN');
    if (!/^[a-f0-9]{32}$/i.test(accountId)) throw new Error('CLOUDFLARE_ACCOUNT_ID does not look like an account id');
    const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run`;
    ask = (state, questions) =>
      post(url, { authorization: `Bearer ${apiToken}` }, { model: 'typesafe/jev', input: { state, questions } });
  } else if (provider === 'workers-ai') {
    if (!aiBinding || typeof aiBinding.run !== 'function') throw new Error('JEV_PROVIDER=workers-ai needs the AI binding');
    ask = (state, questions) => aiBinding.run('typesafe/jev', { state, questions });
  } else if (provider === 'mock') {
    ask = async (state) => mockAnswers(state);
  } else {
    throw new Error(`Unknown JEV_PROVIDER "${provider}"`);
  }

  return {
    provider,
    async judge(page) {
      const state = buildJevState(page);
      const data = await ask(state, JEV_QUESTIONS);
      return { answers: validateAnswers(JEV_QUESTIONS, data), model: typeof data?.model === 'string' ? data.model.slice(0, 40) : provider };
    },
  };
}

export function createJevFromEnv(env = {}, extras = {}) {
  return createJevClient({
    provider: (env.JEV_PROVIDER || 'off').toLowerCase(),
    apiKey: env.TYPESAFE_API_KEY,
    model: env.JEV_MODEL || 'jev-latest',
    accountId: env.CLOUDFLARE_ACCOUNT_ID,
    apiToken: env.CLOUDFLARE_API_TOKEN,
    ...extras,
  });
}

// Turns validated answers into report items. Uncertain answers are dropped.
export function jevFindings(answers, r) {
  const C = 'content';
  const src = (confidence) => ({ source: 'judgment', confidence: Math.round(confidence * 100) / 100 });
  const noul = (a) => (a ? { yes: a.p >= 0.75, no: a.p <= 0.25, confidence: Math.max(a.p, 1 - a.p) } : null);
  const ev = (label, a) =>
    a.type === 'score'
      ? `AI judgment: ${label} rated ${a.score.toFixed(1)} of ${a.max} (${Math.round(a.confidence * 100)}% confidence).`
      : `AI judgment: ${label} (${Math.round(Math.max(a.p, 1 - a.p) * 100)}% confidence).`;

  const depth = answers.content_depth;
  if (depth && depth.confidence >= 0.5) {
    if (depth.score < 1.5) {
      r.add(issue('ai-depth-thin', C, 'medium', {
        issue: 'The content reads as thin or generic',
        impact: 'Search engines favour pages that answer the searcher fully and specifically.',
        evidence: ev('content depth', depth),
        fix: 'Add specifics: services and prices or ranges, process, areas served, examples, FAQs and proof.',
        ...src(depth.confidence),
      }));
    } else if (depth.score < 2.5) {
      r.add(issue('ai-depth-basic', C, 'low', {
        issue: 'The content covers the basics but lacks depth',
        impact: 'Competing pages with more specific detail tend to outrank basic ones.',
        evidence: ev('content depth', depth),
        fix: 'Expand the sections a customer would ask about next, with concrete detail.',
        ...src(depth.confidence),
      }));
    } else {
      r.add(pass('ai-depth', C, 'Content judged specific and useful'));
    }
  }

  const intent = noul(answers.intent_match);
  if (intent?.no) {
    r.add(issue('ai-intent-mismatch', C, 'medium', {
      issue: 'The title and heading do not match what the page delivers',
      impact: 'Visitors who click and do not find what the title promised bounce back to search.',
      evidence: ev('title and heading do not match the content', answers.intent_match),
      fix: 'Rewrite the title and H1 to describe the content, or add the content they promise.',
      ...src(intent.confidence),
    }));
  } else if (intent?.yes) {
    r.add(pass('ai-intent', C, 'Title and heading match the content'));
  }

  const boiler = noul(answers.boilerplate);
  if (boiler?.yes) {
    r.add(issue('ai-boilerplate', C, 'medium', {
      issue: 'Most of the content reads as generic boilerplate',
      impact: 'Copy that could sit on any competitor site gives search engines no reason to prefer this one.',
      evidence: ev('main content is mostly boilerplate', answers.boilerplate),
      fix: 'Replace stock phrases with details only this business can say: people, history, local jobs, real results.',
      ...src(boiler.confidence),
    }));
  }

  const trust = answers.trust_signals;
  if (trust && trust.confidence >= 0.5) {
    if (trust.score < 1.5) {
      r.add(issue('ai-trust-weak', C, 'medium', {
        issue: 'Few trust signals on the page',
        impact: 'Experience and trust signals matter for rankings and for turning visitors into calls.',
        evidence: ev('trust signals', trust),
        fix: 'Add reviews, named team members, licences or certifications, years in business and full contact details.',
        ...src(trust.confidence),
      }));
    } else if (trust.score < 2.5) {
      r.add(issue('ai-trust-some', C, 'low', {
        issue: 'Trust signals could be stronger',
        impact: 'More proof of real experience helps both rankings and conversions.',
        evidence: ev('trust signals', trust),
        fix: 'Add specific proof: named reviews, credentials, photos of real work.',
        ...src(trust.confidence),
      }));
    } else {
      r.add(pass('ai-trust', C, 'Strong trust signals'));
    }
  }

  const cta = answers.cta_clarity;
  if (cta && cta.confidence >= 0.5) {
    if (cta.score < 1) {
      r.add(issue('ai-cta-missing', C, 'medium', {
        issue: 'No clear call to action',
        impact: 'Traffic that does not know what to do next does not turn into leads.',
        evidence: ev('call to action clarity', cta),
        fix: 'Add one clear next step (call, book, get a quote) near the top and again after key sections.',
        ...src(cta.confidence),
      }));
    } else if (cta.score < 2) {
      r.add(issue('ai-cta-vague', C, 'low', {
        issue: 'The call to action is vague or hard to find',
        impact: 'A buried or vague next step loses leads.',
        evidence: ev('call to action clarity', cta),
        fix: 'Make the main action specific ("Book a brake inspection") and visible without scrolling.',
        ...src(cta.confidence),
      }));
    } else {
      r.add(pass('ai-cta', C, 'Clear call to action'));
    }
  }

  const si = answers.search_intent;
  if (si && si.confidence >= 0.5) r.insight(C, 'Search intent the page fits', INTENT_LABELS[si.choice]);
  const lb = noul(answers.local_business);
  if (lb?.yes || lb?.no) r.insight('local', 'Looks like a local business page', lb.yes ? 'Yes' : 'No');
}

// Deterministic stand-in so tests and demos run without a key.
export function mockAnswers(state) {
  const wc = Number(state.word_count) || 0;
  const depth = wc < 150 ? 0.8 : wc < 300 ? 1.6 : wc < 800 ? 2.6 : 3.4;
  const text = String(state.text || '').toLowerCase();
  const titleWords = String(state.title || '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 3);
  const hits = titleWords.filter((w) => text.includes(w)).length;
  const match = titleWords.length ? hits / titleWords.length : 0.5;
  const trustHits = ['review', 'licensed', 'certified', 'years', 'warranty', 'insured', 'team'].filter((w) => text.includes(w)).length;
  const ctaHits = (state.buttons_and_links || []).filter((b) => /call|book|quote|schedule|contact|get started|buy/i.test(b)).length;
  const local = /\b(near|serving|located in|service area)\b/.test(text) || /\b[A-Z]{2}\s\d{5}\b/.test(state.text || '');
  return {
    model: 'mock',
    answers: {
      content_depth: { type: 'score', score: depth, confidence: 0.8, legend: {}, probabilities: {} },
      intent_match: { type: 'noul', noul: Math.min(0.95, Math.max(0.05, match)) },
      boilerplate: { type: 'noul', noul: wc < 200 ? 0.8 : 0.2 },
      trust_signals: { type: 'score', score: Math.min(3, trustHits * 0.75), confidence: 0.7, legend: {}, probabilities: {} },
      cta_clarity: { type: 'score', score: Math.min(3, ctaHits), confidence: 0.7, legend: {}, probabilities: {} },
      search_intent: { type: 'choice', choice: local ? 'local' : 'informational', confidence: 0.6, probabilities: {} },
      local_business: { type: 'noul', noul: local ? 0.85 : 0.15 },
    },
    usage: { input_tokens: 0, output_tokens: 0 },
  };
}
