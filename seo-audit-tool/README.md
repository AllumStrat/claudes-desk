# SEO Audit Tool (test version)

Give it a URL and it runs an in-depth SEO audit of that page, plus a small crawl of up to 4 more pages it links to. Every problem comes back as Issue, Impact, Evidence, Fix and Priority, with a score out of 100 per area and overall.

It is now set up as a small paid product:

- Sign up with an emailed link. There are no passwords.
- The first audit is free and shows the top 5 issues, with the fix for the first one.
- $5 a month gets 20 full audits per paid month, audit history, and a weekly re-check of one saved site that emails what changed. Unused audits do not carry over; each paid invoice resets the count to 20.
- Bot protection (Cloudflare Turnstile) on sign-up and free audits, and rate limits on every step, kept in the database so they hold across servers.

This is still the test version. It runs on your Mac. Nothing here is deployed, no Cloudflare resources or Stripe products have been created, and payments only work with Stripe test keys. See [SECURITY.md](SECURITY.md) for what is covered and what still has to happen before going live.

The checks are plain JavaScript with Cheerio, so it needs no AI to work. Jev (TypeSafe AI's decision model) is an optional extra layer for judgment calls that rules cannot make, like whether the content is thin or generic. It is off until you turn it on. Haiku is not used.

## Run it

Needs Node 22.13 or newer (it uses Node's built-in SQLite for the local database).

```bash
cd seo-audit-tool
npm install
npm start
```

Open http://127.0.0.1:8787 and sign up with any email. The sign-in email is not really sent: the link prints in the terminal where `npm start` is running. Open it in the same browser, press Sign in, then run an audit. Data is kept in `.data/local.db` (delete that folder to start fresh). Stop the server with Ctrl+C.

From the terminal, without accounts:

```bash
npm run audit -- example.com                 # prints a Markdown report
npm run audit -- example.com --out report.md # saves it
npm run audit -- example.com --json          # raw JSON
```

Run the tests:

```bash
npm test
```

## Try payments in Stripe test mode

This uses Stripe's test mode only, so no real money moves. The app refuses a live key unless `STRIPE_ALLOW_LIVE=yes` is set.

1. In the Stripe dashboard, switch to test mode. Create a product with a $5 monthly price and copy its price id (`price_...`). Copy the test secret key (`sk_test_...`).
2. Install the Stripe CLI (`brew install stripe/stripe-cli/stripe`), run `stripe login`, then forward webhooks to the local server. It prints a signing secret (`whsec_...`):

   ```bash
   stripe listen --forward-to 127.0.0.1:8787/api/stripe/webhook
   ```

3. In another terminal:

   ```bash
   export STRIPE_SECRET_KEY=sk_test_...
   export STRIPE_PRICE_ID=price_...
   export STRIPE_WEBHOOK_SECRET=whsec_...
   npm start
   ```

4. Sign in, use your free audit, then press the $5 button. Pay with Stripe's test card 4242 4242 4242 4242, any future date and any CVC. Back on the page, the plan turns on within a few seconds and shows 20 audits.
5. Press Billing to open Stripe's customer portal, where you can cancel. Stripe asks you to save the portal settings once in test mode (Settings, Billing, Customer portal) before it opens. Renewals (the reset to 20) are covered by the automated tests, since a real test-mode renewal only comes a month later.

To try the human check locally, use Cloudflare's test keys: `TURNSTILE_SITE_KEY=1x00000000000000000000AA` and `TURNSTILE_SECRET=1x0000000000000000000000000000000AA` always pass.

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

All settings are environment variables. On a Worker, the ones marked secret go in with `npx wrangler secret put NAME`; never put them in code or in `wrangler.toml`.

| Variable | Default | What it does |
| --- | --- | --- |
| `PORT`, `HOST` | 8787, 127.0.0.1 | Local server address. Leave `HOST` unless you know why |
| `APP_ORIGIN` | the local address | The site's own address. Sign-in links and Stripe return links use it, and POSTs from any other origin are refused |
| `ALLOWED_ORIGINS` | none | Extra origins allowed to POST, comma separated |
| `HASH_SALT` (secret) | required on https | Salt for hashing IPs and emails before they are stored |
| `DB_FILE` | `.data/local.db` | Local database file; `:memory:` keeps nothing |
| `EMAIL_PROVIDER` | `log` locally, `cloudflare` on the Worker | `log` prints emails to the terminal, `cloudflare` uses Cloudflare Email Service, `resend` uses Resend |
| `EMAIL_FROM` | `Allum SEO Audit <audit@allumstrategies.com>` | Sender address. It has to be on a domain set up with the email provider |
| `RESEND_API_KEY` (secret) | none | For `resend` |
| `STRIPE_SECRET_KEY` (secret) | none | Test key `sk_test_...`. Payments are off without it |
| `STRIPE_PRICE_ID` | none | The $5 monthly price |
| `STRIPE_WEBHOOK_SECRET` (secret) | none | `whsec_...` from the webhook endpoint or `stripe listen` |
| `STRIPE_ALLOW_LIVE` | off | Must be `yes` before a live key is accepted |
| `TURNSTILE_SITE_KEY`, `TURNSTILE_SECRET` (secret) | none | Turn on the human check |
| `RUNS_PER_MONTH` | 20 | Audits per paid month |
| `FREE_SHOW_ISSUES`, `FREE_SHOW_FIXES` | 5, 1 | How much the free audit shows |
| `AUDITS_ENABLED`, `SIGNUPS_ENABLED` | on | Off switches. `0` pauses audits, or stops new sign-ups while existing users can still sign in |
| `AUDIT_RATE_LIMIT` | 10 | Audits per connection per 10 minutes |
| `AUDITS_PER_HOUR_ACCOUNT` | 10 | Audits per account per hour, even with runs left |
| `AUDIT_TARGET_LIMIT` | 10 | Audits of the same site per hour, from anyone |
| `FREE_AUDITS_PER_IP_DAY` | 3 | Free audits per connection per day |
| `DAILY_AUDIT_CAP` | 1000 | Audits per day for the whole app |
| `SIGNIN_PER_EMAIL`, `SIGNIN_PER_IP` | 3, 10 | Sign-in emails per address per 15 minutes, and per connection per hour |
| `SESSION_DAYS`, `LOGIN_LINK_MINUTES` | 30, 15 | How long a sign-in lasts, and how long a link works |
| `AUDIT_MAX_CONCURRENT` | 2 | Audits running at once per server |
| `AUDIT_MAX_PAGES` | 5 | Pages per audit, start page included (hard cap 10) |
| `TRUST_PROXY` | off | Set to 1 only behind a proxy you control, to read the visitor IP from X-Forwarded-For |
| `JEV_PROVIDER` | off | `typesafe`, `cloudflare`, `workers-ai` or `mock` |
| `TYPESAFE_API_KEY` (secret), `JEV_MODEL` | none, `jev-latest` | For `typesafe` |
| `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN` (secret) | none | For `cloudflare` |

## Limits per audit

Up to 5 pages, 20 link checks (8 external), 12 image checks, 5 redirects per request, 8 seconds per request, 45 seconds for the whole audit, 2 MB of HTML per page. That is roughly 60 requests at most (plus redirect hops) to the audited site and the sites it links to. Callers cannot raise these past the hard caps in `src/core/audit.js`.

## How it is built

```
src/core/       the audit itself; runs anywhere (Node or a Cloudflare Worker)
  url-guard.js    which URLs and IP addresses are allowed
  safe-fetch.js   guarded fetch: checks every redirect hop, DNS, size, time
  audit.js        the audit run and the bounded crawl
  extract.js      HTML to page facts (Cheerio)
  checks/         the checks, one file per area
  jev.js          optional Jev layer and its mock
  report.js       scoring and Markdown output
src/app/        the paid product, shared by the Worker and the local server
  app.js          routes: sign-in, audits, credits, history, weekly check, billing
  store.js        every database read and write
  stripe.js       Stripe calls over fetch, webhook signature check
  email.js        sign-in and weekly emails
  limits.js       rate limits kept in the database
  plans.js        what the free audit shows, and weekly change reports
  config.js       settings from environment variables
migrations/     the database tables (D1 on Cloudflare, SQLite locally)
src/node/       local server, CLI, local database, socket-level address guard
src/worker/     Cloudflare Worker entry with the hourly cron (not deployed)
public/         the page
test/           111 tests, no network needed
```

## API

| Route | What it does |
| --- | --- |
| `GET /api/me` | The signed-in user, plan, runs left, and whether payments and the human check are on |
| `POST /api/auth/start` | `{ email, turnstileToken }`. Emails a sign-in link |
| `POST /api/auth/verify` | `{ token }` from the link. Starts a session (HttpOnly cookie) |
| `POST /api/auth/logout` | Ends the session |
| `POST /api/audit` | `{ url, turnstileToken }`. Runs an audit and spends the free audit or one paid run |
| `GET /api/audits`, `GET /api/audits/:id` | History (paid plan) and one saved audit |
| `POST /api/watch` | `{ url }` saves the weekly check site, `{ url: null }` stops it (paid plan) |
| `POST /api/billing/checkout`, `POST /api/billing/portal` | Return a Stripe page to send the browser to |
| `POST /api/stripe/webhook` | Stripe events; signature checked |
| `POST /api/account/delete` | Deletes the account and its audits |

## Putting it on Cloudflare later

`wrangler.example.toml` shows the wiring: static files, a D1 database, Cloudflare Email Service, Workers AI for Jev, a rate limiting binding and an hourly cron. Nothing deploys from this folder, and the ids in that file are placeholders. The steps, for when you decide to go ahead, are in SECURITY.md under "Must do before going live".
