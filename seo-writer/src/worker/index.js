// Cloudflare Worker entry (not deployed). One route:
//   POST /api/write   Authorization: Bearer <WRITER_TOKEN>
//   body: { "brief": {...}, "live": false }
// Answers with the copy doc and what the page cost. Internal use only: one
// shared token, no accounts. A run takes a few minutes, and the caller has to
// hold the connection open for all of it.

import { writePage } from '../core/pipeline.js';
import { createClaude, LlmError } from '../core/llm.js';
import { resolveConfig } from '../core/config.js';
import { createNet } from '../core/net.js';
import { createDohResolver } from '../core/doh.js';
import { copyDocName } from '../core/copydoc.js';
import { BriefError } from '../core/brief.js';

const json = (status, data) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json; charset=utf-8' } });

/** Compares two strings in time that does not depend on where they differ. */
export function sameToken(a, b) {
  const x = new TextEncoder().encode(String(a));
  const y = new TextEncoder().encode(String(b));
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

export async function handle(request, env, deps = {}) {
  const url = new URL(request.url);
  if (url.pathname !== '/api/write') return json(404, { error: 'Not found' });
  if (request.method !== 'POST') return json(405, { error: 'Use POST' });
  if (!env.WRITER_TOKEN || !env.ANTHROPIC_API_KEY) return json(503, { error: 'The writer is not set up yet (WRITER_TOKEN and ANTHROPIC_API_KEY).' });
  const auth = request.headers.get('authorization') || '';
  if (!auth.startsWith('Bearer ') || !sameToken(auth.slice(7), env.WRITER_TOKEN)) return json(401, { error: 'Unauthorized' });

  let body;
  try {
    body = await request.json();
  } catch {
    return json(400, { error: 'Send JSON: { "brief": {...} }' });
  }
  let config;
  try {
    config = resolveConfig(env.WRITER_EFFORT ? { effort: JSON.parse(env.WRITER_EFFORT) } : {});
  } catch {
    return json(503, { error: 'WRITER_EFFORT is not valid JSON.' });
  }
  const fetchImpl = (u, init) => fetch(u, init);
  const llm = deps.llm || createClaude({ config, apiKey: env.ANTHROPIC_API_KEY, fetch: fetchImpl });
  const net = deps.net || createNet({ fetchImpl, resolveHost: createDohResolver({ fetchImpl }) });
  try {
    const r = await writePage(body.brief, { llm, net, live: body.live === true, config });
    return json(200, { status: r.status, name: copyDocName(r), copyDoc: r.copyDoc, report: r.check?.report ?? null, confirms: r.confirms ?? [], usage: r.usage });
  } catch (err) {
    if (err instanceof BriefError) return json(400, { error: err.message });
    if (err instanceof LlmError) return json(502, { error: err.message, code: err.code, usage: err.usage });
    console.error('write failed', err?.message);
    return json(500, { error: 'The writer failed.', usage: err.usage });
  }
}

export default { fetch: (request, env) => handle(request, env) };
