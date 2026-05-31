import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import {
  type AdminAuthConfig,
  basicAuth,
  resolveAdminAuth,
  warnIfAdminUnconfigured,
} from "./basic-auth.js";

const SECRET = "secret";

function basic(user: string, pass: string): string {
  return `Basic ${Buffer.from(`${user}:${pass}`).toString("base64")}`;
}

// Build an app that mounts basicAuth in front of a downstream handler so we can
// assert whether the request reached it.
function buildApp(auth: AdminAuthConfig) {
  const downstream = vi.fn();
  const app = new Hono();
  app.use("*", basicAuth(auth));
  app.get("/admin", (c) => {
    downstream();
    return c.text("ok");
  });
  return { app, downstream };
}

describe("resolveAdminAuth", () => {
  it("prefers env over config (HELM_ADMIN_USER/PASSWORD override config.admin.*)", () => {
    const resolved = resolveAdminAuth(
      { admin: { enabled: true, username: "admin", password: "x" } },
      { HELM_ADMIN_USER: "ops", HELM_ADMIN_PASSWORD: "y" },
    );
    expect(resolved).toEqual({ enabled: true, username: "ops", password: "y" });
  });

  it("falls back to config when env is absent", () => {
    const resolved = resolveAdminAuth(
      { admin: { enabled: true, username: "admin", password: SECRET } },
      {},
    );
    expect(resolved).toEqual({ enabled: true, username: "admin", password: SECRET });
  });

  it("resolves null credentials when neither env nor config provides them", () => {
    const resolved = resolveAdminAuth({ admin: { enabled: true } }, {});
    expect(resolved).toEqual({ enabled: true, username: null, password: null });
  });

  it("defaults enabled to false when admin section is missing", () => {
    expect(resolveAdminAuth({}, {})).toEqual({ enabled: false, username: null, password: null });
  });

  it("HELM_ADMIN_ENABLED enables admin via env even without a config admin section", () => {
    const resolved = resolveAdminAuth(
      {},
      { HELM_ADMIN_ENABLED: "1", HELM_ADMIN_USER: "ops", HELM_ADMIN_PASSWORD: SECRET },
    );
    expect(resolved).toEqual({ enabled: true, username: "ops", password: SECRET });
  });

  it("HELM_ADMIN_ENABLED overrides config.admin.enabled (env-priority)", () => {
    expect(
      resolveAdminAuth(
        { admin: { enabled: true, username: "admin", password: SECRET } },
        { HELM_ADMIN_ENABLED: "false" },
      ).enabled,
    ).toBe(false);
    expect(
      resolveAdminAuth({ admin: { enabled: false } }, { HELM_ADMIN_ENABLED: "on" }).enabled,
    ).toBe(true);
  });
});

describe("warnIfAdminUnconfigured", () => {
  it("warns exactly once when enabled but credentials are missing, without throwing", () => {
    const lines: string[] = [];
    expect(() =>
      warnIfAdminUnconfigured({ enabled: true, username: null, password: null }, (l) =>
        lines.push(l),
      ),
    ).not.toThrow();
    expect(lines).toHaveLength(1);
    expect(lines[0]?.toLowerCase()).toContain("admin");
  });

  it("does not warn when disabled", () => {
    const lines: string[] = [];
    warnIfAdminUnconfigured({ enabled: false, username: null, password: null }, (l) =>
      lines.push(l),
    );
    expect(lines).toHaveLength(0);
  });

  it("does not warn when credentials are present", () => {
    const lines: string[] = [];
    warnIfAdminUnconfigured({ enabled: true, username: "admin", password: SECRET }, (l) =>
      lines.push(l),
    );
    expect(lines).toHaveLength(0);
  });

  it("never logs the plaintext password", () => {
    const lines: string[] = [];
    warnIfAdminUnconfigured({ enabled: true, username: "admin", password: null }, (l) =>
      lines.push(l),
    );
    // password is null here; assert with a populated-but-missing-username case too
    const lines2: string[] = [];
    warnIfAdminUnconfigured({ enabled: true, username: null, password: SECRET }, (l) =>
      lines2.push(l),
    );
    expect(lines2.join("\n")).not.toContain(SECRET);
  });
});

