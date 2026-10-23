// robots.txt parsing and matching (RFC 9309).

export const BOT_TOKEN = 'allumseoaudit';

export function parseRobots(text) {
  const groups = [];
  const sitemaps = [];
  let current = null;
  let lastWasAgent = false;
  const lines = String(text || '').split(/\r?\n/);
  let invalidLines = 0;
  for (const rawLine of lines) {
    const line = rawLine.replace(/#.*/, '').trim();
    if (!line) continue;
    const idx = line.indexOf(':');
    if (idx === -1) {
      invalidLines++;
      continue;
    }
    const field = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();
    if (field === 'user-agent') {
      if (!current || !lastWasAgent) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (field === 'sitemap') {
      if (value) sitemaps.push(value);
    } else if (field === 'allow' || field === 'disallow') {
      if (current) current.rules.push({ allow: field === 'allow', path: value });
    } else if (!['crawl-delay', 'host', 'clean-param', 'request-rate'].includes(field)) {
      invalidLines++;
    }
  }
  return { groups, sitemaps, invalidLines };
}

function groupFor(robots, token) {
  const specific = robots.groups.filter((g) => g.agents.some((a) => a !== '*' && token.includes(a)));
  if (specific.length) return mergeGroups(specific);
  const star = robots.groups.filter((g) => g.agents.includes('*'));
  return star.length ? mergeGroups(star) : null;
}

function mergeGroups(groups) {
  return { rules: groups.flatMap((g) => g.rules) };
}

function patternToRegex(path) {
  let anchored = false;
  let p = path;
  if (p.endsWith('$')) {
    anchored = true;
    p = p.slice(0, -1);
  }
  const escaped = p.replace(/[.+?^{}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}${anchored ? '$' : ''}`);
}

// Longest matching rule wins; on a tie, allow wins.
export function isAllowed(robots, pathWithQuery, token = BOT_TOKEN) {
  if (!robots) return true;
  const group = groupFor(robots, token.toLowerCase());
  if (!group) return true;
  let best = null;
  for (const rule of group.rules) {
    if (rule.path === '') continue; // "Disallow:" with no value allows everything
    if (!patternToRegex(rule.path).test(pathWithQuery)) continue;
    const len = rule.path.length;
    if (!best || len > best.len || (len === best.len && rule.allow)) best = { len, allow: rule.allow };
  }
  return best ? best.allow : true;
}

// True when the rules for every crawler ("*") block the whole site.
export function blocksEverything(robots, token = '*') {
  return !isAllowed(robots, '/', token) && !isAllowed(robots, '/index.html', token);
}
