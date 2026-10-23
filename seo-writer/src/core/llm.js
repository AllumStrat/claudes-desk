// The one place that talks to the Claude API. Every call sends the same
// cached system prompt, the same response schema and the same thinking and
// effort settings, so the prompt cache holds from one step to the next; it
// hands back the step's part of the JSON with its token usage. Tests swap
// this for a fake with the same call() shape.

import Anthropic from '@anthropic-ai/sdk';
import { RESPONSE_SCHEMA } from './prompts.js';

export class LlmError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'LlmError';
    this.code = code;
    Object.assign(this, details);
  }
}

const EPHEMERAL = { type: 'ephemeral' };

/**
 * Builds the request body for one call. Exported so tests can check the
 * cache breakpoints and model settings without a network.
 *
 * @param {object} a
 * @param {string} a.system                  stable system prompt (cached)
 * @param {Array<{text:string, cache?:boolean}>} a.blocks  user content, stable blocks first
 * @param {string} a.effort                  keep it the same on every call: a change breaks the cache
 * @param {object} a.config                  resolved writer config
 */
export function buildRequest({ system, blocks, effort, config, schema = RESPONSE_SCHEMA }) {
  const params = {
    model: config.model,
    max_tokens: config.maxTokens,
    // Sonnet 5.5 rejects disabled thinking; adaptive lets it think as much
    // as the step needs, and effort sets how much that is.
    thinking: { type: 'adaptive' },
    output_config: { effort, format: { type: 'json_schema', schema } },
    system: [{ type: 'text', text: system, cache_control: EPHEMERAL }],
    messages: [
      {
        role: 'user',
        content: blocks.map((b) => ({ type: 'text', text: b.text, ...(b.cache ? { cache_control: EPHEMERAL } : {}) })),
      },
    ],
  };
  if (config.fallbacks) {
    params.betas = ['server-side-fallback-2026-07-01'];
    params.fallbacks = 'default';
  }
  return params;
}

/** Reads the JSON answer out of a finished message. */
export function readAnswer(msg) {
  if (msg.stop_reason === 'refusal') {
    const cat = msg.stop_details?.category;
    throw new LlmError('REFUSED', `The model declined this request${cat ? ` (${cat})` : ''}.`);
  }
  if (msg.stop_reason === 'max_tokens') {
    throw new LlmError('TRUNCATED', 'The answer ran past max_tokens; raise maxTokens or lower effort.');
  }
  // After a fallback the answer is the text that follows the last fallback block.
  const content = msg.content || [];
  const lastFallback = content.map((b) => b.type).lastIndexOf('fallback');
  const text = content
    .slice(lastFallback + 1)
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('');
  try {
    return JSON.parse(text);
  } catch {
    throw new LlmError('BAD_JSON', 'The model did not return valid JSON.', { text: text.slice(0, 500) });
  }
}

/**
 * @param {object} opts
 * @param {object} opts.config          resolved writer config
 * @param {string} [opts.apiKey]        defaults to the SDK's own lookup (ANTHROPIC_API_KEY, ...)
 * @param {Anthropic} [opts.client]     inject a client (tests)
 * @param {typeof fetch} [opts.fetch]   fetch for the SDK (Workers pass the global)
 */
export function createClaude({ config, apiKey, client, fetch: fetchImpl } = {}) {
  const anthropic = client || new Anthropic({ ...(apiKey ? { apiKey } : {}), ...(fetchImpl ? { fetch: fetchImpl } : {}), maxRetries: 3 });
  return {
    /** key: the response field this step fills (plan, sources, draft, edit or fix). */
    async call({ step, key, system, blocks, effort }) {
      const params = buildRequest({ system, blocks, effort, config });
      let msg;
      try {
        // Streaming keeps a long answer clear of HTTP timeouts.
        msg = await anthropic.beta.messages.stream(params).finalMessage();
      } catch (err) {
        if (err instanceof Anthropic.AuthenticationError) throw new LlmError('AUTH', 'The Anthropic API key was refused.', { step });
        if (err instanceof Anthropic.RateLimitError) throw new LlmError('RATE_LIMIT', 'The Anthropic API is rate limiting this key; try again shortly.', { step });
        if (err instanceof Anthropic.BadRequestError) throw new LlmError('BAD_REQUEST', `The API refused the ${step} request: ${err.message}`, { step });
        if (err instanceof Anthropic.APIError) throw new LlmError('API', `The Anthropic API failed on ${step}: ${err.message}`, { step });
        throw err;
      }
      const answer = readAnswer(msg);
      const data = key ? answer?.[key] : answer;
      if (data == null) throw new LlmError('BAD_JSON', `The model left the "${key}" field empty on ${step}.`, { step });
      return { data, usage: msg.usage, model: msg.model || config.model };
    },
  };
}
