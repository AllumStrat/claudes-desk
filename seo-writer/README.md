# Allum SEO writer

Writes one web page for a local business client by following the `seo-writing` skill, with Claude Sonnet 5.5 doing the writing and the program doing everything mechanical. Give it a page brief and it returns the step 9 copy doc: search and keywords, metadata options, the page copy in draft format, the link plan, schema notes, the anti-AI-writing fixes and a green `check.py` report.

This is the **content-only tier**. It writes from the brief alone: no SERP pull, no competitor teardown, no `serp.py`. A competitor-research tier is planned as a premium option (`research: 'competitors'` in config.js) and is not built.

## Run it

```bash
npm install
export ANTHROPIC_API_KEY=...            # the writer bills to this key
npm run write -- examples/brief.example.json --out out
```

It prints the check report, the status and what the page cost, and saves `out/[client]-[slug]-copy.md` plus a `-usage.json` with tokens per call. A run is about five API calls and takes a few minutes.

| Flag | What it does |
| --- | --- |
| `--model id` | `claude-sonnet-5-5` (default) or `claude-haiku-5-5` |
| `--live` | also check that every link in the copy loads (`check.py --live`) |
| `--offline` | no network: no sitemap, sibling or source checks, so no external links |
| `--effort step=level` | per-step effort (`plan`, `sources`, `draft`, `edit`, `fix`); see Cost |
| `--max-fix-rounds n` | check-and-fix rounds before giving up (default 3) |
| `--no-fallbacks` | turn off the server-side refusal fallback |

`npm run compare -- examples/brief.example.json` writes the same page on Sonnet 5.5 and Haiku 5.5, one after the other, and saves both copy docs plus `comparison.md` (result, fix rounds, words, open FAILs and WARNs, `[CONFIRM]` tags, tokens, cost, time). `--max-spend 2` (the default) stops it from starting another model once that many dollars are spent.

`npm run check -- draft.md [--live] [sibling.md https://site/page/ ...]` runs the `check.py` port on its own, on any draft in the skill's format.

## The brief

`examples/brief.example.json` is a complete, fictional brief. The fields:

| Field | Needed | What it is |
| --- | --- | --- |
| `business`, `site`, `client`, `brand` | business and site | who the page is for; `client` names the copy doc |
| `page.type` | yes | `service`, `location` or `blog` |
| `page.service` / `page.topic` / `page.primary` | one of them | what the page is about |
| `page.place` | for location pages | the neighborhood or city |
| `page.words_target`, `page.slug`, `page.notes` | no | length target, fixed URL, anything else the writer should know |
| `facts` | should have | confirmed facts, each with its source. Anything else the page needs comes back as a `[CONFIRM: ...]` tag |
| `voice_of_customer` | should have | review lines and customer questions, in their words |
| `conversion` | should have | the one action a reader should take, and its page |
| `internal_pages` | should have | the only pages the copy may link to on the client's site |
| `sitemap` | no | `true` also reads the site's sitemap.xml for link targets |
| `external_sources` | no | sources Jacob already trusts; they still get checked |
| `keywords` | no | search data if you have it; otherwise keywords are marked "suggested, no search data" |
| `competitors`, `retired_names` | no | never linked; never named |
| `siblings` | no | existing pages to check overlap against (URL or Markdown) |

## How a page gets written

1. **Plan** (skill steps 1, 2, 4 and 5): the search, intent, ownership line, keywords, facts, `[CONFIRM]` questions, link targets, source candidates and the outline with word budgets. If the site already owns the search, it stops here and the copy doc says why.
2. **Sources**: every external source the model proposes is fetched and kept only if the page loads and contains the quoted line word for word. Failed ones get one replacement round. Unverified sources never reach the copy.
3. **Draft** (step 6), with two or three title, subhead and CTA options.
4. **Edit** (step 7): every word through the anti-ai-writing skill, plus the E-E-A-T marks from step 8.
5. **Check** (step 8): the `check.py` port plus three writer rules (links outside the brief or the verified sources, retired names, layout words). Every FAIL goes back to the model with the report until it is green or three rounds have passed. A FAIL the copy cannot fix, like no verifiable external source, is reported instead of looped on.
6. **Copy doc** (step 9), in the skill's order, with the cost table at the end.

