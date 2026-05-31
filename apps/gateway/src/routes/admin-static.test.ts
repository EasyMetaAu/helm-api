import { readdirSync } from "node:fs";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import type { AdminAuthConfig } from "../middleware/basic-auth.js";
import { mountAdminStatic } from "./admin-static.js";

// admin.static-serve — Hono 在 /admin 托管 admin SPA（替换 Phase 0 占位）。
// 这些测试钉住契约（DoD 场景 1-7）：
//   1. 带凭证 GET /admin -> 200 index.html (text/html)
//   2. 静态资源 (_app/immutable/assets/*.css) -> 200 + 正确 MIME
//   3. SPA fallback：未命中物理文件的子路由 (/admin/keys) -> 200 index.html，不 404
//   4. 未认证 -> 401 + WWW-Authenticate，且不泄露任何静态内容
//   5. Phase 0 占位文案不再出现（catch-all 静态托管已接管）
//   6. /admin/api/* 不被静态 fallback 吞（API 路由先注册时优先）
//   7. admin.enabled:false -> Basic 不拦，/admin 仍发静态

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
});
