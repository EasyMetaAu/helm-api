import type { OAuthQuotaWindow } from "@helm/shared";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import type { AppEnv } from "../../app.js";
import { createTrackedBackgroundTasks } from "../../runtime/maintenance-gate.js";
import type { AdminApiDeps, OAuthAdminAccess } from "./deps.js";
import { registerOAuthRoutes } from "./oauth.js";

// A complete OAuthAdminAccess seam with vi.fn methods (overridable per test). The
// routes are thin validating wrappers around this seam, so exercising them with a
// mock seam covers the route logic (validation, error mapping, afterMutation).
function fullSeam(over: Partial<OAuthAdminAccess> = {}): OAuthAdminAccess {
  const listStatus =
    over.listStatus ??
    vi.fn(async () => ({
      selectionStrategy: "balanced" as const,
      providers: [{ id: "anthropic", name: "Anthropic", accounts: [{ account: "default" }] }],
    }));
  return {
    listCachedStatus: over.listCachedStatus ?? listStatus,
    listStatus,
    startManualPaste: vi.fn(async () => ({ sessionId: "s1", authorizeUrl: "https://auth" })),
    completeManualPaste: vi.fn(async () => {}),
    startDeviceCode: vi.fn(async () => ({
      sessionId: "s2",
      userCode: "ABCD",
      verificationUri: "https://v",
      intervalMs: 5_000,
      expiresAt: 601_000,
      serverNowMs: 1_000,
    })),
    pollDeviceCode: vi.fn(async () => ({ status: "pending" as const })),
    logout: vi.fn(async () => {}),
    listModels: vi.fn(async () => ({
      available: ["m1", "m2"],
      enabled: ["m1"],
      modelsMode: "manual" as const,
      canPull: true,
    })),
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

async function enqueueRefresh(
  api: ReturnType<typeof app>,
  expectedState: "succeeded" | "failed" = "succeeded",
): Promise<void> {
  const accepted = await api.request("/admin/api/oauth/refresh", { method: "POST" });
  expect(accepted.status).toBe(202);
  await vi.waitFor(async () => {
    const overview = await api.request("/admin/api/oauth/overview");
    const body = (await overview.json()) as { refresh: { state: string } };
    expect(body.refresh.state).toBe(expectedState);
  });
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

  it("GET /oauth/usage/periods requires provider+account, else 400", async () => {
    const res = await app({ oauth: fullSeam() }).request("/admin/api/oauth/usage/periods");
    expect(res.status).toBe(400);
    const res2 = await app({ oauth: fullSeam() }).request(
      "/admin/api/oauth/usage/periods?provider=anthropic",
    );
    expect(res2.status).toBe(400);
  });

  it("GET /oauth/usage/periods reconstructs per-reset-period totals from buckets + quota", async () => {
    const HOUR = 3_600_000;
    // A 5h Anthropic window (windowMinutes null → inferred 300). resetsAtMs is a real
    // upstream value slightly in the FUTURE, so the current period [reset-5h, reset)
    // straddles now; buckets fill the current + one prior 5h period (all in the past).
    const reset = Date.now() + HOUR; // resets ~1h from now
    const buckets = Array.from({ length: 10 }, (_, i) => ({
      bucketMs: reset - (10 - i) * HOUR, // [reset-10h, reset)
      requests: 1,
      tokens: 100,
      costUsd: null,
    }));
    const oauthUsage = {
      queryBuckets: vi.fn(async () => buckets),
    } as unknown as AdminApiDeps["oauthUsage"];
    const oauthQuota = {
      get: vi.fn(async () => ({
        providerId: "anthropic",
        account: "a@x.com",
        windows: [{ key: "5h", usedPercent: 50, resetsAtMs: reset, windowMinutes: null }],
        capturedAt: 0,
        source: "anthropic",
        usageLimitedUntilMs: null,
        resetCredits: null,
      })),
    } as unknown as AdminApiDeps["oauthQuota"];
    const settings = {
      get: () => ({ oauth_usage_retention_days: 180 }),
    } as unknown as AdminApiDeps["settings"];
    const res = await app({ oauth: fullSeam(), oauthUsage, oauthQuota, settings }).request(
      "/admin/api/oauth/usage/periods?provider=anthropic&account=a%40x.com&limit=3",
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      current: Array<{ windowKey: string; tokens: number; approximate: boolean }>;
      periods: Array<{ tokens: number; approximate: boolean }>;
    };
    // current period exists for the 5h window (a real, non-hour-aligned resetsAtMs →
    // hour-bucket quantization makes it approximate; token total is still present).
    expect(body.current).toHaveLength(1);
    expect(body.current[0]?.windowKey).toBe("5h");
    expect(body.current[0]?.tokens ?? 0).toBeGreaterThan(0);
    // history periods are approximate (rolled-back boundaries) and carry token totals.
    expect(body.periods.length).toBeGreaterThanOrEqual(1);
    const firstHistory = body.periods[0];
    expect(firstHistory).toMatchObject({ approximate: true });
    expect(firstHistory?.tokens ?? 0).toBeGreaterThan(0);
    // token conservation: current + history covers the 10 seeded buckets (1000 tokens),
    // minus at most the boundary bucket that falls outside the rolled-back span.
    const total = (body.current[0]?.tokens ?? 0) + body.periods.reduce((s, p) => s + p.tokens, 0);
    expect(total).toBeGreaterThanOrEqual(900);
    expect(total).toBeLessThanOrEqual(1000);
  });

  it("GET /oauth/usage/periods fails open to empty when the quota snapshot is missing", async () => {
    const oauthUsage = {
      queryBuckets: vi.fn(async () => []),
    } as unknown as AdminApiDeps["oauthUsage"];
    const oauthQuota = { get: vi.fn(async () => null) } as unknown as AdminApiDeps["oauthQuota"];
    const settings = {
      get: () => ({ oauth_usage_retention_days: 180 }),
    } as unknown as AdminApiDeps["settings"];
    const res = await app({ oauth: fullSeam(), oauthUsage, oauthQuota, settings }).request(
      "/admin/api/oauth/usage/periods?provider=xai&account=nobody",
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ current: [], periods: [] });
  });

  it("GET /oauth/quota returns cached rows without pulling upstream", async () => {
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
    const onCodexQuotaSaturated = vi.fn(async () => false);
    const api = app({ oauth: seam, oauthQuota, onCodexQuotaSaturated });
    const res = await api.request("/admin/api/oauth/quota");
    expect(res.status).toBe(200);
    expect(upsert).not.toHaveBeenCalled();
    expect(seam.fetchAnthropicQuota).not.toHaveBeenCalled();
    expect((await api.request("/admin/api/oauth/overview")).status).toBe(200);
    expect(onCodexQuotaSaturated).not.toHaveBeenCalled();
  });

  it("GET /oauth/quota hides persisted Codex header placeholders", async () => {
    const capturedAt = 1_000_000;
    const oauthQuota = {
      getAll: vi.fn(async () => [
        {
          providerId: "openai-codex",
          account: "default",
          windows: [
            {
              key: "primary",
              usedPercent: 37,
              resetsAtMs: capturedAt + 500_000,
              windowMinutes: 10_080,
            },
            {
              key: "secondary",
              usedPercent: 0,
              resetsAtMs: capturedAt,
              windowMinutes: null,
            },
          ],
          capturedAt,
          source: "codex-headers",
          usageLimitedUntilMs: null,
        },
      ]),
    } as unknown as AdminApiDeps["oauthQuota"];
    const seam = fullSeam({
      listCachedStatus: vi.fn(async () => ({
        selectionStrategy: "balanced",
        providers: [
          {
            id: "openai-codex",
            name: "Codex",
            accounts: [{ account: "default" }],
          },
        ],
      })) as never,
    });

    const res = await app({ oauth: seam, oauthQuota }).request("/admin/api/oauth/quota");
    const body = (await res.json()) as { quota: Array<{ windows: OAuthQuotaWindow[] }> };
    expect(body.quota[0]?.windows).toEqual([
      {
        key: "primary",
        usedPercent: 37,
        resetsAtMs: capturedAt + 500_000,
        windowMinutes: 10_080,
      },
    ]);
  });

  it("POST /oauth/refresh refreshes xAI, updates the pool snapshot, and syncs cooldown", async () => {
    const now = Date.now();
    const resetAt = now + 3 * 86_400_000;
    const windows: OAuthQuotaWindow[] = [
      { key: "7d", usedPercent: 100, resetsAtMs: resetAt, windowMinutes: 10_080 },
    ];
    const rows: Array<Record<string, unknown>> = [];
    const oauthQuota = {
      get: vi.fn(async () => null),
      getAll: vi.fn(async () => rows),
      upsert: vi.fn(async (snapshot: Record<string, unknown>) => {
        rows.splice(0, rows.length, { ...snapshot, usageLimitedUntilMs: null });
      }),
      delete: vi.fn(async () => {}),
    } as unknown as AdminApiDeps["oauthQuota"];
    const fetchXaiQuota = vi.fn(async () => windows);
    const seam = fullSeam({
      listStatus: vi.fn(async () => ({
        selectionStrategy: "balanced",
        providers: [
          {
            id: "xai",
            name: "Grok",
            accounts: [{ account: "subscription" }],
          },
        ],
      })) as never,
      fetchXaiQuota,
    });
    const applyQuotaSnapshot = vi.fn();
    const applyUsageLimit = vi.fn(async () => {});

    const api = app({
      oauth: seam,
      oauthQuota,
      applyQuotaSnapshot,
      applyUsageLimit,
    });
    await enqueueRefresh(api);
    const res = await api.request("/admin/api/oauth/quota");

    expect(res.status).toBe(200);
    expect(fetchXaiQuota).toHaveBeenCalledWith({ account: "subscription", force: true });
    expect(oauthQuota?.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        providerId: "xai",
        account: "subscription",
        windows,
        source: "xai",
      }),
    );
    expect(applyQuotaSnapshot).toHaveBeenCalledWith(
      "xai",
      "subscription",
      windows,
      expect.any(Number),
    );
    expect(applyUsageLimit).toHaveBeenCalledWith("xai", "subscription", resetAt, "extend");
    expect(await res.json()).toEqual({
      quota: [
        expect.objectContaining({
          providerId: "xai",
          account: "subscription",
          windows,
          source: "xai",
        }),
      ],
    });
  });

  it("POST /oauth/refresh records a reset-period boundary when resetsAtMs advances", async () => {
    const now = Date.now();
    const oldReset = now - 86_400_000; // yesterday
    const newReset = now + 6 * 86_400_000; // next week
    const newWindows: OAuthQuotaWindow[] = [
      { key: "7d", usedPercent: 4, resetsAtMs: newReset, windowMinutes: 10_080 },
    ];
    // Prior snapshot carries the OLD resetsAtMs for the same key → advance detected.
    const oauthQuota = {
      get: vi.fn(async () => ({
        providerId: "xai",
        account: "subscription",
        windows: [{ key: "7d", usedPercent: 96, resetsAtMs: oldReset, windowMinutes: 10_080 }],
        capturedAt: oldReset,
        source: "xai",
        usageLimitedUntilMs: null,
        resetCredits: null,
      })),
      getAll: vi.fn(async () => []),
      upsert: vi.fn(async () => {}),
      delete: vi.fn(async () => {}),
    } as unknown as AdminApiDeps["oauthQuota"];
    const oauthResetPeriod = {
      record: vi.fn(async () => {}),
    } as unknown as AdminApiDeps["oauthResetPeriod"];
    const seam = fullSeam({
      listStatus: vi.fn(async () => ({
        selectionStrategy: "balanced",
        providers: [{ id: "xai", name: "Grok", accounts: [{ account: "subscription" }] }],
      })) as never,
      fetchXaiQuota: vi.fn(async () => newWindows),
    });
    const api = app({ oauth: seam, oauthQuota, oauthResetPeriod, applyQuotaSnapshot: vi.fn() });
    await enqueueRefresh(api);

    expect(oauthResetPeriod?.record).toHaveBeenCalledWith(
      expect.objectContaining({
        providerId: "xai",
        account: "subscription",
        windowKey: "7d",
        periodStartMs: oldReset,
        periodEndMs: newReset,
      }),
    );
  });

  it("POST /oauth/refresh does NOT record a boundary when resetsAtMs is unchanged", async () => {
    const reset = Date.now() + 6 * 86_400_000;
    const windows: OAuthQuotaWindow[] = [
      { key: "7d", usedPercent: 5, resetsAtMs: reset, windowMinutes: 10_080 },
    ];
    const oauthQuota = {
      // Prior snapshot has the SAME resetsAtMs → no advance, no record.
      get: vi.fn(async () => ({
        providerId: "xai",
        account: "subscription",
        windows,
        capturedAt: reset - 1000,
        source: "xai",
        usageLimitedUntilMs: null,
        resetCredits: null,
      })),
      getAll: vi.fn(async () => []),
      upsert: vi.fn(async () => {}),
      delete: vi.fn(async () => {}),
    } as unknown as AdminApiDeps["oauthQuota"];
    const oauthResetPeriod = {
      record: vi.fn(async () => {}),
    } as unknown as AdminApiDeps["oauthResetPeriod"];
    const seam = fullSeam({
      listStatus: vi.fn(async () => ({
        selectionStrategy: "balanced",
        providers: [{ id: "xai", name: "Grok", accounts: [{ account: "subscription" }] }],
      })) as never,
      fetchXaiQuota: vi.fn(async () => windows),
    });
    const api = app({ oauth: seam, oauthQuota, oauthResetPeriod, applyQuotaSnapshot: vi.fn() });
    await enqueueRefresh(api);

    expect(oauthResetPeriod?.record).not.toHaveBeenCalled();
  });

  it("POST /oauth/refresh does NOT record a MULTI-window jump (refresh lagged 2+ windows)", async () => {
    const now = Date.now();
    const oldReset = now - 10 * 86_400_000; // 10 days ago
    const newReset = now + 4 * 86_400_000; // → jump is 14 days = TWO 7d windows
    const windows: OAuthQuotaWindow[] = [
      { key: "7d", usedPercent: 3, resetsAtMs: newReset, windowMinutes: 10_080 },
    ];
    const oauthQuota = {
      get: vi.fn(async () => ({
        providerId: "xai",
        account: "subscription",
        windows: [{ key: "7d", usedPercent: 99, resetsAtMs: oldReset, windowMinutes: 10_080 }],
        capturedAt: oldReset,
        source: "xai",
        usageLimitedUntilMs: null,
        resetCredits: null,
      })),
      getAll: vi.fn(async () => []),
      upsert: vi.fn(async () => {}),
      delete: vi.fn(async () => {}),
    } as unknown as AdminApiDeps["oauthQuota"];
    const oauthResetPeriod = {
      record: vi.fn(async () => {}),
    } as unknown as AdminApiDeps["oauthResetPeriod"];
    const seam = fullSeam({
      listStatus: vi.fn(async () => ({
        selectionStrategy: "balanced",
        providers: [{ id: "xai", name: "Grok", accounts: [{ account: "subscription" }] }],
      })) as never,
      fetchXaiQuota: vi.fn(async () => windows),
    });
    const api = app({ oauth: seam, oauthQuota, oauthResetPeriod, applyQuotaSnapshot: vi.fn() });
    await enqueueRefresh(api);
    // A 14-day jump spans two real 7d periods → recording it as one exact period would
    // fake a huge allowance; it is skipped and stays on the approximate path.
    expect(oauthResetPeriod?.record).not.toHaveBeenCalled();
  });

  it("POST /oauth/refresh reports xAI failure and still refreshes peers and prunes orphans", async () => {
    const anthropicWindows: OAuthQuotaWindow[] = [
      { key: "5h", usedPercent: 10, resetsAtMs: null, windowMinutes: 300 },
    ];
    const oauthQuota = {
      get: vi.fn(async () => null),
      getAll: vi.fn(async () => [
        {
          providerId: "xai",
          account: "subscription",
          windows: [],
          capturedAt: 1,
          source: "xai",
        },
        {
          providerId: "xai",
          account: "orphan",
          windows: [],
          capturedAt: 1,
          source: "xai",
        },
      ]),
      upsert: vi.fn(async () => {}),
      delete: vi.fn(async () => {}),
    } as unknown as AdminApiDeps["oauthQuota"];
    const seam = fullSeam({
      listStatus: vi.fn(async () => ({
        selectionStrategy: "balanced",
        providers: [
          {
            id: "anthropic",
            name: "Anthropic",
            accounts: [{ account: "default" }],
          },
          {
            id: "xai",
            name: "Grok",
            accounts: [{ account: "subscription" }],
          },
        ],
      })) as never,
      fetchAnthropicQuota: vi.fn(async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        return anthropicWindows;
      }) as never,
      fetchXaiQuota: vi.fn(async () => {
        throw new Error("upstream unavailable");
      }),
    });

    const api = app({ oauth: seam, oauthQuota });
    await enqueueRefresh(api, "failed");
    const res = await api.request("/admin/api/oauth/quota");

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      quota: [expect.objectContaining({ providerId: "xai", account: "subscription" })],
    });
    expect(oauthQuota?.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ providerId: "anthropic", account: "default" }),
    );
    expect(oauthQuota?.upsert).not.toHaveBeenCalledWith(
      expect.objectContaining({ providerId: "xai" }),
    );
    expect(oauthQuota?.delete).toHaveBeenCalledWith("xai", "orphan");
  });

  it("POST /oauth/refresh extends an active cooldown to the saturated window reset", async () => {
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

    const api = app({ oauth: seam, oauthQuota, applyUsageLimit });
    await enqueueRefresh(api);
    const res = await api.request("/admin/api/oauth/quota");

    expect(res.status).toBe(200);
    expect(applyUsageLimit).toHaveBeenCalledWith("anthropic", "default", weeklyReset, "replace");
  });

  it("POST /oauth/refresh clears a global cooldown when only scoped windows are saturated", async () => {
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

    const api = app({ oauth: seam, oauthQuota, applyUsageLimit });
    await enqueueRefresh(api);
    const res = await api.request("/admin/api/oauth/quota");

    expect(res.status).toBe(200);
    expect(applyUsageLimit).toHaveBeenCalledWith("anthropic", "default", null, "replace");
  });

  it("POST /oauth/refresh extends an active cooldown to a near-full 5h recovery reset", async () => {
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

    const api = app({ oauth: seam, oauthQuota, applyUsageLimit });
    await enqueueRefresh(api);
    const res = await api.request("/admin/api/oauth/quota");

    expect(res.status).toBe(200);
    expect(applyUsageLimit).toHaveBeenCalledWith("anthropic", "default", fiveHourReset, "replace");
  });

  it("POST /oauth/refresh clears an active cooldown when fresh windows show no active limit", async () => {
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

    const api = app({ oauth: seam, oauthQuota, applyUsageLimit });
    await enqueueRefresh(api);
    const res = await api.request("/admin/api/oauth/quota");

    expect(res.status).toBe(200);
    expect(applyUsageLimit).toHaveBeenCalledWith("anthropic", "default", null, "replace");
  });

  it("POST /oauth/refresh replaces a stale cooldown with the active recovery window", async () => {
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

    const api = app({ oauth: seam, oauthQuota, applyUsageLimit });
    await enqueueRefresh(api);
    const res = await api.request("/admin/api/oauth/quota");

    expect(res.status).toBe(200);
    expect(applyUsageLimit).toHaveBeenCalledWith("anthropic", "default", fiveHourReset, "replace");
  });

  it("POST /oauth/refresh parks an unparked account from a saturated account-wide snapshot", async () => {
    const now = Date.now();
    const saturatedWeekly = {
      key: "primary",
      usedPercent: 100,
      resetsAtMs: now + 8 * 60 * 60_000,
      windowMinutes: 10_080,
    };
    const order: string[] = [];
    const applyUsageLimit = vi.fn(async () => {
      order.push("park");
    });
    const onCodexQuotaSaturated = vi.fn(async () => {
      order.push("reset");
      return false;
    });
    const oauthQuota = {
      get: vi.fn(async () => ({
        providerId: "openai-codex",
        account: "default",
        windows: [],
        capturedAt: now,
        source: "codex",
        usageLimitedUntilMs: null,
      })),
      getAll: vi.fn(async () => [
        {
          providerId: "openai-codex",
          account: "default",
          windows: [saturatedWeekly],
          capturedAt: now,
          source: "codex",
          usageLimitedUntilMs: null,
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
      fetchCodexQuota: vi.fn(async () => ({
        windows: [saturatedWeekly],
        resetCredits: 0,
        rateLimitReachedType: "rate_limit_reached",
      })) as never,
    });

    const api = app({ oauth: seam, oauthQuota, applyUsageLimit, onCodexQuotaSaturated });
    await enqueueRefresh(api);
    const res = await api.request("/admin/api/oauth/quota");

    expect(res.status).toBe(200);
    expect(applyUsageLimit).toHaveBeenCalledWith(
      "openai-codex",
      "default",
      saturatedWeekly.resetsAtMs,
      "extend",
    );
    expect(onCodexQuotaSaturated).toHaveBeenCalledWith(
      "openai-codex",
      "default",
      [saturatedWeekly],
      expect.any(Number),
      "rate_limit_reached",
    );
    expect(order).toEqual(["park", "reset"]);
  });

  it("re-pulls and publishes fresh quota after auto-reset consumes a credit", async () => {
    const now = Date.now();
    const saturatedWeekly = {
      key: "primary",
      usedPercent: 100,
      resetsAtMs: now + 8 * 60 * 60_000,
      windowMinutes: 10_080,
    };
    const refreshedWeekly = {
      ...saturatedWeekly,
      usedPercent: 1,
      resetsAtMs: now + 7 * 86_400_000,
    };
    let row: Record<string, unknown> | null = null;
    const oauthQuota = {
      get: vi.fn(async () => row),
      getAll: vi.fn(async () => (row ? [row] : [])),
      upsert: vi.fn(async (snapshot: Record<string, unknown>) => {
        row = { ...snapshot, usageLimitedUntilMs: row?.usageLimitedUntilMs ?? null };
      }),
      delete: vi.fn(async () => {}),
    } as unknown as AdminApiDeps["oauthQuota"];
    const applyUsageLimit = vi.fn(
      async (_providerId: string, _account: string, until: number | null) => {
        if (row) row = { ...row, usageLimitedUntilMs: until };
      },
    );
    const applyQuotaSnapshot = vi.fn();
    const fetchCodexQuota = vi
      .fn()
      .mockResolvedValueOnce({
        windows: [saturatedWeekly],
        resetCredits: 1,
        rateLimitReachedType: "rate_limit_reached",
      })
      .mockResolvedValueOnce({
        windows: [refreshedWeekly],
        resetCredits: 0,
        rateLimitReachedType: null,
      });
    const seam = fullSeam({
      listStatus: vi.fn(async () => ({
        selectionStrategy: "balanced",
        providers: [{ id: "openai-codex", name: "Codex", accounts: [{ account: "default" }] }],
      })) as never,
      fetchCodexQuota: fetchCodexQuota as never,
    });
    const onCodexQuotaSaturated = vi.fn(async () => true);
    const api = app({
      oauth: seam,
      oauthQuota,
      applyUsageLimit: applyUsageLimit as never,
      applyQuotaSnapshot,
      onCodexQuotaSaturated: onCodexQuotaSaturated as never,
    });

    await enqueueRefresh(api);
    const body = (await (await api.request("/admin/api/oauth/quota")).json()) as {
      quota: Array<{ windows: OAuthQuotaWindow[]; resetCredits: number | null }>;
    };

    expect(fetchCodexQuota).toHaveBeenCalledTimes(2);
    expect(fetchCodexQuota).toHaveBeenNthCalledWith(2, { account: "default", force: true });
    expect(body.quota[0]).toMatchObject({ windows: [refreshedWeekly], resetCredits: 0 });
    expect(applyQuotaSnapshot).toHaveBeenLastCalledWith(
      "openai-codex",
      "default",
      [refreshedWeekly],
      expect.any(Number),
      0,
    );
    expect(applyUsageLimit).toHaveBeenLastCalledWith("openai-codex", "default", null, "replace");
  });

  it("waits for one shared-account reset before pulling the sibling label", async () => {
    const now = Date.now();
    const saturatedWeekly = {
      key: "primary",
      usedPercent: 100,
      resetsAtMs: now + 8 * 60 * 60_000,
      windowMinutes: 10_080,
    };
    let releaseFirstReset!: () => void;
    const firstReset = new Promise<void>((resolve) => {
      releaseFirstReset = resolve;
    });
    const fetchCodexQuota = vi.fn(async () => ({
      windows: [saturatedWeekly],
      resetCredits: 1,
      rateLimitReachedType: "rate_limit_reached" as const,
    }));
    const onCodexQuotaSaturated = vi.fn(async (_providerId: string, account: string) => {
      if (account === "label-a") await firstReset;
      return false;
    });
    const oauthQuota = {
      get: vi.fn(async () => null),
      getAll: vi.fn(async () => []),
      upsert: vi.fn(async () => {}),
      delete: vi.fn(async () => {}),
    } as unknown as AdminApiDeps["oauthQuota"];
    const seam = fullSeam({
      listStatus: vi.fn(async () => ({
        selectionStrategy: "balanced",
        providers: [
          {
            id: "openai-codex",
            name: "Codex",
            accounts: [{ account: "label-a" }, { account: "label-b" }],
          },
        ],
      })) as never,
      fetchCodexQuota: fetchCodexQuota as never,
    });
    const api = app({
      oauth: seam,
      oauthQuota,
      applyUsageLimit: vi.fn(async () => {}),
      onCodexQuotaSaturated,
    });

    expect((await api.request("/admin/api/oauth/refresh", { method: "POST" })).status).toBe(202);
    await vi.waitFor(() => {
      expect(onCodexQuotaSaturated).toHaveBeenCalledWith(
        "openai-codex",
        "label-a",
        [saturatedWeekly],
        expect.any(Number),
        "rate_limit_reached",
      );
    });
    expect(fetchCodexQuota).toHaveBeenCalledTimes(1);
    expect(fetchCodexQuota).toHaveBeenLastCalledWith({ account: "label-a", force: true });

    releaseFirstReset();
    await vi.waitFor(async () => {
      const overview = await api.request("/admin/api/oauth/overview");
      const body = (await overview.json()) as { refresh: { state: string } };
      expect(body.refresh.state).toBe("succeeded");
    });
    expect(fetchCodexQuota).toHaveBeenCalledTimes(2);
    expect(fetchCodexQuota).toHaveBeenLastCalledWith({ account: "label-b", force: true });
  });

  it("POST /oauth/refresh does not park or auto-reset a 99% weekly snapshot", async () => {
    const now = Date.now();
    const nearFullWeekly = {
      key: "primary",
      usedPercent: 99,
      resetsAtMs: now + 2 * 86_400_000,
      windowMinutes: 10_080,
    };
    const applyUsageLimit = vi.fn(async () => {});
    const onCodexQuotaSaturated = vi.fn(async () => false);
    const oauthQuota = {
      get: vi.fn(async () => ({
        providerId: "openai-codex",
        account: "default",
        windows: [],
        capturedAt: now,
        source: "codex",
        usageLimitedUntilMs: null,
      })),
      getAll: vi.fn(async () => [
        {
          providerId: "openai-codex",
          account: "default",
          windows: [nearFullWeekly],
          capturedAt: now,
          source: "codex",
          usageLimitedUntilMs: null,
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
      fetchCodexQuota: vi.fn(async () => ({
        windows: [nearFullWeekly],
        resetCredits: 0,
      })) as never,
    });

    const api = app({ oauth: seam, oauthQuota, applyUsageLimit, onCodexQuotaSaturated });
    await enqueueRefresh(api);
    const res = await api.request("/admin/api/oauth/quota");

    expect(res.status).toBe(200);
    expect(applyUsageLimit).not.toHaveBeenCalled();
    expect(onCodexQuotaSaturated).not.toHaveBeenCalled();
  });

  it("POST /oauth/refresh makes complete Codex metadata available to cached reads", async () => {
    const sparkWindow = {
      key: "codex_spark-primary",
      usedPercent: 40,
      resetsAtMs: null,
      windowMinutes: 30,
      limitId: "codex_spark",
      limitName: "GPT-5.6-Codex-Spark",
    };
    const lunaWindow = {
      key: "codex_luna-primary",
      usedPercent: 30,
      resetsAtMs: null,
      windowMinutes: 300,
      limitId: "codex_luna",
      limitName: "GPT-5.6-Codex-Luna",
    };
    const codexQuota = {
      windows: [sparkWindow, lunaWindow],
      additionalLimits: [],
      resetCredits: 3,
      resetCreditDetails: [
        {
          id: "credit-1",
          resetType: "codexRateLimits",
          status: "available",
          grantedAt: 1,
          expiresAt: 2,
          title: "Full reset",
          description: "Ready",
        },
      ],
      credits: { hasCredits: true, unlimited: false, balance: "9.99" },
      individualLimit: {
        limit: "25000",
        used: "8000",
        remainingPercent: 68,
        resetsAtMs: 1_735_693_200_000,
      },
      planType: "pro",
      rateLimitReachedType: "rate_limit_reached" as const,
    };
    const oauthQuota = {
      getAll: vi.fn(async () => [
        {
          providerId: "openai-codex",
          account: "default",
          windows: [sparkWindow, lunaWindow],
          capturedAt: 1,
          source: "codex",
        },
      ]),
      upsert: vi.fn(async () => {}),
      delete: vi.fn(async () => {}),
    } as unknown as AdminApiDeps["oauthQuota"];
    const upsert = oauthQuota?.upsert as unknown as ReturnType<typeof vi.fn>;
    const seam = fullSeam({
      listStatus: vi.fn(async () => ({
        selectionStrategy: "balanced",
        providers: [
          {
            id: "openai-codex",
            name: "Codex",
            accounts: [
              {
                account: "default",
                email: "codex@example.com",
                chatgptPlanType: "pro",
                chatgptAccountId: "account-1",
                isFedramp: false,
              },
            ],
          },
        ],
      })) as never,
      fetchCodexQuota: vi.fn(async () => codexQuota) as never,
      getCachedCodexQuota: vi.fn(async () => codexQuota) as never,
    });
    const applyQuotaSnapshot = vi.fn();
    const api = app({ oauth: seam, oauthQuota, applyQuotaSnapshot });
    await enqueueRefresh(api);
    const res = await api.request("/admin/api/oauth/quota");
    const body = (await res.json()) as {
      quota: Array<{
        providerId: string;
        windows: Array<{ limitId?: string; limitName?: string | null }>;
        identity?: {
          email?: string;
          chatgptPlanType?: string;
          chatgptAccountId?: string;
          isFedramp?: boolean;
        };
        resetCredits?: number;
        resetCreditDetails?: Array<{ id: string }>;
        credits?: { balance: string | null };
        individualLimit?: { limit: string; used: string; remainingPercent: number };
        planType?: string | null;
        rateLimitReachedType?: string | null;
      }>;
    };
    expect(body.quota).toHaveLength(1);
    expect(body.quota[0]?.identity).toEqual({
      email: "codex@example.com",
      chatgptPlanType: "pro",
      chatgptAccountId: "account-1",
      isFedramp: false,
    });
    expect(body.quota[0]?.resetCredits).toBe(3);
    expect(body.quota[0]?.resetCreditDetails?.[0]?.id).toBe("credit-1");
    expect(body.quota[0]?.credits?.balance).toBe("9.99");
    expect(body.quota[0]?.individualLimit).toMatchObject({
      limit: "25000",
      used: "8000",
      remainingPercent: 68,
    });
    expect(body.quota[0]?.windows).toEqual([
      expect.objectContaining({
        limitId: "codex_luna",
        limitName: "GPT-5.6-Codex-Luna",
      }),
    ]);
    expect(body.quota[0]?.planType).toBe("pro");
    expect(body.quota[0]?.rateLimitReachedType).toBe("rate_limit_reached");
    expect(upsert).toHaveBeenCalledWith(expect.objectContaining({ resetCredits: 3 }));
    expect(applyQuotaSnapshot).toHaveBeenCalledWith(
      "openai-codex",
      "default",
      [lunaWindow],
      expect.any(Number),
      3,
    );
  });

  it("POST /oauth/refresh persists Codex metadata when quota windows are absent", async () => {
    const rows: Array<Record<string, unknown>> = [];
    const codexQuota = {
      windows: [],
      additionalLimits: [
        { limitId: "codex_spark", limitName: "GPT-5.6-Codex-Spark" },
        { limitId: "codex_terra", limitName: "GPT-5.6-Codex-Terra" },
      ],
      resetCredits: 2,
      resetCreditDetails: [],
      credits: { hasCredits: true, unlimited: false, balance: "4.50" },
      individualLimit: {
        limit: "25000",
        used: "8000",
        remainingPercent: 68,
        resetsAtMs: null,
      },
      planType: "pro",
      rateLimitReachedType: null,
    };
    const oauthQuota = {
      getAll: vi.fn(async () => rows),
      upsert: vi.fn(async (snapshot: Record<string, unknown>) => {
        rows.splice(0, rows.length, { ...snapshot, usageLimitedUntilMs: null });
      }),
      delete: vi.fn(async () => {}),
    } as unknown as AdminApiDeps["oauthQuota"];
    const seam = fullSeam({
      listStatus: vi.fn(async () => ({
        selectionStrategy: "balanced",
        providers: [{ id: "openai-codex", name: "Codex", accounts: [{ account: "default" }] }],
      })) as never,
      fetchCodexQuota: vi.fn(async () => codexQuota) as never,
      getCachedCodexQuota: vi.fn(async () => codexQuota) as never,
    });

    const api = app({ oauth: seam, oauthQuota });
    await enqueueRefresh(api);
    const res = await api.request("/admin/api/oauth/quota");
    const body = (await res.json()) as {
      quota: Array<{
        windows: unknown[];
        additionalLimits?: Array<{ limitId: string; limitName: string | null }>;
        resetCredits?: number | null;
        credits?: { balance: string | null };
        individualLimit?: { limit: string };
        planType?: string | null;
      }>;
    };

    expect(oauthQuota?.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        providerId: "openai-codex",
        account: "default",
        windows: [],
        resetCredits: 2,
      }),
    );
    expect(body.quota).toEqual([
      expect.objectContaining({
        windows: [],
        additionalLimits: [{ limitId: "codex_terra", limitName: "GPT-5.6-Codex-Terra" }],
        resetCredits: 2,
        credits: { hasCredits: true, unlimited: false, balance: "4.50" },
        individualLimit: expect.objectContaining({ limit: "25000" }),
        planType: "pro",
      }),
    ]);
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

describe("admin OAuth routes — tracked refresh lifecycle", () => {
  it("returns 202 while maintenance still waits for the refresh database work", async () => {
    const background = createTrackedBackgroundTasks();
    let releaseStatus!: () => void;
    const statusGate = new Promise<void>((resolve) => {
      releaseStatus = resolve;
    });
    const seam = fullSeam({
      listStatus: vi.fn(async () => {
        await statusGate;
        return { selectionStrategy: "balanced", providers: [] };
      }) as never,
    });
    const oauthQuota = {
      get: vi.fn(async () => null),
      getAll: vi.fn(async () => []),
      upsert: vi.fn(async () => {}),
      delete: vi.fn(async () => {}),
    } as unknown as AdminApiDeps["oauthQuota"];
    const api = app({
      oauth: seam,
      oauthQuota,
      runInBackground: background.run,
    });

    expect((await api.request("/admin/api/oauth/refresh", { method: "POST" })).status).toBe(202);
    await vi.waitFor(() => expect(seam.listStatus).toHaveBeenCalledOnce());
    let paused = false;
    const waiting = background.pauseAndWait().then(() => {
      paused = true;
    });
    await Promise.resolve();
    expect(paused).toBe(false);

    releaseStatus();
    await waiting;
    expect(paused).toBe(true);
  });
});

describe("admin OAuth routes — reset credit", () => {
  const codexWindows = (weeklyUsedPercent = 90): OAuthQuotaWindow[] => [
    {
      key: "secondary",
      usedPercent: weeklyUsedPercent,
      resetsAtMs: Date.now() + 86_400_000,
      windowMinutes: 10_080,
    },
  ];
  const quotaStore = (windows: OAuthQuotaWindow[] = codexWindows()): AdminApiDeps["oauthQuota"] =>
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
  const allowResetCredit = () => {
    const commit = vi.fn(async () => {});
    const rollback = vi.fn(async () => {});
    return {
      commit,
      rollback,
      reserve: vi.fn(async (input: { idempotencyKey?: string }) => ({
        ok: true as const,
        sharedKey: "codex:shared-account",
        windowId: "secondary:1",
        idempotencyKey: input.idempotencyKey ?? "guard-idem-1",
        commit,
        rollback,
      })),
    };
  };

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

  it("409 treats a stale Spark-only quota snapshot as unavailable", async () => {
    const consume = vi.fn(async () => ({ code: "ok", windowsReset: 2 }));
    const guard = allowResetCredit();
    const seam = fullSeam({ consumeCodexResetCredit: consume as never });
    const res = await app({
      oauth: seam,
      oauthQuota: quotaStore([
        {
          key: "codex_spark-primary",
          usedPercent: 100,
          resetsAtMs: Date.now() + 86_400_000,
          windowMinutes: 10_080,
          limitId: "codex_spark",
          limitName: "GPT-5.3-Codex-Spark",
        },
      ]),
      resetCreditGuard: guard,
    }).request("/admin/api/oauth/openai-codex/reset-credit", {
      method: "POST",
      headers: JSONH,
      body: "{}",
    });

    expect(res.status).toBe(409);
    expect((await res.json()) as { code: string }).toMatchObject({ code: "quota_unavailable" });
    expect(guard.reserve).not.toHaveBeenCalled();
    expect(consume).not.toHaveBeenCalled();
  });

  it("falls back to live quota when the persisted snapshot only contains retired Spark limits", async () => {
    const consume = vi.fn(async () => ({
      code: "reset",
      outcome: "reset",
      windowsReset: 1,
      redeemRequestId: "guard-idem-1",
    }));
    const guard = allowResetCredit();
    const liveWindows = codexWindows(100);
    const seam = fullSeam({
      fetchCodexQuota: vi.fn(async () => ({
        windows: liveWindows,
        resetCredits: 1,
        resetCreditDetails: [],
        credits: null,
        individualLimit: null,
        planType: "pro",
        rateLimitReachedType: "rate_limit_reached",
      })) as never,
      consumeCodexResetCredit: consume as never,
    });
    const res = await app({
      oauth: seam,
      oauthQuota: quotaStore([
        {
          key: "codex_spark-primary",
          usedPercent: 100,
          resetsAtMs: Date.now() + 86_400_000,
          windowMinutes: 10_080,
          limitId: "codex_spark",
          limitName: "GPT-5.3-Codex-Spark",
        },
      ]),
      resetCreditGuard: guard,
    }).request("/admin/api/oauth/openai-codex/reset-credit", {
      method: "POST",
      headers: JSONH,
      body: "{}",
    });

    expect(res.status).toBe(200);
    expect(guard.reserve).toHaveBeenCalledWith(
      expect.objectContaining({
        windows: liveWindows,
        rateLimitReachedType: "rate_limit_reached",
      }),
    );
    expect(consume).toHaveBeenCalledOnce();
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

  it("409 blocks reset-credit consumption for workspace credits or spend-control limits", async () => {
    const consume = vi.fn(async () => ({
      code: "reset",
      outcome: "reset",
      windowsReset: 2,
      redeemRequestId: "idem-1",
    }));
    const guard = allowResetCredit();
    const seam = fullSeam({
      fetchCodexQuota: vi.fn(async () => ({
        windows: codexWindows(100),
        resetCredits: 1,
        resetCreditDetails: [],
        credits: { hasCredits: false, unlimited: false, balance: null },
        planType: "team",
        rateLimitReachedType: "workspace_member_usage_limit_reached",
      })) as never,
      consumeCodexResetCredit: consume as never,
    });
    const res = await app({
      oauth: seam,
      oauthQuota: quotaStore(codexWindows(100)),
      resetCreditGuard: guard,
    }).request("/admin/api/oauth/openai-codex/reset-credit", {
      method: "POST",
      headers: JSONH,
      body: "{}",
    });
    expect(res.status).toBe(409);
    expect((await res.json()) as { code: string }).toMatchObject({
      code: "reset_credit_not_applicable",
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

  it("200 consumes a selected credit with a reusable idempotency key after quota + guard allow it", async () => {
    const consume = vi.fn(async () => ({
      code: "reset",
      outcome: "reset",
      windowsReset: 2,
      redeemRequestId: "idem-1",
    }));
    const guard = allowResetCredit();
    const seam = fullSeam({
      fetchCodexQuota: vi.fn(async () => ({
        windows: codexWindows(100),
        resetCredits: 1,
        resetCreditDetails: [],
        credits: { hasCredits: true, unlimited: false, balance: "5.00" },
        planType: "pro",
        rateLimitReachedType: "rate_limit_reached",
      })) as never,
      consumeCodexResetCredit: consume as never,
    });
    const res = await app({
      oauth: seam,
      oauthQuota: quotaStore(),
      resetCreditGuard: guard,
    }).request("/admin/api/oauth/openai-codex/reset-credit", {
      method: "POST",
      headers: JSONH,
      body: JSON.stringify({
        creditId: "credit-1",
        idempotencyKey: "idem-1",
      }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      code: "reset",
      outcome: "reset",
      windowsReset: 2,
      redeemRequestId: "idem-1",
    });
    expect(guard.reserve).toHaveBeenCalledWith({
      providerId: "openai-codex",
      account: "default",
      windows: expect.arrayContaining([
        expect.objectContaining({ key: "secondary", usedPercent: 90 }),
      ]),
      mode: "manual",
      idempotencyKey: "idem-1",
      rateLimitReachedType: "rate_limit_reached",
    });
    expect(consume).toHaveBeenCalledWith({
      account: "default",
      creditId: "credit-1",
      idempotencyKey: "idem-1",
    });
    expect(guard.commit).toHaveBeenCalledOnce();
    expect(guard.rollback).not.toHaveBeenCalled();
  });

  it.each([
    ["nothing_to_reset", "nothingToReset", false],
    ["no_credit", "noCredit", false],
    ["already_redeemed", "alreadyRedeemed", true],
  ] as const)("200 preserves the %s reset-credit outcome", async (code, outcome, consumed) => {
    const guard = allowResetCredit();
    const seam = fullSeam({
      fetchCodexQuota: vi.fn(async () => ({
        windows: codexWindows(100),
        resetCredits: 1,
        resetCreditDetails: [],
        credits: null,
        individualLimit: null,
        planType: "pro",
        rateLimitReachedType: "rate_limit_reached",
      })) as never,
      consumeCodexResetCredit: vi.fn(async () => ({
        code,
        outcome,
        windowsReset: 0,
        redeemRequestId: "idem-1",
      })) as never,
    });
    const res = await app({
      oauth: seam,
      oauthQuota: quotaStore(codexWindows(100)),
      resetCreditGuard: guard,
    }).request("/admin/api/oauth/openai-codex/reset-credit", {
      method: "POST",
      headers: JSONH,
      body: JSON.stringify({ idempotencyKey: "idem-1" }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ code, outcome, windowsReset: 0 });
    expect(guard.commit).toHaveBeenCalledTimes(consumed ? 1 : 0);
    expect(guard.rollback).toHaveBeenCalledTimes(consumed ? 0 : 1);
  });

  it("passes an explicit account through to the seam", async () => {
    const consume = vi.fn(async () => ({
      code: "reset",
      outcome: "reset",
      windowsReset: 1,
      redeemRequestId: "idem-1",
    }));
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
    expect(consume).toHaveBeenCalledWith({
      account: "work",
      idempotencyKey: "guard-idem-1",
    });
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
    expect(guard.commit).not.toHaveBeenCalled();
    expect(guard.rollback).toHaveBeenCalledOnce();
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

  it("POST manual/complete deletes the old durable quota before rebuilding", async () => {
    const events: string[] = [];
    const seam = fullSeam({
      completeManualPaste: vi.fn(async () => {
        events.push("credential");
      }),
    });
    const oauthQuota = {
      delete: vi.fn(async () => {
        events.push("quota-delete");
      }),
    } as unknown as AdminApiDeps["oauthQuota"];
    const onOAuthMutation = vi.fn(async () => {
      events.push("rebuild");
      return { applied: true };
    });

    const res = await app({ oauth: seam, oauthQuota, onOAuthMutation }).request(
      "/admin/api/oauth/anthropic/manual/complete",
      {
        method: "POST",
        headers: JSONH,
        body: JSON.stringify({ sessionId: "s1", redirectInput: "https://cb", account: "work" }),
      },
    );

    expect(res.status).toBe(204);
    expect(oauthQuota?.delete).toHaveBeenCalledWith("anthropic", "work");
    expect(events).toEqual(["credential", "quota-delete", "rebuild"]);
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
    expect((await start.json()) as { userCode: string }).toMatchObject({
      userCode: "ABCD",
      intervalMs: 5_000,
      expiresAt: 601_000,
      serverNowMs: 1_000,
    });
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

  it("POST device/poll returns 503 not_applied when the completed login cannot rebuild", async () => {
    const onOAuthMutation = vi.fn(async () => ({ applied: false }));
    const seam = fullSeam({ pollDeviceCode: vi.fn(async () => ({ status: "done" as const })) });
    const res = await app({ oauth: seam, onOAuthMutation }).request(
      "/admin/api/oauth/xai/device/poll",
      {
        method: "POST",
        headers: JSONH,
        body: JSON.stringify({ sessionId: "s2" }),
      },
    );

    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ code: "not_applied" });
    expect(onOAuthMutation).toHaveBeenCalledOnce();
  });

  it("POST device/poll done deletes the old durable quota before rebuilding", async () => {
    const events: string[] = [];
    const seam = fullSeam({
      pollDeviceCode: vi.fn(async () => {
        events.push("credential");
        return { status: "done" as const };
      }),
    });
    const oauthQuota = {
      delete: vi.fn(async () => {
        events.push("quota-delete");
      }),
    } as unknown as AdminApiDeps["oauthQuota"];
    const onOAuthMutation = vi.fn(async () => {
      events.push("rebuild");
      return { applied: true };
    });

    const res = await app({ oauth: seam, oauthQuota, onOAuthMutation }).request(
      "/admin/api/oauth/xai/device/poll",
      {
        method: "POST",
        headers: JSONH,
        body: JSON.stringify({ sessionId: "s2", account: "subscription" }),
      },
    );

    expect(res.status).toBe(200);
    expect(oauthQuota?.delete).toHaveBeenCalledWith("xai", "subscription");
    expect(events).toEqual(["credential", "quota-delete", "rebuild"]);
  });

  it("does not rebuild when durable quota cleanup fails after a completed login", async () => {
    const onOAuthMutation = vi.fn(async () => ({ applied: true }));
    const oauthQuota = {
      delete: vi.fn(async () => {
        throw new Error("quota delete failed");
      }),
    } as unknown as AdminApiDeps["oauthQuota"];

    const res = await app({ oauth: fullSeam(), oauthQuota, onOAuthMutation }).request(
      "/admin/api/oauth/anthropic/manual/complete",
      {
        method: "POST",
        headers: JSONH,
        body: JSON.stringify({ sessionId: "s1", redirectInput: "https://cb" }),
      },
    );

    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ code: "not_applied" });
    expect(onOAuthMutation).not.toHaveBeenCalled();
  });

  it("POST device/poll returns a stable device error code", async () => {
    const seam = fullSeam({
      pollDeviceCode: vi.fn(async () => {
        throw new Error("xAI device authorization was denied");
      }),
    });
    const res = await app({ oauth: seam }).request("/admin/api/oauth/xai/device/poll", {
      method: "POST",
      headers: JSONH,
      body: JSON.stringify({ sessionId: "s2" }),
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "xAI device authorization was denied",
      code: "device_authorization_denied",
    });
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

  it("DELETE removes durable quota after logout and before rebuilding", async () => {
    const events: string[] = [];
    const seam = fullSeam({
      logout: vi.fn(async () => {
        events.push("credential");
      }),
    });
    const oauthQuota = {
      delete: vi.fn(async () => {
        events.push("quota-delete");
      }),
    } as unknown as AdminApiDeps["oauthQuota"];
    const onOAuthMutation = vi.fn(async () => {
      events.push("rebuild");
      return { applied: true };
    });

    const res = await app({ oauth: seam, oauthQuota, onOAuthMutation }).request(
      "/admin/api/oauth/xai?account=subscription",
      { method: "DELETE" },
    );

    expect(res.status).toBe(204);
    expect(oauthQuota?.delete).toHaveBeenCalledWith("xai", "subscription");
    expect(events).toEqual(["credential", "quota-delete", "rebuild"]);
  });

  it.each([
    true,
    false,
  ])("DELETE still rebuilds after quota cleanup fails (rebuild applied: %s)", async (rebuildApplied) => {
    const events: string[] = [];
    const seam = fullSeam({
      logout: vi.fn(async () => {
        events.push("credential-delete");
      }),
    });
    const oauthQuota = {
      delete: vi.fn(async () => {
        events.push("quota-delete");
        throw new Error("quota delete failed");
      }),
    } as unknown as AdminApiDeps["oauthQuota"];
    const onOAuthMutation = vi.fn(async () => {
      events.push("rebuild");
      return { applied: rebuildApplied };
    });

    const res = await app({ oauth: seam, oauthQuota, onOAuthMutation }).request(
      "/admin/api/oauth/xai?account=subscription",
      { method: "DELETE" },
    );

    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ code: "not_applied" });
    expect(events).toEqual(["credential-delete", "quota-delete", "rebuild"]);
    expect(onOAuthMutation).toHaveBeenCalledOnce();
  });

  it("DELETE rebuilds but does not clear quota when logout fails after token deletion", async () => {
    const events: string[] = [];
    const seam = fullSeam({
      logout: vi.fn(async () => {
        events.push("credential-delete");
        throw new Error("account settings cleanup failed");
      }),
    });
    const oauthQuota = {
      delete: vi.fn(async () => {
        events.push("quota-delete");
      }),
    } as unknown as AdminApiDeps["oauthQuota"];
    const onOAuthMutation = vi.fn(async () => {
      events.push("rebuild");
      return { applied: false };
    });

    const res = await app({ oauth: seam, oauthQuota, onOAuthMutation }).request(
      "/admin/api/oauth/anthropic?account=work",
      { method: "DELETE" },
    );

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({
      error: "account settings cleanup failed",
      code: "logout_failed",
    });
    expect(events).toEqual(["credential-delete", "rebuild"]);
    expect(oauthQuota?.delete).not.toHaveBeenCalled();
  });

  it("DELETE rebuilds from durable truth when logout fails before token deletion", async () => {
    const events: string[] = [];
    const seam = fullSeam({
      logout: vi.fn(async () => {
        throw new Error("token store unavailable");
      }),
    });
    const oauthQuota = {
      delete: vi.fn(async () => {
        events.push("quota-delete");
      }),
    } as unknown as AdminApiDeps["oauthQuota"];
    const onOAuthMutation = vi.fn(async () => {
      events.push("rebuild");
      return { applied: true };
    });

    const res = await app({ oauth: seam, oauthQuota, onOAuthMutation }).request(
      "/admin/api/oauth/anthropic?account=work",
      { method: "DELETE" },
    );

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "token store unavailable", code: "logout_failed" });
    expect(events).toEqual(["rebuild"]);
    expect(oauthQuota?.delete).not.toHaveBeenCalled();
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
