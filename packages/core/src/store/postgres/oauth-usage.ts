import { type OAuthUsageRow, OAuthUsageRowSchema } from "@helm/shared";
import { and, gte, lt, sql } from "drizzle-orm";
import type { OAuthUsageStore } from "../ports.js";
import type { PgDb } from "./migrate.js";
import { oauthUsage } from "./schema.js";

// Postgres adapter for the OAuthUsageStore port (providers page Tier 2) — the
// supabase mirror of the sqlite adapter. Additive upsert per (provider_id,
// account, day); cost_usd null-aware (NULL only while never measured). Pure
// aggregate counters — no key/payload (principle 7).
export class PgOAuthUsageStore implements OAuthUsageStore {
  constructor(private readonly db: PgDb) {}

  async record(input: {
    providerId: string;
    account: string;
    bucketMs: number;
    tokens: number;
    costUsd: number | null;
    nowMs: number;
  }): Promise<void> {
    await this.db
      .insert(oauthUsage)
      .values({
        providerId: input.providerId,
        account: input.account,
        bucketMs: input.bucketMs,
        requests: 1,
        tokens: input.tokens,
        costUsd: input.costUsd,
        firstSeenMs: input.nowMs,
        updatedAt: input.nowMs,
      })
      .onConflictDoUpdate({
        target: [oauthUsage.providerId, oauthUsage.account, oauthUsage.bucketMs],
        set: {
          requests: sql`${oauthUsage.requests} + 1`,
          tokens: sql`${oauthUsage.tokens} + ${input.tokens}`,
          // null-aware sum: NULL only while BOTH sides are NULL (never measured).
          costUsd: sql`CASE WHEN ${oauthUsage.costUsd} IS NULL AND ${input.costUsd ?? null}::double precision IS NULL
            THEN NULL ELSE COALESCE(${oauthUsage.costUsd}, 0) + COALESCE(${input.costUsd ?? null}::double precision, 0) END`,
          firstSeenMs: sql`LEAST(${oauthUsage.firstSeenMs}, ${input.nowMs})`,
          updatedAt: input.nowMs,
        },
      });
  }

  // Roll the per-hour buckets up to per-(provider, account) totals over [startMs,
  // endMs) — pg mirror of the sqlite adapter. SUM(cost_usd) is intrinsically
  // null-aware (NULL only when every row is unpriced). firstSeenMs = MIN, updatedAt
  // = MAX. Contract-tested for parity with sqlite.
  async queryRange(startMs: number, endMs: number): Promise<OAuthUsageRow[]> {
    const rows = await this.db
      .select({
        providerId: oauthUsage.providerId,
        account: oauthUsage.account,
        requests: sql<number>`COALESCE(SUM(${oauthUsage.requests}), 0)`,
        tokens: sql<number>`COALESCE(SUM(${oauthUsage.tokens}), 0)`,
        costUsd: sql<number | null>`SUM(${oauthUsage.costUsd})`,
        firstSeenMs: sql<number>`MIN(${oauthUsage.firstSeenMs})`,
        updatedAt: sql<number>`MAX(${oauthUsage.updatedAt})`,
      })
      .from(oauthUsage)
      .where(and(gte(oauthUsage.bucketMs, startMs), lt(oauthUsage.bucketMs, endMs)))
      .groupBy(oauthUsage.providerId, oauthUsage.account);
    return rows.map((r) => this.toRow(r));
  }

  // Aggregated row -> OAuthUsageRow. pg marshals SUM()/MIN()/MAX() over bigint as
  // STRINGS (avoids 2^53 loss), so Number() normalizes the integer counters;
  // cost_usd is double precision (number|null). Re-validates through the shared
  // schema so a corrupted row surfaces loudly.
  private toRow(row: {
    providerId: string;
    account: string;
    requests: unknown;
    tokens: unknown;
    costUsd: unknown;
    firstSeenMs: unknown;
    updatedAt: unknown;
  }): OAuthUsageRow {
    const num = (v: unknown): number => (v == null ? 0 : Number(v));
    return OAuthUsageRowSchema.parse({
      providerId: row.providerId,
      account: row.account,
      requests: num(row.requests),
      tokens: num(row.tokens),
      costUsd: row.costUsd == null ? null : Number(row.costUsd),
      firstSeenMs: num(row.firstSeenMs),
      updatedAt: num(row.updatedAt),
    });
  }
}
