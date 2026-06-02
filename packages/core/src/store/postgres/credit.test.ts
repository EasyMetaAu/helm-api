import { describe, expect, it } from "vitest";
import { PgCreditStore } from "./credit.js";
import { createPgliteDb, type PgDb } from "./migrate.js";

const NOW = 1_700_000_000_000;

async function freshStore(): Promise<{ db: PgDb; store: PgCreditStore }> {
  const db = await createPgliteDb();
  return { db, store: new PgCreditStore(db) };
}

describe("PgCreditStore", () => {
  it("getBalance returns null for an unknown account", async () => {
    const { db, store } = await freshStore();
    expect(await store.getBalance("nope")).toBeNull();
    await db.$close();
  });

  it("ensureAccount provisions a zero-balance row, idempotently", async () => {
    const { db, store } = await freshStore();
    await store.ensureAccount({ accountId: "a", nowMs: NOW });
    expect(await store.getBalance("a")).toEqual({ balance: 0, quota: null, disabled: false });
    await store.topup({
      accountId: "a",
      requestId: null,
      apiKeyId: null,
      amountUsd: 5,
      kind: "topup",
      costMeasured: true,
      nowMs: NOW,
    });
    await store.ensureAccount({ accountId: "a", nowMs: NOW });
    expect((await store.getBalance("a"))?.balance).toBeCloseTo(5);
    await db.$close();
  });

  it("debit lowers the balance, auto-provisions, records signed amount + key_id", async () => {
    const { db, store } = await freshStore();
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
    await db.$close();
  });

  it("repeated debit with the same request_id is idempotent", async () => {
    const { db, store } = await freshStore();
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
    await db.$close();
  });

  it("topup and adjustment are not deduped by null request_id", async () => {
    const { db, store } = await freshStore();
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
    await db.$close();
  });

  it("debit 0 + cost_measured=false is allowed (D4)", async () => {
    const { db, store } = await freshStore();
    await store.ensureAccount({ accountId: "a", nowMs: NOW });
    const r = await store.debit({
      accountId: "a",
      requestId: "r",
      apiKeyId: "k",
      amountUsd: 0,
      kind: "debit",
      costMeasured: false,
      nowMs: NOW,
    });
    expect(r.ok).toBe(true);
    expect((await store.recentLedger("a", 1))[0]?.cost_measured).toBe(false);
    await db.$close();
  });

  it("two debits on the last credit both persist (no lost update)", async () => {
    const { db, store } = await freshStore();
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
    await store.debit({
      accountId: "a",
      requestId: "r1",
      apiKeyId: "k",
      amountUsd: -0.6,
      kind: "debit",
      costMeasured: true,
      nowMs: NOW,
    });
    await store.debit({
      accountId: "a",
      requestId: "r2",
      apiKeyId: "k",
      amountUsd: -0.6,
      kind: "debit",
      costMeasured: true,
      nowMs: NOW,
    });
    expect((await store.getBalance("a"))?.balance).toBeCloseTo(-0.2);
    expect(await store.recentLedger("a", 10)).toHaveLength(3);
    await db.$close();
  });

  it("spendByAccount sums DEBIT absolute amounts within the window only", async () => {
    const { db, store } = await freshStore();
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
    await store.debit({
      accountId: "a",
      requestId: "r3",
      apiKeyId: "k",
      amountUsd: -99,
      kind: "debit",
      costMeasured: true,
      nowMs: NOW + 10_000,
    });
    expect(await store.spendByAccount("a", NOW, NOW + 6)).toBeCloseTo(5);
    await db.$close();
  });
});
