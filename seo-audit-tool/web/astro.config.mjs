import { defineConfig } from "astro/config";

// The audit API. Locally the Node server on 8787; `npm run dev` starts it.
const API = process.env.AUDIT_API_PROXY || "http://127.0.0.1:8787";

export default defineConfig({
  site: process.env.SITE_URL || "https://allumstrategies.com",
  output: "static",
  // "ignore", not the host site's "always": the dev server applies the slash
  // rule before its proxy, so "always" would 404 every /api call. The build
  // writes /tools/seo-audit/index.html either way.
  trailingSlash: "ignore",
  server: { host: "127.0.0.1", port: 4321 },
  vite: {
    // With PUBLIC_AUDIT_API unset the page calls /api on its own origin, and
    // the dev server forwards that to the audit server. Setting it to the
    // API's own address (http://127.0.0.1:8787) runs the cross-origin setup a
    // live deploy uses instead.
    server: { proxy: { "/api": { target: API, changeOrigin: false } } },
  },
});
