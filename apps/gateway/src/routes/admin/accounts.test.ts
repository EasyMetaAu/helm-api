import { createSqliteDb, SqliteCreditStore } from "@helm/core";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import type { AppEnv } from "../../app.js";
import { registerAccountsRoutes } from "./accounts.js";
import type { AdminApiDeps } from "./deps.js";

const NOW = 1_700_000_000_000;

function buildApp(creditStore?: SqliteCreditStore) {
  const app = new Hono<AppEnv>();
  registerAccountsRoutes(app, { creditStore } as unknown as AdminApiDeps);
  return app;
}

async function seedStore() {
  const store = new SqliteCreditStore(createSqliteDb(":memory:"));
  await store.ensureAccount({ accountId: "acct_default", nowMs: NOW });
  await store.topup({
    accountId: "acct_default",
    requestId: null,
    apiKeyId: null,
    amountUsd: 100,
    kind: "topup",
    costMeasured: true,
    nowMs: NOW,
  });
  await store.debit({
    accountId: "acct_default",
    requestId: "r1",
    apiKeyId: "k1",
    amountUsd: -4,
    kind: "debit",
    costMeasured: true,
    nowMs: NOW + 1,
  });
  return store;
}

describe("admin accounts routes (Issue #37)", () => {
  it("GET /accounts lists accounts with balance", async () => {
    const app = buildApp(await seedStore());
    const res = await app.request("/admin/api/accounts");
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<{ account_id: string; credit_balance_usd: number }>;
    const acct = body.find((a) => a.account_id === "acct_default");
    expect(acct?.credit_balance_usd).toBeCloseTo(96);
  });

  it("GET /accounts/:id/spend sums debits in the window (authoritative ledger)", async () => {
    const app = buildApp(await seedStore());
    const res = await app.request(
      `/admin/api/accounts/acct_default/spend?from=${NOW}&to=${NOW + 10}`,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { spend_usd: number };
    expect(body.spend_usd).toBeCloseTo(4);
  });

  it("POST /accounts/:id/topup increases the balance + records a ledger entry", async () => {
    const store = await seedStore();
    const app = buildApp(store);
    const res = await app.request("/admin/api/accounts/acct_default/topup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ amount_usd: 50 }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { balance_after_usd: number };
    expect(body.balance_after_usd).toBeCloseTo(146);
    expect((await store.getBalance("acct_default"))?.balance).toBeCloseTo(146);
  });

  it("POST topup with a negative amount records an adjustment (manual deduction)", async () => {
    const store = await seedStore();
    const app = buildApp(store);
    const res = await app.request("/admin/api/accounts/acct_default/topup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ amount_usd: -10 }),
    });
    expect(res.status).toBe(200);
    const led = await store.recentLedger("acct_default", 1);
    expect(led[0]?.kind).toBe("adjustment");
    expect(led[0]?.amount_usd).toBeCloseTo(-10);
  });

  it("POST topup rejects a non-finite amount (fail-closed 400)", async () => {
    const app = buildApp(await seedStore());
    const res = await app.request("/admin/api/accounts/acct_default/topup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ amount_usd: "lots" }),
    });
    expect(res.status).toBe(400);
  });

  it("returns 503 when the credit store is not wired (billing disabled build)", async () => {
    const app = buildApp(undefined);
    const res = await app.request("/admin/api/accounts");
    expect(res.status).toBe(503);
  });
});
