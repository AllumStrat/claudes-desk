# SEO Audit Tool (test version)

Give it a URL and it runs an in-depth SEO audit of that page, plus a small crawl of up to 4 more pages it links to. Every problem comes back as Issue, Impact, Evidence, Fix and Priority, with a score out of 100 per area and overall.

This is the test version. It runs on your Mac. Nothing here is deployed. The point of this round is to prove it is safe to put on the open web; see [SECURITY.md](SECURITY.md) for what is covered and what still has to happen first.

The checks are plain JavaScript with Cheerio, so it needs no AI to work. Jev (TypeSafe AI's decision model) is an optional extra layer for judgment calls that rules cannot make, like whether the content is thin or generic. It is off until you add a key. Haiku is not used.

## Run it

Needs Node 20.10 or newer.

```bash
cd seo-audit-tool
npm install
npm start
```

Open http://127.0.0.1:8787, type a URL (example.com works, https is added for you) and press Run audit. Results show on the page and download as JSON. Stop the server with Ctrl+C.

From the terminal instead:

```bash
npm run audit -- example.com                 # prints a Markdown report
npm run audit -- example.com --out report.md # saves it
npm run audit -- example.com --json          # raw JSON
```

Run the tests:

```bash
npm test
```

## What it checks

Crawling and indexing: status code, redirect chain and temporary redirects, HTTPS and whether http redirects to https, canonical (missing, several, relative, cross-domain, pointing elsewhere), robots meta and X-Robots-Tag (noindex, nofollow), robots.txt (missing, server errors, blocks everything, blocks this page, bad lines, sitemap line), XML sitemap (found, valid, empty, lists this page), hreflang (codes, absolute URLs, self reference, x-default).

On-page: title (missing, length, several), meta description (missing, length, several), H1 count, empty headings, skipped heading levels, lang attribute, viewport (missing, fixed width, zoom blocked), charset, doctype, favicon, duplicate titles and descriptions across the crawled pages, crawled pages with no title or H1.

Content: visible word count and thin content, on the page and across the crawl.

Images: missing alt text, missing width and height, no lazy loading, heavy files over 300 KB, broken images, large files in older formats (sampled, up to 12).

Links: internal link count, broken links (sampled, up to 20, including up to 8 external), internal links that redirect, nofollow on internal links, empty and generic anchor text, internal pages that return errors.

Structured data: invalid JSON-LD, missing schema, missing @context, LocalBusiness types (AutoRepair, Plumber, RoofingContractor and about 50 more) missing name, address, phone, url, hours, geo or image, incomplete PostalAddress, Organization missing name or url, empty FAQPage.

Social: Open Graph title, description, image and url, relative og:image, twitter:card.

Performance: HTML size, time to first byte, render-blocking scripts and stylesheets, total files referenced, inline JavaScript weight, iframes, text compression.

Security: HSTS, CSP, X-Content-Type-Options, Referrer-Policy, frame protection, server version leaks, mixed content.

Local business signals (only when the page looks like a local business): visible phone, clickable tel: link, visible street address, LocalBusiness markup present, phone in markup matches the page, ZIP in markup matches the page.

AI judgment (optional, Jev): content depth, whether the title and H1 match the content, generic boilerplate, trust signals, call to action clarity, which search intent the page fits, whether it is a local business page. These show in the report marked "AI judgment" with a confidence, and answers Jev is unsure about are dropped.

The report never names outside tools.

## Plugging in Jev

Jev answers typed questions with probabilities and scores and never writes text, so it fits judgment checks well and is very cheap (Cloudflare lists it at $0.042 per million input tokens, output free). The adapter is built from the official API docs, tested against a mock. It has not been run against the live API yet because there is no key.

Pick one of these, then restart `npm start`:

1. TypeSafe directly. Get an API key from TypeSafe (docs at docs.typesafe.ai). Then:

   ```bash
   export JEV_PROVIDER=typesafe
   export TYPESAFE_API_KEY=your_key_here
   npm start
   ```

2. Through your Cloudflare account. Cloudflare's docs list Jev on Workers AI as `typesafe/jev`, so this may work without the TypeSafe waitlist. Make an API token with Workers AI permission, then:

   ```bash
   export JEV_PROVIDER=cloudflare
   export CLOUDFLARE_ACCOUNT_ID=your_32_character_account_id
   export CLOUDFLARE_API_TOKEN=your_token
   npm start
   ```

3. To see what the AI section looks like without any key, use the built-in stand-in. Its answers are rough rules, not real AI:

   ```bash
   JEV_PROVIDER=mock npm start
   ```

On a Worker later, set `JEV_PROVIDER = "workers-ai"` and the `[ai]` binding in the config; no key is needed there.

Keys stay on the server. They are never sent to the browser or written into reports. If Jev fails or times out, the audit still finishes with the rule-based checks.

## Settings

| Variable | Default | What it does |
| --- | --- | --- |
| `PORT` | 8787 | Server port |
| `HOST` | 127.0.0.1 | Only reachable from this computer. Leave it unless you know why |
| `AUDIT_RATE_LIMIT` | 5 | Audits per visitor per window |
| `AUDIT_RATE_WINDOW_MIN` | 10 | Window length in minutes |
| `AUDIT_TARGET_LIMIT` | 10 | Audits of the same site per hour, from anyone |
| `AUDIT_MAX_CONCURRENT` | 2 | Audits running at once |
| `AUDIT_MAX_PAGES` | 5 | Pages per audit, start page included (hard cap 10) |
| `TRUST_PROXY` | off | Set to 1 only behind a proxy you control, to read the visitor IP from X-Forwarded-For |
| `TURNSTILE_SECRET` | none | Turns on the human check (see SECURITY.md) |
| `JEV_PROVIDER` | off | `typesafe`, `cloudflare`, `workers-ai` or `mock` |
| `TYPESAFE_API_KEY`, `JEV_MODEL` | none, `jev-latest` | For `typesafe` |
| `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN` | none | For `cloudflare` |

## Limits per audit

Up to 5 pages, 20 link checks (8 external), 12 image checks, 5 redirects per request, 8 seconds per request, 45 seconds for the whole audit, 2 MB of HTML per page. That is roughly 60 requests at most (plus redirect hops) to the audited site and the sites it links to. Callers cannot raise these past the hard caps in `src/core/audit.js`.

## How it is built

```
src/core/       runs anywhere (Node or a Cloudflare Worker)
  url-guard.js    which URLs and IP addresses are allowed
  safe-fetch.js   guarded fetch: checks every redirect hop, DNS, size, time
  audit.js        the audit run and the bounded crawl
  extract.js      HTML to page facts (Cheerio)
  checks/         the checks, one file per area
  jev.js          optional Jev layer and its mock
  handler.js      the /api/audit endpoint rules
  report.js       scoring and Markdown output
src/node/       local server, CLI, and the socket-level address guard
src/worker/     Cloudflare Worker entry (not deployed)
public/         the test page
test/           67 tests, no network needed
```

`wrangler.example.toml` shows how the Worker would be wired. Nothing deploys from this folder.
