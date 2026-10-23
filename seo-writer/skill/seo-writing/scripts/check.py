#!/usr/bin/env python3
"""Mechanical checks for an seo-writing draft.

Usage:
  python3 check.py draft.md [--live] [--siblings URL_OR_FILE ...] [--banned PATH]

Reads every number from ../PARAMETERS.md (the first ```json block).
Reads banned vocabulary from the anti-ai-writing skill (sibling folder, or --banned).
Exit code 0 = green (no FAIL), 1 = red.
"""
import argparse, html, json, re, sys
import urllib.request, urllib.error
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from urllib.parse import urlparse, urljoin

HERE = Path(__file__).resolve().parent
SKILL = HERE.parent
STOP = {"a", "an", "the", "in", "near", "for", "of", "and", "to", "on", "at", "me", "my", "with", "by", "&"}
WORD = re.compile(r"[A-Za-z0-9][A-Za-z0-9'’]*")
LINK = re.compile(r"(?<!!)\[([^\]]+)\]\(\s*<?([^)\s>]+)>?(?:\s+\"[^\"]*\")?\s*\)")

results = []


def add(level, check, msg):
    results.append((level, check, msg))


# ---------- loading ----------

def load_params():
    text = (SKILL / "PARAMETERS.md").read_text(encoding="utf-8")
    m = re.search(r"```json\s*(.*?)```", text, re.S)
    if not m:
        sys.exit("PARAMETERS.md has no ```json block")
    return json.loads(m.group(1))


def parse_frontmatter(text):
    fm, body = {}, text
    m = re.match(r"^---\s*\n(.*?)\n---\s*\n?(.*)$", text, re.S)
    if m:
        body = m.group(2)
        for line in m.group(1).splitlines():
            if ":" not in line or line.strip().startswith("#"):
                continue
            k, v = line.split(":", 1)
            v = v.strip()
            if v.startswith("[") and v.endswith("]"):
                v = [x.strip().strip("'\"") for x in v[1:-1].split(",") if x.strip()]
            else:
                v = v.strip("'\"")
            fm[k.strip()] = v
    return fm, body


def load_banned(path_arg):
    candidates = [Path(path_arg)] if path_arg else [
        SKILL.parent / "anti-ai-writing" / "SKILL.md",
        Path.home() / ".claude" / "skills" / "anti-ai-writing" / "SKILL.md",
    ]
    for p in candidates:
        if p.exists():
            text = p.read_text(encoding="utf-8")
            m = re.search(r"##\s*Banned vocabulary.*?\n(.*?)\n##\s", text, re.S | re.I)
            if not m:
                continue
            hard, soft = [], []
            for line in m.group(1).splitlines():
                line = line.strip()
                if not line or line.startswith("**"):
                    continue
                for item in line.split(","):
                    item = item.strip().rstrip(".")
                    if not item:
                        continue
                    qual = re.search(r"\(([^)]*)\)", item)
                    word = re.sub(r"\s*\([^)]*\)", "", item).strip().rstrip("!").strip()
                    if word:
                        (soft if qual else hard).append(word)
            return hard, soft, str(p)
    return [], [], None


# ---------- helpers ----------

def words(text):
    return WORD.findall(text)


def strip_md(text):
    text = re.sub(r"```.*?```", " ", text, flags=re.S)
    text = re.sub(r"!\[[^\]]*\]\([^)]*\)", " ", text)
    text = LINK.sub(lambda m: m.group(1), text)
    text = re.sub(r"<[^>]+>", " ", text)
    text = re.sub(r"[*_`>|#]", " ", text)
    return text


def tokens(s):
    return [w.lower() for w in words(s) if w.lower() not in STOP]


def has_target(text, target):
    have = {w.lower() for w in words(text)}
    need = tokens(target)
    return all(t in have for t in need), [t for t in need if t not in have]


def domain(u):
    d = urlparse(u).netloc.lower()
    return d[4:] if d.startswith("www.") else d


def is_title_case(h):
    ws = [w for w in words(h)[1:] if len(w) > 3]
    if len(ws) < 2:
        return False
    caps = sum(1 for w in ws if w[0].isupper())
    return caps / len(ws) >= 0.6


