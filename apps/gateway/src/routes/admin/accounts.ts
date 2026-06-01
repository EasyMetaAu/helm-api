import { CreditAdjustRequestSchema } from "@helm/shared";
import type { Hono } from "hono";
import type { AppEnv } from "../../app.js";
import type { AdminApiDeps } from "./deps.js";

// /admin/api/accounts — account credit balances + window spend + operator topup
// (Issue #37). PURE HTTP glue (Principle 1): the authoritative numbers come from
// the CreditStore (balance row + the append-only credit_ledger, the single source
// of per-account spend). NO key material is ever returned (principle 7). When the
// credit store is not wired (a billing-off build), every route returns 503 rather
// than a misleading empty success.

export function registerAccountsRoutes(app: Hono<AppEnv>, deps: AdminApiDeps): void {
  // GET /accounts -> AccountRecord[] (balance + tri-state quota + disabled).
  app.get("/admin/api/accounts", async (c) => {
    if (deps.creditStore === undefined) {
      return c.json({ error: "credit store not configured" }, 503);
    }
    return c.json(await deps.creditStore.listAccounts());
  });

  // GET /accounts/:id/spend?from=&to= -> { spend_usd } summed from the ledger over
  // the half-open window [from, to). Defaults: last 30 days if unspecified.
  app.get("/admin/api/accounts/:id/spend", async (c) => {
    if (deps.creditStore === undefined) {
      return c.json({ error: "credit store not configured" }, 503);
    }
    const accountId = c.req.param("id");
    const now = Date.now();
    const fromRaw = Number(c.req.query("from"));
    const toRaw = Number(c.req.query("to"));
    const from = Number.isFinite(fromRaw) ? fromRaw : now - 30 * 86_400_000;
    const to = Number.isFinite(toRaw) ? toRaw : now;
    const spend = await deps.creditStore.spendByAccount(accountId, from, to);
    return c.json({ account_id: accountId, from, to, spend_usd: spend });
  });

  // POST /accounts/:id/topup { amount_usd, note? } -> apply a balance movement +
  // ledger entry. A positive amount is a topup; a negative amount is a manual
  // adjustment (deduction). Fail-closed (Principle 2): a non-finite/unknown-field
  // body is rejected (400) and never applied. account_id/api_key_id on the ledger
  // row are null (operator action, no originating request).
  app.post("/admin/api/accounts/:id/topup", async (c) => {
    if (deps.creditStore === undefined) {
      return c.json({ error: "credit store not configured" }, 503);
    }
    const parsed = CreditAdjustRequestSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json({ error: "invalid topup request", issues: parsed.error.issues }, 400);
    }
    const accountId = c.req.param("id");
    const amount = parsed.data.amount_usd;
    const result = await deps.creditStore.topup({
      accountId,
      requestId: null,
      apiKeyId: null,
      amountUsd: amount,
      kind: amount >= 0 ? "topup" : "adjustment",
      costMeasured: true,
      nowMs: Date.now(),
    });
    return c.json({ account_id: accountId, balance_after_usd: result.balanceAfter });
  });
}
