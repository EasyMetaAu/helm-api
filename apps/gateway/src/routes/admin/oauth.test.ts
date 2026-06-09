import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import type { AppEnv } from "../../app.js";
import type { AdminApiDeps, OAuthAdminAccess } from "./deps.js";
import { registerOAuthRoutes } from "./oauth.js";

// A complete OAuthAdminAccess seam with vi.fn methods (overridable per test). The
// routes are thin validating wrappers around this seam, so exercising them with a
// mock seam covers the route logic (validation, error mapping, afterMutation).
function fullSeam(over: Partial<OAuthAdminAccess> = {}): OAuthAdminAccess {
  return {
    listStatus: vi.fn(async () => [
      { id: "anthropic", name: "Anthropic", accounts: [{ account: "default" }] },
    ]),
    startManualPaste: vi.fn(async () => ({ sessionId: "s1", authorizeUrl: "https://auth" })),
    completeManualPaste: vi.fn(async () => {}),
    startDeviceCode: vi.fn(async () => ({
      sessionId: "s2",
      userCode: "ABCD",
      verificationUri: "https://v",
    })),
    pollDeviceCode: vi.fn(async () => ({ status: "pending" as const })),
    logout: vi.fn(async () => {}),
    listModels: vi.fn(async () => ({ available: ["m1", "m2"], enabled: ["m1"], canPull: true })),
    setEnabledModels: vi.fn(async () => {}),
    getAccountProxy: vi.fn(async () => null),
    setAccountProxy: vi.fn(async () => {}),
    getAccountSchedule: vi.fn(async () => ({ priority: 50, schedulable: true })),
    setAccountSchedule: vi.fn(async () => {}),
    ...over,
  } as unknown as OAuthAdminAccess;
}

function app(deps: Partial<AdminApiDeps>) {
  const a = new Hono<AppEnv>();
  registerOAuthRoutes(a, deps as AdminApiDeps);
  return a;
}

const JSONH = { "Content-Type": "application/json" };
const VALID_PROXY = { type: "http", host: "127.0.0.1", port: 8080 };

describe("admin OAuth routes — 503 when the seam is not configured", () => {
  it.each([
    ["GET", "/admin/api/oauth"],
    ["POST", "/admin/api/oauth/anthropic/manual/start"],
    ["POST", "/admin/api/oauth/anthropic/manual/complete"],
    ["POST", "/admin/api/oauth/x/device/start"],
    ["POST", "/admin/api/oauth/x/device/poll"],
    ["GET", "/admin/api/oauth/x/models"],
    ["PUT", "/admin/api/oauth/x/models"],
    ["GET", "/admin/api/oauth/x/proxy"],
    ["PUT", "/admin/api/oauth/x/proxy"],
    ["GET", "/admin/api/oauth/x/account"],
    ["PUT", "/admin/api/oauth/x/account"],
    ["DELETE", "/admin/api/oauth/x"],
  ])("%s %s -> 503 oauth not configured", async (method, path) => {
    const init: RequestInit =
      method === "GET" || method === "DELETE" ? { method } : { method, headers: JSONH, body: "{}" };
    const res = await app({}).request(path, init);
    expect(res.status).toBe(503);
  });
});

