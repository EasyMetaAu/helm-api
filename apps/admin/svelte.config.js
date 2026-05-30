import adapter from '@sveltejs/adapter-static';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

/** @type {import('@sveltejs/kit').Config} */
const config = {
  preprocess: vitePreprocess(),
  kit: {
    adapter: adapter({
      pages: 'build',
      assets: 'build',
      // SPA fallback: every route falls back to index.html so client-side
      // routing keeps working when Hono serves the static bundle at /admin.
      fallback: 'index.html',
      precompress: false,
      strict: true,
    }),
    // Must match the Hono mount point in admin.static-serve, otherwise assets
    // resolve against a bare "/" and 404.
    paths: { base: '/admin' },
  },
};

export default config;
