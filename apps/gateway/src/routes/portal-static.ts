import { readFileSync } from "node:fs";
import { serveStatic } from "@hono/node-server/serve-static";
import { type Context, Hono } from "hono";

// portal.static-serve — serves the self-service portal SPA (apps/portal/build/,
// adapter-static) at /portal. Unlike /admin this has NO server-side auth gate: the
// static shell is public, and auth happens per-request when the SPA calls
// /portal/api/* with a Bearer key (docs/12 §4.1). Principle 1: static files only,
// never SvelteKit SSR in-process.
//
// Mounted via `app.route('/portal', mountPortalStatic())`; inside the sub-app
// `c.req.path` is still the FULL path (`/portal/...`), so strip the prefix and
// resolve against apps/portal/build — matching the SPA's `paths.base:'/portal'`.

export const PORTAL_BUILD_ROOT = "./apps/portal/build";
const INDEX_PATH = `${PORTAL_BUILD_ROOT}/index.html`;
const FAVICON_CACHE_CONTROL = "private, max-age=604800";

// Strong CSP (§4.1): the portal holds a plaintext upstream key in sessionStorage,
// so XSS is the whole threat model. Lock scripts/styles to same-origin, forbid any
// third-party/CDN. SvelteKit injects ONE tiny inline bootstrap script into
// index.html; its SHA256 hash (kit.csp hash mode) is written into the built HTML,
// which we read once at startup and fold into `script-src` so the shell boots
// under a header CSP without ever needing 'unsafe-inline' for scripts.
function buildCsp(scriptHash: string | null): string {
  const scriptSrc = scriptHash ? `script-src 'self' '${scriptHash}'` : "script-src 'self'";
  return [
    "default-src 'self'",
    scriptSrc,
    // Tailwind ships hashed CSS files, but SvelteKit hydration injects inline
    // <style> blocks; 'unsafe-inline' for STYLE only (never script) is the
    // standard SvelteKit-static tradeoff.
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self'",
    "connect-src 'self'",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join("; ");
}

// Read SvelteKit's inline-bootstrap script hash from the built index.html (it
// writes a <meta http-equiv CSP> with the exact 'sha256-…'). Returns null if the
// build is absent — the CSP then omits the hash (the SPA won't boot, but /portal
// already warns "build missing", so this only bites an un-built deploy).
function readScriptHash(): string | null {
  try {
    const html = readFileSync(INDEX_PATH, "utf8");
    return /'(sha256-[A-Za-z0-9+/=]+)'/.exec(html)?.[1] ?? null;
  } catch {
    return null;
  }
}

function stripPortalPrefix(path: string): string {
  const rest = path.replace(/^\/portal/, "");
  return rest === "" ? "/" : rest;
}

// Same cache policy rationale as admin-static: immutable hashed chunks for a year,
// favicon bounded, index.html (the shell) always revalidated so a deploy takes.
function setCacheHeaders(c: Context): void {
  if (c.req.path.includes("/_app/immutable/")) {
    c.header("Cache-Control", "public, max-age=31536000, immutable");
  } else if (/^\/portal\/favicon\.(?:svg|png)$/.test(c.req.path)) {
    c.header("Cache-Control", FAVICON_CACHE_CONTROL);
  } else {
    c.header("Cache-Control", "no-cache");
  }
}

export function mountPortalStatic(): Hono {
  const portal = new Hono();
  const csp = buildCsp(readScriptHash());

  // CSP + cache headers on every response, BEFORE the static handler builds the body.
  portal.use("/*", async (c, next) => {
    c.header("Content-Security-Policy", csp);
    c.header("X-Content-Type-Options", "nosniff");
    c.header("Referrer-Policy", "no-referrer");
    setCacheHeaders(c);
    await next();
  });

  portal.use(
    "/*",
    serveStatic({
      root: PORTAL_BUILD_ROOT,
      rewriteRequestPath: stripPortalPrefix,
    }),
  );

  // SPA deep-link fallback; let /portal/api/* pass through (registered before this
  // mount, so it never reaches here — this is defense in depth).
  portal.get("*", (c, next) => {
    if (c.req.path.startsWith("/portal/api/")) return next();
    return serveStatic({ path: INDEX_PATH })(c, next);
  });

  return portal;
}
