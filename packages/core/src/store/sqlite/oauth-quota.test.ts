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
