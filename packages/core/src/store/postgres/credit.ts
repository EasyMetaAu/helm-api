import { randomUUID } from "node:crypto";
import type { AccountRecord, CreditLedgerEntry, CreditLedgerKind } from "@helm/shared";
import { and, desc, eq, gte, lt, sql } from "drizzle-orm";
import type {
  AccountBalance,
  CreditMovementInput,
  CreditMovementResult,
  CreditStore,
} from "../ports.js";
import type { PgDb } from "./migrate.js";
import { accounts, creditLedger } from "./schema.js";

// Postgres adapter for the CreditStore port (Issue #37) — the supabase
// implementation. The balance read-modify-write + ledger insert run inside ONE
// transaction with `SELECT … FOR UPDATE` row locking so concurrent debits/topups
// serialize on the account row and never lose an update or double-spend the last
// credit (mirrors PgRateLimitStore, D7). A cold account is seeded FIRST (no-op if
// present) so FOR UPDATE always has a row to lock. api_key_id is key_id only
// (principle 7). getBalance READS propagate errors (fail-closed at the gate).
export class PgCreditStore implements CreditStore {
  constructor(
    private readonly db: PgDb,
    private readonly genId: () => string = randomUUID,
  ) {}

  async getBalance(accountId: string): Promise<AccountBalance | null> {
    const rows = await this.db
      .select()
      .from(accounts)
      .where(eq(accounts.accountId, accountId))
      .limit(1);
    const row = rows[0];
    if (row === undefined) return null;
    return {
      balance: row.creditBalanceUsd,
      quota: row.creditQuotaUsd ?? null,
      disabled: row.disabled,
    };
  }

  async ensureAccount(account: {
    accountId: string;
    name?: string | null;
    nowMs: number;
  }): Promise<void> {
    await this.db
      .insert(accounts)
      .values({
        accountId: account.accountId,
        name: account.name ?? null,
        creditBalanceUsd: 0,
        creditQuotaUsd: null,
        disabled: false,
        createdAt: account.nowMs,
      })
      .onConflictDoNothing({ target: accounts.accountId });
  }

  private async applyMovement(input: CreditMovementInput): Promise<CreditMovementResult> {
    return this.db.transaction(async (tx): Promise<CreditMovementResult> => {
      // Seed a zero-balance row FIRST (no-op if present) so the FOR UPDATE below
      // always locks an existing row — otherwise two cold concurrent txns would
      // both seed + apply (a lost update).
      await tx
        .insert(accounts)
        .values({
          accountId: input.accountId,
          name: null,
          creditBalanceUsd: 0,
          creditQuotaUsd: null,
          disabled: false,
          createdAt: input.nowMs,
        })
        .onConflictDoNothing({ target: accounts.accountId });

      const rows = await tx
        .select()
        .from(accounts)
        .where(eq(accounts.accountId, input.accountId))
        .limit(1)
        .for("update");
      if (input.kind === "debit" && input.requestId !== null) {
        const existingDebit = await tx
          .select({ balanceAfterUsd: creditLedger.balanceAfterUsd })
          .from(creditLedger)
          .where(
            and(
              eq(creditLedger.accountId, input.accountId),
              eq(creditLedger.requestId, input.requestId),
              eq(creditLedger.kind, "debit"),
            ),
          )
          .limit(1);
        if (existingDebit[0] !== undefined) {
          return { balanceAfter: existingDebit[0].balanceAfterUsd, ok: true };
        }
      }

      const current = rows[0]?.creditBalanceUsd ?? 0;
      const balanceAfter = current + input.amountUsd;

      await tx
        .update(accounts)
        .set({ creditBalanceUsd: balanceAfter })
        .where(eq(accounts.accountId, input.accountId));

      await tx.insert(creditLedger).values({
        id: this.genId(),
        accountId: input.accountId,
        requestId: input.requestId,
        apiKeyId: input.apiKeyId,
        amountUsd: input.amountUsd,
        balanceAfterUsd: balanceAfter,
        kind: input.kind,
        costMeasured: input.costMeasured,
        createdAt: input.nowMs,
      });

      return { balanceAfter, ok: true };
    });
  }

  async debit(input: CreditMovementInput): Promise<CreditMovementResult> {
    return this.applyMovement(input);
  }

  async topup(input: CreditMovementInput): Promise<CreditMovementResult> {
    return this.applyMovement(input);
  }

  async listAccounts(): Promise<AccountRecord[]> {
    const rows = await this.db.select().from(accounts);
    return rows.map((r) => ({
      account_id: r.accountId,
      name: r.name,
      credit_balance_usd: r.creditBalanceUsd,
      credit_quota_usd: r.creditQuotaUsd ?? null,
      disabled: r.disabled,
      created_at: r.createdAt,
    }));
  }

  async spendByAccount(accountId: string, fromMs: number, toMs: number): Promise<number> {
    const rows = await this.db
      .select({ total: sql<number>`COALESCE(SUM(${creditLedger.amountUsd}), 0)` })
      .from(creditLedger)
      .where(
        and(
          eq(creditLedger.accountId, accountId),
          eq(creditLedger.kind, "debit"),
          gte(creditLedger.createdAt, fromMs),
          lt(creditLedger.createdAt, toMs),
        ),
      );
    // COALESCE(SUM(...)) can round-trip as a string through the pg driver; Number()
    // normalizes it. amount_usd is negative for debits → negate to report spend.
    return -Number(rows[0]?.total ?? 0);
  }

  async recentLedger(accountId: string, limit: number): Promise<CreditLedgerEntry[]> {
    const rows = await this.db
      .select()
      .from(creditLedger)
      .where(eq(creditLedger.accountId, accountId))
      .orderBy(desc(creditLedger.createdAt))
      .limit(limit);
    return rows.map((r) => ({
      id: r.id,
      account_id: r.accountId,
      request_id: r.requestId ?? null,
      api_key_id: r.apiKeyId ?? null,
      amount_usd: r.amountUsd,
      balance_after_usd: r.balanceAfterUsd,
      kind: r.kind as CreditLedgerKind,
      cost_measured: r.costMeasured,
      created_at: r.createdAt,
    }));
  }
}
