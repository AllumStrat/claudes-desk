# Security notes

A public audit tool fetches whatever URL a stranger types. The two big risks are that someone uses it to reach things that are not on the public web (server-side request forgery, SSRF), and that someone uses it to hammer a site or run up costs. This file lists what the test version already guards against, how each guard is tested, and what must be done before it goes live.

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
- Request bodies to the API are capped at 4 KB, including chunked uploads on the Worker.
- At most 2 audits run at once per server; extra requests get a 503.

Tests: `test/safe-fetch.test.js` (cap, endless body, timeout, redirect loop), `test/audit.test.js` (request volume on a page with 1,500 links, limit ceilings), `test/handler.test.js`, `test/server.test.js`.

### Abuse of the tool itself

- Rate limit per visitor IP: 5 audits per 10 minutes by default.
- Rate limit per target site: 10 audits of the same domain per hour, from anyone, so the tool cannot be pointed at one site over and over.
- Cross-site requests are refused: a POST with an Origin header from another site gets a 403.
- Only JSON requests with a single `url` field (and an optional human-check token) are accepted. Unknown fields are refused, so callers cannot change limits.
- The crawl obeys robots.txt (the rules for its own user agent, or the `*` rules when there are none) and skips nofollow links.
- A clear user agent: `AllumSEOAudit/0.1 (+https://allumstrategies.com; site audit on request)`.

### Output safety

- The page renders every piece of report text as plain text nodes. No HTML from an audited site is ever parsed in the browser, and a test fails the build if `innerHTML` or similar shows up in `public/app.js`.
- Strict Content Security Policy: scripts only from this site (plus Cloudflare's Turnstile script, for later), no inline scripts, no framing.
- Error messages are fixed sentences. They never echo the submitted URL or internal details, and unexpected errors return a generic 500.
- The Markdown report escapes HTML and Markdown characters from page text.
- `nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, `Permissions-Policy` and same-origin policies on every response. The test page is marked `noindex`.

### Jev (optional AI layer)

- Off unless `JEV_PROVIDER` is set. Keys only live in server environment variables and never reach the browser or the report. A failing provider is reported with a fixed sentence, never the raw error.
- Jev only returns numbers and picks from our own fixed list, so an audited page cannot make the tool print text it wrote (prompt injection has no text to come out through). Answers are validated: wrong types, out-of-range numbers, unknown choices and extra fields are dropped.
- A page can still try to sway its own scores with text aimed at the model. That only affects that site's own report, and these findings are labelled as AI judgment with a confidence.
- Page text sent to Jev is capped at 12,000 characters. Note that this sends the audited page's public text to TypeSafe or Cloudflare. Cloudflare lists zero data retention for this model.

## Must do before going live

1. Human check. The server side of Cloudflare Turnstile is built (`TURNSTILE_SECRET` turns it on and the API then refuses requests without a valid token), but the test page does not show the widget yet. Add the widget with a site key, then turn the secret on.
2. Shared rate limits. The limits here are in memory, which is fine for one Node process but resets per Worker instance. On Cloudflare, use the Rate Limiting binding (sketched in `wrangler.example.toml` and already wired in `src/worker/index.js`) or a KV or Durable Object counter, for both the per-visitor and per-target limits. Add a daily cap on total audits too.
3. Rebinding on Workers. The Worker checks DNS over HTTPS before each request, but the Worker's own fetch resolves the name again, so the connect-time guard that Node has does not exist there. Before going live, confirm what Cloudflare's network lets a Worker reach (it should not route to private ranges, but verify it), and consider refusing IP-address URLs entirely on the public version.
4. Turn off error details in logs or send them somewhere private. The Node server prints unexpected errors to the console.
5. Bot info page. Publish a page at the URL in the user agent saying what the bot does and how a site owner can opt out, and honour opt-outs.
6. Caching. Cache results per URL for a while (for example an hour) so repeat requests do not refetch the site.
7. Terms and a short disclaimer on the page (audits are automated estimates).
8. Dependency checks. Run `npm audit` and keep Cheerio and undici current. Cheerio is pinned to 1.0.0.
9. Monitoring and an off switch: alerts on error spikes and request volume, and a way to disable the endpoint quickly.
10. Run the full audit against a handful of real client sites from a normal network and compare with a manual review. This sandbox could not reach the open web, so the tests use a fake web.

## Not covered

- No login or accounts; anyone who can reach the page can run audits within the limits.
- The tool does not render JavaScript, so content added by scripts after load is not seen (like many crawlers' first pass).
- Speed numbers come from one request from the server, not a real browser on a phone.
