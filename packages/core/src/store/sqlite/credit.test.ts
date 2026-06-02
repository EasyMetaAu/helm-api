import { describe, expect, it } from "vitest";
import { SqliteCreditStore } from "./credit.js";
import { createSqliteDb } from "./migrate.js";

function freshStore() {
  const db = createSqliteDb(":memory:");
  return { db, store: new SqliteCreditStore(db) };
}

const NOW = 1_700_000_000_000;

describe("SqliteCreditStore", () => {
  it("getBalance returns null for an unknown account", async () => {
    const { store } = freshStore();
    expect(await store.getBalance("nope")).toBeNull();
  });

  it("ensureAccount provisions a zero-balance row, idempotently", async () => {
    const { store } = freshStore();
    await store.ensureAccount({ accountId: "acct_x", nowMs: NOW });
    const b = await store.getBalance("acct_x");
    expect(b).toEqual({ balance: 0, quota: null, disabled: false });
    // Topup, then re-ensure: balance must NOT be reset.
    await store.topup({
      accountId: "acct_x",
      requestId: null,
      apiKeyId: null,
      amountUsd: 5,
      kind: "topup",
      costMeasured: true,
      nowMs: NOW,
    });
    await store.ensureAccount({ accountId: "acct_x", nowMs: NOW });
    expect((await store.getBalance("acct_x"))?.balance).toBeCloseTo(5);
  });

  it("topup increases the balance and appends a ledger row", async () => {
    const { store } = freshStore();
    await store.ensureAccount({ accountId: "a", nowMs: NOW });
    const r = await store.topup({
      accountId: "a",
      requestId: null,
      apiKeyId: null,
      amountUsd: 10,
      kind: "topup",
      costMeasured: true,
      nowMs: NOW,
    });
    expect(r.ok).toBe(true);
    expect(r.balanceAfter).toBeCloseTo(10);
    const led = await store.recentLedger("a", 10);
    expect(led).toHaveLength(1);
    expect(led[0]?.kind).toBe("topup");
    expect(led[0]?.amount_usd).toBeCloseTo(10);
    expect(led[0]?.balance_after_usd).toBeCloseTo(10);
  });

  it("debit lowers the balance, records signed negative amount, auto-provisions", async () => {
    const { store } = freshStore();
    // No ensureAccount: debit must auto-provision rather than crash.
    const r = await store.debit({
      accountId: "fresh",
      requestId: "req1",
      apiKeyId: "k1",
      amountUsd: -0.25,
      kind: "debit",
      costMeasured: true,
      nowMs: NOW,
    });
    expect(r.ok).toBe(true);
    expect(r.balanceAfter).toBeCloseTo(-0.25);
    const led = await store.recentLedger("fresh", 10);
    expect(led[0]?.amount_usd).toBeCloseTo(-0.25);
    expect(led[0]?.api_key_id).toBe("k1");
    expect(led[0]?.request_id).toBe("req1");
  });

  it("repeated debit with the same request_id is idempotent", async () => {
    const { store } = freshStore();
    await store.topup({
      accountId: "a",
      requestId: null,
      apiKeyId: null,
      amountUsd: 10,
      kind: "topup",
      costMeasured: true,
      nowMs: NOW,
    });
    const first = await store.debit({
      accountId: "a",
      requestId: "req-idem",
      apiKeyId: "k1",
      amountUsd: -2,
      kind: "debit",
      costMeasured: true,
      nowMs: NOW + 1,
    });
    const second = await store.debit({
      accountId: "a",
      requestId: "req-idem",
      apiKeyId: "k1",
      amountUsd: -2,
      kind: "debit",
      costMeasured: true,
      nowMs: NOW + 2,
    });
    expect(first.balanceAfter).toBeCloseTo(8);
    expect(second.balanceAfter).toBeCloseTo(8);
    expect((await store.getBalance("a"))?.balance).toBeCloseTo(8);
    expect((await store.recentLedger("a", 10)).filter((e) => e.kind === "debit")).toHaveLength(1);
  });

  it("topup and adjustment are not deduped by null request_id", async () => {
    const { store } = freshStore();
    await store.topup({
      accountId: "a",
      requestId: null,
      apiKeyId: null,
      amountUsd: 5,
      kind: "topup",
      costMeasured: true,
      nowMs: NOW,
    });
    await store.topup({
      accountId: "a",
      requestId: null,
      apiKeyId: null,
      amountUsd: -1,
      kind: "adjustment",
      costMeasured: true,
      nowMs: NOW + 1,
    });
    expect((await store.getBalance("a"))?.balance).toBeCloseTo(4);
    expect(await store.recentLedger("a", 10)).toHaveLength(2);
  });

  it("debit 0 is allowed (D4 — null cost debits 0 + cost_measured=false)", async () => {
    const { store } = freshStore();
    await store.ensureAccount({ accountId: "a", nowMs: NOW });
    const r = await store.debit({
      accountId: "a",
      requestId: "req",
      apiKeyId: "k",
      amountUsd: 0,
      kind: "debit",
      costMeasured: false,
      nowMs: NOW,
    });
    expect(r.ok).toBe(true);
    expect(r.balanceAfter).toBeCloseTo(0);
    expect((await store.recentLedger("a", 1))[0]?.cost_measured).toBe(false);
  });

  it("two concurrent debits on the last credit BOTH persist atomically (no lost update)", async () => {
    const { store } = freshStore();
    await store.ensureAccount({ accountId: "a", nowMs: NOW });
    await store.topup({
      accountId: "a",
      requestId: null,
      apiKeyId: null,
      amountUsd: 1,
      kind: "topup",
      costMeasured: true,
      nowMs: NOW,
    });
    // v1 has no reservation; both post-served debits apply. The invariant is that
    // NEITHER update is lost: final balance reflects BOTH debits (1 - 0.6 - 0.6).
    await Promise.all([
      store.debit({
        accountId: "a",
        requestId: "r1",
        apiKeyId: "k",
        amountUsd: -0.6,
        kind: "debit",
        costMeasured: true,
        nowMs: NOW,
      }),
      store.debit({
        accountId: "a",
        requestId: "r2",
        apiKeyId: "k",
        amountUsd: -0.6,
        kind: "debit",
        costMeasured: true,
        nowMs: NOW,
      }),
    ]);
    expect((await store.getBalance("a"))?.balance).toBeCloseTo(-0.2);
    expect(await store.recentLedger("a", 10)).toHaveLength(3); // topup + 2 debits
  });

  it("debit and topup interleaved on the same row keep both updates", async () => {
    const { store } = freshStore();
    await store.ensureAccount({ accountId: "a", nowMs: NOW });
    await Promise.all([
      store.topup({
        accountId: "a",
        requestId: null,
        apiKeyId: null,
        amountUsd: 5,
        kind: "topup",
        costMeasured: true,
        nowMs: NOW,
      }),
      store.debit({
        accountId: "a",
        requestId: "r",
        apiKeyId: "k",
        amountUsd: -2,
        kind: "debit",
        costMeasured: true,
        nowMs: NOW,
      }),
    ]);
    expect((await store.getBalance("a"))?.balance).toBeCloseTo(3);
  });

  it("spendByAccount sums DEBIT absolute amounts within the window only", async () => {
    const { store } = freshStore();
    await store.ensureAccount({ accountId: "a", nowMs: NOW });
    await store.topup({
      accountId: "a",
      requestId: null,
      apiKeyId: null,
      amountUsd: 100,
      kind: "topup",
      costMeasured: true,
      nowMs: NOW - 10,
    });
    await store.debit({
      accountId: "a",
      requestId: "r1",
      apiKeyId: "k",
      amountUsd: -2,
      kind: "debit",
      costMeasured: true,
      nowMs: NOW,
    });
    await store.debit({
      accountId: "a",
      requestId: "r2",
      apiKeyId: "k",
      amountUsd: -3,
      kind: "debit",
      costMeasured: true,
      nowMs: NOW + 5,
    });
    // Out-of-window debit (excluded).
    await store.debit({
      accountId: "a",
      requestId: "r3",
      apiKeyId: "k",
      amountUsd: -99,
      kind: "debit",
      costMeasured: true,
      nowMs: NOW + 10_000,
    });
    // Topup must NOT count toward spend.
    const spend = await store.spendByAccount("a", NOW, NOW + 6);
    expect(spend).toBeCloseTo(5);
  });

  it("reports the account's quota + disabled flag", async () => {
    const { db, store } = freshStore();
    db.$sqlite
      .prepare(
        "INSERT INTO accounts (account_id, credit_balance_usd, credit_quota_usd, disabled, created_at) VALUES (?,?,?,?,?)",
      )
      .run("a", 12.5, 50, 1, NOW);
    const b = await store.getBalance("a");
    expect(b).toEqual({ balance: 12.5, quota: 50, disabled: true });
  });
});
