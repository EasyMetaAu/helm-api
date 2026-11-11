import { and, eq, sql } from "drizzle-orm";
import { weeklyPeriodStart } from "../../budget/weekly.js";
import { type BucketState, refill } from "../../ratelimit/token-bucket.js";
import type { BudgetDim, BudgetPeekResult, BudgetStore } from "../ports.js";
import type { PgDb } from "./migrate.js";
import { usageBudgetBuckets, weeklyBudgetUsage } from "./schema.js";

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
    weeklyAnchorMs?: number,
  ): Promise<BudgetPeekResult> {
    if (weeklyAnchorMs !== undefined) {
      const periodStartMs = weeklyPeriodStart(nowMs, weeklyAnchorMs);
      const query = this.db
        .select()
        .from(weeklyBudgetUsage)
        .where(
          and(
            eq(weeklyBudgetUsage.keyId, keyId),
            eq(weeklyBudgetUsage.dim, dim),
            eq(weeklyBudgetUsage.periodStartMs, periodStartMs),
          ),
        );
      const [row] = await query.limit(1);
      const remaining = capacity - (row?.used ?? 0);
      return { remaining, ok: remaining > 0 };
    }
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
    weeklyAnchorMs?: number,
  ): Promise<{ remaining: number }> {
    if (weeklyAnchorMs !== undefined)
      return this.changeWeekly(keyId, dim, capacity, amount, nowMs, weeklyAnchorMs, false);
    const result = await this.change(keyId, dim, capacity, windowMs, amount, nowMs, false);
    return { remaining: result.remaining };
  }

  async reserveRequest(
    keyId: string,
    capacity: number,
    windowMs: number,
    nowMs: number,
    weeklyAnchorMs?: number,
  ): Promise<boolean> {
    if (weeklyAnchorMs !== undefined)
      return (await this.changeWeekly(keyId, "req", capacity, 1, nowMs, weeklyAnchorMs, true))
        .accepted;
    return (await this.change(keyId, "req", capacity, windowMs, 1, nowMs, true)).accepted;
  }

  private async change(
    keyId: string,
    dim: BudgetDim,
    capacity: number,
    windowMs: number,
    amount: number,
    nowMs: number,
    requireAvailable: boolean,
  ): Promise<{ remaining: number; accepted: boolean }> {
    const where = and(eq(usageBudgetBuckets.keyId, keyId), eq(usageBudgetBuckets.dim, dim));

    return this.db.transaction(async (tx): Promise<{ remaining: number; accepted: boolean }> => {
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
      if (requireAvailable && refilled.tokens < amount)
        return { remaining: refilled.tokens, accepted: false };
      const tokens = refilled.tokens - amount;

      await tx
        .insert(usageBudgetBuckets)
        .values({ keyId, dim, tokens, lastRefillMs: refilled.lastRefillMs })
        .onConflictDoUpdate({
          target: [usageBudgetBuckets.keyId, usageBudgetBuckets.dim],
          set: { tokens: sql`excluded.tokens`, lastRefillMs: sql`excluded.last_refill_ms` },
        });

      return { remaining: tokens, accepted: true };
    });
  }
  private async changeWeekly(
    keyId: string,
    dim: BudgetDim,
    capacity: number,
    amount: number,
    nowMs: number,
    anchorMs: number,
    requireAvailable: boolean,
  ): Promise<{ remaining: number; accepted: boolean }> {
    const periodStartMs = weeklyPeriodStart(nowMs, anchorMs);
    const where = and(
      eq(weeklyBudgetUsage.keyId, keyId),
      eq(weeklyBudgetUsage.dim, dim),
      eq(weeklyBudgetUsage.periodStartMs, periodStartMs),
    );
    return this.db.transaction(async (tx) => {
      await tx
        .insert(weeklyBudgetUsage)
        .values({ keyId, dim, periodStartMs, used: 0 })
        .onConflictDoNothing();
      const [row] = await tx.select().from(weeklyBudgetUsage).where(where).limit(1).for("update");
      if (!row) throw new Error("weekly budget row unavailable");
      if (requireAvailable && capacity - row.used < amount)
        return { remaining: capacity - row.used, accepted: false };
      const used = row.used + amount;
      await tx.update(weeklyBudgetUsage).set({ used }).where(where);
      return { remaining: capacity - used, accepted: true };
    });
  }
}