describe("basicAuth middleware", () => {
  it("intercepts with 401 + WWW-Authenticate when no Authorization header", async () => {
    const { app, downstream } = buildApp({ enabled: true, username: "admin", password: SECRET });
    const res = await app.request("/admin");
    expect(res.status).toBe(401);
    expect(res.headers.get("WWW-Authenticate")).toContain("Basic");
    expect(downstream).not.toHaveBeenCalled();
  });

  it("passes through to downstream on correct credentials", async () => {
    const { app, downstream } = buildApp({ enabled: true, username: "admin", password: SECRET });
    const res = await app.request("/admin", { headers: { Authorization: basic("admin", SECRET) } });
    expect(res.status).toBe(200);
    expect(downstream).toHaveBeenCalledOnce();
  });

  it("rejects with 401 on wrong password, downstream not run", async () => {
    const { app, downstream } = buildApp({ enabled: true, username: "admin", password: SECRET });
    const res = await app.request("/admin", {
      headers: { Authorization: basic("admin", "wrong") },
    });
    expect(res.status).toBe(401);
    expect(downstream).not.toHaveBeenCalled();
  });

  it("rejects with 401 on wrong username", async () => {
    const { app, downstream } = buildApp({ enabled: true, username: "admin", password: SECRET });
    const res = await app.request("/admin", { headers: { Authorization: basic("root", SECRET) } });
    expect(res.status).toBe(401);
    expect(downstream).not.toHaveBeenCalled();
  });

  it("passes through everything when disabled (no credentials required)", async () => {
    const { app, downstream } = buildApp({ enabled: false, username: null, password: null });
    const res = await app.request("/admin");
    expect(res.status).toBe(200);
    expect(downstream).toHaveBeenCalledOnce();
  });

  it("fail-closed: enabled but credentials missing -> all requests 401, never silently allowed", async () => {
    const { app, downstream } = buildApp({ enabled: true, username: null, password: null });
    const res = await app.request("/admin", { headers: { Authorization: basic("admin", SECRET) } });
    expect(res.status).toBe(401);
    expect(downstream).not.toHaveBeenCalled();
  });

  it("isolated from API key auth: a Bearer helm_ token is not accepted as admin credentials", async () => {
    const { app, downstream } = buildApp({ enabled: true, username: "admin", password: SECRET });
    const res = await app.request("/admin", {
      headers: { Authorization: "Bearer helm_live_abc123" },
    });
    expect(res.status).toBe(401);
    expect(res.headers.get("WWW-Authenticate")).toContain("Basic");
    expect(downstream).not.toHaveBeenCalled();
  });

  it("rejects credentials that differ in length from the configured ones", async () => {
    const { app, downstream } = buildApp({ enabled: true, username: "admin", password: SECRET });
    // attacker password is both shorter and longer than the real one
    for (const attempt of ["s", `${SECRET}-and-then-some-extra`]) {
      const res = await app.request("/admin", {
        headers: { Authorization: basic("admin", attempt) },
      });
      expect(res.status).toBe(401);
    }
    expect(downstream).not.toHaveBeenCalled();
  });

  it("accepts a correct password whose length differs from the username", async () => {
    // guards against a fixed-length-digest comparison accidentally truncating
    const { app, downstream } = buildApp({
      enabled: true,
      username: "u",
      password: "a-much-longer-password-than-the-username",
    });
    const res = await app.request("/admin", {
      headers: { Authorization: basic("u", "a-much-longer-password-than-the-username") },
    });
    expect(res.status).toBe(200);
    expect(downstream).toHaveBeenCalledOnce();
  });

  it("never echoes the plaintext password in the 401 response body", async () => {
    const { app } = buildApp({ enabled: true, username: "admin", password: SECRET });
    const res = await app.request("/admin", {
      headers: { Authorization: basic("admin", "wrong") },
    });
    const text = await res.text();
    expect(text).not.toContain(SECRET);
  });
});
