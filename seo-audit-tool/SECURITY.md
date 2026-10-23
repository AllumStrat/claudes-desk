# Security notes

A public audit tool fetches whatever URL a stranger types. The two big risks are that someone uses it to reach things that are not on the public web (server-side request forgery, SSRF), and that someone uses it to hammer a site or run up costs. Now that it has accounts and payments, there are two more: someone getting into another person's account or getting paid audits without paying, and bots burning through free audits. This file lists what the test version already guards against, how each guard is tested, and what must be done before it goes live.

## Covered now

### Reaching private networks (SSRF)

- Only `http` and `https`. No `file:`, `ftp:`, `gopher:`, `data:`, `javascript:` and so on.
- Only ports 80 and 443. URLs with a username or password are refused.
- Blocked hostnames: `localhost` and anything under `.localhost`, `.local`, `.internal`, `.lan`, `.home.arpa`, `.corp`, `.test`, `.onion` and similar, plus cloud metadata names like `metadata.google.internal`. Single-label names (like `intranet`) are refused.
- Blocked IP ranges, IPv4: 0/8, 10/8, 100.64/10, 127/8, 169.254/16 (cloud metadata), 172.16/12, 192.0.0/24, 192.0.2/24, 192.88.99/24, 192.168/16, 198.18/15, 198.51.100/24, 203.0.113/24, multicast and everything from 240.0.0.0 up.
- Blocked IP ranges, IPv6: unspecified and loopback, IPv4-mapped and IPv4-compatible addresses (judged by the IPv4 address inside), NAT64 (judged by the IPv4 address inside), 6to4, Teredo and other 2001::/23 protocol ranges, documentation ranges, unique local fc00::/7, link-local, site-local, multicast. Only global unicast 2000::/3 is allowed.
- Odd IP spellings like `2130706433`, `0x7f000001`, `017700000001` and `127.1` are normalized by the URL parser first, then checked.
- DNS is checked before every request: if any address a domain resolves to is private, the request is refused (a mix of public and private answers is a known trick).
- Redirects are followed by hand, never automatically, and every hop goes through all of the checks above. A public site that redirects to `http://169.254.169.254/` is stopped before that request is made.
- DNS rebinding (a domain that answers with a public IP for the check and a private IP for the real connection): in Node, the check runs a second time inside the socket's own DNS lookup, so the connection itself refuses a private address. A test proves this with a real local server.
- Every URL the audit finds on a page (crawl pages, link checks, images, sitemaps) goes through the same guarded fetch. Sitemaps named in robots.txt are only fetched from the same site.

Tests: `test/url-guard.test.js`, `test/safe-fetch.test.js`, `test/node-net.test.js`, and the private-link cases in `test/audit.test.js`.

### Resource limits

- 8 seconds per request, 45 seconds per audit (hard cap 60).
- Response bodies are read in chunks and cut off at the cap (2 MB HTML, 512 KB robots.txt, 5 MB sitemap), counted after decompression, so a compression bomb or an endless response stops at the cap.
- At most 5 redirects per request, 5 pages per audit (hard cap 10), 20 link checks, 12 image checks, 3 requests in parallel.
- A request budget per audit: 80 HTTP requests in all, redirect hops included (hard cap 100), and 12 to any one host other than the audited site (hard cap 20). The start page, robots.txt, sitemaps and the crawl need at most 54 even with every redirect hop used, so only the link and image samples can be cut short. Requests the budget refuses are not reported as broken.
- Parsing is bounded, because it is synchronous and a timer cannot stop it. A page is parsed to at most 256 levels of nesting and 30,000 elements; past that the audit checks the part it read and reports `html-too-complex`. JSON-LD is read from at most 20 blocks, each up to 512 KB and 64 levels deep (checked before `JSON.parse`), and walked with a loop, not recursion. The doctype check and robots.txt wildcard matching are linear scans, not regexes that can backtrack. robots.txt is checked for at most 50 links per audit. The worst hostile pages found (2 MB of nested links, headings or JSON-LD blocks) take under 1 second of CPU per page, so about 4 seconds for a 5-page audit, where before a 237-byte page could take minutes.
- Stored reports are bounded: crawled titles and descriptions are cut to 300 characters, every string to 2,000, a report over 128 KB drops passed checks and notes and then issues, and the store refuses anything over 256 KB. Links over 2,048 characters are not crawled.
- Request bodies to the API are capped at 4 KB (256 KB for Stripe webhooks), including chunked uploads.
- At most 2 audits run at once per server; extra requests get a 503 and keep their credit. On Workers this is per isolate, so it does not cap the whole app; the database limits below do.