def grams(t, n=6):
    w = re.findall(r"[a-z0-9']+", t.lower())
    return {tuple(w[i:i + n]) for i in range(len(w) - n + 1)}


def jaccard(a, b):
    A, B = grams(a), grams(b)
    return len(A & B) / len(A | B) if A | B else 0.0


def fetch(url, timeout=25):
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 seo-writing-check"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read().decode("utf-8", "replace")


def html_main_text(raw):
    raw = re.sub(r"(?is)<(script|style|noscript|svg|header|footer|nav)\b.*?</\1>", " ", raw)
    m = re.search(r"(?is)<main\b.*?</main>", raw)
    if m:
        raw = m.group(0)
    return html.unescape(re.sub(r"<[^>]+>", " ", raw))


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *a, **k):
        return None


def status(url):
    opener = urllib.request.build_opener(NoRedirect)
    for method in ("HEAD", "GET"):
        try:
            req = urllib.request.Request(url, method=method, headers={"User-Agent": "Mozilla/5.0 seo-writing-check"})
            with opener.open(req, timeout=20) as r:
                return r.status, None
        except urllib.error.HTTPError as e:
            if e.code in (301, 302, 303, 307, 308):
                return e.code, e.headers.get("Location")
            if method == "HEAD" and e.code in (403, 405, 501):
                continue
            return e.code, None
        except Exception as e:  # noqa: BLE001
            if method == "GET":
                return None, str(e)[:80]
    return None, "no response"


# ---------- checks ----------

def in_range(check, label, n, rng):
    lo, hi = rng if isinstance(rng, list) else (rng, rng)
    add("PASS" if lo <= n <= hi else "FAIL", check, f"{n} {label} (want {lo}-{hi})" if lo != hi else f"{n} {label} (want {lo})")