describe("admin OAuth routes — read endpoints", () => {
  it("GET /oauth returns the provider catalog", async () => {
    const res = await app({ oauth: fullSeam() }).request("/admin/api/oauth");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { providers: unknown[] };
    expect(body.providers).toHaveLength(1);
  });

  it("GET /oauth/usage returns [] with no store, and bound-filtered rows with one", async () => {
    expect(
      (
        (await (await app({ oauth: fullSeam() }).request("/admin/api/oauth/usage")).json()) as {
          usage: unknown[];
        }
      ).usage,
    ).toEqual([]);
    const oauthUsage = {
      queryDay: vi.fn(async () => [
        {
          providerId: "anthropic",
          account: "default",
          requests: 120,
          tokens: 10,
          costUsd: 0.5,
          firstSeenMs: Date.now() - 60_000,
        },
        {
          providerId: "anthropic",
          account: "ghost",
          requests: 5,
          tokens: 1,
          costUsd: 0,
          firstSeenMs: Date.now(),
        },
      ]),
    } as unknown as AdminApiDeps["oauthUsage"];
    const res = await app({ oauth: fullSeam(), oauthUsage }).request("/admin/api/oauth/usage");
    const body = (await res.json()) as { usage: Array<{ account: string; rpm: number }> };
    // The unbound "ghost" account is filtered out; the bound one keeps a derived rpm.
    expect(body.usage).toHaveLength(1);
    expect(body.usage[0]?.account).toBe("default");
  });

  it("GET /oauth/quota returns [] with no store and merges PULL windows with one", async () => {
    expect(
      (
        (await (await app({ oauth: fullSeam() }).request("/admin/api/oauth/quota")).json()) as {
          quota: unknown[];
        }
      ).quota,
    ).toEqual([]);
    const upsert = vi.fn(async () => {});
    const oauthQuota = {
      getAll: vi.fn(async () => [{ providerId: "anthropic", account: "default", windows: [] }]),
      upsert,
    } as unknown as AdminApiDeps["oauthQuota"];
    const seam = fullSeam({
      fetchAnthropicQuota: vi.fn(async () => [{ kind: "5h", utilization: 0.1 }]) as never,
    });
    const res = await app({ oauth: seam, oauthQuota }).request("/admin/api/oauth/quota");
    expect(res.status).toBe(200);
    expect(upsert).toHaveBeenCalled(); // the PULL refreshed the store
  });

  it("GET /oauth/:provider/models returns available + enabled", async () => {
    const res = await app({ oauth: fullSeam() }).request(
      "/admin/api/oauth/anthropic/models?account=default",
    );
    const body = (await res.json()) as { available: string[]; enabled: string[] };
    expect(body.available).toEqual(["m1", "m2"]);
    expect(body.enabled).toEqual(["m1"]);
  });

  it("GET /oauth/:provider/proxy returns {proxy:null} when none set", async () => {
    const res = await app({ oauth: fullSeam() }).request("/admin/api/oauth/anthropic/proxy");
    expect((await res.json()) as { proxy: null }).toEqual({ proxy: null });
  });

  it("GET /oauth/:provider/account returns the effective schedule", async () => {
    const res = await app({ oauth: fullSeam() }).request("/admin/api/oauth/anthropic/account");
    expect((await res.json()) as { priority: number }).toMatchObject({
      priority: 50,
      schedulable: true,
    });
  });
});

describe("admin OAuth routes — connect flows", () => {
  it("POST manual/start returns the authorize URL; a bad proxy is 400", async () => {
    const ok = await app({ oauth: fullSeam() }).request("/admin/api/oauth/anthropic/manual/start", {
      method: "POST",
      headers: JSONH,
      body: JSON.stringify({ proxy: VALID_PROXY }),
    });
    expect((await ok.json()) as { authorizeUrl: string }).toMatchObject({
      authorizeUrl: "https://auth",
    });
    const bad = await app({ oauth: fullSeam() }).request(
      "/admin/api/oauth/anthropic/manual/start",
      {
        method: "POST",
        headers: JSONH,
        body: JSON.stringify({ proxy: { type: "ftp" } }),
      },
    );
    expect(bad.status).toBe(400);
  });

  it("POST manual/complete 400s on missing fields, 204s on success", async () => {
    const missing = await app({ oauth: fullSeam() }).request(
      "/admin/api/oauth/anthropic/manual/complete",
      {
        method: "POST",
        headers: JSONH,
        body: JSON.stringify({ sessionId: "s1" }),
      },
    );
    expect(missing.status).toBe(400);
    const seam = fullSeam();
    const res = await app({ oauth: seam }).request("/admin/api/oauth/anthropic/manual/complete", {
      method: "POST",
      headers: JSONH,
      body: JSON.stringify({ sessionId: "s1", redirectInput: "https://cb?code=x" }),
    });
    expect(res.status).toBe(204);
    expect(seam.completeManualPaste).toHaveBeenCalledOnce();
  });

  it("POST manual/complete returns 503 not_applied when the live rebuild fails", async () => {
    const onOAuthMutation = vi.fn(async () => ({ applied: false }));
    const res = await app({ oauth: fullSeam(), onOAuthMutation }).request(
      "/admin/api/oauth/anthropic/manual/complete",
      {
        method: "POST",
        headers: JSONH,
        body: JSON.stringify({ sessionId: "s", redirectInput: "u" }),
      },
    );
    expect(res.status).toBe(503);
    expect((await res.json()) as { code: string }).toMatchObject({ code: "not_applied" });
  });

  it("POST device/start returns the device code; device/poll 400s without sessionId", async () => {
    const start = await app({ oauth: fullSeam() }).request(
      "/admin/api/oauth/copilot/device/start",
      {
        method: "POST",
        headers: JSONH,
        body: JSON.stringify({ enterprise: "acme" }),
      },
    );
    expect((await start.json()) as { userCode: string }).toMatchObject({ userCode: "ABCD" });
    const noSess = await app({ oauth: fullSeam() }).request(
      "/admin/api/oauth/copilot/device/poll",
      {
        method: "POST",
        headers: JSONH,
        body: "{}",
      },
    );
    expect(noSess.status).toBe(400);
  });

  it("POST device/poll rebuilds the pool only once the status is done", async () => {
    const onOAuthMutation = vi.fn(async () => ({ applied: true }));
    const seam = fullSeam({ pollDeviceCode: vi.fn(async () => ({ status: "done" as const })) });
    const res = await app({ oauth: seam, onOAuthMutation }).request(
      "/admin/api/oauth/copilot/device/poll",
      {
        method: "POST",
        headers: JSONH,
        body: JSON.stringify({ sessionId: "s2" }),
      },
    );
    expect((await res.json()) as { status: string }).toEqual({ status: "done" });
    expect(onOAuthMutation).toHaveBeenCalledOnce();
  });
});

