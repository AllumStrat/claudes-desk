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

// The largest request body accepted. A full brief with ten pasted siblings
// is well under it.
export const MAX_BODY_BYTES = 256 * 1024;

const json = (status, data) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json; charset=utf-8' } });

/** Compares two strings in time that does not depend on where they differ. */
export function sameToken(a, b) {
  const x = new TextEncoder().encode(String(a));
  const y = new TextEncoder().encode(String(b));
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

/**
 * Reads the body as text, stopping at max bytes. Content-Length is checked
 * first, but the count is what decides: the header can be missing or wrong.
 * Resolves to null when the body is too big.
 */
export async function readBody(request, max = MAX_BODY_BYTES) {
  const declared = Number(request.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > max) return null;
  if (!request.body) return '';
  const reader = request.body.getReader();
  const chunks = [];
  let bytes = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > max) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const all = new Uint8Array(bytes);
  let at = 0;
  for (const c of chunks) {
    all.set(c, at);
    at += c.byteLength;
  }
  return new TextDecoder().decode(all);
}

export async function handle(request, env, deps = {}) {
  const url = new URL(request.url);
  if (url.pathname !== '/api/write') return json(404, { error: 'Not found' });
  if (request.method !== 'POST') return json(405, { error: 'Use POST' });
  if (!env.WRITER_TOKEN || !env.ANTHROPIC_API_KEY) return json(503, { error: 'The writer is not set up yet (WRITER_TOKEN and ANTHROPIC_API_KEY).' });
  const auth = request.headers.get('authorization') || '';
  if (!auth.startsWith('Bearer ') || !sameToken(auth.slice(7), env.WRITER_TOKEN)) return json(401, { error: 'Unauthorized' });

  const raw = await readBody(request);
  if (raw == null) return json(413, { error: `The request body is over ${MAX_BODY_BYTES / 1024} KB.` });
  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    return json(400, { error: 'Send JSON: { "brief": {...} }' });
  }
  if (!body || typeof body !== 'object') return json(400, { error: 'Send JSON: { "brief": {...} }' });
  let config;
  try {
    config = resolveConfig({ ...(env.WRITER_EFFORT ? { effort: JSON.parse(env.WRITER_EFFORT) } : {}), ...(env.WRITER_MODEL ? { model: env.WRITER_MODEL } : {}) });
  } catch {
    return json(503, { error: 'WRITER_EFFORT or WRITER_MODEL is not valid.' });
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
