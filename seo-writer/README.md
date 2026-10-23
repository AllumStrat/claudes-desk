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
| `--max-spend dollars` | stop before the next model call once the page has cost this much (default 1) |
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
5. **Check** (step 8): the `check.py` port plus the writer's own rules: nothing in the copy but Markdown links to the brief's pages and the verified sources (see Safety), no retired names, no layout words. Every FAIL goes back to the model with the report until it is green or three rounds have passed. A FAIL the copy cannot fix, like no verifiable external source, is reported instead of looped on.
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

On Sonnet that is about **25 to 30 cents a page** with one fix round, and about 45 cents in a bad case (a source retry and three fix rounds). A run stops before its next model call once it has spent `maxSpend` (config.js, default $1; `--max-spend` on the CLI, `WRITER_MAX_SPEND` on the Worker) and reports what it spent, so it can pass the cap by at most one call. Output tokens, mostly thinking, are about three quarters of it. Every run logs its real per-call tokens and cost, so the first few real pages replace this estimate. Raising effort to `high` on the draft makes better copy likely but costs more and breaks the cache for that call.

## The Worker

`src/worker/index.js` is a thin, undeployed endpoint for when the writer should run from somewhere other than Jacob's machine: `POST /api/write` with `Authorization: Bearer <WRITER_TOKEN>` and `{ "brief": {...} }`, answering with the copy doc and its cost. Nothing is deployed. `wrangler.example.toml` lists the secrets and settings.

What it enforces on its own:

- It answers 503 until `WRITER_TOKEN` and `ANTHROPIC_API_KEY` are set, and while `WRITER_TOKEN` is under 32 characters (`openssl rand -hex 32` makes a good one). The token is compared in constant time.
- Bodies over 256 KB get a 413. The bytes are counted as they arrive, so a missing or wrong `Content-Length` makes no difference.
- A brief over its caps (`LIMITS` in brief.js: 10 external sources, 10 siblings, 300 internal pages, 100 facts, 100 customer lines, 2,048 characters a field) gets a 400 that names the field.
- `WRITER_MAX_SPEND` (default $1) caps what one page may spend; a run that reaches it stops with a 402 and the usage so far.
- If the client disconnects, the run makes no further model calls and the open model call is cancelled. This relies on `request.signal`, which Workers only fire with the `enable_request_signal` compatibility flag (listed, commented, in `wrangler.example.toml`; check the flag name against Cloudflare's docs before deploying). Without it, a dropped request still runs to the end and its cost is spent.

What it does not do: accounts, per-user rate limits or a job queue. A shared token is one secret for everyone. Before deploying, put two things outside the code in front of it:

1. **Cloudflare Access** on the Worker's route (Zero Trust, an Access application with a policy for the people allowed in, and a service token for any script that calls it). Access then decides who reaches the Worker; the bearer token becomes a second check.
2. **A spend limit on the Anthropic side**: a separate workspace or API key for the writer, with a monthly limit set in the Claude Console. `WRITER_MAX_SPEND` caps one page; only the Console limit caps the month.

**Long requests.** A page takes a few minutes and the caller holds the connection open for all of it. If the connection drops, the run stops at its next model call (with `enable_request_signal`) and the copy is lost; what was spent is spent. The fix, if the Worker gets real use, is a job queue: `POST /api/write` stores the brief, enqueues it (Cloudflare Queues or Workflows) and returns a job id at once; a consumer runs `writePage` and saves the result (KV or R2); `GET /api/jobs/:id` returns the status and, when done, the copy doc. Not built yet.

## Safety

- **What reaches the copy.** The only links allowed are Markdown `[anchor](url)` links to the brief's internal pages, the sitemap's pages and the sources the program verified. The writer FAILs, and sends back to the model to remove, any raw HTML tag or comment (`<a href>`, `<script>`, `<img onerror>`), autolink (`<https://...>`), bare URL (`https://`, `www.`, `//host`), reference-style link definition (`[r1]: https://...`), image, `javascript:` or `data:` link, and link to a host or page not on the allowed lists. It checks the body, title and meta. If one survives the last fix round the page is red, never green, and the copy doc says not to paste it. Title, subhead and CTA options and inbound edits that hold HTML or a URL are dropped. Outside its fenced blocks the copy doc escapes `<`, so model text cannot render as a tag if the doc is ever shown as HTML.
- **Fetching.** Every fetch (sitemap, sibling pages, sources, `--live`) goes through `safe-fetch.js` from the audit tool, which refuses private and internal addresses at every redirect hop (and again at connect time in Node). Pages are read up to 500 KB. A run fetches at most the brief's sources, 4 model-proposed sources per round, the siblings and the sitemap, 4 at a time, and `--live` only checks links already on the allowed lists.
- **Hostile pages.** Text is pulled out of fetched HTML and pasted Markdown with one-pass scanners that give the same result as `check.py`'s regexes without their backtracking: a 3 MB page built to stall them is read in well under a second.
- **Sources.** External links come only from sources the program verified (the page loads with a 200 and holds the quoted line); the client's competitors and the skill's `serp_exclude` sites are never used as sources. Fetched page text is only searched for the quote, never sent to the model.
- **Facts** come only from the brief. Anything else is tagged `[CONFIRM]` for the owner.
- **Files.** The copy doc name is made of `a-z`, `0-9` and dashes only, and the CLI refuses to write anywhere outside `--out`.
- **Keys and spend.** The API key is read from the environment (CLI) or a Worker secret, never from a file in the repo. `maxSpend` caps one page.

## Not yet run against the real API

Every test uses a fake model. The request was checked by hand against the installed `@anthropic-ai/sdk` 1.1.0 types and the Anthropic docs: `thinking: {type: "adaptive"}`, `output_config` with `effort` and a `json_schema` format, a schema built only from keywords structured outputs accept (every object closed with `additionalProperties: false`, five nullable `anyOf` branches), `betas: ["server-side-fallback-2026-07-01"]` with `fallbacks: "default"`, and `beta.messages.stream(...).finalMessage()`. A Sonnet 5.5 fallback is served by Claude Sonnet 5 and is costed at its rates. What only a real run will show: that the API accepts this schema's size and nesting, the real token counts and cost, and how often the fallback fires.

## Tests

`npm test` runs 111 tests with a fake model and a fake network: the `check.py` parity, the one-pass scanners against `check.py`'s regexes (fuzzed, plus 3 MB hostile inputs), brief checks and caps, source verification, the request shape (adaptive thinking, one schema, cache breakpoints, fallbacks), the spend cap, the full pipeline including the fix loop, links and code smuggled into the copy, the copy doc, the output path and the Worker (token length, body cap, disconnects). The parity tests need `python3`.
