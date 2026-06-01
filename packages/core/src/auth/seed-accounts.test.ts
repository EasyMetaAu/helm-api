import { describe, expect, it } from "vitest";
import { SqliteCreditStore } from "../store/sqlite/credit.js";
import { createSqliteDb } from "../store/sqlite/migrate.js";
import { BOOTSTRAP_ACCOUNT_IDS, ensureSeedAccounts } from "./seed-accounts.js";

function freshStore() {
  return new SqliteCreditStore(createSqliteDb(":memory:"));
}

const NOW = 1_700_000_000_000;

describe("ensureSeedAccounts", () => {
  it("seeds BOTH legacy account literals (acct_default and default)", async () => {
    const store = freshStore();
    await ensureSeedAccounts(store, () => NOW);
    expect(BOOTSTRAP_ACCOUNT_IDS).toEqual(["acct_default", "default"]);
    for (const id of BOOTSTRAP_ACCOUNT_IDS) {
      const b = await store.getBalance(id);
      expect(b).not.toBeNull();
      expect(b?.balance).toBe(0);
    }
  });

  it("is idempotent and never resets an existing balance", async () => {
    const store = freshStore();
    await ensureSeedAccounts(store, () => NOW);
    await store.topup({
      accountId: "acct_default",
      requestId: null,
      apiKeyId: null,
      amountUsd: 42,
      kind: "topup",
      costMeasured: true,
      nowMs: NOW,
    });
    await ensureSeedAccounts(store, () => NOW);
    expect((await store.getBalance("acct_default"))?.balance).toBeCloseTo(42);
  });
});
