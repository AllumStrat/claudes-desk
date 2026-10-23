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
- At most 5 redirects per request, 5 pages per audit (hard cap 10), 20 link checks, 12 image checks, 3 requests in parallel. Roughly 60 requests per audit at most.
- Request bodies to the API are capped at 4 KB (256 KB for Stripe webhooks), including chunked uploads.
- At most 2 audits run at once per server; extra requests get a 503 and keep their credit.

Tests: `test/safe-fetch.test.js` (cap, endless body, timeout, redirect loop), `test/audit.test.js` (request volume on a page with 1,500 links, limit ceilings), `test/credits.test.js`, `test/server.test.js`.

### Abuse of the tool itself

- An account is needed for every audit, including the free one.
- Limits are counted in the database, so they hold across every Worker instance and restart: 10 audits per connection per 10 minutes, 10 per account per hour (even with runs left), 10 audits of the same site per hour from anyone, 3 free audits per connection per day, and 1,000 audits a day for the whole app. All are settings.
- On the Worker, a Cloudflare Rate Limiting binding is checked first, so a flood is turned away before it reaches the database.
- Human check (Turnstile) before any sign-in email is sent and before every free audit. Paid audits skip it, since they are tied to a paying account and limited per account.
- Off switches: `AUDITS_ENABLED=0` pauses audits, `SIGNUPS_ENABLED=0` stops new accounts.
- Cross-site requests are refused: every POST must carry this site's own Origin header (except the Stripe webhook, which is checked by signature). Requests must be JSON, under 4 KB, with only the expected fields, so callers cannot change limits.
- The crawl obeys robots.txt (the rules for its own user agent, or the `*` rules when there are none) and skips nofollow links.
- A clear user agent: `AllumSEOAudit/0.1 (+https://allumstrategies.com; site audit on request)`.

Tests: `test/credits.test.js`, `test/auth.test.js`, `test/worker.test.js`.

### Accounts and sign-in

- Sign-in is by emailed link only, so there are no passwords to leak. A link works once, for 15 minutes, and only a SHA-256 hash of it is stored.
- The link puts the token after `#`, so it never reaches a server log or a Referer header. The page asks the person to press Sign in before using it, so mail scanners that open links cannot use it up.
- The sign-in step answers the same way whether or not the email has an account, so it cannot be used to find out who has one.
- Emails are checked strictly (no spaces, commas, angle brackets or line breaks), so a sign-up cannot add extra recipients.
- Sessions are random 256-bit tokens in an HttpOnly, Secure, SameSite=Lax cookie named with the `__Host-` prefix. Only a hash is stored, sign-out deletes it on the server, and it expires after 30 days.
- Every account action checks the session first, and audits are only ever read with the owner's id, so one user cannot open another's audit.
- Account deletion removes the user, sessions and audits. The hashed free-audit claim stays, so deleting and signing up again does not give a second free audit.

Tests: `test/auth.test.js`.

### Credits and payments

- The free audit is claimed against a hash of the normalized email, so `name+1@gmail.com` or `n.ame@gmail.com` does not get a second one.
- Spending a run is one conditional database update, so two audits started at the same moment cannot both spend the last run. A test fires three at once with one run left.
- Nothing is spent when an address is refused or a limit is hit, and a run (or the free audit) is given back when the audit could not run: a site that cannot be reached, a timeout, or a busy server.
- The free audit's locked fixes are removed on the server. They never reach the browser.
- Stripe test mode only: a live key is refused unless `STRIPE_ALLOW_LIVE=yes` is set, and a test-mode app ignores live-mode webhook events.
- Webhooks are accepted only with a valid Stripe signature from the last 5 minutes, checked in constant time against the raw body.
- Each event is handled once. Runs are reset only by a paid invoice for a later period than the last one, so a replayed event or the same invoice twice cannot add runs. Unused runs do not carry over.
- Subscription changes apply in order, so a late "active" cannot undo a cancel, and a late "deleted" for an old subscription cannot end a newer one.
- Cancelling, an unpaid subscription, or a missed renewal (after 3 days of grace) ends paid access and the weekly check.
- The browser is only ever sent to `checkout.stripe.com` or `billing.stripe.com`. Both the server and the page check this.
- No card details touch this app. Stripe Checkout and the customer portal handle them.

Tests: `test/billing.test.js`, `test/credits.test.js`.

### Weekly re-check

- Runs from the hourly cron, at most 10 sites per run, 2 at a time, through the same guarded fetch and limits as any audit. The saved URL passes the same address checks.
- The next run time is moved forward before the audit starts, so a crash cannot make one site get audited every hour. A failed check tries again the next day.
- Emails are plain text. The HTML copy is built only from escaped text, and schema type names taken from a page are cut to letters and digits.

Tests: `test/watch.test.js`.

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
2. Stripe: create the $5 monthly price, a webhook endpoint for `/api/stripe/webhook` with these events: `checkout.session.completed`, `invoice.paid`, `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`, and save the customer portal settings (allow cancel). Do a full run in test mode on the deployed preview before switching to live keys with `STRIPE_ALLOW_LIVE=yes`.
3. Rebinding on Workers. The Worker checks DNS over HTTPS before each request, but the Worker's own fetch resolves the name again, so the connect-time guard that Node has does not exist there. Before going live, confirm what Cloudflare's network lets a Worker reach (it should not route to private ranges, but verify it), and consider refusing IP-address URLs entirely on the public version.
4. Add a Cloudflare WAF rate limiting rule on `/api/*` as an outer layer, and set billing alerts on the Cloudflare and Stripe accounts.
5. Legal pages: terms, a privacy note (stored data: email, audit reports, hashed IPs in short-lived counters), a refund policy, and a short disclaimer that audits are automated estimates. Stripe needs these before live payments.
6. Bot info page. Publish a page at the URL in the user agent saying what the bot does and how a site owner can opt out, and honour opt-outs.
7. Disposable email domains. A determined person can still make new inboxes for more free audits; the human check, per-connection limits and daily cap keep the cost small. Add a blocklist of throwaway domains if it becomes a problem.
8. Refunds and disputes: there is no automatic handling of `charge.refunded` or disputes yet. Cancelling the subscription in Stripe ends access.
9. Logs: the app logs only short error messages. Check that Workers logs do not keep request bodies, and keep error details private.
10. Caching. Cache results per URL for a while (for example an hour) so repeat requests do not refetch the site.
11. Dependency checks. `npm audit` showed 0 known problems on Oct 22, 2026. Keep Cheerio and undici current. Cheerio is pinned to 1.0.0.
12. Monitoring: alerts on error spikes, sign-up volume and audit volume.
13. Run the full audit against a handful of real client sites from a normal network and compare with a manual review. This sandbox could not reach the open web, so the tests use a fake web, a fake Stripe and an in-memory database.

## Not covered

- The tool does not render JavaScript, so content added by scripts after load is not seen (like many crawlers' first pass).
- Speed numbers come from one request from the server, not a real browser on a phone.
