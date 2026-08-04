import type { OAuthResetPeriod } from "@helm/shared";
import { describe, expect, it } from "vitest";
import { createSqliteDb, type SqliteDb } from "./migrate.js";
import { SqliteOAuthResetPeriodStore } from "./oauth-reset-period.js";

function freshStore(): { store: SqliteOAuthResetPeriodStore; close: () => void } {
  const db: SqliteDb = createSqliteDb(":memory:");
  return { store: new SqliteOAuthResetPeriodStore(db), close: () => db.$sqlite.close() };
}

function period(over: Partial<OAuthResetPeriod> = {}): OAuthResetPeriod {
  return {
    providerId: "anthropic",
    account: "a@x.com",
    windowKey: "5h",
    periodStartMs: 1000,
    periodEndMs: 19000,
    detectedAtMs: 19500,
    ...over,
  };
}

describe("SqliteOAuthResetPeriodStore", () => {
  it("record is idempotent on (provider, account, window, start)", async () => {
    const { store, close } = freshStore();
    await store.record(period());
    // Re-detecting the same reset (even with a different detectedAt) must not duplicate
    // or overwrite — first write wins, second is a no-op.
    await store.record(period({ detectedAtMs: 99999 }));
    const rows = await store.queryPeriods("anthropic", "a@x.com", "5h", 10);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.detectedAtMs).toBe(19500);
    close();
  });

  it("queryPeriods filters by provider/account/window and returns most-recent first", async () => {
    const { store, close } = freshStore();
    await store.record(period({ periodStartMs: 1000, periodEndMs: 19000 }));
    await store.record(period({ periodStartMs: 19000, periodEndMs: 37000 }));
    await store.record(period({ periodStartMs: 37000, periodEndMs: 55000 }));
    // other window / account / provider — must be excluded
    await store.record(period({ windowKey: "7d", periodStartMs: 1000 }));
    await store.record(period({ account: "b@x.com", periodStartMs: 1000 }));
    await store.record(period({ providerId: "xai", periodStartMs: 1000 }));

    const rows = await store.queryPeriods("anthropic", "a@x.com", "5h", 10);
    expect(rows).toHaveLength(3);
    // descending by periodEndMs
    expect(rows.map((r) => r.periodEndMs)).toEqual([55000, 37000, 19000]);
    close();
  });

  it("queryPeriods honours the limit", async () => {
    const { store, close } = freshStore();
    for (let i = 0; i < 5; i++) {
      await store.record(period({ periodStartMs: i * 18000, periodEndMs: (i + 1) * 18000 }));
    }
    const rows = await store.queryPeriods("anthropic", "a@x.com", "5h", 2);
    expect(rows).toHaveLength(2);
    close();
  });

  it("queryPeriods returns [] for an account with no recorded boundaries", async () => {
    const { store, close } = freshStore();
    expect(await store.queryPeriods("anthropic", "nobody", "5h", 10)).toHaveLength(0);
    close();
  });
});
