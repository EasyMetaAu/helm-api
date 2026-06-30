import { readdirSync } from "node:fs";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import type { AdminAuthConfig } from "../middleware/basic-auth.js";
import { mountAdminStatic } from "./admin-static.js";

// admin.static-serve — Hono serves the admin SPA at /admin (replacing the Phase 0
// placeholder). These tests pin the contract (DoD scenarios 1-7):
//   1. With credentials, GET /admin -> 200 index.html (text/html)
//   2. Static assets (_app/immutable/assets/*.css) -> 200 + correct MIME
//   3. SPA fallback: a sub-route with no physical file (/admin/keys) -> 200 index.html, not 404
//   4. Unauthenticated -> 401 + WWW-Authenticate, and leaks no static content
//   5. The Phase 0 placeholder text no longer appears (catch-all static serving has taken over)
//   6. /admin/api/* is not swallowed by the static fallback (API routes win when registered first)
//   7. admin.enabled:false -> Basic does not block, /admin still serves static files

const ENABLED: AdminAuthConfig = { enabled: true, username: "admin", password: "s3cret" };
const DISABLED: AdminAuthConfig = { enabled: false, username: null, password: null };

// `Authorization: Basic base64(admin:s3cret)`.
const CRED = `Basic ${Buffer.from("admin:s3cret").toString("base64")}`;

// The hashed CSS asset name is build-dependent; discover it so the test does not
// couple to a specific content hash.
function findCssAsset(): string {
  const dir = "apps/admin/build/_app/immutable/assets";
  const css = readdirSync(dir).find((f) => f.endsWith(".css"));
  if (!css) throw new Error(`no css asset found under ${dir}`);
  return `/admin/_app/immutable/assets/${css}`;
}

function appWith(auth: AdminAuthConfig): Hono {
  const app = new Hono();
  app.route("/admin", mountAdminStatic(auth));
  return app;
}

describe("mountAdminStatic", () => {
  it("serves the SPA index.html at /admin with valid credentials", async () => {
    const res = await appWith(ENABLED).request("/admin", {
      headers: { Authorization: CRED },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/html");
    const body = await res.text();
    // SPA mount root + base path injected by adapter-static.
    expect(body).toContain("<!doctype html>");
    expect(body).toContain('base: "/admin"');
  });

  it("serves real static assets with the correct MIME type", async () => {
    const res = await appWith(ENABLED).request(findCssAsset(), {
      headers: { Authorization: CRED },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/css");
    const body = await res.text();
    expect(body.length).toBeGreaterThan(0);
  });

  it("falls back to index.html for SPA deep links (no 404)", async () => {
    const res = await appWith(ENABLED).request("/admin/keys", {
      headers: { Authorization: CRED },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/html");
    const body = await res.text();
    expect(body).toContain('base: "/admin"');
  });

  it("rejects unauthenticated requests with 401 and does not leak content", async () => {
    const res = await appWith(ENABLED).request("/admin");
    expect(res.status).toBe(401);
    expect(res.headers.get("WWW-Authenticate")).toContain("Basic");
    const body = await res.text();
    expect(body).not.toContain("<!doctype html>");
    expect(body).not.toContain('base: "/admin"');
  });

  it("rejects wrong credentials with 401", async () => {
    const wrong = `Basic ${Buffer.from("admin:nope").toString("base64")}`;
    const res = await appWith(ENABLED).request("/admin", { headers: { Authorization: wrong } });
    expect(res.status).toBe(401);
  });

  it("no longer returns the Phase 0 placeholder text", async () => {
    const res = await appWith(ENABLED).request("/admin", { headers: { Authorization: CRED } });
    const body = await res.text();
    expect(body).not.toContain("placeholder");
  });

  it("does not swallow /admin/api/* when the API route is registered first", async () => {
    const app = new Hono();
    // API registered BEFORE the static mount -> Hono matches it first (registration order).
    app.get("/admin/api/lanes", (c) => c.json([{ name: "fast" }]));
    app.route("/admin", mountAdminStatic(ENABLED));
    const res = await app.request("/admin/api/lanes", { headers: { Authorization: CRED } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<{ name: string }>;
    expect(body[0]?.name).toBe("fast");
  });

  it("serves the SPA without Basic when admin is disabled", async () => {
    const res = await appWith(DISABLED).request("/admin");
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("<!doctype html>");
  });

  // Cache policy (DoD: a deploy must take effect in an already-open browser).
  // The SPA shell (index.html) hard-codes the current build's hashed chunk URLs;
  // if it is heuristically cached the browser keeps replaying the OLD build after
  // a deploy. So the shell must revalidate every load, while the content-hashed
  // immutable assets (hash == content) can be cached for a year.
  it("sets Cache-Control: no-cache on the SPA shell so a deploy is picked up", async () => {
    const res = await appWith(ENABLED).request("/admin", { headers: { Authorization: CRED } });
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/html");
    expect(res.headers.get("Cache-Control")).toBe("no-cache");
  });

  it("sets Cache-Control: no-cache on SPA deep-link fallbacks (index.html)", async () => {
    const res = await appWith(ENABLED).request("/admin/keys", {
      headers: { Authorization: CRED },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/html");
    expect(res.headers.get("Cache-Control")).toBe("no-cache");
  });

  it("caches content-hashed immutable assets for a year", async () => {
    const res = await appWith(ENABLED).request(findCssAsset(), {
      headers: { Authorization: CRED },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("public, max-age=31536000, immutable");
  });

  it("caches favicon assets instead of forcing a full re-fetch on every admin load", async () => {
    for (const path of ["/admin/favicon.svg", "/admin/favicon.png"]) {
      const res = await appWith(ENABLED).request(path, {
        headers: { Authorization: CRED },
      });
      expect(res.status).toBe(200);
      expect(res.headers.get("Cache-Control")).toBe("private, max-age=604800");
    }
  });
});
