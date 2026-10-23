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

// Does a robots.txt rule match the start of a path? "*" matches any run of
// characters and a "$" at the very end pins the match to the end of the path
// (RFC 9309; a "$" anywhere else is an ordinary character). No regex: the
// literal pieces between the stars are found in order, each at its leftmost
// place, which is always enough when "*" is the only wildcard. That is linear
// in the path for each piece, so a rule full of stars cannot backtrack.
export function ruleMatches(pattern, path) {
  return piecesMatch(compile(pattern), path);
}

// Split once per rule, not once per path checked.
const compiled = new Map();
function compile(pattern) {
  let c = compiled.get(pattern);
  if (!c) {
    const anchored = pattern.endsWith('$');
    c = { anchored, pieces: (anchored ? pattern.slice(0, -1) : pattern).split('*') };
    if (compiled.size > 10_000) compiled.clear();
    compiled.set(pattern, c);
  }
  return c;
}

function piecesMatch({ anchored, pieces }, path) {
  const first = pieces[0];
  if (!path.startsWith(first)) return false;
  if (pieces.length === 1) return !anchored || path.length === first.length;
  let at = first.length;
  const last = pieces.length - 1;
  for (let i = 1; i < last; i++) {
    const found = path.indexOf(pieces[i], at);
    if (found === -1) return false;
    at = found + pieces[i].length;
  }
  const tail = pieces[last];
  if (anchored) return path.length - tail.length >= at && path.endsWith(tail);
  return path.indexOf(tail, at) !== -1;
}

// Longest matching rule wins; on a tie, allow wins.
export function isAllowed(robots, pathWithQuery, token = BOT_TOKEN) {
  if (!robots) return true;
  const group = groupFor(robots, token.toLowerCase());
  if (!group) return true;
  let best = null;
  for (const rule of group.rules) {
    if (rule.path === '') continue; // "Disallow:" with no value allows everything
    if (!ruleMatches(rule.path, pathWithQuery)) continue;
    const len = rule.path.length;
    if (!best || len > best.len || (len === best.len && rule.allow)) best = { len, allow: rule.allow };
  }
  return best ? best.allow : true;
}

// True when the rules for every crawler ("*") block the whole site.
export function blocksEverything(robots, token = '*') {
  return !isAllowed(robots, '/', token) && !isAllowed(robots, '/index.html', token);
}