describe("admin OAuth routes — mutations + validation", () => {
  it("PUT models rejects a non-string-array, accepts a valid list (204)", async () => {
    const bad = await app({ oauth: fullSeam() }).request("/admin/api/oauth/anthropic/models", {
      method: "PUT",
      headers: JSONH,
      body: JSON.stringify({ models: [1, 2] }),
    });
    expect(bad.status).toBe(400);
    const seam = fullSeam();
    const ok = await app({ oauth: seam }).request("/admin/api/oauth/anthropic/models", {
      method: "PUT",
      headers: JSONH,
      body: JSON.stringify({ account: "default", models: ["m1"] }),
    });
    expect(ok.status).toBe(204);
    expect(seam.setEnabledModels).toHaveBeenCalledOnce();
  });

  it("PUT proxy clears (null) and sets (valid); a malformed proxy is 400", async () => {
    const seam = fullSeam();
    const cleared = await app({ oauth: seam }).request("/admin/api/oauth/anthropic/proxy", {
      method: "PUT",
      headers: JSONH,
      body: JSON.stringify({ proxy: null }),
    });
    expect(cleared.status).toBe(204);
    const bad = await app({ oauth: fullSeam() }).request("/admin/api/oauth/anthropic/proxy", {
      method: "PUT",
      headers: JSONH,
      body: JSON.stringify({ proxy: { type: "http" } }), // missing host/port
    });
    expect(bad.status).toBe(400);
  });

  it("PUT account validates priority (non-negative int) and schedulable (boolean)", async () => {
    const negPriority = await app({ oauth: fullSeam() }).request(
      "/admin/api/oauth/anthropic/account",
      {
        method: "PUT",
        headers: JSONH,
        body: JSON.stringify({ priority: -1 }),
      },
    );
    expect(negPriority.status).toBe(400);
    const badSched = await app({ oauth: fullSeam() }).request(
      "/admin/api/oauth/anthropic/account",
      {
        method: "PUT",
        headers: JSONH,
        body: JSON.stringify({ schedulable: "yes" }),
      },
    );
    expect(badSched.status).toBe(400);
    const seam = fullSeam();
    const ok = await app({ oauth: seam }).request("/admin/api/oauth/anthropic/account", {
      method: "PUT",
      headers: JSONH,
      body: JSON.stringify({ priority: 10, schedulable: false }),
    });
    expect(ok.status).toBe(204);
    expect(seam.setAccountSchedule).toHaveBeenCalledWith({
      providerId: "anthropic",
      account: "default",
      priority: 10,
      schedulable: false,
    });
  });

  it("DELETE /oauth/:provider logs out the account (204) and rebuilds the pool", async () => {
    const seam = fullSeam();
    const onOAuthMutation = vi.fn(async () => ({ applied: true }));
    const res = await app({ oauth: seam, onOAuthMutation }).request(
      "/admin/api/oauth/anthropic?account=default",
      {
        method: "DELETE",
      },
    );
    expect(res.status).toBe(204);
    expect(seam.logout).toHaveBeenCalledWith({ providerId: "anthropic", account: "default" });
    expect(onOAuthMutation).toHaveBeenCalledOnce();
  });

  it("a seam that throws maps to a 400 with the error message", async () => {
    const seam = fullSeam({
      startManualPaste: vi.fn(async () => {
        throw new Error("provider unsupported");
      }),
    });
    const res = await app({ oauth: seam }).request("/admin/api/oauth/x/manual/start", {
      method: "POST",
      headers: JSONH,
      body: "{}",
    });
    expect(res.status).toBe(400);
    expect((await res.json()) as { error: string }).toMatchObject({
      error: "provider unsupported",
    });
  });
});
