// Local test server: serves the page in public/ and the app's /api routes.
// Binds to 127.0.0.1 by default so it is not reachable from your network.

import http from 'node:http';
import { Readable } from 'node:stream';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { SECURITY_HEADERS } from '../app/http.js';
import { buildLocalApp } from './config.js';

const PUBLIC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../public');
const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/styles.css': ['styles.css', 'text/css; charset=utf-8'],
};

export function createServer(env = process.env, { port = Number(env.PORT || 8787), overrides } = {}) {
  const built = buildLocalApp(env, { port, overrides });
  const { app, config } = built;
  const trustProxy = env.TRUST_PROXY === '1';

  const server = http.createServer(async (req, res) => {
    const send = (status, body, headers = {}) => {
      res.writeHead(status, { ...SECURITY_HEADERS, ...headers });
      res.end(body);
    };
    try {
      const url = new URL(req.url, config.appOrigin);
      if (req.method === 'GET' && STATIC[url.pathname]) {
        const [file, type] = STATIC[url.pathname];
        const body = await readFile(path.join(PUBLIC_DIR, file));
        return send(200, body, { 'content-type': type, 'cache-control': 'no-cache' });
      }
      if (req.method === 'GET' && url.pathname === '/healthz') return send(200, 'ok', { 'content-type': 'text/plain' });
      if (!url.pathname.startsWith('/api/')) return send(404, 'Not found', { 'content-type': 'text/plain' });

      const headers = new Headers();
      for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers.set(k, v);
      const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
      const request = new Request(url, { method: req.method, headers, body: hasBody ? Readable.toWeb(req) : undefined, duplex: 'half' });
      const forwarded = trustProxy ? String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() : '';
      const response = await app.fetch(request, { ip: forwarded || req.socket.remoteAddress || '' });

      const out = {};
      response.headers.forEach((v, k) => {
        if (k !== 'set-cookie') out[k] = v;
      });
      const cookies = response.headers.getSetCookie();
      if (cookies.length) out['set-cookie'] = cookies;
      if (!req.complete) {
        // The app stopped reading a body that was too large.
        out.connection = 'close';
        res.on('finish', () => req.destroy());
      }
      res.writeHead(response.status, out);
      res.end(Buffer.from(await response.arrayBuffer()));
    } catch (err) {
      console.error('[server]', err?.stack || err);
      if (!res.headersSent) send(500, 'Server error', { 'content-type': 'text/plain' });
      else res.destroy();
    }
  });
  server.headersTimeout = 10_000;
  server.requestTimeout = 90_000;
  server.maxHeadersCount = 50;
  return { server, ...built };
}

// Runs the hourly job (weekly re-checks and cleanup) while the server is up.
function startCron(app) {
  const timer = setInterval(() => app.scheduled().catch((err) => console.error('[cron]', err?.message)), 60 * 60_000);
  timer.unref();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const host = process.env.HOST || '127.0.0.1';
  const port = Number(process.env.PORT || 8787);
  const { server, jev, app, config } = createServer(process.env, { port });
  startCron(app);
  server.listen(port, host, () => {
    console.log(`SEO audit test server on ${config.appOrigin}`);
    console.log(`Email: ${config.email.provider === 'log' ? 'sign-in links print here' : config.email.provider}`);
    console.log(`Payments: ${config.billing ? (config.billing.testMode ? 'Stripe test mode' : 'Stripe LIVE mode') : config.billingProblem || 'off (no Stripe keys)'}`);
    console.log(`Human check: ${config.turnstileSecret ? 'on' : 'off'}`);
    console.log(`Jev judgment: ${jev ? jev.provider : 'off'}`);
  });
}
