// Copied unchanged from seo-audit-tool (claudes-desk, branch claude/project-thread-5eav50).
// Keep the two copies in step until they move to a shared package.

// Decides whether a URL or an IP address is safe for the auditor to fetch.
// Every request the tool makes (the page, each redirect hop, robots.txt,
// sitemaps, link and image checks) passes through these checks first.

export const MAX_URL_LENGTH = 2048;

// Hostnames that never point at the public web.
const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  'localhost.localdomain',
  'ip6-localhost',
  'ip6-loopback',
  'metadata',
  'metadata.google.internal',
  'instance-data',
  'instance-data.ec2.internal',
]);

const BLOCKED_SUFFIXES = [
  '.localhost',
  '.local',
  '.localdomain',
  '.internal',
  '.intranet',
  '.lan',
  '.home',
  '.home.arpa',
  '.corp',
  '.private',
  '.test',
  '.invalid',
  '.example',
  '.onion',
  '.arpa',
];

// IPv4 ranges that are not public unicast (RFC 6890 and friends).
const BLOCKED_V4 = [
  ['0.0.0.0', 8], // "this" network
  ['10.0.0.0', 8], // private
  ['100.64.0.0', 10], // carrier-grade NAT
  ['127.0.0.0', 8], // loopback
  ['169.254.0.0', 16], // link-local, cloud metadata
  ['172.16.0.0', 12], // private
  ['192.0.0.0', 24], // IETF protocol assignments
  ['192.0.2.0', 24], // documentation
  ['192.88.99.0', 24], // 6to4 relay anycast
  ['192.168.0.0', 16], // private
  ['198.18.0.0', 15], // benchmarking
  ['198.51.100.0', 24], // documentation
  ['203.0.113.0', 24], // documentation
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved, broadcast
].map(([base, bits]) => [ipv4ToInt(base), bits]);

export function parseIPv4(str) {
  if (typeof str !== 'string') return null;
  const parts = str.split('.');
  if (parts.length !== 4) return null;
  const out = [];
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const n = Number(p);
    if (n > 255) return null;
    out.push(n);
  }
  return out;
}

function ipv4ToInt(str) {
  const p = parseIPv4(str);
  return ((p[0] << 24) | (p[1] << 16) | (p[2] << 8) | p[3]) >>> 0;
}

function v4InRange(int, base, bits) {
  if (bits === 0) return true;
  const mask = (0xffffffff << (32 - bits)) >>> 0;
  return (int & mask) === (base & mask);
}

export function isBlockedIPv4(str) {
  const p = parseIPv4(str);
  if (!p) return true;
  const int = ((p[0] << 24) | (p[1] << 16) | (p[2] << 8) | p[3]) >>> 0;
  return BLOCKED_V4.some(([base, bits]) => v4InRange(int, base, bits));
}

// Parses an IPv6 address into 8 16-bit groups. Handles "::" and a dotted
// IPv4 tail. Returns null when the string is not an IPv6 address.
export function parseIPv6(input) {
  if (typeof input !== 'string') return null;
  let str = input.trim().toLowerCase();
  if (str.startsWith('[') && str.endsWith(']')) str = str.slice(1, -1);
  const zone = str.indexOf('%');
  if (zone !== -1) str = str.slice(0, zone);
  if (!str.includes(':')) return null;

  // A dotted IPv4 tail ("::ffff:127.0.0.1") becomes two hex groups.
  const lastColon = str.lastIndexOf(':');
  const maybeV4 = str.slice(lastColon + 1);
  if (maybeV4.includes('.')) {
    const v4 = parseIPv4(maybeV4);
    if (!v4) return null;
    const hi = ((v4[0] << 8) | v4[1]).toString(16);
    const lo = ((v4[2] << 8) | v4[3]).toString(16);
    str = `${str.slice(0, lastColon + 1)}${hi}:${lo}`;
  }

  const halves = str.split('::');
  if (halves.length > 2) return null;
  const toGroups = (s) => (s === '' ? [] : s.split(':'));
  const head = toGroups(halves[0]);
  const rest = halves.length === 2 ? toGroups(halves[1]) : [];
  for (const g of [...head, ...rest]) {
    if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
  }
  const explicit = head.length + rest.length;
  const groups = head.map((g) => parseInt(g, 16));
  if (halves.length === 2) {
    if (explicit > 7) return null;
    for (let i = 0; i < 8 - explicit; i++) groups.push(0);
    groups.push(...rest.map((g) => parseInt(g, 16)));
  } else if (explicit !== 8) {
    return null;
  }
  return groups.length === 8 ? groups : null;
}

function embeddedV4(groups, hi, lo) {
  return [groups[hi] >> 8, groups[hi] & 0xff, groups[lo] >> 8, groups[lo] & 0xff].join('.');
}

