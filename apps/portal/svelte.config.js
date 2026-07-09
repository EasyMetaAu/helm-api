import adapter from "@sveltejs/adapter-static";
import { vitePreprocess } from "@sveltejs/vite-plugin-svelte";

/** @type {import('@sveltejs/kit').Config} */
const config = {
  preprocess: vitePreprocess(),
  kit: {
    adapter: adapter({
      pages: "build",
      assets: "build",
      // SPA fallback: every route falls back to index.html so client-side routing
      // keeps working when Hono serves the static bundle at /portal.
      fallback: "index.html",
      precompress: false,
      strict: true,
    }),
    // Must match the Hono mount point in portal.static-serve, otherwise assets
    // resolve against a bare "/" and 404.
    paths: { base: "/portal" },
    // Strong CSP (docs/12 §4.1). SvelteKit injects one tiny inline bootstrap
    // script into index.html; hash mode computes its SHA256 and writes a matching
    // <meta http-equiv> CSP so the shell boots under `script-src 'self'` WITHOUT
    // needing 'unsafe-inline'. The Hono response header carries the same policy
    // (portal-static.ts) — browsers intersect header + meta, so both must agree;
    // the meta's per-build hash covers the inline script the header's bare 'self'
    // would otherwise block.
    csp: {
      mode: "hash",
      directives: {
        "default-src": ["self"],
        "script-src": ["self"],
        "style-src": ["self", "unsafe-inline"],
        "img-src": ["self", "data:"],
        "font-src": ["self"],
        "connect-src": ["self"],
        "frame-ancestors": ["none"],
        "base-uri": ["self"],
        "form-action": ["self"],
      },
    },
  },
};

export default config;
