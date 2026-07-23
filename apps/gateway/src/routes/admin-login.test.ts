import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { ADMIN_SESSION_COOKIE, type AdminAuthConfig, basicAuth } from "../middleware/basic-auth.js";
import { mountAdminLogin } from "./admin-login.js";

const AUTH: AdminAuthConfig = {
  enabled: true,
  username: "admin",
  password: "correct horse battery staple",
};
const NOW = 1_800_000_000_000;

function appWithLogin(auth: AdminAuthConfig = AUTH): Hono {
  const app = new Hono();
  app.route("/admin", mountAdminLogin(auth, { now: () => NOW }));
  return app;
}

function form(fields: Record<string, string>): RequestInit {
  return {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      Origin: "http://localhost",
    },
    body: new URLSearchParams(fields).toString(),
  };
}

describe("Admin login page", () => {
  it("renders a private, accessible login form without a Basic challenge", async () => {
    const res = await appWithLogin().request("/admin/login?next=%2Fadmin%2Fproviders");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/html");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    const csp = res.headers.get("Content-Security-Policy") ?? "";
    expect(csp).toContain("default-src 'none'");
    expect(csp).not.toContain("script-src");
    expect(res.headers.get("WWW-Authenticate")).toBeNull();
    const html = await res.text();
    expect(html).toContain("Sign in to Helm");
    expect(html).toContain('name="username"');
    expect(html).toContain('autocomplete="current-password"');
    expect(html).toContain('name="next" value="/admin/providers"');
    expect(html).not.toContain("<script");
    expect(html).not.toContain(AUTH.password);
  });

  it("sets a hardened session cookie and redirects after valid credentials", async () => {
    const res = await appWithLogin().request(
      "/admin/login",
      form({ username: "admin", password: AUTH.password ?? "", next: "/admin/providers" }),
    );
    expect(res.status).toBe(303);
    expect(res.headers.get("Location")).toBe("/admin/providers");
    const cookie = res.headers.get("Set-Cookie") ?? "";
    expect(cookie).toContain(`${ADMIN_SESSION_COOKIE}=`);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Strict");
    expect(cookie).toContain("Path=/admin");
    expect(cookie).toContain("Max-Age=2592000");
    expect(cookie).not.toContain("Secure");
  });

  it("marks the session cookie Secure when HTTPS terminates at a reverse proxy", async () => {
    const request = form({ username: "admin", password: AUTH.password ?? "", next: "/admin" });
    request.headers = { ...request.headers, "X-Forwarded-Proto": "https" };
    const res = await appWithLogin().request("/admin/login", request);
    expect(res.status).toBe(303);
    expect(res.headers.get("Set-Cookie")).toContain("Secure");
  });

  it("uses a login-issued session cookie on the protected Admin API", async () => {
    const app = appWithLogin();
    let now = NOW + 30 * 24 * 60 * 60 * 1000 - 1;
    app.use("/admin/api/*", basicAuth(AUTH, { allowSession: true, now: () => now }));
    app.get("/admin/api/ping", (c) => c.json({ ok: true }));

    const login = await app.request(
      "/admin/login",
      form({ username: "admin", password: AUTH.password ?? "", next: "/admin" }),
    );
    const cookie = login.headers.get("Set-Cookie")?.split(";", 1)[0];
    expect(cookie).toBeTruthy();

    const api = await app.request("/admin/api/ping", { headers: { Cookie: cookie ?? "" } });
    expect(api.status).toBe(200);
    await expect(api.json()).resolves.toEqual({ ok: true });

    now += 1;
    const expired = await app.request("/admin/api/ping", { headers: { Cookie: cookie ?? "" } });
    expect(expired.status).toBe(401);
  });

  it("shows a generic inline error without echoing credentials", async () => {
    const res = await appWithLogin().request(
      "/admin/login",
      form({ username: "admin", password: "wrong-secret", next: "/admin" }),
    );
    expect(res.status).toBe(401);
    expect(res.headers.get("Set-Cookie")).toBeNull();
    expect(res.headers.get("WWW-Authenticate")).toBeNull();
    const html = await res.text();
    expect(html).toContain("The username or password is incorrect.");
    expect(html).not.toContain("wrong-secret");
    expect(html).not.toContain(AUTH.password);
  });

  it("rejects cross-origin credential submission", async () => {
    const request = form({ username: "admin", password: AUTH.password ?? "", next: "/admin" });
    request.headers = { ...request.headers, Origin: "https://attacker.example" };
    const res = await appWithLogin().request("/admin/login", request);
    expect(res.status).toBe(403);
    expect(res.headers.get("Set-Cookie")).toBeNull();
  });

  it("accepts a browser origin that matches the external Host behind a proxy", async () => {
    const request = form({
      username: "admin",
      password: AUTH.password ?? "",
      next: "/admin",
    });
    request.headers = {
      ...request.headers,
      Host: "helm.example",
      Origin: "https://helm.example",
    };
    const res = await appWithLogin().request("http://gateway.internal/admin/login", request);
    expect(res.status).toBe(303);
    expect(res.headers.get("Location")).toBe("/admin");
  });

  it("accepts an opaque browser origin only when Fetch Metadata proves it is same-origin", async () => {
    const sameOriginRequest = form({
      username: "admin",
      password: AUTH.password ?? "",
      next: "/admin",
    });
    sameOriginRequest.headers = {
      ...sameOriginRequest.headers,
      Origin: "null",
      "Sec-Fetch-Site": "same-origin",
    };
    const accepted = await appWithLogin().request("/admin/login", sameOriginRequest);
    expect(accepted.status).toBe(303);

    const crossSiteRequest = form({
      username: "admin",
      password: AUTH.password ?? "",
      next: "/admin",
    });
    crossSiteRequest.headers = {
      ...crossSiteRequest.headers,
      Origin: "null",
      "Sec-Fetch-Site": "cross-site",
    };
    const rejected = await appWithLogin().request("/admin/login", crossSiteRequest);
    expect(rejected.status).toBe(403);
  });

  it("prevents open or non-Admin redirects and clears the cookie on logout", async () => {
    for (const next of [
      "https://evil.example",
      "//evil.example",
      "/administrator",
      "/admin/login",
    ]) {
      const login = await appWithLogin().request(
        "/admin/login",
        form({ username: "admin", password: AUTH.password ?? "", next }),
      );
      expect(login.status).toBe(303);
      expect(login.headers.get("Location")).toBe("/admin");
    }

    const logout = await appWithLogin().request("/admin/logout", {
      method: "POST",
      headers: { Origin: "http://localhost" },
    });
    expect(logout.status).toBe(303);
    expect(logout.headers.get("Location")).toBe("/admin/login");
    const cookie = logout.headers.get("Set-Cookie") ?? "";
    expect(cookie).toContain(`${ADMIN_SESSION_COOKIE}=`);
    expect(cookie).toContain("Max-Age=0");
  });
});
