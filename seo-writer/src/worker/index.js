// Cloudflare Worker entry (not deployed). Two routes:
//   GET  /api/status  whether the writer is set up, in demo mode, and its model and cap
//   POST /api/write   Authorization: Bearer <WRITER_TOKEN>
//   body: { "brief": {...}, "live": false }
// Answers with the copy doc and what the page cost. Send
// Accept: application/x-ndjson to get one line per step as the run goes,
// then a last line with the answer; the web page in web/ does this.
// WRITER_DEMO=1 swaps in a canned model and network (src/core/demo.js): no
// token, no key, no spend, and the same fictional page every time. Internal use only: one
// shared token of at least 32 characters, no accounts, and a per-page spend
// cap (WRITER_MAX_SPEND). Put Cloudflare Access in front of it and set a
// spend limit on the Anthropic key before deploying (README, The Worker).
// A run takes a few minutes, and the caller has to hold the connection open
// for all of it.

import { writePage } from '../core/pipeline.js';
import { createClaude, LlmError } from '../core/llm.js';
import { resolveConfig } from '../core/config.js';
import { createNet } from '../core/net.js';
import { createDohResolver } from '../core/doh.js';
import { copyDocName } from '../core/copydoc.js';
import { BriefError, normalizeBrief } from '../core/brief.js';
import { DEMO_BRIEF, createDemoLlm, createDemoNet } from '../core/demo.js';

// A shared token is only as good as its length. Shorter ones are refused at
// startup; better still, put Cloudflare Access in front (see the README).
export const MIN_TOKEN_LENGTH = 32;

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

const isDemo = (env) => env.WRITER_DEMO === '1' || env.WRITER_DEMO === 'true';

/** Why the writer cannot run yet, or null when it can. */
function notReady(env) {
  if (isDemo(env)) return null;
  if (!env.WRITER_TOKEN || !env.ANTHROPIC_API_KEY) return 'The writer is not set up yet (WRITER_TOKEN and ANTHROPIC_API_KEY).';
  if (String(env.WRITER_TOKEN).length < MIN_TOKEN_LENGTH) {
    return `WRITER_TOKEN is too short; use a random string of at least ${MIN_TOKEN_LENGTH} characters (openssl rand -hex 32).`;
  }
  return null;
}

function writerConfig(env) {
  return resolveConfig({
    ...(env.WRITER_EFFORT ? { effort: JSON.parse(env.WRITER_EFFORT) } : {}),
    ...(env.WRITER_MODEL ? { model: env.WRITER_MODEL } : {}),
    ...(env.WRITER_MAX_SPEND ? { maxSpend: Number(env.WRITER_MAX_SPEND) } : {}),
  });
}

export async function handle(request, env, deps = {}) {
  const url = new URL(request.url);
  if (url.pathname === '/api/status') return status(request, env);
  if (url.pathname !== '/api/write') return json(404, { error: 'Not found' });
  if (request.method !== 'POST') return json(405, { error: 'Use POST' });
  const why = notReady(env);
  if (why) return json(503, { error: why });
  const demo = isDemo(env);
  if (!demo) {
    const auth = request.headers.get('authorization') || '';
    if (!auth.startsWith('Bearer ') || !sameToken(auth.slice(7), env.WRITER_TOKEN)) return json(401, { error: 'Unauthorized' });
  }

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
    config = writerConfig(env);
  } catch {
    return json(503, { error: 'WRITER_EFFORT, WRITER_MODEL or WRITER_MAX_SPEND is not valid.' });
  }
  let brief = body.brief;
  let llm = deps.llm;
  let net = deps.net;
  if (demo) {
    // The brief that was sent is still checked, so the page shows real
    // errors, but the canned answers only fit the demo brief.
    try {
      normalizeBrief(brief);
    } catch (err) {
      if (err instanceof BriefError) return json(400, { error: err.message });
      throw err;
    }
    brief = DEMO_BRIEF;
    llm ||= createDemoLlm();
    net ||= createDemoNet();
  } else {
    const fetchImpl = (u, init) => fetch(u, init);
    llm ||= createClaude({ config, apiKey: env.ANTHROPIC_API_KEY, fetch: fetchImpl });
    net ||= createNet({ fetchImpl, resolveHost: createDohResolver({ fetchImpl }) });
  }
  const opts = { llm, net, live: body.live === true, config, signal: request.signal };

  if (!(request.headers.get('accept') || '').includes('application/x-ndjson')) {
    const [code, data] = await run(brief, opts, demo);
    return json(code, data);
  }
  // Streamed: a line per step, then { type: "done", code, data } with the
  // status code the plain answer would have had.
  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const enc = new TextEncoder();
  const send = (event) => writer.write(enc.encode(JSON.stringify(event) + '\n')).catch(() => {});
  (async () => {
    const [code, data] = await run(brief, { ...opts, onProgress: (step) => send({ type: 'step', step }) }, demo);
    await send({ type: 'done', code, data });
    await writer.close().catch(() => {});
  })();
  return new Response(readable, { status: 200, headers: { 'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': 'no-store' } });
}

/** Runs one page and returns [status code, answer]. */
async function run(brief, opts, demo) {
  try {
    // request.signal fires when the client disconnects (Workers need the
    // enable_request_signal compatibility flag); the run then makes no more
    // model calls. Without it, a dropped run finishes and its cost is spent.
    const r = await writePage(brief, opts);
    return [200, { status: r.status, demo, name: copyDocName(r), copyDoc: r.copyDoc, report: r.check?.report ?? null, confirms: r.confirms ?? [], usage: r.usage, usageTable: r.usageTable ?? null }];
  } catch (err) {
    if (err instanceof BriefError) return [400, { error: err.message }];
    if (err.code === 'SPEND_CAP') return [402, { error: err.message, code: err.code, usage: err.usage, usageTable: err.usageTable ?? null }];
    if (err.code === 'ABORTED') return [499, { error: err.message, code: err.code, usage: err.usage, usageTable: err.usageTable ?? null }];
    if (err instanceof LlmError) return [502, { error: err.message, code: err.code, usage: err.usage, usageTable: err.usageTable ?? null }];
    console.error('write failed', err?.message);
    return [500, { error: 'The writer failed.', usage: err.usage }];
  }
}

/** What the web page needs before it shows the form. Holds no secrets. */
function status(request, env) {
  if (request.method !== 'GET') return json(405, { error: 'Use GET' });
  const demo = isDemo(env);
  const why = notReady(env);
  let config = null;
  try {
    config = writerConfig(env);
  } catch {
    return json(200, { ready: false, demo, reason: 'WRITER_EFFORT, WRITER_MODEL or WRITER_MAX_SPEND is not valid.' });
  }
  return json(200, { ready: !why, demo, reason: why, model: config.model, maxSpend: config.maxSpend, token: !demo, maxBodyBytes: MAX_BODY_BYTES });
}

export default { fetch: (request, env) => handle(request, env) };