Tests: `test/safe-fetch.test.js` (cap, endless body, timeout, redirect loop), `test/audit.test.js` (request volume, the request budget, limit ceilings), `test/hostile.test.js` (doctype, nesting, JSON-LD, report size), `test/robots-sitemap.test.js` (wildcard speed and a random comparison with the old matcher), `test/credits.test.js`, `test/server.test.js`.

### Abuse of the tool itself

- An account is needed for every audit, including the free one.
- Limits are counted in the database, so they hold across every Worker instance and restart: 10 audits per connection per 10 minutes, 10 per account per hour (even with runs left), 10 audits of the same site per hour from anyone, 3 free audits per connection per day and 5 per 7 days, and 1,000 audits a day for the whole app. All are settings. IPv6 connections count per /64.
- The limits shared with other people (per site, and the daily cap) are counted only for audits that will run: after the human check and after the credit is claimed. A request without the human check, or from an account with no audits left, cannot use them up for everyone else.
- The per-site limit applies to the site an audit's redirects end on as well as the one typed in, so many domains redirecting to one site share that site's limit.
- On the Worker, a Cloudflare Rate Limiting binding is checked first on every API route except the Stripe webhook, so a flood is turned away before it reaches the database.
- Human check (Turnstile) before any sign-in email is sent and before every free audit. Paid audits skip it, since they are tied to a paying account and limited per account. An https deploy refuses to start without a Turnstile secret and site key, or with one of Cloudflare's always-pass test secrets, unless `TURNSTILE_BYPASS=dev` is set for testing. Tokens must come back from Siteverify with this app's hostname.
- Throwaway-inbox domains (a short list in `src/app/disposable.js`) can sign in and pay but get no free audit.
- Checkout and portal requests are limited to 5 per account per 10 minutes, since each one calls Stripe.
- On the local server, `TRUST_PROXY=1` takes the visitor address from the last X-Forwarded-For entry (the one your own proxy added), never the first, which the client controls.
- Off switches: `AUDITS_ENABLED=0` pauses audits, `SIGNUPS_ENABLED=0` stops new accounts.
- Cross-site requests are refused: every POST must carry this site's own Origin header (except the Stripe webhook, which is checked by signature). When the page lives on another host than the API (`web/`, a marketing site), only `APP_ORIGIN` and `ALLOWED_ORIGINS` get CORS headers with credentials; any other origin gets none, so it cannot read answers even when the browser sends the cookie. Preflights from other origins get a 403. Requests must be JSON, under 4 KB, with only the expected fields, so callers cannot change limits.
- The crawl obeys robots.txt (the rules for its own user agent, or the `*` rules when there are none) and skips nofollow links.
- A clear user agent: `AllumSEOAudit/0.1 (+https://allumstrategies.com; site audit on request)`.

Tests: `test/credits.test.js`, `test/auth.test.js`, `test/abuse.test.js`, `test/worker.test.js`, `test/billing.test.js`.

### Accounts and sign-in

