import { type CreditProbe, createCreditGate, createSqliteDb, SqliteCreditStore } from "@helm/core";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { creditGateMiddleware } from "./credit-gate.js";

function buildApp(opts: {
  enabled: boolean;
  defaultQuotaUsd: number;
  behavior?: "reject" | "alert";
  accountId?: string | null;
  seed?: (store: SqliteCreditStore) => Promise<void>;
}) {
  const db = createSqliteDb(":memory:");
  const store = new SqliteCreditStore(db);
  const config = {
    enabled: opts.enabled,
    defaultQuotaUsd: opts.defaultQuotaUsd,
    overQuotaBehavior: opts.behavior ?? ("reject" as const),
  };
  const gate = createCreditGate({ store, config });
  const app = new Hono();
  app.use("*", async (c, next) => {
    if (opts.accountId !== null) {
      // biome-ignore lint/suspicious/noExplicitAny: minimal identity stub
      (c as any).set("identity", { keyId: "k1", accountId: opts.accountId ?? "acct_default" });
    }
    await next();
  });
  app.use("*", creditGateMiddleware({ gate }));
  app.get("/v1/chat/completions", (c) => c.json({ ok: true }));
  return { app, store, seed: opts.seed };
}

async function run(opts: Parameters<typeof buildApp>[0]) {
  const { app, store } = buildApp(opts);
  if (opts.seed) await opts.seed(store);
  return app.request("/v1/chat/completions");
}

const NOW = 1_700_000_000_000;

describe("creditGateMiddleware", () => {
  it("allows when credits are disabled (zero-touch)", async () => {
    const res = await run({ enabled: false, defaultQuotaUsd: 10 });
    expect(res.status).toBe(200);
  });

  it("allows a request with positive balance under a finite quota", async () => {
    const res = await run({
      enabled: true,
      defaultQuotaUsd: 10,
      seed: async (store) => {
        await store.ensureAccount({ accountId: "acct_default", nowMs: NOW });
        await store.topup({
          accountId: "acct_default",
          requestId: null,
          apiKeyId: null,
          amountUsd: 5,
          kind: "topup",
          costMeasured: true,
          nowMs: NOW,
        });
      },
    });
    expect(res.status).toBe(200);
  });

  it("returns a structured 429 when the account is over quota (reject)", async () => {
    const res = await run({
      enabled: true,
      defaultQuotaUsd: 10,
      seed: async (store) => {
        await store.ensureAccount({ accountId: "acct_default", nowMs: NOW });
      },
    });
    expect(res.status).toBe(429);
    const body = (await res.json()) as { error: { type: string; limited_by: string } };
    expect(body.error.type).toBe("rate_limited");
    expect(body.error.limited_by).toBe("credit");
  });

  it("alert mode serves the over-quota request (soft)", async () => {
    const res = await run({
      enabled: true,
      defaultQuotaUsd: 10,
      behavior: "alert",
      seed: async (store) => {
        await store.ensureAccount({ accountId: "acct_default", nowMs: NOW });
        await store.debit({
          accountId: "acct_default",
          requestId: "r",
          apiKeyId: "k",
          amountUsd: -1,
          kind: "debit",
          costMeasured: true,
          nowMs: NOW,
        });
      },
    });
    expect(res.status).toBe(200);
  });

  it("allows when there is no resolved identity (nothing to meter)", async () => {
    const res = await run({ enabled: true, defaultQuotaUsd: 10, accountId: null });
    expect(res.status).toBe(200);
  });

  it("propagates a store error (fail-CLOSED) — surfaces as a 5xx, never an allow", async () => {
    const throwingGate = {
      check: async (_probe: CreditProbe) => {
        throw new Error("db down");
      },
    };
    const app = new Hono();
    app.onError((_err, c) => c.json({ error: "internal" }, 500));
    app.use("*", async (c, next) => {
      // biome-ignore lint/suspicious/noExplicitAny: minimal identity stub
      (c as any).set("identity", { keyId: "k1", accountId: "acct_default" });
      await next();
    });
    app.use("*", creditGateMiddleware({ gate: throwingGate }));
    app.get("/x", (c) => c.json({ ok: true }));
    const res = await app.request("/x");
    expect(res.status).toBe(500);
  });
});
