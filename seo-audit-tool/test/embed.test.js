import test from 'node:test';
import assert from 'node:assert/strict';
import { makeApp, client, ORIGIN } from './app-helpers.js';
import { readConfig } from '../src/app/config.js';

// The page on a marketing site, calling the API on its own subdomain.
const SITE = 'https://www.example-agency.test';
const embedEnv = { APP_ORIGIN: SITE, APP_PAGE: '/tools/seo-audit/' };

const preflight = (ctx, origin) =>
  ctx.app.fetch(
    new Request(`${ORIGIN}/api/audit`, {
      method: 'OPTIONS',
      headers: { origin, 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type' },
    }),
  );

test('APP_PAGE moves emailed and Stripe links onto the page the tool sits on', async () => {
  const ctx = makeApp({ env: embedEnv });
  const c = client(ctx, { origin: SITE });
  await c.signIn('a@example.com');
  assert.match(ctx.mailer.sent[0].text, new RegExp(`^${SITE}/tools/seo-audit/#signin=`, 'm'));
  await c.post('/api/billing/checkout');
  const [, session] = ctx.stripe.calls.find(([k]) => k === 'checkout');
  assert.equal(session.successUrl, `${SITE}/tools/seo-audit/?paid=1`);
  assert.equal(session.cancelUrl, `${SITE}/tools/seo-audit/`);
});

test('APP_PAGE must be a plain path', () => {
  const base = { APP_ORIGIN: 'http://127.0.0.1:1' };
  assert.equal(readConfig(base).pageUrl, 'http://127.0.0.1:1/');
  assert.equal(readConfig({ ...base, APP_PAGE: '/tools/seo-audit/' }).pageUrl, 'http://127.0.0.1:1/tools/seo-audit/');
  for (const bad of ['tools/', '//evil.test/', '/a/../b', '/a?x=1', '/a#b', '/a b/', 'https://evil.test/']) {
    assert.throws(() => readConfig({ ...base, APP_PAGE: bad }), /APP_PAGE/, bad);
  }
});

test('preflight answers allowed origins only', async () => {
  const ctx = makeApp({ env: embedEnv });
  const ok = await preflight(ctx, SITE);
  assert.equal(ok.status, 204);
  assert.equal(ok.headers.get('access-control-allow-origin'), SITE);
  assert.equal(ok.headers.get('access-control-allow-credentials'), 'true');
  assert.match(ok.headers.get('access-control-allow-methods'), /POST/);
  assert.match(ok.headers.get('access-control-allow-headers'), /content-type/);

  const bad = await preflight(ctx, 'https://evil.test');
  assert.equal(bad.status, 403);
  assert.equal(bad.headers.get('access-control-allow-origin'), null);
});

test('responses carry CORS headers for allowed origins and never for others', async () => {
  const ctx = makeApp({ env: embedEnv });
  const c = client(ctx, { origin: SITE });
  await c.signIn('a@example.com');
  const me = await c.get('/api/me', { origin: SITE });
  assert.equal(me.data.user.email, 'a@example.com');
  assert.equal(me.headers.get('access-control-allow-origin'), SITE);
  assert.equal(me.headers.get('access-control-allow-credentials'), 'true');
  assert.match(me.headers.get('vary'), /Origin/);

  // Another site can make the browser send the cookie on a GET, but without
  // the CORS headers the browser will not let it read the answer.
  const evil = await c.get('/api/me', { origin: 'https://evil.test' });
  assert.equal(evil.headers.get('access-control-allow-origin'), null);
  const post = await client(ctx, { origin: 'https://evil.test' }).post('/api/auth/start', { email: 'b@example.com' });
  assert.equal(post.status, 403);
  assert.equal(post.headers.get('access-control-allow-origin'), null);
});
