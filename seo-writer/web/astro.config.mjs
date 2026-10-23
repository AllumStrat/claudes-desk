import { defineConfig } from 'astro/config';
import writerApi from './dev-api.mjs';

// A static page. In `astro dev` the Worker's own handler answers /api/* (see
// dev-api.mjs), so the page talks to the same code it will talk to live.
export default defineConfig({
  site: process.env.SITE || 'https://allumstrategies.com',
  output: 'static',
  trailingSlash: 'always',
  devToolbar: { enabled: false },
  integrations: [writerApi()],
});