- Sign-in is by emailed link only, so there are no passwords to leak. A link works once, for 15 minutes, and only a SHA-256 hash of it is stored.
- The link puts the token after `#`, so it never reaches a server log or a Referer header. The page asks the person to press Sign in before using it, so mail scanners that open links cannot use it up.
- Before signing in, the page shows which email the link is for (`/api/auth/peek`, which does not use the link up) and warns when it would switch from the account already signed in. The sign-in call must send that email back. So a link someone requested for their own address and sent to you cannot quietly put you in their account.
- The sign-in step answers the same way whether or not the email has an account, so it cannot be used to find out who has one.
- Emails are checked strictly (no spaces, commas, angle brackets or line breaks), so a sign-up cannot add extra recipients.
- Sessions are random 256-bit tokens in an HttpOnly, Secure, SameSite=Lax cookie named with the `__Host-` prefix. Only a hash is stored, sign-out deletes it on the server, and it expires after 30 days.
- Every account action checks the session first, and audits are only ever read with the owner's id, so one user cannot open another's audit.
- Account deletion removes the user, sessions and audits. The hashed free-audit claim stays, so deleting and signing up again does not give a second free audit.

Tests: `test/auth.test.js`.

### Credits and payments

- The free audit is claimed against a hash of the normalized email, so `name+1@gmail.com` or `n.ame@gmail.com` does not get a second one.
- Spending a run is one conditional database update, so two audits started at the same moment cannot both spend the last run. A test fires three at once with one run left.
- Nothing is spent when an address is refused or a limit is hit, and a run (or the free audit) is given back when the audit could not run: a site that cannot be reached, a timeout before the page arrived, a limit that stopped it, a busy server, or a failed save on our side. Once the site has sent its page, the run is spent even if the audit then crashes, so a page built to crash or stall the parser gets no free audits.
- The free audit's locked fixes are removed on the server. They never reach the browser.
- Stripe test mode only: a live key is refused unless `STRIPE_ALLOW_LIVE=yes` is set, and a test-mode app ignores live-mode webhook events.
- Webhooks are accepted only with a valid Stripe signature from the last 5 minutes, checked in constant time against the raw body.
- Each event is handled once. Runs are reset only by a paid invoice for a later period than the last one, so a replayed event or the same invoice twice cannot add runs. Unused runs do not carry over.
- A paid invoice grants runs only if one of its lines is `STRIPE_PRICE_ID` and it paid at least `STRIPE_PRICE_AMOUNT` (500 cents by default). A $0 invoice, a 100% coupon or another price in the same Stripe account grants nothing.
- A second checkout tab reuses the session the first one opened (kept until it expires, 60 minutes), and only one request at a time can create one. A user with an active, trialing or past-due subscription cannot start another.
- A full refund (`charge.refunded`) or a dispute (`charge.dispute.created`) ends paid access for the current period. The next period's invoice turns it back on; a replay of the refunded one does not. Cancel the subscription in Stripe as well if you do not want it to renew.
- Subscription changes apply in order, so a late "active" cannot undo a cancel, and a late "deleted" for an old subscription cannot end a newer one.
- Cancelling, an unpaid subscription, or a missed renewal (after 3 days of grace) ends paid access and the weekly check.
- The browser is only ever sent to `checkout.stripe.com` or `billing.stripe.com`. Both the server and the page check this.
- No card details touch this app. Stripe Checkout and the customer portal handle them.

Tests: `test/billing.test.js`, `test/credits.test.js`.

### Weekly re-check

- Runs from the hourly cron, at most 10 sites per run, 2 at a time, through the same guarded fetch and limits as any audit. The saved URL passes the same address checks. `AUDITS_ENABLED=0` pauses it too.
- Each weekly check counts against the per-site limit and the daily cap, and waits 6 hours when one is full.
- Changing the saved site cannot buy extra audits: saving the same site again does nothing, changes are limited to 5 a day, and a new site waits for the usual weekly slot if a weekly check ran in the last 7 days.
- The next run time is moved forward before the audit starts, so a crash cannot make one site get audited every hour. A failed check tries again the next day.
- Emails are plain text. The HTML copy is built only from escaped text, and schema type names taken from a page are cut to letters and digits.

Tests: `test/watch.test.js`.

### Stored data

- Audits of accounts without the plan are deleted after 30 days. Paid accounts keep their latest 100.

### Output safety

