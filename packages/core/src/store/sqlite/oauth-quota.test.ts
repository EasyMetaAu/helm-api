import type { OAuthQuotaSnapshot } from "@helm/shared";
import { describe, expect, it } from "vitest";
import { createSqliteDb, type SqliteDb } from "./migrate.js";
import { SqliteOAuthQuotaStore } from "./oauth-quota.js";

function freshStore(): { store: SqliteOAuthQuotaStore; close: () => void } {
  const db: SqliteDb = createSqliteDb(":memory:");
  return { store: new SqliteOAuthQuotaStore(db), close: () => db.$sqlite.close() };
}

const snap = (over: Partial<OAuthQuotaSnapshot> = {}): OAuthQuotaSnapshot => ({
  providerId: "anthropic",
  account: "a",
  windows: [
    { key: "5h", usedPercent: 6, resetsAtMs: 1_000, windowMinutes: null },
    { key: "7d", usedPercent: 14, resetsAtMs: 2_000, windowMinutes: null },
  ],
  capturedAt: 500,
  source: "anthropic",
  usageLimitedUntilMs: null,
  ...over,
});

describe("SqliteOAuthQuotaStore", () => {
  it("upsert then get round-trips the windows", async () => {
    const { store, close } = freshStore();
    await store.upsert(snap());
    const got = await store.get("anthropic", "a");
    expect(got?.windows).toHaveLength(2);
    expect(got?.windows[0]).toMatchObject({ key: "5h", usedPercent: 6, resetsAtMs: 1_000 });
    expect(got?.source).toBe("anthropic");
    close();
  });

  it("upsert is latest-wins (one row per provider+account)", async () => {
    const { store, close } = freshStore();
    await store.upsert(snap({ capturedAt: 500 }));
    await store.upsert(
      snap({
        capturedAt: 999,
        windows: [{ key: "5h", usedPercent: 80, resetsAtMs: 3_000, windowMinutes: null }],
      }),
    );
    const got = await store.get("anthropic", "a");
    expect(got?.capturedAt).toBe(999);
    expect(got?.windows).toHaveLength(1);
    expect(got?.windows[0]?.usedPercent).toBe(80);
    close();
  });

  it("round-trips reset credits and preserves them when a header snapshot omits the count", async () => {
    const { store, close } = freshStore();
    await store.upsert(
      snap({
        providerId: "openai-codex",
        source: "codex",
        resetCredits: 2,
      }),
    );
    expect((await store.get("openai-codex", "a"))?.resetCredits).toBe(2);

    await store.upsert(
      snap({
        providerId: "openai-codex",
        source: "codex-headers",
        capturedAt: 999,
        resetCredits: undefined,
      }),
    );

    expect((await store.get("openai-codex", "a"))?.resetCredits).toBe(2);
    close();
  });

  it("round-trips Codex live metadata (planType/credits/individualLimit) and preserves it when a header snapshot omits it", async () => {
    const { store, close } = freshStore();
    await store.upsert(
      snap({
        providerId: "openai-codex",
        source: "codex",
        planType: "pro",
        credits: { hasCredits: false, unlimited: false, balance: "0" },
        individualLimit: { limit: "100", used: "40", remainingPercent: 60, resetsAtMs: 9_000 },
        additionalLimits: [{ limitId: "web_search", limitName: "Web search" }],
        rateLimitReachedType: "rate_limit_reached",
      }),
    );
    const got = await store.get("openai-codex", "a");
    expect(got?.planType).toBe("pro");
    expect(got?.credits).toMatchObject({ balance: "0", unlimited: false });
    expect(got?.individualLimit).toMatchObject({ remainingPercent: 60 });
    expect(got?.additionalLimits).toHaveLength(1);
    expect(got?.rateLimitReachedType).toBe("rate_limit_reached");

    // A Codex header PUSH carries no live metadata (undefined) → must NOT wipe it,
    // same preserve-on-omit contract as resetCredits.
    await store.upsert(
      snap({ providerId: "openai-codex", source: "codex-headers", capturedAt: 999 }),
    );
    expect((await store.get("openai-codex", "a"))?.planType).toBe("pro");
    close();
  });

  it("getAll returns every account's latest snapshot; get is null when absent", async () => {
    const { store, close } = freshStore();
    expect(await store.get("anthropic", "missing")).toBeNull();
    await store.upsert(snap({ account: "a" }));
    await store.upsert(
      snap({ providerId: "openai-codex", account: "b", source: "codex-headers", windows: [] }),
    );
    expect(await store.getAll()).toHaveLength(2);
    close();
  });

  it("defaults usageLimitedUntilMs to null and round-trips a set value", async () => {
    const { store, close } = freshStore();
    await store.upsert(snap());
    expect((await store.get("anthropic", "a"))?.usageLimitedUntilMs).toBeNull();
    await store.setUsageLimit("anthropic", "a", 7_777);
    expect((await store.get("anthropic", "a"))?.usageLimitedUntilMs).toBe(7_777);
    await store.setUsageLimit("anthropic", "a", null); // the reset path
    expect((await store.get("anthropic", "a"))?.usageLimitedUntilMs).toBeNull();
    close();
  });

  it("setUsageLimit upserts a row even when no snapshot exists yet (429 before any PULL)", async () => {
    const { store, close } = freshStore();
    await store.setUsageLimit("openai-codex", "fresh", 5_000);
    const got = await store.get("openai-codex", "fresh");
    expect(got?.usageLimitedUntilMs).toBe(5_000);
    expect(got?.windows).toEqual([]); // synthetic empty snapshot
    close();
  });

  it("marks a synthetic xAI cooldown row with the honest source", async () => {
    const { store, close } = freshStore();
    await store.setUsageLimit("xai", "subscription", 5_000);
    expect(await store.get("xai", "subscription")).toMatchObject({
      source: "xai",
      usageLimitedUntilMs: 5_000,
      windows: [],
    });
    close();
  });

  it("a window-snapshot upsert PRESERVES an active cooldown (does not clobber it)", async () => {
    const { store, close } = freshStore();
    await store.setUsageLimit("anthropic", "a", 9_000);
    // A later observability refresh (new windows) must not wipe the cooldown.
    await store.upsert(
      snap({
        capturedAt: 1_234,
        windows: [{ key: "5h", usedPercent: 20, resetsAtMs: 3, windowMinutes: null }],
      }),
    );
    const got = await store.get("anthropic", "a");
    expect(got?.usageLimitedUntilMs).toBe(9_000);
    expect(got?.capturedAt).toBe(1_234); // windows still refreshed
    close();
  });

  it("delete removes one (provider, account) row and leaves siblings intact", async () => {
    const { store, close } = freshStore();
    await store.upsert(snap({ account: "keep" }));
    await store.upsert(
      snap({ providerId: "openai-codex", account: "orphan", source: "codex-headers" }),
    );
    await store.delete("openai-codex", "orphan");
    expect(await store.get("openai-codex", "orphan")).toBeNull();
    expect((await store.getAll()).map((q) => `${q.providerId}/${q.account}`)).toEqual([
      "anthropic/keep",
    ]);
    // Deleting a non-existent row is a no-op (idempotent), never throws.
    await store.delete("openai-codex", "orphan");
    close();
  });
});
