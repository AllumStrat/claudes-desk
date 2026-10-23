import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { fetch as undiciFetch, Agent } from 'undici';
import { createGuardedLookup, createNodeNetwork } from '../src/node/net.js';

test('connect-time lookup refuses private answers', async () => {
  const fakeDns = (host, opts, cb) => cb(null, [{ address: '192.168.0.10', family: 4 }]);
  const lookup = createGuardedLookup(fakeDns);
  const err = await new Promise((resolve) => lookup('rebind.example.com', { all: true }, (e) => resolve(e)));
  assert.equal(err?.code, 'EBLOCKED');
});

test('connect-time lookup passes public answers in both callback styles', async () => {
  const fakeDns = (host, opts, cb) => cb(null, [{ address: '93.184.215.14', family: 4 }]);
  const lookup = createGuardedLookup(fakeDns);
  const all = await new Promise((resolve) => lookup('ok.example.com', { all: true }, (e, a) => resolve(a)));
  assert.equal(all[0].address, '93.184.215.14');
  const single = await new Promise((resolve) => lookup('ok.example.com', {}, (e, a, f) => resolve([a, f])));
  assert.deepEqual(single, ['93.184.215.14', 4]);
});

test('the real socket refuses a hostname that resolves to loopback', async () => {
  // Simulates DNS rebinding: the URL check is skipped and only the socket guard stands.
  const server = http.createServer((req, res) => res.end('secret'));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  const agent = new Agent({ connect: { lookup: createGuardedLookup() } });
  try {
    await assert.rejects(undiciFetch(`http://localhost:${port}/`, { dispatcher: agent }), (err) => {
      assert.equal(err.cause?.code, 'EBLOCKED');
      return true;
    });
  } finally {
    await agent.close();
    server.close();
  }
});

test('direct network mode builds', () => {
  const net = createNodeNetwork();
  assert.equal(net.mode, 'direct');
  assert.equal(typeof net.fetchImpl, 'function');
});
