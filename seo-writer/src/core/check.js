// JavaScript port of the seo-writing skill's scripts/check.py, so the same
// mechanical checks run inside a Worker (no Python there). Every number comes
// from the PARAMETERS.md JSON block and the banned words from the
// anti-ai-writing skill, exactly as check.py reads them.
//
// test/check-parity.test.js runs the real check.py on the same drafts and
// expects the same report, line for line. If check.py changes, sync the skill
// (npm run sync-skill) and that test shows what to port.

import { pyRound, pyListRepr, splitlines, pyStrip } from './py.js';

export const STOP = new Set(['a', 'an', 'the', 'in', 'near', 'for', 'of', 'and', 'to', 'on', 'at', 'me', 'my', 'with', 'by', '&']);
const WORD = /[A-Za-z0-9][A-Za-z0-9'’]*/g;
const LINK_SRC = String.raw`(?<!!)\[([^\]]+)\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)`;
const ITEM = /^\s*([-*+]|\d+[.)])\s+/;

// ---------- loading ----------

/** The first ```json block of PARAMETERS.md. */
export function parseParams(text) {
  const m = /```json\s*([\s\S]*?)```/.exec(text);
  if (!m) throw new Error('PARAMETERS.md has no ```json block');
  return JSON.parse(m[1]);
}

export function parseFrontmatter(text) {
  const fm = {};
  let body = text;
  const m = /^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/.exec(text);
  if (m) {
    body = m[2];
    for (const line of splitlines(m[1])) {
      if (!line.includes(':') || line.trim().startsWith('#')) continue;
      const at = line.indexOf(':');
      const k = line.slice(0, at);
      let v = line.slice(at + 1).trim();
      if (v.startsWith('[') && v.endsWith(']')) {
        v = v
          .slice(1, -1)
          .split(',')
          .filter((x) => x.trim())
          .map((x) => pyStrip(x.trim(), `'"`));
      } else {
        v = pyStrip(v, `'"`);
      }
      fm[k.trim()] = v;
    }
  }
  return { fm, body };
}

/** Banned vocabulary from the anti-ai-writing SKILL.md text: [hard, soft]. */
export function parseBanned(text) {
  const m = /##\s*Banned vocabulary[\s\S]*?\n([\s\S]*?)\n##\s/i.exec(text || '');
  if (!m) return null;
  const hard = [];
  const soft = [];
  for (let line of splitlines(m[1])) {
    line = line.trim();
    if (!line || line.startsWith('**')) continue;
    for (let item of line.split(',')) {
      item = item.trim().replace(/\.+$/, '');
      if (!item) continue;
      const qual = /\(([^)]*)\)/.test(item);
      const word = item.replace(/\s*\([^)]*\)/g, '').trim().replace(/!+$/, '').trim();
      if (word) (qual ? soft : hard).push(word);
    }
  }
  return { hard, soft };
}

// ---------- helpers ----------

export function words(text) {
  return text.match(WORD) || [];
}

