import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from '../src/node/server.js';
import { createMailer } from '../src/app/email.js';

async function withServer(env, fn) {
  const mailer = createMailer({ provider: 'mock' });
  const { server, db } = createServer({ DB_FILE: ':memory:', ...env }, { port: 0, overrides: { mailer } });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await fn(base, mailer);
  } finally {
    server.close();
    db.close();
  }
}

test('serves the page with security headers and nothing else from disk', async () => {
  await withServer({}, async (base) => {
    const res = await fetch(`${base}/`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-security-policy'), /default-src 'none'/);
    assert.equal(res.headers.get('x-frame-options'), 'DENY');
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.equal((await fetch(`${base}/../package.json`)).status, 404);
    assert.equal((await fetch(`${base}/src/core/audit.js`)).status, 404);
    assert.equal((await fetch(`${base}/migrations/0001_accounts.sql`)).status, 404);
    const me = await (await fetch(`${base}/api/me`)).json();
    assert.equal(me.user, null);
  });
});

test('the local server runs sign-in end to end and rejects big bodies', async () => {
  // The server's own origin is http://127.0.0.1:0 here, so allow the test port.
  await withServer({ ALLOWED_ORIGINS: 'http://test.local' }, async (base, mailer) => {
    const headers = { 'content-type': 'application/json', origin: 'http://test.local' };
    const big = await fetch(`${base}/api/auth/start`, { method: 'POST', headers, body: 'x'.repeat(10_000) });
    assert.equal(big.status, 413);
    const start = await fetch(`${base}/api/auth/start`, { method: 'POST', headers, body: JSON.stringify({ email: 'local@example.com' }) });
    assert.equal(start.status, 200);
    const token = mailer.sent[0].text.match(/#signin=(\S+)/)[1];
    const verify = await fetch(`${base}/api/auth/verify`, { method: 'POST', headers, body: JSON.stringify({ token, email: 'local@example.com' }) });
    const cookie = verify.headers.get('set-cookie');
    assert.match(cookie, /^sid=.+HttpOnly; SameSite=Lax/);
    const me = await (await fetch(`${base}/api/me`, { headers: { cookie: cookie.split(';')[0] } })).json();
    assert.equal(me.user.email, 'local@example.com');
    const audit = await fetch(`${base}/api/audit`, { method: 'POST', headers: { ...headers, cookie: cookie.split(';')[0] }, body: JSON.stringify({ url: 'http://127.0.0.1:22/' }) });
    assert.equal(audit.status, 400);
  });
});
