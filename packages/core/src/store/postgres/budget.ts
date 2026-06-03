import { and, eq, sql } from "drizzle-orm";
import { type BucketState, refill } from "../../ratelimit/token-bucket.js";
import type { BudgetDim, BudgetPeekResult, BudgetStore } from "../ports.js";
import type { PgDb } from "./migrate.js";
import { usageBudgetBuckets } from "./schema.js";

// Postgres adapter for BudgetStore (docs/06 "usage budgets") — the supabase
// implementation. `peek` (pre-route sign check) is READ-ONLY. `debit` (post-served
// settle) runs the read-modify-write inside a transaction with `SELECT ... FOR
// UPDATE` row locking so two concurrent settles on the same (key_id, dim) serialize
// and never lose an update. A debit ALWAYS applies (may go negative — soft cap
// settled after the request, not a hard reservation). key_id only (principle 7).
export class PgBudgetStore implements BudgetStore {
  constructor(private readonly db: PgDb) {}

  async peek(
    keyId: string,
    dim: BudgetDim,
    capacity: number,
    windowMs: number,
    nowMs: number,
  ): Promise<BudgetPeekResult> {
    const rows = await this.db
      .select()
      .from(usageBudgetBuckets)
      .where(and(eq(usageBudgetBuckets.keyId, keyId), eq(usageBudgetBuckets.dim, dim)))
      .limit(1);
    const row = rows[0];

    const current: BucketState = row
      ? { tokens: row.tokens, lastRefillMs: row.lastRefillMs }
      : { tokens: capacity, lastRefillMs: nowMs };
    const remaining = refill(current, capacity, nowMs, windowMs).tokens;
    return { remaining, ok: remaining > 0 };
  }

  async debit(
    keyId: string,
    dim: BudgetDim,
    capacity: number,
    windowMs: number,
    amount: number,
    nowMs: number,
  ): Promise<{ remaining: number }> {
    const where = and(eq(usageBudgetBuckets.keyId, keyId), eq(usageBudgetBuckets.dim, dim));

    return this.db.transaction(async (tx): Promise<{ remaining: number }> => {
      // Seed a FULL bucket FIRST (no-op if present) so the FOR UPDATE below always
      // locks an existing row — otherwise two cold concurrent settles would both
      // seed + debit a full bucket (a lost update).
      await tx
        .insert(usageBudgetBuckets)
        .values({ keyId, dim, tokens: capacity, lastRefillMs: nowMs })
        .onConflictDoNothing({ target: [usageBudgetBuckets.keyId, usageBudgetBuckets.dim] });

      const rows = await tx.select().from(usageBudgetBuckets).where(where).limit(1).for("update");
      const row = rows[0];
      const current: BucketState = row
        ? { tokens: row.tokens, lastRefillMs: row.lastRefillMs }
        : { tokens: capacity, lastRefillMs: nowMs };

      const refilled = refill(current, capacity, nowMs, windowMs);
      const tokens = refilled.tokens - amount;

      await tx
        .insert(usageBudgetBuckets)
        .values({ keyId, dim, tokens, lastRefillMs: refilled.lastRefillMs })
        .onConflictDoUpdate({
          target: [usageBudgetBuckets.keyId, usageBudgetBuckets.dim],
          set: { tokens: sql`excluded.tokens`, lastRefillMs: sql`excluded.last_refill_ms` },
        });

      return { remaining: tokens };
    });
  }
}
