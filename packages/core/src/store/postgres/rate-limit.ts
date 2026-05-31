import { and, eq, sql } from "drizzle-orm";
import { type BucketState, tryConsume } from "../../ratelimit/token-bucket.js";
import type { RateLimitConsumeResult, RateLimitStore } from "../ports.js";
import type { PgDb } from "./migrate.js";
import { rateLimitBuckets } from "./schema.js";

// Postgres adapter for RateLimitStore — the supabase implementation. The
// read-modify-write of one (key_id, dim) bucket runs inside a transaction with a
// `SELECT ... FOR UPDATE` row lock so two concurrent requests cannot both spend
// the last token (atomic compare-and-set on the persisted row). Counters persist
// in Postgres, so windows survive a restart and are shared across instances.
// Fail-CLOSED: any DB error propagates (the limiter rejects) — never silently
// "unlimited" (principle 3/5).
export class PgRateLimitStore implements RateLimitStore {
  constructor(private readonly db: PgDb) {}

  async consume(
    keyId: string,
    dim: "rpm" | "tpm",
    _state: BucketState | null,
    capacityPerMin: number,
    cost: number,
    nowMs: number,
  ): Promise<RateLimitConsumeResult> {
    const where = and(eq(rateLimitBuckets.keyId, keyId), eq(rateLimitBuckets.dim, dim));

    return this.db.transaction(async (tx): Promise<RateLimitConsumeResult> => {
      // FOR UPDATE serializes concurrent consumers of the same bucket; the second
      // txn blocks until the first commits, then reads the updated row.
      const rows = await tx.select().from(rateLimitBuckets).where(where).limit(1).for("update");
      const row = rows[0];

      // First sighting seeds a FULL bucket (capacity tokens) at `nowMs`.
      const current: BucketState = row
        ? { tokens: row.tokens, lastRefillMs: row.lastRefillMs }
        : { tokens: capacityPerMin, lastRefillMs: nowMs };

      const result = tryConsume(current, capacityPerMin, cost, nowMs);

      // Upsert the new bucket state (composite PK on key_id+dim).
      await tx
        .insert(rateLimitBuckets)
        .values({
          keyId,
          dim,
          tokens: result.state.tokens,
          lastRefillMs: result.state.lastRefillMs,
        })
        .onConflictDoUpdate({
          target: [rateLimitBuckets.keyId, rateLimitBuckets.dim],
          set: {
            tokens: sql`excluded.tokens`,
            lastRefillMs: sql`excluded.last_refill_ms`,
          },
        });

      return result;
    });
  }
}
