import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { type AdminAuthConfig, basicAuth } from "../middleware/basic-auth.js";

// admin.static-serve — Hono serves the admin SPA's static build at /admin
// (apps/admin/build/, produced by adapter-static). CLAUDE.md Principle 1: the
// gateway only serves static files and NEVER runs SvelteKit SSR/runtime in-process
// (does not import SvelteKit). The whole /admin goes through HTTP Basic (admin.auth)
// first; unauthenticated requests are always blocked, never serve a file before
// validating.
//
// Path handling: this sub-app is mounted via `app.route('/admin', mountAdminStatic(auth))`,
// but inside the sub-app Hono still exposes `c.req.path` as the **full** path
// (`/admin/...`), and serveStatic uses that path to look up files under root.
// So we strip the `/admin` prefix and resolve against `apps/admin/build` as root —
// matching admin.scaffold's `paths.base:'/admin'`.
//
// SPA deep-link refresh (sub-routes with no physical file, e.g. /admin/keys) must
// fall back to index.html and let the frontend router take over, not 404.
// `/admin/api/*` are admin.api endpoints: the caller registers the API routes
// **before** mounting this sub-app (Hono matches in registration order), so the
// sub-app never receives API requests; the fallback here still lets `/api/*`
// through (next()) as defense in depth, to avoid treating it as a page and
// returning index.html.

// serveStatic's root resolves relative to the launching process's cwd (repo root).
// Exported so server.ts can emit a startup "build artifacts missing" warning and
// avoid drifting the path string in two places.
export const ADMIN_BUILD_ROOT = "./apps/admin/build";
const INDEX_PATH = `${ADMIN_BUILD_ROOT}/index.html`;

// Strip the mount prefix, mapping `/admin/_app/x.js` to `apps/admin/build/_app/x.js`;
// `/admin` itself maps to the root directory (serveStatic falls back to index.html).
function stripAdminPrefix(path: string): string {
  const rest = path.replace(/^\/admin/, "");
  return rest === "" ? "/" : rest;
}

export function mountAdminStatic(auth: AdminAuthConfig): Hono {
  const admin = new Hono();

  // 1) The whole /admin goes through Basic first (foremost): unauthenticated -> 401 + WWW-Authenticate, no content leaked.
  admin.use("*", basicAuth(auth));

  // 2) Real file hit (/admin/_app/..., .js/.css) -> serve that file directly with the correct MIME.
  admin.use(
    "/*",
    serveStatic({
      root: ADMIN_BUILD_ROOT,
      rewriteRequestPath: stripAdminPrefix,
    }),
  );

  // 3) SPA fallback: non-API routes with no physical file -> fall back to index.html (frontend router takes over).
  //    `/admin/api/*` is let through, to avoid swallowing API endpoints.
  admin.get("*", (c, next) => {
    if (c.req.path.startsWith("/admin/api/")) return next();
    return serveStatic({ path: INDEX_PATH })(c, next);
  });

  return admin;
}