ITEM = re.compile(r"^\s*([-*+]|\d+[.)])\s+")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("draft")
    ap.add_argument("--live", action="store_true", help="check every link's HTTP status")
    ap.add_argument("--siblings", nargs="*", default=[], help="sibling page URLs or files for overlap")
    ap.add_argument("--banned", help="path to anti-ai-writing SKILL.md")
    a = ap.parse_args()

    P = load_params()
    C, K, M, I = P["content"], P["keywords"], P["metadata"], P["internal"]
    fm, body = parse_frontmatter(Path(a.draft).read_text(encoding="utf-8"))
    primary = fm.get("primary") or fm.get("target", "")
    secondary = fm.get("secondary", []) or []
    variants = fm.get("variants", []) or []
    if isinstance(secondary, str):
        secondary = [secondary]
    if isinstance(variants, str):
        variants = [variants]
    ptype = fm.get("type", "")
    site = domain("https://" + fm.get("site", "").replace("https://", "").replace("http://", ""))
    title, meta = fm.get("title", ""), fm.get("meta", "")
    competitors = {domain("https://" + c.replace("https://", "").replace("http://", "")) for c in fm.get("competitors", []) or []}

    for k in ("type", "site", "slug", "title", "meta"):
        if not fm.get(k):
            add("FAIL", "frontmatter", f"missing '{k}'")
    if not primary:
        add("FAIL", "frontmatter", "missing 'primary'")
    T = P["types"].get(ptype)
    if ptype and not T:
        add("FAIL", "frontmatter", f"type '{ptype}' not in PARAMETERS.md types {list(P['types'])}")

    # ---- headings
    lines = body.splitlines()
    heads = [(len(m.group(1)), m.group(2).strip(), i) for i, l in enumerate(lines)
             if (m := re.match(r"^(#{1,6})\s+(.*)$", l))]
    h1s = [h for h in heads if h[0] == 1]
    h2s = [t for l, t, _ in heads if l == 2]
    in_range("content", "H1", len(h1s), C["h1"])
    in_range("content", "H2s", len(h2s), C["h2"])
    prev = 0
    for lvl, text, _ in heads:
        if prev and lvl > prev + 1:
            add("FAIL", "headings", f"skipped level H{prev} -> H{lvl} at '{text}'")
        if is_title_case(text):
            add("WARN", "headings", f"looks like title case: '{text}' (use sentence case)")
        prev = lvl

    # ---- body blocks: paragraphs and lists
    start = h1s[0][2] + 1 if h1s else 0
    blines = lines[start:]
    after_h1 = "\n".join(blines)
    plain = strip_md(after_h1)
    body_words = words(plain)
    wc = len(body_words)

    paras, block, n_lists, prev_item = [], [], 0, False
    for l in blines + [""]:
        is_item = bool(ITEM.match(l))
        if is_item:
            if not prev_item:
                n_lists += 1
            prev_item = True
        elif l.strip() == "":
            pass
        elif prev_item and re.match(r"^\s{2,}\S", l):
            pass  # continuation of a list item
        else:
            prev_item = False
        if l.strip() == "" or is_item or re.match(r"^\s*([#>|]|---)", l) or (prev_item and not is_item):
            if block:
                paras.append(" ".join(block))
            block = []
        else:
            block.append(l.strip())
    in_range("content", "paragraphs", len(paras), C["paragraphs"])
    in_range("content", "lists", n_lists, C["lists"])

    # ---- length
    lo, hi = C["words"]
    add("PASS" if lo <= wc <= hi else "FAIL", "content", f"{wc} words (want {lo}-{hi})")
    wt = fm.get("words_target")
    tol = P["length"]["tolerance"]
    if wt:
        wt = int(str(wt).replace(",", ""))
        if not lo <= wt <= hi:
            add("FAIL", "length", f"words_target {wt} is outside {lo}-{hi}; clamp it")
        tlo, thi = wt * (1 - tol), wt * (1 + tol)
        if wc < tlo:
            add("FAIL", "length", f"{wc} words vs target {wt} (min {int(tlo)})")
        elif wc > thi:
            add("WARN", "length", f"{wc} words vs target {wt} (max {int(thi)}); check for padding")
        else:
            add("PASS", "length", f"{wc} words vs target {wt}")
    else:
        add("WARN", "length", "no words_target; run serp.py on the top 3 and add it")

    # ---- keywords
    def phrase_re(kw):
        toks = [re.escape(t) for t in tokens(kw)]
        gap = r"(?:\s+(?:" + "|".join(sorted(STOP - {"&"})) + r"))*\s+"
        return re.compile(r"\b" + gap.join(toks) + r"\b", re.I) if toks else None

    flat = " ".join(w.lower() for w in body_words)
    thirds = [" ".join(body_words[i * wc // 3:(i + 1) * wc // 3]).lower() for i in range(3)] if wc else ["", "", ""]
    if primary:
        prx = phrase_re(primary)
        if h1s:
            ok, miss = has_target(h1s[0][1], primary)
            add("PASS" if ok else "FAIL", "primary", f"H1 '{h1s[0][1]}'" + ("" if ok else f" missing {miss}"))
        if paras:
            ok = bool(prx.search(strip_md(paras[0])))
            add("PASS" if ok else "FAIL", "primary", "in first paragraph" if ok else "missing from the first paragraph")
        missing = [n for n, t in zip(("opening", "middle", "closing"), thirds) if not prx.search(t)]
        add("FAIL" if missing else "PASS", "primary", f"missing from the {', '.join(missing)} third" if missing else "in every third of the body")
        hits = len(prx.findall(flat))
        dens = hits / wc if wc else 0
        dlo, dhi = K["primary_density"]
        dmax = K["primary_density_max"]
        lvl = "FAIL" if dens > dmax else "WARN" if not dlo <= dens <= dhi else "PASS"
        add(lvl, "primary", f"{hits} mentions, density {dens:.1%} (want {dlo:.1%}-{dhi:.1%}, max {dmax:.0%})")
        h2_hits = sum(1 for h in h2s if prx.search(h))
        if h2s and h2_hits / len(h2s) > K["primary_h2_share_max"]:
            add("WARN", "primary", f"in {h2_hits} of {len(h2s)} H2s; move some headings to secondaries or variants")
        slug = fm.get("slug", "")
        if slug and not has_target(slug.replace("-", " ").replace("/", " "), primary)[0]:
            add("FAIL", "primary", f"slug '{slug}' missing primary words")
    in_range("variants", "variants", len(variants), K["variants"])
    for kw in variants:
        r = phrase_re(kw)
        add("PASS" if r and r.search(flat) else "FAIL", "variants", f"'{kw}' " + ("in body" if r and r.search(flat) else "missing from body"))
    in_range("secondary", "secondary keywords", len(secondary), K["secondary"])
    for kw in secondary:
        r = phrase_re(kw)
        if r and r.search(flat):
            add("PASS", "secondary", f"'{kw}' in body")
        elif has_target(plain, kw)[0]:
            add("WARN", "secondary", f"'{kw}' words present but not as a phrase")
        else:
            add("FAIL", "secondary", f"'{kw}' missing from body")
    if secondary and not any(has_target(h, kw)[0] for h in h2s for kw in secondary):
        add("WARN", "secondary", "no secondary keyword carries an H2")

    # ---- metadata
    if title:
        add("PASS" if len(title) <= M["title_max"] else "FAIL", "title", f"{len(title)} chars (max {M['title_max']})")
        if primary:
            if not has_target(title, primary)[0]:
                add("FAIL", "title", "primary keyword missing")
            elif not has_target(title[: len(title) // 2 + 10], primary)[0]:
                add("WARN", "title", "primary keyword not in first half")
    if meta:
        mlo, mhi = M["meta"]
        add("PASS" if mlo <= len(meta) <= mhi else "FAIL", "meta", f"{len(meta)} chars (want {mlo}-{mhi})")
        if primary and not has_target(meta, primary)[0]:
            add("FAIL", "meta", "primary keyword missing")

    # ---- readability
    R = P["readability"]
    for p in paras:
        n = len(re.findall(r"[.!?](?:\s|$)", strip_md(p)))
        if n > R["paragraph_max_sentences"]:
            add("WARN", "paragraph", f"{n} sentences: '{strip_md(p)[:60].strip()}...'")
    idx = [h[2] for h in heads] + [len(lines)]
    for s, e in zip(idx, idx[1:]):
        n = len(words(strip_md("\n".join(lines[s + 1:e]))))
        if n > R["max_words_between_headings"]:
            add("WARN", "headings", f"{n} words under '{lines[s].lstrip('# ')[:50]}' (max {R['max_words_between_headings']})")

    # ---- FAQ
    if T:
        faq_i = next((i for l, t, i in heads if l == 2 and re.search(r"faq|frequently asked|questions", t, re.I)), None)
        n = 0
        if faq_i is not None:
            for l, t, i in heads:
                if i > faq_i:
                    if l <= 2:
                        break
                    if l == 3:
                        n += 1
        in_range("faq", "FAQ pairs", n, T["faq"])

    # ---- links
    links = [(m.group(1).strip(), m.group(2).strip()) for m in LINK.finditer(after_h1)]
    internal, external = [], []
    for anc, url in links:
        if url.startswith(("mailto:", "tel:", "#")):
            continue
        d = domain(url) if urlparse(url).scheme else ""
        (internal if (not d or d == site or d.endswith("." + site)) else external).append((anc, url))
    ilo, ihi = I["per_1000_words"]
    imin = I["blog_min"] if ptype == "blog" else I["min"]
    need, cap = max(imin, round(ilo * wc / 1000)), max(imin, int(ihi * wc / 1000))
    add("PASS" if need <= len(internal) <= cap else "FAIL", "content", f"{len(internal)} internal links (want {need}-{cap} for {wc} words)")
    in_range("content", "external links", len(external), C["external_links"])

    def norm(u):
        p = urlparse(urljoin("https://" + site + "/", u))
        return (domain(p.geturl()) + p.path.rstrip("/")).lower()

    seen_url, seen_anchor = {}, {}
    generic = {g.lower() for g in P["generic_anchors"]}
    for anc, url in internal + external:
        n_url, n_anc = norm(url), anc.lower()
        if n_url in seen_url:
            add("FAIL", "links", f"{url} linked twice ('{seen_url[n_url]}', '{anc}')")
        seen_url.setdefault(n_url, anc)
        if n_anc in seen_anchor and seen_anchor[n_anc] != n_url:
            add("FAIL", "links", f"anchor '{anc}' points at two URLs")
        seen_anchor.setdefault(n_anc, n_url)
        if n_anc.strip(" .→>") in generic:
            add("FAIL", "links", f"generic anchor '{anc}' -> {url}")
    for anc, url in internal:
        n = len(words(anc))
        if not I["anchor_words"][0] <= n <= I["anchor_words"][1]:
            add("WARN", "internal", f"anchor '{anc}' is {n} words (want {I['anchor_words'][0]}-{I['anchor_words'][1]})")
    for anc, url in external:
        if domain(url) in competitors:
            add("FAIL", "external", f"links to competitor {domain(url)}")

    # voice: em dashes and banned words (rules owned by anti-ai-writing)
    alltext = "\n".join([title, meta, strip_md(body)])
    n = alltext.count("\u2014")
    add("PASS" if n == 0 else "FAIL", "voice", f"{n} em dashes")
    hard, soft, src = load_banned(a.banned)
    if src:
        low = alltext.lower()
        for w in hard:
            c = len(re.findall(r"\b" + re.escape(w.lower()) + r"\b", low))
            if c:
                add("FAIL", "voice", f"banned '{w}' x{c}")
        for w in soft:
            c = len(re.findall(r"\b" + re.escape(w.lower()) + r"\b", low))
            if c:
                add("WARN", "voice", f"'{w}' x{c}: check usage against anti-ai-writing")
    else:
        add("WARN", "voice", "anti-ai-writing SKILL.md not found; banned words unchecked (use --banned)")

    n = len(re.findall(r"\[CONFIRM", body))
    if n:
        add("INFO", "confirm", f"{n} [CONFIRM] tags open")
    leftovers = re.findall(r"\[(?:int|ext):[^\]]*\]|\bTODO\b|\bTK\b|lorem ipsum", body, re.I)
    if leftovers:
        add("FAIL", "placeholders", f"{len(leftovers)} leftover: {leftovers[:3]}")

    # live link status
    if a.live:
        urls = sorted({urljoin("https://" + site + "/", u) for _, u in internal + external})
        with ThreadPoolExecutor(8) as ex:
            for u, (code, extra) in zip(urls, ex.map(status, urls)):
                if code == 200:
                    continue
                if code in (301, 302, 303, 307, 308):
                    add("FAIL", "live", f"{u} redirects ({code}) to {extra}; link the final URL")
                elif code in (401, 403, 429):
                    add("WARN", "live", f"{u} -> {code}: blocks bots, open it by hand and confirm it loads")
                else:
                    add("FAIL", "live", f"{u} -> {code or extra}")
        add("PASS", "live", f"{len(urls)} URLs checked")

    # overlap
    O = P["overlap"]
    for s in a.siblings:
        try:
            if re.match(r"https?://", s):
                text = html_main_text(fetch(s))
            else:
                t = Path(s).read_text(encoding="utf-8")
                text = strip_md(parse_frontmatter(t)[1]) if s.endswith(".md") else html_main_text(t)
            j = jaccard(plain, text)
            lvl = "FAIL" if j > O["rewrite"] else "WARN" if j > O["watch"] else "PASS"
            add(lvl, "overlap", f"{j:.0%} vs {s}")
        except Exception as e:  # noqa: BLE001
            add("WARN", "overlap", f"could not read {s}: {str(e)[:60]}")

    # report
    order = {"FAIL": 0, "WARN": 1, "INFO": 2, "PASS": 3}
    for lvl, c, m in sorted(results, key=lambda r: order[r[0]]):
        print(f"{lvl:5} {c:12} {m}")
    fails = sum(1 for r in results if r[0] == "FAIL")
    print("\nGREEN" if not fails else f"\nRED: {fails} FAIL")
    sys.exit(1 if fails else 0)


if __name__ == "__main__":
    main()
