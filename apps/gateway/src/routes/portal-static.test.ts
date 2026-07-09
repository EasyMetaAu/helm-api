import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { mountPortalStatic } from "./portal-static.js";

// portal.static-serve — the file-serving/cache mechanics are identical to
// admin-static (covered there); these tests pin only what DIFFERS for the portal:
//   1. NO Basic Auth gate — a request is never 401'd by the shell.
//   2. A strong CSP header on every response (the sessionStorage-key XSS threat).
//   3. /portal/api/* is not swallowed by the SPA fallback (API wins when first).

function appWith(): Hono {
  const app = new Hono();
  app.route("/portal", mountPortalStatic());
  return app;
}

describe("mountPortalStatic", () => {
  it("does not gate the shell behind Basic Auth (never 401)", async () => {
    const res = await appWith().request("/portal");
    expect(res.status).not.toBe(401);
    expect(res.headers.get("WWW-Authenticate")).toBeNull();
  });

  it("applies a strong CSP that forbids third-party scripts and framing", async () => {
    const res = await appWith().request("/portal");
    const csp = res.headers.get("Content-Security-Policy") ?? "";
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("script-src 'self'");
    expect(csp).not.toContain("script-src 'self' 'unsafe-inline'"); // no inline SCRIPT
    expect(csp).toContain("frame-ancestors 'none'");
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
  });

  it("does not swallow /portal/api/* when the API is registered first", async () => {
    const app = new Hono();
    app.get("/portal/api/me", (c) => c.json({ key_prefix: "helm_live_ab" }));
    app.route("/portal", mountPortalStatic());
    const res = await app.request("/portal/api/me");
    expect(res.status).toBe(200);
    expect(((await res.json()) as { key_prefix: string }).key_prefix).toBe("helm_live_ab");
  });
});
