import { and, eq } from "drizzle-orm";
import { type BucketState, refill } from "../../ratelimit/token-bucket.js";
import type { BudgetDim, BudgetPeekResult, BudgetStore } from "../ports.js";
import type { SqliteDb } from "./migrate.js";
import { usageBudgetBuckets } from "./schema.js";

// SQLite adapter for BudgetStore (docs/06 "usage budgets"). Reuses the pure
// token-bucket refill math with a CONFIGURABLE window. `peek` is READ-ONLY (the
// pre-route sign check), so it computes the refilled level without writing. `debit`
// (post-served settle) runs the read-modify-write inside a better-sqlite3
// transaction — synchronous, single tick, no interleaving — so two concurrent
// settles on the same (key_id, dim) cannot lose an update. Unlike the rate limiter,
// a debit ALWAYS applies (may push tokens negative): a budget is a soft cap settled
// after the request, not a hard pre-reservation. key_id only (principle 7).
export class SqliteBudgetStore implements BudgetStore {
  constructor(private readonly db: SqliteDb) {}

  async peek(
    keyId: string,
    dim: BudgetDim,
    capacity: number,
    windowMs: number,
    nowMs: number,
  ): Promise<BudgetPeekResult> {
    const row = this.db
      .select()
      .from(usageBudgetBuckets)
      .where(and(eq(usageBudgetBuckets.keyId, keyId), eq(usageBudgetBuckets.dim, dim)))
      .get() as { tokens: number; lastRefillMs: number } | undefined;

    // A cold bucket reads as FULL (the key has its whole budget available).
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

    const txn = this.db.$sqlite.transaction((): { remaining: number } => {
      const row = this.db.select().from(usageBudgetBuckets).where(where).get() as
        | { tokens: number; lastRefillMs: number }
        | undefined;

      const current: BucketState = row
        ? { tokens: row.tokens, lastRefillMs: row.lastRefillMs }
        : { tokens: capacity, lastRefillMs: nowMs };

      // Refill to now, then subtract the settled amount. NO floor at 0 — a budget
      // is a soft cap, so over-spend pushes the bucket negative until it refills.
      const refilled = refill(current, capacity, nowMs, windowMs);
      const tokens = refilled.tokens - amount;

      this.db
        .insert(usageBudgetBuckets)
        .values({ keyId, dim, tokens, lastRefillMs: refilled.lastRefillMs })
        .onConflictDoUpdate({
          target: [usageBudgetBuckets.keyId, usageBudgetBuckets.dim],
          set: { tokens, lastRefillMs: refilled.lastRefillMs },
        })
        .run();

      return { remaining: tokens };
    });

    return txn();
  }
}
