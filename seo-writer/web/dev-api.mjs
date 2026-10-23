// Mounts the Worker's handler on /api/* inside `astro dev`, so the page runs
// against the real request path: token check, body cap, brief checks, the
// pipeline and the streamed progress. `npm run dev` sets WRITER_DEMO=1 (canned
// model, no key, no spend). `npm run dev:real` uses WRITER_TOKEN and
// ANTHROPIC_API_KEY from the shell and bills the key.

import { Readable } from 'node:stream';
import { handle } from '../src/worker/index.js';

const ENV_KEYS = ['WRITER_DEMO', 'WRITER_TOKEN', 'ANTHROPIC_API_KEY', 'WRITER_MODEL', 'WRITER_EFFORT', 'WRITER_MAX_SPEND'];

/** Node request in, Worker handler, Node response out. A dropped client aborts the run. */
const apiMiddleware = (env, logger) => async (req, res, next) => {
  if (!req.url?.startsWith('/api/')) return next();
  const gone = new AbortController();
  res.on('close', () => {
    if (!res.writableFinished) gone.abort();
  });
  try {
    const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
    const request = new Request(new URL(req.url, `http://${req.headers.host}`), {
      method: req.method,
      headers: Object.entries(req.headers).flatMap(([k, v]) => (Array.isArray(v) ? v.map((x) => [k, x]) : [[k, String(v)]])),
      body: hasBody ? Readable.toWeb(req) : undefined,
      duplex: hasBody ? 'half' : undefined,
      signal: gone.signal,
    });
    const response = await handle(request, env);
    res.writeHead(response.status, Object.fromEntries(response.headers));
    if (response.body) {
      for await (const chunk of response.body) res.write(chunk);
    }
    res.end();
  } catch (err) {
    logger.error(`writer API failed: ${err?.message}`);
    if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'The dev API failed.' }));
  }
};

export default function writerApi() {
  const env = Object.fromEntries(ENV_KEYS.filter((k) => process.env[k]).map((k) => [k, process.env[k]]));
  return {
    name: 'seo-writer-dev-api',
    hooks: {
      'astro:config:setup': ({ command, updateConfig, logger }) => {
        if (command !== 'dev') return;
        logger.info(env.WRITER_DEMO ? 'writer API on /api/*: demo mode, no API calls' : 'writer API on /api/*: real mode, bills ANTHROPIC_API_KEY');
        updateConfig({
          vite: {
            plugins: [
              {
                name: 'seo-writer-dev-api',
                // A post hook, so it runs after Astro has put its own
                // middlewares (the trailing-slash 404 among them) at the top
                // of the stack, and lands above them.
                configureServer: (server) => () => server.middlewares.stack.unshift({ route: '', handle: apiMiddleware(env, logger) }),
              },
            ],
          },
        });
      },
    },
  };
}
