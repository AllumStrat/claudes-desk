// Local test server: serves the page in public/ and the /api/audit endpoint.
// Binds to 127.0.0.1 by default so it is not reachable from your network.

import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createAuditHandler, SECURITY_HEADERS, MAX_BODY_BYTES, turnstileVerifier } from '../core/handler.js';
import { SlidingWindowLimiter, ConcurrencyGate } from '../core/rate-limit.js';
import { buildDeps } from './config.js';

const PUBLIC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../public');
const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/styles.css': ['styles.css', 'text/css; charset=utf-8'],
};

export function createServer(env = process.env) {
  const { auditDeps, net, jev } = buildDeps(env);
  const limiter = new SlidingWindowLimiter({
    limit: Number(env.AUDIT_RATE_LIMIT || 5),
    windowMs: Number(env.AUDIT_RATE_WINDOW_MIN || 10) * 60_000,
  });
  const targetLimiter = new SlidingWindowLimiter({ limit: Number(env.AUDIT_TARGET_LIMIT || 10), windowMs: 60 * 60_000 });
  const gate = new ConcurrencyGate(Number(env.AUDIT_MAX_CONCURRENT || 2));
  const handle = createAuditHandler({
    auditDeps,
    limiter,
    targetLimiter,
    gate,
    verifyHuman: env.TURNSTILE_SECRET ? turnstileVerifier(env.TURNSTILE_SECRET) : undefined,
    onError: (err) => console.error('[audit] unexpected error:', err?.stack || err),
  });
  const trustProxy = env.TRUST_PROXY === '1';

  const server = http.createServer(async (req, res) => {
    const send = (status, body, headers = {}) => {
      res.writeHead(status, { ...SECURITY_HEADERS, ...headers });
      res.end(body);
    };
    try {
      const url = new URL(req.url, 'http://local');
      if (req.method === 'GET' && STATIC[url.pathname]) {
        const [file, type] = STATIC[url.pathname];
        const body = await readFile(path.join(PUBLIC_DIR, file));
        return send(200, body, { 'content-type': type, 'cache-control': 'no-cache' });
      }
      if (req.method === 'GET' && url.pathname === '/healthz') {
        return send(200, 'ok', { 'content-type': 'text/plain' });
      }
      if (url.pathname === '/api/audit') {
        const bodyText = await readBody(req, MAX_BODY_BYTES);
        if (bodyText === null) {
          res.on('finish', () => req.destroy());
          return send(413, JSON.stringify({ error: 'Request is too large.' }), { 'content-type': 'application/json', connection: 'close' });
        }
        const forwarded = trustProxy ? String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() : '';
        const out = await handle({
          method: req.method,
          host: req.headers.host || '',
          origin: req.headers.origin || '',
          contentType: req.headers['content-type'] || '',
          ip: forwarded || req.socket.remoteAddress,
          bodyText,
        });
        return send(out.status, JSON.stringify(out.body), {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': 'no-store',
          ...out.headers,
        });
      }
      return send(404, 'Not found', { 'content-type': 'text/plain' });
    } catch (err) {
      console.error('[server]', err?.stack || err);
      if (!res.headersSent) send(500, 'Server error', { 'content-type': 'text/plain' });
      else res.destroy();
    }
  });
  server.headersTimeout = 10_000;
  server.requestTimeout = 90_000;
  server.maxHeadersCount = 50;
  return { server, net, jev };
}

function readBody(req, max) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > max) {
        req.removeAllListeners('data');
        req.pause();
        resolve(null);
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const host = process.env.HOST || '127.0.0.1';
  const port = Number(process.env.PORT || 8787);
  const { server, jev } = createServer();
  server.listen(port, host, () => {
    console.log(`SEO audit test server on http://${host}:${port}`);
    console.log(`Jev judgment: ${jev ? jev.provider : 'off'}`);
  });
}