The program writes the frontmatter, so the keywords, slug, site, title and meta that `check.py` reads always come from the plan and the brief.

The copy doc says what the page contains and nothing about how it looks. That is the skill's rule and the writer's: no layout, hero, button, image, font or color notes.

## Where the rules come from

`skill/` holds copies of Jacob's `seo-writing` (SKILL.md, PARAMETERS.md, check.py), `anti-ai-writing` and `copywriting` skills. Every number (length limits, keyword ranges, link counts, metadata lengths, overlap) is read from PARAMETERS.md; nothing in the code repeats one. The skill text is the model's system prompt.

After the skills change:

```bash
npm run sync-skill -- /path/to/skills     # copies them into skill/ and regenerates src/core/rules.generated.js
npm test                                   # the parity test shows anything in check.py the JS port has to follow
```

`src/core/check.js` is a JavaScript port of `check.py` so the same checks run in a Cloudflare Worker. `test/check-parity.test.js` runs the real `check.py` on thirteen drafts and expects the same report, line for line. One deliberate difference: a bare string in `competitors:` is read as one domain, where `check.py` would read it letter by letter.

## Cost

Sonnet 5.5 costs $2 per million input tokens and $10 per million output tokens; cache writes are $2.50 and cache reads $0.20. Every call shares one cached prefix: the system prompt (the four skill files, about 11,000 tokens) and one response schema, then the brief, then the plan. To keep that cache valid from call to call, every call sends the same schema, thinking setting and effort level (`medium` by default).

**Estimated, not measured**: no API key was available while this was built. For an 1,100-word page:

| Call | Input | Output, thinking included | Cost |
| --- | --- | --- | --- |
| plan | ~13k written to cache, ~1k new | ~5k | ~$0.09 |
| draft | ~14k from cache, ~2k new | ~6k | ~$0.07 |
| edit | ~15k from cache, ~2k new | ~6.5k | ~$0.07 |
| each fix round (0 to 3) | ~15k from cache, ~3k new | ~4k | ~$0.05 |
| source replacement (only when sources fail) | ~14k from cache | ~1.5k | ~$0.02 |

On Haiku 5.5 ($0.10 in, $0.50 out per million tokens, no server-side fallback) the same calls cost about a twentieth as much, roughly 1 to 2 cents a page, before any extra fix rounds it needs. `npm run compare` measures both on one brief.

On Sonnet that is about **25 to 30 cents a page** with one fix round, and about 45 cents in a bad case (a source retry and three fix rounds). Output tokens, mostly thinking, are about three quarters of it. Every run logs its real per-call tokens and cost, so the first few real pages replace this estimate. Raising effort to `high` on the draft makes better copy likely but costs more and breaks the cache for that call.

## The Worker

`src/worker/index.js` is a thin, undeployed endpoint for when the writer should run from somewhere other than Jacob's machine: `POST /api/write` with `Authorization: Bearer <WRITER_TOKEN>` and `{ "brief": {...} }`, answering with the copy doc and its cost. It is for internal use: one shared token, no accounts, no queue, and the caller holds the connection open for the few minutes a page takes. `wrangler.example.toml` lists the two secrets it needs. Nothing is deployed.

## Safety

- Every fetch (sitemap, sibling pages, sources, `--live`) goes through `safe-fetch.js` from the audit tool, which refuses private and internal addresses at every redirect hop (and again at connect time in Node).
- External links come only from sources the program verified; internal links only from the brief's page list and the sitemap; the client's competitors and the skill's `serp_exclude` sites are never used as sources.
- Facts come only from the brief. Anything else is tagged `[CONFIRM]` for the owner.
- The API key is read from the environment (CLI) or a Worker secret, never from a file in the repo.

## Tests

`npm test` runs everything with a fake model and a fake network: the `check.py` parity, brief checks, source verification, the request shape (adaptive thinking, one schema, cache breakpoints, fallbacks), the full pipeline including the fix loop, the copy doc and the Worker.
