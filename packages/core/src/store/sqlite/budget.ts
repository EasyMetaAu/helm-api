import { type MediaSpendRecord, MediaSpendRecordSchema } from "@helm/shared";
import { and, eq } from "drizzle-orm";
import { weeklyPeriodStart } from "../../budget/weekly.js";
import { type BucketState, refill } from "../../ratelimit/token-bucket.js";
import type { BudgetDim, BudgetPeekResult, BudgetStore } from "../ports.js";
import type { SqliteDb } from "./migrate.js";
import { mediaSpendRecords, usageBudgetBuckets, weeklyBudgetUsage } from "./schema.js";

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

  async getMediaSpend(id: string, keyId: string): Promise<MediaSpendRecord | null> {
    const row = this.db
      .select()
      .from(mediaSpendRecords)
      .where(and(eq(mediaSpendRecords.id, id), eq(mediaSpendRecords.keyId, keyId)))
      .get();
    return row ? MediaSpendRecordSchema.parse(JSON.parse(row.recordJson)) : null;
  }
  async reserveMediaSpend(raw: MediaSpendRecord): Promise<boolean> {
    const record = MediaSpendRecordSchema.parse(raw);
    if (record.state !== "reserved" || record.costUsd !== null)
      throw new Error("invalid media reservation");
    return this.db.$sqlite.transaction(() => {
      if (record.capacity !== null) {
        const debit =
          record.anchorMs === null
            ? this.change(
                record.keyId,
                "usd",
                record.capacity,
                record.windowMs,
                record.reservedUsd,
                record.admittedAtMs,
                true,
              )
            : this.changeWeekly(
                record.keyId,
                "usd",
                record.capacity,
                record.reservedUsd,
                record.admittedAtMs,
                record.anchorMs,
                true,
              );
        if (!debit.accepted) return false;
      }
      this.db
        .insert(mediaSpendRecords)
        .values({ id: record.id, keyId: record.keyId, recordJson: JSON.stringify(record) })
        .run();
      return true;
    })();
  }
  async settleMediaSpend(
    id: string,
    keyId: string,
    result: { costUsd: number | null; usage: Record<string, unknown> | null },
    nowMs: number,
  ): Promise<MediaSpendRecord | null> {
    return this.db.$sqlite.transaction(() => {
      const row = this.db
        .select()
        .from(mediaSpendRecords)
        .where(and(eq(mediaSpendRecords.id, id), eq(mediaSpendRecords.keyId, keyId)))
        .get();
      if (!row) return null;
      const record = MediaSpendRecordSchema.parse(JSON.parse(row.recordJson));
      if (record.state === "settled") return record;
      const next = MediaSpendRecordSchema.parse({
        ...record,
        ...result,
        state: result.costUsd === null ? "outcome_unknown" : "settled",
      });
      if (record.capacity !== null && next.costUsd !== null) {
        const amount = next.costUsd - record.reservedUsd;
        if (record.anchorMs === null)
          this.change(keyId, "usd", record.capacity, record.windowMs, amount, nowMs, false);
        else
          this.changeWeekly(
            keyId,
            "usd",
            record.capacity,
            amount,
            record.admittedAtMs,
            record.anchorMs,
            false,
          );
      }
      this.db
        .update(mediaSpendRecords)
        .set({ recordJson: JSON.stringify(next) })
        .where(eq(mediaSpendRecords.id, id))
        .run();
      return next;
    })();
  }
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
      const row = query.get();
      const remaining = capacity - (row?.used ?? 0);
      return { remaining, ok: remaining > 0 };
    }
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

  private change(
    keyId: string,
    dim: BudgetDim,
    capacity: number,
    windowMs: number,
    amount: number,
    nowMs: number,
    requireAvailable: boolean,
  ): { remaining: number; accepted: boolean } {
    const where = and(eq(usageBudgetBuckets.keyId, keyId), eq(usageBudgetBuckets.dim, dim));

    const txn = this.db.$sqlite.transaction((): { remaining: number; accepted: boolean } => {
      const row = this.db.select().from(usageBudgetBuckets).where(where).get() as
        | { tokens: number; lastRefillMs: number }
        | undefined;

      const current: BucketState = row
        ? { tokens: row.tokens, lastRefillMs: row.lastRefillMs }
        : { tokens: capacity, lastRefillMs: nowMs };

      // Refill to now, then subtract the settled amount. NO floor at 0 — a budget
      // is a soft cap, so over-spend pushes the bucket negative until it refills.
      const refilled = refill(current, capacity, nowMs, windowMs);
      if (requireAvailable && refilled.tokens < amount)
        return { remaining: refilled.tokens, accepted: false };
      const tokens = refilled.tokens - amount;

      this.db
        .insert(usageBudgetBuckets)
        .values({ keyId, dim, tokens, lastRefillMs: refilled.lastRefillMs })
        .onConflictDoUpdate({
          target: [usageBudgetBuckets.keyId, usageBudgetBuckets.dim],
          set: { tokens, lastRefillMs: refilled.lastRefillMs },
        })
        .run();

      return { remaining: tokens, accepted: true };
    });

    return txn();
  }
  private changeWeekly(
    keyId: string,
    dim: BudgetDim,
    capacity: number,
    amount: number,
    nowMs: number,
    anchorMs: number,
    requireAvailable: boolean,
  ): { remaining: number; accepted: boolean } {
    const periodStartMs = weeklyPeriodStart(nowMs, anchorMs);
    const where = and(
      eq(weeklyBudgetUsage.keyId, keyId),
      eq(weeklyBudgetUsage.dim, dim),
      eq(weeklyBudgetUsage.periodStartMs, periodStartMs),
    );
    return this.db.$sqlite.transaction(() => {
      const row = this.db.select().from(weeklyBudgetUsage).where(where).get();
      const used = row?.used ?? 0;
      if (requireAvailable && capacity - used < amount)
        return { remaining: capacity - used, accepted: false };
      this.db
        .insert(weeklyBudgetUsage)
        .values({ keyId, dim, periodStartMs, used: used + amount })
        .onConflictDoUpdate({
          target: [weeklyBudgetUsage.keyId, weeklyBudgetUsage.dim, weeklyBudgetUsage.periodStartMs],
          set: { used: used + amount },
        })
        .run();
      return { remaining: capacity - used - amount, accepted: true };
    })();
  }
}
