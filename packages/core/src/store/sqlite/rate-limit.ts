import { and, eq } from "drizzle-orm";
import { type BucketState, tryConsume } from "../../ratelimit/token-bucket.js";
import type { RateLimitConsumeResult, RateLimitStore } from "../ports.js";
import type { SqliteDb } from "./migrate.js";
import { rateLimitBuckets } from "./schema.js";

// SQLite adapter for RateLimitStore. The read-modify-write of one (key_id, dim)
// bucket runs inside a better-sqlite3 transaction so two concurrent requests
// cannot both spend the last token (atomic compare-and-set on the persisted
// row). better-sqlite3 is synchronous, so the whole txn is a single tick — no
// interleaving. Counters persist in the DB, so windows survive a restart and are
// shared across instances on the same file/Postgres. Fail-CLOSED: any DB error
// propagates (the limiter rejects) — never silently "unlimited" (principle 3/5).
export class SqliteRateLimitStore implements RateLimitStore {
  constructor(private readonly db: SqliteDb) {}

  async consume(
    keyId: string,
    dim: "rpm" | "tpm",
    _state: BucketState | null,
    capacityPerMin: number,
    cost: number,
    nowMs: number,
  ): Promise<RateLimitConsumeResult> {
    const where = and(eq(rateLimitBuckets.keyId, keyId), eq(rateLimitBuckets.dim, dim));

    const txn = this.db.$sqlite.transaction((): RateLimitConsumeResult => {
      const row = this.db.select().from(rateLimitBuckets).where(where).get() as
        | { tokens: number; lastRefillMs: number }
        | undefined;

      // First sighting seeds a FULL bucket (capacity tokens) at `nowMs`.
      const current: BucketState = row
        ? { tokens: row.tokens, lastRefillMs: row.lastRefillMs }
        : { tokens: capacityPerMin, lastRefillMs: nowMs };

      const result = tryConsume(current, capacityPerMin, cost, nowMs);

      // Upsert the new bucket state (composite PK on key_id+dim).
      this.db
        .insert(rateLimitBuckets)
        .values({
          keyId,
          dim,
          tokens: result.state.tokens,
          lastRefillMs: result.state.lastRefillMs,
        })
        .onConflictDoUpdate({
          target: [rateLimitBuckets.keyId, rateLimitBuckets.dim],
          set: { tokens: result.state.tokens, lastRefillMs: result.state.lastRefillMs },
        })
        .run();

      return result;
    });

    return txn();
  }
}
