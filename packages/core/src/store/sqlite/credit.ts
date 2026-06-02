import { randomUUID } from "node:crypto";
import type { AccountRecord, CreditLedgerEntry, CreditLedgerKind } from "@helm/shared";
import { and, desc, eq, gte, lt, sql } from "drizzle-orm";
import type {
  AccountBalance,
  CreditMovementInput,
  CreditMovementResult,
  CreditStore,
} from "../ports.js";
import type { SqliteDb } from "./migrate.js";
import { accounts, creditLedger } from "./schema.js";

// SQLite adapter for the CreditStore port (Issue #37). The balance update + ledger
// insert run inside a SINGLE better-sqlite3 transaction so two concurrent
// debits/topups can never lose an update or double-spend the last credit
// (better-sqlite3 is synchronous, so each txn is one tick — no interleaving;
// mirrors SqliteRateLimitStore). getBalance READS propagate errors (fail-closed at
// the gate). api_key_id is key_id only — never plaintext/hash (principle 7).
export class SqliteCreditStore implements CreditStore {
  constructor(
    private readonly db: SqliteDb,
    private readonly genId: () => string = randomUUID,
  ) {}

  async getBalance(accountId: string): Promise<AccountBalance | null> {
    const row = this.db.select().from(accounts).where(eq(accounts.accountId, accountId)).get() as
      | { creditBalanceUsd: number; creditQuotaUsd: number | null; disabled: boolean }
      | undefined;
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
    // Insert-if-absent; an existing row (with its balance) is left untouched.
    this.db
      .insert(accounts)
      .values({
        accountId: account.accountId,
        name: account.name ?? null,
        creditBalanceUsd: 0,
        creditQuotaUsd: null,
        disabled: false,
        createdAt: new Date(account.nowMs),
      })
      .onConflictDoNothing({ target: accounts.accountId })
      .run();
  }

  // Shared atomic movement: refill the row (auto-provision a zero-balance account
  // if missing), add the SIGNED amount, persist the new balance + append the
  // ledger row — all in one synchronous transaction.
  private applyMovement(input: CreditMovementInput): CreditMovementResult {
    const txn = this.db.$sqlite.transaction((): CreditMovementResult => {
      if (input.kind === "debit" && input.requestId !== null) {
        const existingDebit = this.db
          .select({ balanceAfterUsd: creditLedger.balanceAfterUsd })
          .from(creditLedger)
          .where(
            and(
              eq(creditLedger.accountId, input.accountId),
              eq(creditLedger.requestId, input.requestId),
              eq(creditLedger.kind, "debit"),
            ),
          )
          .get() as { balanceAfterUsd: number } | undefined;
        if (existingDebit !== undefined)
          return { balanceAfter: existingDebit.balanceAfterUsd, ok: true };
      }

      const existing = this.db
        .select()
        .from(accounts)
        .where(eq(accounts.accountId, input.accountId))
        .get() as { creditBalanceUsd: number } | undefined;

      if (existing === undefined) {
        this.db
          .insert(accounts)
          .values({
            accountId: input.accountId,
            name: null,
            creditBalanceUsd: 0,
            creditQuotaUsd: null,
            disabled: false,
            createdAt: new Date(input.nowMs),
          })
          .onConflictDoNothing({ target: accounts.accountId })
          .run();
      }

      const current = existing?.creditBalanceUsd ?? 0;
      const balanceAfter = current + input.amountUsd;

      this.db
        .update(accounts)
        .set({ creditBalanceUsd: balanceAfter })
        .where(eq(accounts.accountId, input.accountId))
        .run();

      this.db
        .insert(creditLedger)
        .values({
          id: this.genId(),
          accountId: input.accountId,
          requestId: input.requestId,
          apiKeyId: input.apiKeyId,
          amountUsd: input.amountUsd,
          balanceAfterUsd: balanceAfter,
          kind: input.kind,
          costMeasured: input.costMeasured,
          createdAt: new Date(input.nowMs),
        })
        .run();

      return { balanceAfter, ok: true };
    });
    return txn();
  }

  async debit(input: CreditMovementInput): Promise<CreditMovementResult> {
    return this.applyMovement(input);
  }

  async topup(input: CreditMovementInput): Promise<CreditMovementResult> {
    return this.applyMovement(input);
  }

  async listAccounts(): Promise<AccountRecord[]> {
    const rows = this.db.select().from(accounts).all() as Array<{
      accountId: string;
      name: string | null;
      creditBalanceUsd: number;
      creditQuotaUsd: number | null;
      disabled: boolean;
      createdAt: Date;
    }>;
    return rows.map((r) => ({
      account_id: r.accountId,
      name: r.name,
      credit_balance_usd: r.creditBalanceUsd,
      credit_quota_usd: r.creditQuotaUsd ?? null,
      disabled: r.disabled,
      created_at: r.createdAt.getTime(),
    }));
  }

  async spendByAccount(accountId: string, fromMs: number, toMs: number): Promise<number> {
    // Σ of |debit amounts| in [fromMs, toMs). Topups/adjustments are excluded —
    // spend is the cost served, not balance movement. amount_usd is negative for
    // debits, so negate the sum to report a positive spend figure.
    const row = this.db
      .select({ total: sql<number>`COALESCE(SUM(${creditLedger.amountUsd}), 0)` })
      .from(creditLedger)
      .where(
        and(
          eq(creditLedger.accountId, accountId),
          eq(creditLedger.kind, "debit"),
          gte(creditLedger.createdAt, new Date(fromMs)),
          lt(creditLedger.createdAt, new Date(toMs)),
        ),
      )
      .get() as { total: number } | undefined;
    return -(row?.total ?? 0);
  }

  async recentLedger(accountId: string, limit: number): Promise<CreditLedgerEntry[]> {
    const rows = this.db
      .select()
      .from(creditLedger)
      .where(eq(creditLedger.accountId, accountId))
      .orderBy(desc(creditLedger.createdAt))
      .limit(limit)
      .all() as Array<{
      id: string;
      accountId: string;
      requestId: string | null;
      apiKeyId: string | null;
      amountUsd: number;
      balanceAfterUsd: number;
      kind: string;
      costMeasured: boolean;
      createdAt: Date;
    }>;
    return rows.map((r) => ({
      id: r.id,
      account_id: r.accountId,
      request_id: r.requestId ?? null,
      api_key_id: r.apiKeyId ?? null,
      amount_usd: r.amountUsd,
      balance_after_usd: r.balanceAfterUsd,
      kind: r.kind as CreditLedgerKind,
      cost_measured: r.costMeasured,
      created_at: r.createdAt.getTime(),
    }));
  }
}
