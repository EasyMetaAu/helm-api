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
    listStatus: vi.fn(async () => ({
      selectionStrategy: "balanced",
      providers: [{ id: "anthropic", name: "Anthropic", accounts: [{ account: "default" }] }],
    })),
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
    getAccountSchedule: vi.fn(async () => ({
      priority: 50,
      schedulable: true,
      autoReset: false,
      fastMode: false,
    })),
    setAccountSchedule: vi.fn(async () => {}),
    getSelectionStrategy: vi.fn(async () => ({ selectionStrategy: "balanced" })),
    setSelectionStrategy: vi.fn(async () => {}),
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
    ["GET", "/admin/api/oauth/strategy"],
    ["PUT", "/admin/api/oauth/strategy"],
    ["GET", "/admin/api/oauth/x/account"],
    ["PUT", "/admin/api/oauth/x/account"],
    ["POST", "/admin/api/oauth/openai-codex/reset-credit"],
    ["DELETE", "/admin/api/oauth/x"],
    ["POST", "/admin/api/oauth/x/reset"],
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
      queryRange: vi.fn(async () => [
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

  it("GET /oauth/usage?tzOffsetMinutes rolls up the viewer's LOCAL day window", async () => {
    const DAY = 86_400_000;
    const calls: Array<[number, number]> = [];
    const oauthUsage = {
      queryRange: vi.fn(async (start: number, end: number) => {
        calls.push([start, end]);
        return [];
      }),
    } as unknown as AdminApiDeps["oauthUsage"];
    const now = Date.now();
    await app({ oauth: fullSeam(), oauthUsage }).request(
      "/admin/api/oauth/usage?tzOffsetMinutes=480",
    );
    expect(calls).toHaveLength(1);
    const [start, end] = calls[0] ?? [0, 0];
    const offsetMs = 480 * 60_000; // UTC+8
    expect(end - start).toBe(DAY); // exactly one local day
    expect((start + offsetMs) % DAY).toBe(0); // start floors to LOCAL midnight
    expect(start).toBeLessThanOrEqual(now); // window contains "now"
    expect(end).toBeGreaterThan(now);
  });

  it("GET /oauth/usage fails open to UTC bucketing on a garbage tz offset", async () => {
    const calls: Array<[number, number]> = [];
    const oauthUsage = {
      queryRange: vi.fn(async (start: number, end: number) => {
        calls.push([start, end]);
        return [];
      }),
    } as unknown as AdminApiDeps["oauthUsage"];
    await app({ oauth: fullSeam(), oauthUsage }).request(
      "/admin/api/oauth/usage?tzOffsetMinutes=banana",
    );
    const [start] = calls[0] ?? [0];
    expect((start ?? 0) % 86_400_000).toBe(0); // offset 0 → UTC midnight
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

  it("GET /oauth/quota extends an active cooldown to the saturated window reset", async () => {
    const now = Date.now();
    const shortCooldown = now + 60_000;
    const weeklyReset = now + 8 * 60 * 60_000;
    const saturatedWeekly = {
      key: "7d",
      usedPercent: 100,
      resetsAtMs: weeklyReset,
      windowMinutes: null,
    };
    const applyUsageLimit = vi.fn(async () => {});
    const oauthQuota = {
      get: vi.fn(async () => ({
        providerId: "anthropic",
        account: "default",
        windows: [],
        capturedAt: now,
        source: "anthropic",
        usageLimitedUntilMs: shortCooldown,
      })),
      getAll: vi.fn(async () => [
        {
          providerId: "anthropic",
          account: "default",
          windows: [saturatedWeekly],
          capturedAt: now,
          source: "anthropic",
          usageLimitedUntilMs: shortCooldown,
        },
      ]),
      upsert: vi.fn(async () => {}),
      delete: vi.fn(async () => {}),
    } as unknown as AdminApiDeps["oauthQuota"];
    const seam = fullSeam({
      fetchAnthropicQuota: vi.fn(async () => [saturatedWeekly]) as never,
    });

    const res = await app({ oauth: seam, oauthQuota, applyUsageLimit }).request(
      "/admin/api/oauth/quota",
    );

    expect(res.status).toBe(200);
    expect(applyUsageLimit).toHaveBeenCalledWith("anthropic", "default", weeklyReset, "replace");
  });

  it("GET /oauth/quota clears a global cooldown when only scoped model windows are saturated", async () => {
    const now = Date.now();
    const shortCooldown = now + 60_000;
    const windows = [
      { key: "5h", usedPercent: 0, resetsAtMs: now + 3 * 60 * 60_000, windowMinutes: null },
      { key: "7d", usedPercent: 75, resetsAtMs: now + 2 * 86_400_000, windowMinutes: null },
      {
        key: "7d-fable",
        usedPercent: 100,
        resetsAtMs: now + 2 * 86_400_000,
        windowMinutes: null,
      },
      {
        key: "7d-sonnet",
        usedPercent: 100,
        resetsAtMs: now + 2 * 86_400_000,
        windowMinutes: null,
      },
    ];
    const applyUsageLimit = vi.fn(async () => {});
    const oauthQuota = {
      get: vi.fn(async () => ({
        providerId: "anthropic",
        account: "default",
        windows: [],
        capturedAt: now,
        source: "anthropic",
        usageLimitedUntilMs: shortCooldown,
      })),
      getAll: vi.fn(async () => [
        {
          providerId: "anthropic",
          account: "default",
          windows,
          capturedAt: now,
          source: "anthropic",
          usageLimitedUntilMs: shortCooldown,
        },
      ]),
      upsert: vi.fn(async () => {}),
      delete: vi.fn(async () => {}),
    } as unknown as AdminApiDeps["oauthQuota"];
    const seam = fullSeam({
      fetchAnthropicQuota: vi.fn(async () => windows) as never,
    });

    const res = await app({ oauth: seam, oauthQuota, applyUsageLimit }).request(
      "/admin/api/oauth/quota",
    );

    expect(res.status).toBe(200);
    expect(applyUsageLimit).toHaveBeenCalledWith("anthropic", "default", null, "replace");
  });

  it("GET /oauth/quota extends an active cooldown to a near-full 5h recovery reset", async () => {
    const now = Date.now();
    const shortCooldown = now + 60_000;
    const fiveHourReset = now + 2 * 60 * 60_000 + 57 * 60_000;
    const likelyFiveHourLimit = {
      key: "5h",
      usedPercent: 98,
      resetsAtMs: fiveHourReset,
      windowMinutes: null,
    };
    const applyUsageLimit = vi.fn(async () => {});
    const oauthQuota = {
      get: vi.fn(async () => ({
        providerId: "anthropic",
        account: "default",
        windows: [],
        capturedAt: now,
        source: "anthropic",
        usageLimitedUntilMs: shortCooldown,
      })),
      getAll: vi.fn(async () => [
        {
          providerId: "anthropic",
          account: "default",
          windows: [
            likelyFiveHourLimit,
            { key: "7d", usedPercent: 61, resetsAtMs: now + 5 * 86_400_000, windowMinutes: null },
          ],
          capturedAt: now,
          source: "anthropic",
          usageLimitedUntilMs: shortCooldown,
        },
      ]),
      upsert: vi.fn(async () => {}),
      delete: vi.fn(async () => {}),
    } as unknown as AdminApiDeps["oauthQuota"];
    const seam = fullSeam({
      fetchAnthropicQuota: vi.fn(async () => [
        likelyFiveHourLimit,
        { key: "7d", usedPercent: 61, resetsAtMs: now + 5 * 86_400_000, windowMinutes: null },
      ]) as never,
    });

    const res = await app({ oauth: seam, oauthQuota, applyUsageLimit }).request(
      "/admin/api/oauth/quota",
    );

    expect(res.status).toBe(200);
    expect(applyUsageLimit).toHaveBeenCalledWith("anthropic", "default", fiveHourReset, "replace");
  });

  it("GET /oauth/quota clears an active cooldown when fresh windows show no active limit", async () => {
    const now = Date.now();
    const activeCooldown = now + 4 * 86_400_000;
    const cleanWindows = [
      { key: "5h", usedPercent: 0, resetsAtMs: null, windowMinutes: null },
      { key: "7d", usedPercent: 0, resetsAtMs: null, windowMinutes: null },
    ];
    const applyUsageLimit = vi.fn(async () => {});
    const oauthQuota = {
      get: vi.fn(async () => ({
        providerId: "anthropic",
        account: "default",
        windows: [],
        capturedAt: now,
        source: "anthropic",
        usageLimitedUntilMs: activeCooldown,
      })),
      getAll: vi.fn(async () => [
        {
          providerId: "anthropic",
          account: "default",
          windows: cleanWindows,
          capturedAt: now,
          source: "anthropic",
          usageLimitedUntilMs: activeCooldown,
        },
      ]),
      upsert: vi.fn(async () => {}),
      delete: vi.fn(async () => {}),
    } as unknown as AdminApiDeps["oauthQuota"];
    const seam = fullSeam({
      fetchAnthropicQuota: vi.fn(async () => cleanWindows) as never,
    });

    const res = await app({ oauth: seam, oauthQuota, applyUsageLimit }).request(
      "/admin/api/oauth/quota",
    );

    expect(res.status).toBe(200);
    expect(applyUsageLimit).toHaveBeenCalledWith("anthropic", "default", null, "replace");
  });

  it("GET /oauth/quota replaces a stale long cooldown with the active shorter recovery window", async () => {
    const now = Date.now();
    const staleCooldown = now + 5 * 86_400_000;
    const fiveHourReset = now + 2 * 60 * 60_000;
    const windows = [
      { key: "5h", usedPercent: 98, resetsAtMs: fiveHourReset, windowMinutes: null },
      { key: "7d", usedPercent: 40, resetsAtMs: staleCooldown, windowMinutes: null },
    ];
    const applyUsageLimit = vi.fn(async () => {});
    const oauthQuota = {
      get: vi.fn(async () => ({
        providerId: "anthropic",
        account: "default",
        windows: [],
        capturedAt: now,
        source: "anthropic",
        usageLimitedUntilMs: staleCooldown,
      })),
      getAll: vi.fn(async () => [
        {
          providerId: "anthropic",
          account: "default",
          windows,
          capturedAt: now,
          source: "anthropic",
          usageLimitedUntilMs: staleCooldown,
        },
      ]),
      upsert: vi.fn(async () => {}),
      delete: vi.fn(async () => {}),
    } as unknown as AdminApiDeps["oauthQuota"];
    const seam = fullSeam({
      fetchAnthropicQuota: vi.fn(async () => windows) as never,
    });

    const res = await app({ oauth: seam, oauthQuota, applyUsageLimit }).request(
      "/admin/api/oauth/quota",
    );

    expect(res.status).toBe(200);
    expect(applyUsageLimit).toHaveBeenCalledWith("anthropic", "default", fiveHourReset, "replace");
  });

  it("GET /oauth/quota does not newly park an unparked account from a PULL snapshot", async () => {
    const now = Date.now();
    const saturatedWeekly = {
      key: "7d",
      usedPercent: 100,
      resetsAtMs: now + 8 * 60 * 60_000,
      windowMinutes: null,
    };
    const applyUsageLimit = vi.fn(async () => {});
    const oauthQuota = {
      get: vi.fn(async () => ({
        providerId: "anthropic",
        account: "default",
        windows: [],
        capturedAt: now,
        source: "anthropic",
        usageLimitedUntilMs: null,
      })),
      getAll: vi.fn(async () => [
        {
          providerId: "anthropic",
          account: "default",
          windows: [saturatedWeekly],
          capturedAt: now,
          source: "anthropic",
          usageLimitedUntilMs: null,
        },
      ]),
      upsert: vi.fn(async () => {}),
      delete: vi.fn(async () => {}),
    } as unknown as AdminApiDeps["oauthQuota"];
    const seam = fullSeam({
      fetchAnthropicQuota: vi.fn(async () => [saturatedWeekly]) as never,
    });

    const res = await app({ oauth: seam, oauthQuota, applyUsageLimit }).request(
      "/admin/api/oauth/quota",
    );

    expect(res.status).toBe(200);
    expect(applyUsageLimit).not.toHaveBeenCalled();
  });

  it("GET /oauth/quota folds the live codex reset-credit count onto its snapshot", async () => {
    const window = { key: "primary", usedPercent: 40, resetsAtMs: null, windowMinutes: 300 };
    const oauthQuota = {
      getAll: vi.fn(async () => [
        {
          providerId: "openai-codex",
          account: "default",
          windows: [window],
          capturedAt: 1,
          source: "codex",
        },
      ]),
      upsert: vi.fn(async () => {}),
      delete: vi.fn(async () => {}),
    } as unknown as AdminApiDeps["oauthQuota"];
    const seam = fullSeam({
      listStatus: vi.fn(async () => ({
        selectionStrategy: "balanced",
        providers: [{ id: "openai-codex", name: "Codex", accounts: [{ account: "default" }] }],
      })) as never,
      fetchCodexQuota: vi.fn(async () => ({ windows: [window], resetCredits: 3 })) as never,
    });
    const res = await app({ oauth: seam, oauthQuota }).request("/admin/api/oauth/quota");
    const body = (await res.json()) as {
      quota: Array<{ providerId: string; resetCredits?: number }>;
    };
    expect(body.quota).toHaveLength(1);
    expect(body.quota[0]?.resetCredits).toBe(3);
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

describe("admin OAuth routes — reset credit", () => {
  const codexWindows = (weeklyUsedPercent = 90) => [
    {
      key: "secondary",
      usedPercent: weeklyUsedPercent,
      resetsAtMs: Date.now() + 86_400_000,
      windowMinutes: 10_080,
    },
  ];
  const quotaStore = (windows = codexWindows()): AdminApiDeps["oauthQuota"] =>
    ({
      get: vi.fn(async (providerId: string, account: string) => ({
        providerId,
        account,
        windows,
        capturedAt: Date.now(),
        source: "codex",
        usageLimitedUntilMs: null,
      })),
    }) as unknown as AdminApiDeps["oauthQuota"];
  const allowResetCredit = () => ({
    reserve: vi.fn(async () => ({
      ok: true as const,
      sharedKey: "codex:shared-account",
      windowId: "secondary:1",
    })),
  });

  it("503 when the seam lacks consumeCodexResetCredit", async () => {
    const res = await app({ oauth: fullSeam() }).request(
      "/admin/api/oauth/openai-codex/reset-credit",
      { method: "POST", headers: JSONH, body: "{}" },
    );
    expect(res.status).toBe(503);
  });

  it("400 for a non-codex provider", async () => {
    const seam = fullSeam({
      consumeCodexResetCredit: vi.fn(async () => ({ code: "ok", windowsReset: 1 })) as never,
    });
    const res = await app({ oauth: seam }).request("/admin/api/oauth/anthropic/reset-credit", {
      method: "POST",
      headers: JSONH,
      body: "{}",
    });
    expect(res.status).toBe(400);
  });

  it("409 when no Codex quota snapshot is available", async () => {
    const consume = vi.fn(async () => ({ code: "ok", windowsReset: 2 }));
    const guard = allowResetCredit();
    const seam = fullSeam({ consumeCodexResetCredit: consume as never });
    const res = await app({ oauth: seam, resetCreditGuard: guard }).request(
      "/admin/api/oauth/openai-codex/reset-credit",
      {
        method: "POST",
        headers: JSONH,
        body: "{}",
      },
    );
    expect(res.status).toBe(409);
    expect((await res.json()) as { code: string }).toMatchObject({ code: "quota_unavailable" });
    expect(guard.reserve).not.toHaveBeenCalled();
    expect(consume).not.toHaveBeenCalled();
  });

  it("409 blocks reset-credit consumption when weekly usage is below 90%", async () => {
    const consume = vi.fn(async () => ({ code: "ok", windowsReset: 2 }));
    const guard = allowResetCredit();
    const seam = fullSeam({ consumeCodexResetCredit: consume as never });
    const res = await app({
      oauth: seam,
      oauthQuota: quotaStore(codexWindows(89)),
      resetCreditGuard: guard,
    }).request("/admin/api/oauth/openai-codex/reset-credit", {
      method: "POST",
      headers: JSONH,
      body: "{}",
    });
    expect(res.status).toBe(409);
    expect((await res.json()) as { code: string; minWeeklyUsedPercent: number }).toMatchObject({
      code: "weekly_usage_below_reset_threshold",
      minWeeklyUsedPercent: 90,
    });
    expect(guard.reserve).not.toHaveBeenCalled();
    expect(consume).not.toHaveBeenCalled();
  });

  it("429 blocks reset-credit consumption when the one-hour guard is active", async () => {
    const consume = vi.fn(async () => ({ code: "ok", windowsReset: 2 }));
    const guard = {
      reserve: vi.fn(async () => ({
        ok: false as const,
        status: 429 as const,
        code: "reset_credit_cooldown_active",
        error: "cooldown",
        retryAfterMs: 60_000,
      })),
    };
    const seam = fullSeam({ consumeCodexResetCredit: consume as never });
    const res = await app({
      oauth: seam,
      oauthQuota: quotaStore(),
      resetCreditGuard: guard,
    }).request("/admin/api/oauth/openai-codex/reset-credit", {
      method: "POST",
      headers: JSONH,
      body: "{}",
    });
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("60");
    expect(consume).not.toHaveBeenCalled();
  });

  it("200 consumes a credit only after quota + guard allow it (defaults the account)", async () => {
    const consume = vi.fn(async () => ({ code: "ok", windowsReset: 2 }));
    const guard = allowResetCredit();
    const seam = fullSeam({ consumeCodexResetCredit: consume as never });
    const res = await app({
      oauth: seam,
      oauthQuota: quotaStore(),
      resetCreditGuard: guard,
    }).request("/admin/api/oauth/openai-codex/reset-credit", {
      method: "POST",
      headers: JSONH,
      body: "{}",
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ code: "ok", windowsReset: 2 });
    expect(guard.reserve).toHaveBeenCalledWith({
      providerId: "openai-codex",
      account: "default",
      windows: expect.arrayContaining([
        expect.objectContaining({ key: "secondary", usedPercent: 90 }),
      ]),
      mode: "manual",
    });
    expect(consume).toHaveBeenCalledWith({ account: "default" });
  });

  it("passes an explicit account through to the seam", async () => {
    const consume = vi.fn(async () => ({ code: "ok", windowsReset: 1 }));
    const guard = allowResetCredit();
    const seam = fullSeam({ consumeCodexResetCredit: consume as never });
    await app({ oauth: seam, oauthQuota: quotaStore(), resetCreditGuard: guard }).request(
      "/admin/api/oauth/openai-codex/reset-credit",
      {
        method: "POST",
        headers: JSONH,
        body: JSON.stringify({ account: "work" }),
      },
    );
    expect(guard.reserve).toHaveBeenCalledWith(
      expect.objectContaining({ providerId: "openai-codex", account: "work", mode: "manual" }),
    );
    expect(consume).toHaveBeenCalledWith({ account: "work" });
  });

  it("502 when the seam throws (fail-closed upstream error)", async () => {
    const guard = allowResetCredit();
    const seam = fullSeam({
      consumeCodexResetCredit: vi.fn(async () => {
        throw new Error("no credits");
      }) as never,
    });
    const res = await app({
      oauth: seam,
      oauthQuota: quotaStore(),
      resetCreditGuard: guard,
    }).request("/admin/api/oauth/openai-codex/reset-credit", {
      method: "POST",
      headers: JSONH,
      body: "{}",
    });
    expect(res.status).toBe(502);
    expect(((await res.json()) as { error: string }).error).toContain("no credits");
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

  it("PUT account validates priority (non-negative int), schedulable + autoReset + fastMode (boolean)", async () => {
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
    const badAutoReset = await app({ oauth: fullSeam() }).request(
      "/admin/api/oauth/openai-codex/account",
      {
        method: "PUT",
        headers: JSONH,
        body: JSON.stringify({ autoReset: "yes" }),
      },
    );
    expect(badAutoReset.status).toBe(400);
    const badFastMode = await app({ oauth: fullSeam() }).request(
      "/admin/api/oauth/openai-codex/account",
      {
        method: "PUT",
        headers: JSONH,
        body: JSON.stringify({ fastMode: "yes" }),
      },
    );
    expect(badFastMode.status).toBe(400);
    const seam = fullSeam();
    const ok = await app({ oauth: seam }).request("/admin/api/oauth/openai-codex/account", {
      method: "PUT",
      headers: JSONH,
      body: JSON.stringify({ priority: 10, schedulable: false, autoReset: true, fastMode: true }),
    });
    expect(ok.status).toBe(204);
    expect(seam.setAccountSchedule).toHaveBeenCalledWith({
      providerId: "openai-codex",
      account: "default",
      priority: 10,
      schedulable: false,
      autoReset: true,
      fastMode: true,
    });
  });

  it("GET/PUT global strategy validates selectable account-pool strategies", async () => {
    const seam = fullSeam();
    const got = await app({ oauth: seam }).request("/admin/api/oauth/strategy");
    expect(got.status).toBe(200);
    expect(await got.json()).toEqual({ selectionStrategy: "balanced" });

    const bad = await app({ oauth: fullSeam() }).request("/admin/api/oauth/strategy", {
      method: "PUT",
      headers: JSONH,
      body: JSON.stringify({ selectionStrategy: "random" }),
    });
    expect(bad.status).toBe(400);

    const ok = await app({ oauth: seam }).request("/admin/api/oauth/strategy", {
      method: "PUT",
      headers: JSONH,
      body: JSON.stringify({ selectionStrategy: "use_expiring" }),
    });
    expect(ok.status).toBe(204);
    expect(seam.setSelectionStrategy).toHaveBeenCalledWith({ selectionStrategy: "use_expiring" });
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

describe("admin OAuth routes — POST /oauth/:provider/reset (Reset usage)", () => {
  it("503 when no applyUsageLimit is wired", async () => {
    const res = await app({ oauth: fullSeam() }).request("/admin/api/oauth/openai-codex/reset", {
      method: "POST",
    });
    expect(res.status).toBe(503);
  });

  it("503 (no mutation) when OAuth is disabled even though applyUsageLimit is wired", async () => {
    // buildServer always passes applyUsageLimit, so the SEAM is the real gate: a
    // disabled deployment (no oauth seam) must 503, never write a synthetic quota row.
    const applyUsageLimit = vi.fn(async () => {});
    const res = await app({ applyUsageLimit }).request("/admin/api/oauth/openai-codex/reset", {
      method: "POST",
    });
    expect(res.status).toBe(503);
    expect(applyUsageLimit).not.toHaveBeenCalled();
  });

  it("204 and clears the cooldown (untilMs null) for the default account", async () => {
    const applyUsageLimit = vi.fn(async () => {});
    const res = await app({ oauth: fullSeam(), applyUsageLimit }).request(
      "/admin/api/oauth/openai-codex/reset",
      { method: "POST" },
    );
    expect(res.status).toBe(204);
    expect(applyUsageLimit).toHaveBeenCalledWith("openai-codex", "default", null);
  });

  it("rejects Anthropic reset because Claude usage windows are not resettable", async () => {
    const applyUsageLimit = vi.fn(async () => {});
    const seam = fullSeam();
    const res = await app({ oauth: seam, applyUsageLimit }).request(
      "/admin/api/oauth/anthropic/reset?account=work",
      { method: "POST" },
    );
    expect(res.status).toBe(400);
    expect((await res.json()) as { error: string }).toMatchObject({
      error: "usage reset is only supported for openai-codex",
    });
    expect(applyUsageLimit).not.toHaveBeenCalled();
    expect(
      (seam as unknown as { setAccountSchedule: ReturnType<typeof vi.fn> }).setAccountSchedule,
    ).not.toHaveBeenCalled();
  });

  it("400 when applyUsageLimit throws", async () => {
    const applyUsageLimit = vi.fn(async () => {
      throw new Error("boom");
    });
    const res = await app({ oauth: fullSeam(), applyUsageLimit }).request(
      "/admin/api/oauth/openai-codex/reset",
      { method: "POST" },
    );
    expect(res.status).toBe(400);
    expect((await res.json()) as { error: string }).toMatchObject({ error: "boom" });
  });
});