export function isBlockedIPv6(str) {
  const g = parseIPv6(str);
  if (!g) return true;
  const allZeroUpTo = (n) => g.slice(0, n).every((x) => x === 0);

  // ::, ::1, and the deprecated IPv4-compatible ::a.b.c.d
  if (allZeroUpTo(6)) return true;
  // IPv4-mapped ::ffff:a.b.c.d
  if (allZeroUpTo(5) && g[5] === 0xffff) return isBlockedIPv4(embeddedV4(g, 6, 7));
  // IPv4-translated ::ffff:0:a.b.c.d
  if (allZeroUpTo(4) && g[4] === 0xffff && g[5] === 0) return true;
  // NAT64 64:ff9b::/96 maps to an IPv4 address; judge that address
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0)) {
    return isBlockedIPv4(embeddedV4(g, 6, 7));
  }
  // Local-use NAT64 64:ff9b:1::/48
  if (g[0] === 0x64 && g[1] === 0xff9b && g[2] === 1) return true;
  // Discard-only 100::/64
  if (g[0] === 0x100 && g[1] === 0 && g[2] === 0 && g[3] === 0) return true;
  // 2001::/23 IETF protocol assignments (Teredo, ORCHID, etc.)
  if (g[0] === 0x2001 && g[1] < 0x200) return true;
  // Documentation 2001:db8::/32 and 3fff::/20
  if (g[0] === 0x2001 && g[1] === 0xdb8) return true;
  if (g[0] === 0x3fff && g[1] < 0x1000) return true;
  // 6to4 2002::/16 can wrap any IPv4 address, so refuse it outright
  if (g[0] === 0x2002) return true;
  // Unique local fc00::/7, link-local fe80::/10, site-local fec0::/10, multicast ff00::/8
  if ((g[0] & 0xfe00) === 0xfc00) return true;
  if ((g[0] & 0xffc0) === 0xfe80) return true;
  if ((g[0] & 0xffc0) === 0xfec0) return true;
  if ((g[0] & 0xff00) === 0xff00) return true;
  // Only global unicast 2000::/3 is left as allowed
  if ((g[0] & 0xe000) !== 0x2000) return true;
  return false;
}

export function isIpLiteral(host) {
  return parseIPv4(host) !== null || parseIPv6(host) !== null;
}

// True when the address must never be contacted.
export function isBlockedIp(address) {
  if (parseIPv4(address)) return isBlockedIPv4(address);
  if (parseIPv6(address)) return isBlockedIPv6(address);
  return true;
}

function isBlockedHostname(host) {
  if (BLOCKED_HOSTNAMES.has(host)) return true;
  if (BLOCKED_SUFFIXES.some((s) => host.endsWith(s))) return true;
  return false;
}

const LABEL = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/;

/**
 * Validates a URL the auditor is about to fetch.
 * Returns { ok: true, url } with a normalized URL string, or { ok: false, reason }.
 * `allowBareHost` lets user input like "example.com" through by adding https://.
 */
export function checkUrl(input, { allowBareHost = false } = {}) {
  if (typeof input !== 'string') return { ok: false, reason: 'URL must be text.' };
  let raw = input.trim();
  if (!raw) return { ok: false, reason: 'Enter a URL.' };
  if (raw.length > MAX_URL_LENGTH) return { ok: false, reason: 'That URL is too long.' };
  // Control characters and whitespace inside a URL are never legitimate here.
  if (/[\u0000-\u001f\u007f\s]/.test(raw)) return { ok: false, reason: 'That URL has invalid characters.' };
  if (allowBareHost && !/^[a-z][a-z0-9+.-]*:/i.test(raw)) raw = `https://${raw}`;

  let url;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: 'That is not a valid URL.' };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, reason: 'Only http and https URLs can be audited.' };
  }
  if (url.username || url.password) {
    return { ok: false, reason: 'URLs with a username or password are not allowed.' };
  }
  // The URL parser drops default ports, so any port left over is non-standard.
  if (url.port !== '') {
    return { ok: false, reason: 'Only the standard web ports (80 and 443) are allowed.' };
  }

  let host = url.hostname.toLowerCase();
  if (host.endsWith('.')) host = host.slice(0, -1);
  if (!host) return { ok: false, reason: 'That URL has no host.' };

  const bare = host.startsWith('[') ? host.slice(1, -1) : host;
  if (isIpLiteral(bare)) {
    if (isBlockedIp(bare)) return { ok: false, reason: 'That address is private or reserved and cannot be audited.' };
  } else {
    if (isBlockedHostname(host)) return { ok: false, reason: 'That host is private or reserved and cannot be audited.' };
    const labels = host.split('.');
    if (labels.length < 2) return { ok: false, reason: 'Enter a full domain name, like example.com.' };
    if (!labels.every((l) => LABEL.test(l))) return { ok: false, reason: 'That domain name is not valid.' };
    if (/^\d+$/.test(labels[labels.length - 1])) return { ok: false, reason: 'That domain name is not valid.' };
  }

  url.hash = '';
  return { ok: true, url: url.toString(), hostname: bare };
}
