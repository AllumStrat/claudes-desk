import test from 'node:test';
import assert from 'node:assert/strict';
import { checkUrl, isBlockedIp, parseIPv6 } from '../src/core/url-guard.js';

const blocked = [
  'http://localhost/',
  'http://LOCALHOST./',
  'http://foo.localhost/',
  'http://127.0.0.1/',
  'http://127.1/',
  'http://2130706433/', // decimal 127.0.0.1
  'http://0x7f000001/', // hex
  'http://017700000001/', // octal
  'http://0/',
  'http://0.0.0.0/',
  'http://10.0.0.5/',
  'http://172.16.3.4/',
  'http://172.31.255.255/',
  'http://192.168.1.1/',
  'http://100.64.0.1/',
  'http://169.254.169.254/latest/meta-data/',
  'http://metadata.google.internal/computeMetadata/v1/',
  'http://instance-data/',
  'http://[::1]/',
  'http://[::]/',
  'http://[::ffff:127.0.0.1]/',
  'http://[::ffff:7f00:1]/',
  'http://[::ffff:a9fe:a9fe]/', // mapped 169.254.169.254
  'http://[64:ff9b::a9fe:a9fe]/', // NAT64 of metadata IP
  'http://[fe80::1]/',
  'http://[fc00::1]/',
  'http://[fd12:3456::1]/',
  'http://[2002:7f00:1::]/', // 6to4 wrapping 127.0.0.1
  'http://[2001:db8::1]/',
  'http://224.0.0.1/',
  'http://255.255.255.255/',
  'http://198.18.0.1/',
  'http://printer.local/',
  'http://router.lan/',
  'http://intranet/',
  'file:///etc/passwd',
  'ftp://example.com/',
  'gopher://example.com/',
  'javascript:alert(1)',
  'data:text/html,hi',
  'http://user:pass@example.com/',
  'http://example.com@127.0.0.1/',
  'http://example.com:22/',
  'http://example.com:8080/',
  'https://example.com:6379/',
  'http://exa mple.com/',
  'http://exa\nmple.com/',
  'http://example.com/\u0000',
  'http://127.0.0.1.nip.io.local/',
];

test('refuses private, reserved and odd targets', () => {
  for (const u of blocked) {
    const r = checkUrl(u, { allowBareHost: true });
    assert.equal(r.ok, false, `expected ${JSON.stringify(u)} to be refused, got ${JSON.stringify(r)}`);
  }
});

test('allows ordinary public sites', () => {
  for (const u of ['https://example.com/', 'http://www.example.org/path?q=1', 'example.com', 'https://8.8.8.8/', 'https://[2606:4700:4700::1111]/', 'https://xn--bcher-kva.ch/', 'http://1.2.3/']) {
    const r = checkUrl(u, { allowBareHost: true });
    assert.equal(r.ok, true, `expected ${u} to pass: ${r.reason}`);
  }
});

test('bare hosts need https added only when allowed', () => {
  assert.equal(checkUrl('example.com').ok, false);
  assert.equal(checkUrl('example.com', { allowBareHost: true }).url, 'https://example.com/');
});

test('drops the fragment and keeps default ports implicit', () => {
  assert.equal(checkUrl('https://example.com:443/a#frag').url, 'https://example.com/a');
});

test('rejects very long URLs', () => {
  assert.equal(checkUrl(`https://example.com/${'a'.repeat(3000)}`).ok, false);
});

test('IP classification', () => {
  assert.equal(isBlockedIp('93.184.215.14'), false);
  assert.equal(isBlockedIp('1.1.1.1'), false);
  assert.equal(isBlockedIp('2606:4700:4700::1111'), false);
  assert.equal(isBlockedIp('127.0.0.1'), true);
  assert.equal(isBlockedIp('::ffff:10.0.0.1'), true);
  assert.equal(isBlockedIp('::ffff:8.8.8.8'), false);
  assert.equal(isBlockedIp('fe80::1%eth0'), true);
  assert.equal(isBlockedIp('not an ip'), true);
});

test('IPv6 parser', () => {
  assert.deepEqual(parseIPv6('::1'), [0, 0, 0, 0, 0, 0, 0, 1]);
  assert.deepEqual(parseIPv6('::ffff:127.0.0.1'), [0, 0, 0, 0, 0, 0xffff, 0x7f00, 1]);
  assert.deepEqual(parseIPv6('2001:db8::'), [0x2001, 0xdb8, 0, 0, 0, 0, 0, 0]);
  assert.equal(parseIPv6('1::2::3'), null);
  assert.equal(parseIPv6('12345::'), null);
});
