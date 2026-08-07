import type { OAuthQuotaSnapshot } from "@helm/shared";
import { describe, expect, it } from "vitest";
import { createPgliteDb, type PgDb } from "./migrate.js";
import { PgOAuthQuotaStore } from "./oauth-quota.js";

// pglite runs the SAME pg-dialect adapter in-process — validates the supabase path
// (incl. the jsonb metadata column added in pg-migration v47) with no server.
const snap = (over: Partial<OAuthQuotaSnapshot> = {}): OAuthQuotaSnapshot => ({
  providerId: "openai-codex",
  account: "a",
  windows: [{ key: "primary", usedPercent: 100, resetsAtMs: 1_000, windowMinutes: 10_080 }],
  capturedAt: 500,
  source: "codex",
  usageLimitedUntilMs: null,
  ...over,
});

describe("PgOAuthQuotaStore (pglite)", () => {
  it("round-trips Codex live metadata and preserves it when a header snapshot omits it", async () => {
    const db: PgDb = await createPgliteDb();
    const store = new PgOAuthQuotaStore(db);

    await store.upsert(
      snap({
        planType: "pro",
        credits: { hasCredits: false, unlimited: false, balance: "0" },
        individualLimit: { limit: "100", used: "40", remainingPercent: 60, resetsAtMs: 9_000 },
        additionalLimits: [{ limitId: "web_search", limitName: "Web search" }],
        rateLimitReachedType: "rate_limit_reached",
        resetCredits: 3,
      }),
    );
    const got = await store.get("openai-codex", "a");
    expect(got?.planType).toBe("pro");
    expect(got?.credits).toMatchObject({ balance: "0", unlimited: false });
    expect(got?.individualLimit).toMatchObject({ remainingPercent: 60 });
    expect(got?.additionalLimits).toHaveLength(1);
    expect(got?.rateLimitReachedType).toBe("rate_limit_reached");
    expect(got?.resetCredits).toBe(3);

    // A header PUSH carries no live metadata → must not wipe the persisted blob.
    await store.upsert(snap({ source: "codex-headers", capturedAt: 999 }));
    const after = await store.get("openai-codex", "a");
    expect(after?.planType).toBe("pro");
    expect(after?.resetCredits).toBe(3);
    expect(after?.capturedAt).toBe(999); // windows still refreshed
  });

  it("a corrupt/absent metadata column reads as no metadata (fail-open, non-Codex)", async () => {
    const db: PgDb = await createPgliteDb();
    const store = new PgOAuthQuotaStore(db);
    await store.upsert(snap({ providerId: "anthropic", source: "anthropic" }));
    const got = await store.get("anthropic", "a");
    expect(got?.planType ?? null).toBeNull();
    expect(got?.credits ?? null).toBeNull();
  });
});
