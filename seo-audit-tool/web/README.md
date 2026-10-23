# SEO audit page (Astro)

The audit tool's page, built with Astro, inside a stand-in for allumstrategies.com. It is the page you would drop onto a live site at `/tools/seo-audit/`.

## Run it

Needs Node 22.13 or newer. From this folder:

```bash
npm install
(cd .. && npm install)   # the audit server, once
npm run dev
```

Open http://127.0.0.1:4321/tools/seo-audit/. That one command starts two servers:

- the audit API on 127.0.0.1:8787, with `APP_ORIGIN=http://127.0.0.1:4321` and `APP_PAGE=/tools/seo-audit/`, so sign-in links come back to this page
- the Astro dev server on 127.0.0.1:4321, which forwards `/api` to the API

Sign-in emails are not sent. The link prints in the terminal on an `[api]` line. Data lives in `../.data/local.db`; start with `DB_FILE=:memory: npm run dev` to keep nothing.

`npm run dev -- --cross-origin` makes the page call `http://127.0.0.1:8787` directly instead of going through the dev server. That is how a live deploy works (the page on the marketing site, the API on its own subdomain), so use it to check CORS and cookies.

`npm run build` writes the static page to `dist/`.

## Files

| File | What it is |
| --- | --- |
| `src/components/SeoAuditTool.astro` | The tool: form, sign-in, report, plan extras. Portable |
| `src/scripts/seo-audit.ts` | The tool's browser code. Goes with the component |
| `src/pages/tools/seo-audit/index.astro` | The page: hero, tool window, what it checks, plans, FAQ, close |
| `src/layouts/HostSite.astro` | Stand-in for the host site's header, footer and tokens. Not copied to the real site |

The component reads only the host site's CSS variables (`--deep`, `--line`, `--r-card` and so on) and its `.btn` classes, so it looks right on any page that declares them.

## Putting it on a live site

The page is static. The API is the Cloudflare Worker in `../src/worker/`, on its own subdomain, for example `audit-api.allumstrategies.com`.

1. Copy `SeoAuditTool.astro` into the site's `src/components/` and `seo-audit.ts` into `src/scripts/`.
2. Make the page. On allumstrategies.com that is `src/pages/tools/seo-audit.astro` using `Layout` and `ToolHero` with the tool in its `tool` slot, and an entry in `src/data/tools.ts`. Copy the sections below the window from `index.astro` here.
3. Build the site with `PUBLIC_AUDIT_API=https://audit-api.allumstrategies.com`.
4. Set the Worker's `APP_ORIGIN=https://allumstrategies.com` and `APP_PAGE=/tools/seo-audit/`. Turnstile's site key has to allow allumstrategies.com, since the widget renders there.
5. If the site sends a Content-Security-Policy, add the API to `connect-src`, and `https://challenges.cloudflare.com` to `script-src` and `frame-src`.

The API has to be a subdomain of the same site as the page. The session cookie is `SameSite=Lax`, so a browser only sends it to the API when both share a registrable domain. For devbysalt.com, deploy a second copy of the API on `audit-api.devbysalt.com` with that site's `APP_ORIGIN`. Each copy sends its links to one page.
