# SEO writer web page

The writer as a page on the site: `/tools/seo-writer/`. A brief form, the run's steps as they happen, then the copy doc with a preview, the check report and the cost.

## Run it

```bash
cd seo-writer && npm install          # the writer itself
cd web && npm install
npm run dev                           # http://localhost:4321/tools/seo-writer/
```

`npm run dev` is **demo mode** (`WRITER_DEMO=1`): every run writes the same sample page for Example Auto with a canned model. No key, no token, no API calls, no spend. The form, the brief checks, the streamed steps and the results are all real code.

`npm run dev:real` runs the real writer and bills the key:

```bash
export ANTHROPIC_API_KEY=...
export WRITER_TOKEN=$(openssl rand -hex 32)   # paste it into the page's token field
npm run dev:real
```

In both, `astro dev` answers `/api/*` with the Worker's own handler (`dev-api.mjs` mounts `src/worker/index.js`), so the page talks to the same code it will talk to live.

## The pieces

| File | What it is |
| --- | --- |
| `src/components/SeoWriter.astro` | The tool: form, progress, results. Drop-in; uses only the site's token names (`--deep`, `--gold`, `--line`, ...). |
| `src/scripts/seo-writer.js` | Talks to `/api/status` and `/api/write` and fills the page. |
| `src/scripts/brief-form.js` | Form to brief JSON and back. Fields the form has no input for survive a paste. |
| `src/scripts/render.js` | The page preview. All model text is escaped first; links render only for site paths and `https://`. |
| `src/layouts/Shell.astro` | A cut-down copy of allumstrategies.com's header, footer and tokens, so the page previews as it will look on the site. |
| `src/pages/tools/seo-writer.astro` | The page: hero, the tool, how it works. `noindex`. |

## Putting it live

The page is static. It needs the Worker on the **same origin** for `/api/status` and `/api/write` (there is no CORS).

1. **Its own subdomain (simplest).** Build here (`npm run build`), turn on the `[assets]` block in `../wrangler.example.toml`, and deploy the Worker to `writer.allumstrategies.com` (or `writer.devbysalt.com`). Cloudflare serves the page, the Worker answers `/api/*`. Put Cloudflare Access on the hostname.
2. **Inside allumstrategies.com.** Copy `SeoWriter.astro` and `src/scripts/` into the site, add a page that wraps it in the site's `Layout` (keep `noindex`), and route `allumstrategies.com/api/*` to the Worker. That needs the domain on Cloudflare; a separate Worker host means adding CORS to the Worker first.

To show it without spending anything, deploy with `WRITER_DEMO = "1"`.

Everything in the parent README's "The Worker" section still applies before real use: Access, a monthly limit on the Anthropic key, `enable_request_signal`. The open blockers in the go-live review (invented facts, prompt injection through the brief, link checks on titles and CTAs, spend-cap accuracy) are not fixed by this page.