- The page renders every piece of report text as plain text nodes. No HTML from an audited site is ever parsed in the browser, and a test fails the build if `innerHTML` or similar shows up in `public/app.js`.
- Strict Content Security Policy: scripts only from this site and Cloudflare's Turnstile script, no inline scripts, no framing.
- Error messages are fixed sentences. They never echo the submitted URL or internal details, and unexpected errors return a generic 500.
- The Markdown report escapes HTML and Markdown characters from page text.
- `nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, `Permissions-Policy` and same-origin policies on every response. The test page is marked `noindex`.

### Jev (optional AI layer)

- Off unless `JEV_PROVIDER` is set. Keys only live in server environment variables and never reach the browser or the report. A failing provider is reported with a fixed sentence, never the raw error.
- Jev only returns numbers and picks from our own fixed list, so an audited page cannot make the tool print text it wrote (prompt injection has no text to come out through). Answers are validated: wrong types, out-of-range numbers, unknown choices and extra fields are dropped.
- A page can still try to sway its own scores with text aimed at the model. That only affects that site's own report, and these findings are labelled as AI judgment with a confidence.
- Page text sent to Jev is capped at 12,000 characters. Note that this sends the audited page's public text to TypeSafe or Cloudflare. Cloudflare lists zero data retention for this model.

## Must do before going live

Nothing below has been done. Each step creates something in your accounts, so each waits for your go-ahead.

1. Cloudflare: create the D1 database and apply `migrations/`, set up Cloudflare Email Service on the sending domain (SPF and DKIM), create a Turnstile widget, and copy `wrangler.example.toml` to `wrangler.toml` with the real ids. Set the secrets with `wrangler secret put`: `HASH_SALT`, `TURNSTILE_SECRET`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`.
2. Stripe: create the $5 monthly price, a webhook endpoint for `/api/stripe/webhook` with these events: `checkout.session.completed`, `invoice.paid`, `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`, `charge.refunded`, `charge.dispute.created`, and save the customer portal settings (allow cancel, and do not allow switching to other prices). Do a full run in test mode on the deployed preview before switching to live keys with `STRIPE_ALLOW_LIVE=yes`.
3. Rebinding on Workers (still open). The Worker checks every hop's name over DNS over HTTPS before the request, but the Worker's own `fetch()` resolves the name again, so a domain can answer with a public address for the check and a private one for the request. The connect-time guard that Node has does not exist on Workers, and there is no cheap fix in the Worker itself. Before going live, confirm on a preview what a Worker's `fetch()` can reach (Cloudflare's network should not route to private ranges, but this has not been tested here), and consider refusing IP-address URLs entirely on the public version.
4. Add a Cloudflare WAF rate limiting rule on `/api/*` as an outer layer, and set billing alerts on the Cloudflare and Stripe accounts.
5. Legal pages: terms, a privacy note (stored data: email, audit reports, hashed IPs in short-lived counters), a refund policy, and a short disclaimer that audits are automated estimates. Stripe needs these before live payments.
6. Bot info page. Publish a page at the URL in the user agent saying what the bot does and how a site owner can opt out, and honour opt-outs.
7. Disposable email domains. The blocklist is short, and catch-all domains still give new inboxes; the human check, per-connection limits and daily cap keep the cost small. Use a maintained list if it becomes a problem.
8. Refunds and disputes end paid access automatically, but they do not cancel the subscription. Do that in Stripe.
9. Logs: the app logs only short error messages. Check that Workers logs do not keep request bodies, and keep error details private.
10. Caching. Cache results per URL for a while (for example an hour) so repeat requests do not refetch the site.
11. Dependency checks. `npm audit` showed 0 known problems on Oct 22, 2026. Keep Cheerio and undici current. Cheerio is pinned to 1.0.0.
12. Monitoring: alerts on error spikes, sign-up volume and audit volume.
13. Run the full audit against a handful of real client sites from a normal network and compare with a manual review. This sandbox could not reach the open web, so the tests use a fake web, a fake Stripe and an in-memory database.

## Not covered

- The tool does not render JavaScript, so content added by scripts after load is not seen (like many crawlers' first pass).
- Speed numbers come from one request from the server, not a real browser on a phone.