export function stripMd(text) {
  text = text.replace(/```[\s\S]*?```/g, ' ');
  text = text.replace(/!\[[^\]]*\]\([^)]*\)/g, ' ');
  text = text.replace(new RegExp(LINK_SRC, 'g'), (_, a) => a);
  text = text.replace(/<[^>]+>/g, ' ');
  text = text.replace(/[*_`>|#]/g, ' ');
  return text;
}

export function tokens(s) {
  return words(s)
    .map((w) => w.toLowerCase())
    .filter((w) => !STOP.has(w));
}

export function hasTarget(text, target) {
  const have = new Set(words(text).map((w) => w.toLowerCase()));
  const need = tokens(target);
  const miss = need.filter((t) => !have.has(t));
  return [miss.length === 0, miss];
}

function netloc(u) {
  const m = /^[A-Za-z][A-Za-z0-9+.-]*:\/\/([^/?#]*)/.exec(u);
  return m ? m[1] : '';
}

function hasScheme(u) {
  return /^[A-Za-z][A-Za-z0-9+.-]*:/.test(u);
}

export function domain(u) {
  const d = netloc(u).toLowerCase();
  return d.startsWith('www.') ? d.slice(4) : d;
}

function isTitleCase(h) {
  const ws = words(h)
    .slice(1)
    .filter((w) => w.length > 3);
  if (ws.length < 2) return false;
  const caps = ws.filter((w) => w[0] !== w[0].toLowerCase() && w[0] === w[0].toUpperCase()).length;
  return caps / ws.length >= 0.6;
}

function grams(t, n = 6) {
  const w = t.toLowerCase().match(/[a-z0-9']+/g) || [];
  const out = new Set();
  for (let i = 0; i < w.length - n + 1; i++) out.add(w.slice(i, i + n).join('\u0000'));
  return out;
}

export function jaccard(a, b) {
  const A = grams(a);
  const B = grams(b);
  let inter = 0;
  for (const g of A) if (B.has(g)) inter++;
  const union = A.size + B.size - inter;
  return union ? inter / union : 0;
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', mdash: '—', ndash: '–', hellip: '…' };

export function htmlUnescape(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (all, e) => {
    if (e[0] === '#') {
      const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      try {
        return String.fromCodePoint(n);
      } catch {
        return all;
      }
    }
    return ENTITIES[e.toLowerCase()] ?? all;
  });
}

export function htmlMainText(raw) {
  raw = raw.replace(/<(script|style|noscript|svg|header|footer|nav)\b[\s\S]*?<\/\1>/gi, ' ');
  const m = /<main\b[\s\S]*?<\/main>/i.exec(raw);
  if (m) raw = m[0];
  return htmlUnescape(raw.replace(/<[^>]+>/g, ' '));
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\/-]/g, '\\$&');
const len = (s) => Array.from(s).length;
const pct = (x, d) => `${(x * 100).toFixed(d)}%`;

function phraseRe(kw) {
  const toks = tokens(kw).map(escapeRe);
  if (!toks.length) return null;
  const gap = String.raw`(?:\s+(?:` + [...STOP].filter((s) => s !== '&').sort().join('|') + String.raw`))*\s+`;
  return new RegExp(String.raw`\b` + toks.join(gap) + String.raw`\b`, 'gi');
}

const test = (re, s) => {
  re.lastIndex = 0;
  return re.test(s);
};
const count = (re, s) => {
  re.lastIndex = 0;
  return (s.match(re) || []).length;
};

// ---------- the check ----------

/**
 * Runs every check on one draft.
 *
 * @param {string} draft      draft text in the skill's format (frontmatter + Markdown)
 * @param {object} opts
 * @param {object} opts.params        parsed PARAMETERS.md JSON
 * @param {{hard:string[],soft:string[]}|null} opts.banned  from parseBanned
 * @param {(url:string)=>Promise<[number|null, string|null]>} [opts.status]  live link check
 * @param {Array<{name:string,text?:string,html?:string,markdown?:string}>} [opts.siblings]
 * @returns {Promise<{results:Array<[string,string,string]>, fails:number, green:boolean, report:string}>}
 */
export async function checkDraft(draft, { params: P, banned = null, status = null, siblings = [] } = {}) {
  const results = [];
  const add = (level, check, msg) => results.push([level, check, msg]);
  const inRange = (check, label, n, rng) => {
    const [lo, hi] = Array.isArray(rng) ? rng : [rng, rng];
    add(lo <= n && n <= hi ? 'PASS' : 'FAIL', check, lo !== hi ? `${n} ${label} (want ${lo}-${hi})` : `${n} ${label} (want ${lo})`);
  };

  const C = P.content;
  const K = P.keywords;
  const M = P.metadata;
  const I = P.internal;
  const { fm, body } = parseFrontmatter(draft);
  const primary = fm.primary || fm.target || '';
  let secondary = fm.secondary || [];
  let variants = fm.variants || [];
  if (typeof secondary === 'string') secondary = [secondary];
  if (typeof variants === 'string') variants = [variants];
  const ptype = fm.type || '';
  const site = domain('https://' + String(fm.site || '').replace('https://', '').replace('http://', ''));
  const title = fm.title || '';
  const meta = fm.meta || '';
  let comp = fm.competitors || [];
  if (typeof comp === 'string') comp = [comp]; // check.py would read a bare string letter by letter
  const competitors = new Set(comp.map((c) => domain('https://' + c.replace('https://', '').replace('http://', ''))));

  for (const k of ['type', 'site', 'slug', 'title', 'meta']) {
    if (!fm[k] || (Array.isArray(fm[k]) && !fm[k].length)) add('FAIL', 'frontmatter', `missing '${k}'`);
  }
  if (!primary) add('FAIL', 'frontmatter', "missing 'primary'");
  const T = P.types[ptype];
  if (ptype && !T) add('FAIL', 'frontmatter', `type '${ptype}' not in PARAMETERS.md types ${pyListRepr(Object.keys(P.types))}`);

  // ---- headings
  const lines = splitlines(body);
  const heads = [];
  lines.forEach((l, i) => {
    const m = /^(#{1,6})\s+(.*)$/.exec(l);
    if (m) heads.push([m[1].length, m[2].trim(), i]);
  });
  const h1s = heads.filter((h) => h[0] === 1);
  const h2s = heads.filter((h) => h[0] === 2).map((h) => h[1]);
  inRange('content', 'H1', h1s.length, C.h1);
  inRange('content', 'H2s', h2s.length, C.h2);
  let prev = 0;
  for (const [lvl, text] of heads) {
    if (prev && lvl > prev + 1) add('FAIL', 'headings', `skipped level H${prev} -> H${lvl} at '${text}'`);
    if (isTitleCase(text)) add('WARN', 'headings', `looks like title case: '${text}' (use sentence case)`);
    prev = lvl;
  }

  // ---- body blocks: paragraphs and lists
  const start = h1s.length ? h1s[0][2] + 1 : 0;
  const blines = lines.slice(start);
  const afterH1 = blines.join('\n');
  const plain = stripMd(afterH1);
  const bodyWords = words(plain);
  const wc = bodyWords.length;

  const paras = [];
  let block = [];
  let nLists = 0;
  let prevItem = false;
  for (const l of [...blines, '']) {
    const isItem = ITEM.test(l);
    if (isItem) {
      if (!prevItem) nLists++;
      prevItem = true;
    } else if (l.trim() === '') {
      // blank lines keep a list open
    } else if (prevItem && /^\s{2,}\S/.test(l)) {
      // continuation of a list item
    } else {
      prevItem = false;
    }
    if (l.trim() === '' || isItem || /^\s*([#>|]|---)/.test(l) || (prevItem && !isItem)) {
      if (block.length) paras.push(block.join(' '));
      block = [];
    } else {
      block.push(l.trim());
    }
  }
  inRange('content', 'paragraphs', paras.length, C.paragraphs);
  inRange('content', 'lists', nLists, C.lists);

  // ---- length
  const [lo, hi] = C.words;
  add(lo <= wc && wc <= hi ? 'PASS' : 'FAIL', 'content', `${wc} words (want ${lo}-${hi})`);
  let wt = fm.words_target;
  const tol = P.length.tolerance;
  if (wt) {
    wt = parseInt(String(wt).replaceAll(',', ''), 10);
    if (Number.isNaN(wt)) {
      add('FAIL', 'length', `words_target '${fm.words_target}' is not a number`);
    } else {
      if (!(lo <= wt && wt <= hi)) add('FAIL', 'length', `words_target ${wt} is outside ${lo}-${hi}; clamp it`);
      const tlo = wt * (1 - tol);
      const thi = wt * (1 + tol);
      if (wc < tlo) add('FAIL', 'length', `${wc} words vs target ${wt} (min ${Math.trunc(tlo)})`);
      else if (wc > thi) add('WARN', 'length', `${wc} words vs target ${wt} (max ${Math.trunc(thi)}); check for padding`);
      else add('PASS', 'length', `${wc} words vs target ${wt}`);
    }
  } else {
    add('WARN', 'length', 'no words_target; run serp.py on the top 3 and add it');
  }

  // ---- keywords
  const flat = bodyWords.map((w) => w.toLowerCase()).join(' ');
  const thirds = wc
    ? [0, 1, 2].map((i) =>
        bodyWords
          .slice(Math.floor((i * wc) / 3), Math.floor(((i + 1) * wc) / 3))
          .join(' ')
          .toLowerCase(),
      )
    : ['', '', ''];
  if (primary) {
    const prx = phraseRe(primary);
    if (h1s.length) {
      const [ok, miss] = hasTarget(h1s[0][1], primary);
      add(ok ? 'PASS' : 'FAIL', 'primary', `H1 '${h1s[0][1]}'` + (ok ? '' : ` missing ${pyListRepr(miss)}`));
    }
    if (paras.length) {
      const ok = test(prx, stripMd(paras[0]));
      add(ok ? 'PASS' : 'FAIL', 'primary', ok ? 'in first paragraph' : 'missing from the first paragraph');
    }
    const missing = ['opening', 'middle', 'closing'].filter((n, i) => !test(prx, thirds[i]));
    add(missing.length ? 'FAIL' : 'PASS', 'primary', missing.length ? `missing from the ${missing.join(', ')} third` : 'in every third of the body');
    const hits = count(prx, flat);
    const dens = wc ? hits / wc : 0;
    const [dlo, dhi] = K.primary_density;
    const dmax = K.primary_density_max;
    const lvl = dens > dmax ? 'FAIL' : !(dlo <= dens && dens <= dhi) ? 'WARN' : 'PASS';
    add(lvl, 'primary', `${hits} mentions, density ${pct(dens, 1)} (want ${pct(dlo, 1)}-${pct(dhi, 1)}, max ${pct(dmax, 0)})`);
    const h2Hits = h2s.filter((h) => test(prx, h)).length;
    if (h2s.length && h2Hits / h2s.length > K.primary_h2_share_max) {
      add('WARN', 'primary', `in ${h2Hits} of ${h2s.length} H2s; move some headings to secondaries or variants`);
    }
    const slug = fm.slug || '';
    if (slug && !hasTarget(slug.replaceAll('-', ' ').replaceAll('/', ' '), primary)[0]) {
      add('FAIL', 'primary', `slug '${slug}' missing primary words`);
    }
  }
  inRange('variants', 'variants', variants.length, K.variants);
  for (const kw of variants) {
    const r = phraseRe(kw);
    const ok = r && test(r, flat);
    add(ok ? 'PASS' : 'FAIL', 'variants', `'${kw}' ` + (ok ? 'in body' : 'missing from body'));
  }
  inRange('secondary', 'secondary keywords', secondary.length, K.secondary);
  for (const kw of secondary) {
    const r = phraseRe(kw);
    if (r && test(r, flat)) add('PASS', 'secondary', `'${kw}' in body`);
    else if (hasTarget(plain, kw)[0]) add('WARN', 'secondary', `'${kw}' words present but not as a phrase`);
    else add('FAIL', 'secondary', `'${kw}' missing from body`);
  }
  if (secondary.length && !h2s.some((h) => secondary.some((kw) => hasTarget(h, kw)[0]))) {
    add('WARN', 'secondary', 'no secondary keyword carries an H2');
  }

  // ---- metadata
  if (title) {
    add(len(title) <= M.title_max ? 'PASS' : 'FAIL', 'title', `${len(title)} chars (max ${M.title_max})`);
    if (primary) {
      if (!hasTarget(title, primary)[0]) add('FAIL', 'title', 'primary keyword missing');
      else if (!hasTarget(Array.from(title).slice(0, Math.floor(len(title) / 2) + 10).join(''), primary)[0]) {
        add('WARN', 'title', 'primary keyword not in first half');
      }
    }
  }
  if (meta) {
    const [mlo, mhi] = M.meta;
    add(mlo <= len(meta) && len(meta) <= mhi ? 'PASS' : 'FAIL', 'meta', `${len(meta)} chars (want ${mlo}-${mhi})`);
    if (primary && !hasTarget(meta, primary)[0]) add('FAIL', 'meta', 'primary keyword missing');
  }

  // ---- readability
  const R = P.readability;
  for (const p of paras) {
    const n = (stripMd(p).match(/[.!?](?:\s|$)/g) || []).length;
    if (n > R.paragraph_max_sentences) add('WARN', 'paragraph', `${n} sentences: '${Array.from(stripMd(p)).slice(0, 60).join('').trim()}...'`);
  }
  const idx = [...heads.map((h) => h[2]), lines.length];
  for (let j = 0; j < idx.length - 1; j++) {
    const s = idx[j];
    const e = idx[j + 1];
    const n = words(stripMd(lines.slice(s + 1, e).join('\n'))).length;
    if (n > R.max_words_between_headings) {
      add('WARN', 'headings', `${n} words under '${Array.from(lines[s].replace(/^[# ]+/, '')).slice(0, 50).join('')}' (max ${R.max_words_between_headings})`);
    }
  }

  // ---- FAQ
  if (T) {
    const faq = heads.find(([l, t]) => l === 2 && /faq|frequently asked|questions/i.test(t));
    let n = 0;
    if (faq) {
      for (const [l, , i] of heads) {
        if (i > faq[2]) {
          if (l <= 2) break;
          if (l === 3) n++;
        }
      }
    }
    inRange('faq', 'FAQ pairs', n, T.faq);
  }

  // ---- links
  const links = [...afterH1.matchAll(new RegExp(LINK_SRC, 'g'))].map((m) => [m[1].trim(), m[2].trim()]);
  const internal = [];
  const external = [];
  for (const [anc, url] of links) {
    if (url.startsWith('mailto:') || url.startsWith('tel:') || url.startsWith('#')) continue;
    const d = hasScheme(url) ? domain(url) : '';
    (!d || d === site || d.endsWith('.' + site) ? internal : external).push([anc, url]);
  }
  const [ilo, ihi] = I.per_1000_words;
  const imin = ptype === 'blog' ? I.blog_min : I.min;
  const need = Math.max(imin, pyRound((ilo * wc) / 1000));
  const cap = Math.max(imin, Math.trunc((ihi * wc) / 1000));
  add(need <= internal.length && internal.length <= cap ? 'PASS' : 'FAIL', 'content', `${internal.length} internal links (want ${need}-${cap} for ${wc} words)`);
  inRange('content', 'external links', external.length, C.external_links);

  const base = 'https://' + site + '/';
  const norm = (u) => {
    try {
      const p = new URL(u, base);
      return (domain(p.href) + p.pathname.replace(/\/+$/, '')).toLowerCase();
    } catch {
      return u.toLowerCase();
    }
  };
  const seenUrl = new Map();
  const seenAnchor = new Map();
  const generic = new Set(P.generic_anchors.map((g) => g.toLowerCase()));
  for (const [anc, url] of [...internal, ...external]) {
    const nUrl = norm(url);
    const nAnc = anc.toLowerCase();
    if (seenUrl.has(nUrl)) add('FAIL', 'links', `${url} linked twice ('${seenUrl.get(nUrl)}', '${anc}')`);
    if (!seenUrl.has(nUrl)) seenUrl.set(nUrl, anc);
    if (seenAnchor.has(nAnc) && seenAnchor.get(nAnc) !== nUrl) add('FAIL', 'links', `anchor '${anc}' points at two URLs`);
    if (!seenAnchor.has(nAnc)) seenAnchor.set(nAnc, nUrl);
    if (generic.has(pyStrip(nAnc, ' .→>'))) add('FAIL', 'links', `generic anchor '${anc}' -> ${url}`);
  }
  const [awLo, awHi] = I.anchor_words;
  for (const [anc] of internal) {
    const n = words(anc).length;
    if (!(awLo <= n && n <= awHi)) add('WARN', 'internal', `anchor '${anc}' is ${n} words (want ${awLo}-${awHi})`);
  }
  for (const [, url] of external) {
    if (competitors.has(domain(url))) add('FAIL', 'external', `links to competitor ${domain(url)}`);
  }

  // voice: em dashes and banned words (rules owned by anti-ai-writing)
  const alltext = [title, meta, stripMd(body)].join('\n');
  const dashes = (alltext.match(/—/g) || []).length;
  add(dashes === 0 ? 'PASS' : 'FAIL', 'voice', `${dashes} em dashes`);
  if (banned) {
    const low = alltext.toLowerCase();
    for (const w of banned.hard) {
      const c = (low.match(new RegExp(String.raw`\b` + escapeRe(w.toLowerCase()) + String.raw`\b`, 'g')) || []).length;
      if (c) add('FAIL', 'voice', `banned '${w}' x${c}`);
    }
    for (const w of banned.soft) {
      const c = (low.match(new RegExp(String.raw`\b` + escapeRe(w.toLowerCase()) + String.raw`\b`, 'g')) || []).length;
      if (c) add('WARN', 'voice', `'${w}' x${c}: check usage against anti-ai-writing`);
    }
  } else {
    add('WARN', 'voice', 'anti-ai-writing SKILL.md not found; banned words unchecked (use --banned)');
  }

  const confirms = (body.match(/\[CONFIRM/g) || []).length;
  if (confirms) add('INFO', 'confirm', `${confirms} [CONFIRM] tags open`);
  const leftovers = body.match(/\[(?:int|ext):[^\]]*\]|\bTODO\b|\bTK\b|lorem ipsum/gi) || [];
  if (leftovers.length) add('FAIL', 'placeholders', `${leftovers.length} leftover: ${pyListRepr(leftovers.slice(0, 3))}`);

  // live link status
  if (status) {
    const abs = (u) => {
      try {
        return new URL(u, base).href;
      } catch {
        return u;
      }
    };
    const urls = [...new Set([...internal, ...external].map(([, u]) => abs(u)))].sort();
    const codes = await Promise.all(urls.map((u) => status(u).catch((e) => [null, String(e?.message || e).slice(0, 80)])));
    urls.forEach((u, i) => {
      const [code, extra] = codes[i];
      if (code === 200) return;
      if ([301, 302, 303, 307, 308].includes(code)) add('FAIL', 'live', `${u} redirects (${code}) to ${extra}; link the final URL`);
      else if ([401, 403, 429].includes(code)) add('WARN', 'live', `${u} -> ${code}: blocks bots, open it by hand and confirm it loads`);
      else add('FAIL', 'live', `${u} -> ${code || extra}`);
    });
    add('PASS', 'live', `${urls.length} URLs checked`);
  }

  // overlap
  const O = P.overlap;
  for (const s of siblings) {
    let text = s.text;
    if (text == null && s.markdown != null) text = stripMd(parseFrontmatter(s.markdown).body);
    if (text == null && s.html != null) text = htmlMainText(s.html);
    if (text == null) {
      add('WARN', 'overlap', `could not read ${s.name}: ${String(s.error || 'no text').slice(0, 60)}`);
      continue;
    }
    const j = jaccard(plain, text);
    add(j > O.rewrite ? 'FAIL' : j > O.watch ? 'WARN' : 'PASS', 'overlap', `${pct(j, 0)} vs ${s.name}`);
  }

  const order = { FAIL: 0, WARN: 1, INFO: 2, PASS: 3 };
  results.sort((a, b) => order[a[0]] - order[b[0]]);
  const fails = results.filter((r) => r[0] === 'FAIL').length;
  const report = results.map(([l, c, m]) => `${l.padEnd(5)} ${c.padEnd(12)} ${m}`).join('\n') + (fails ? `\n\nRED: ${fails} FAIL` : '\n\nGREEN');
  return { results, fails, green: fails === 0, report, stats: { words: wc, internal: internal.length, external: external.length, confirms } };
}

