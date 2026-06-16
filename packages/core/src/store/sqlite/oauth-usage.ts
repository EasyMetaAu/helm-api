import { type OAuthUsageRow, OAuthUsageRowSchema } from "@helm/shared";
import { and, gte, lt, sql } from "drizzle-orm";
import type { OAuthUsageStore } from "../ports.js";
import type { SqliteDb } from "./migrate.js";
import { oauthUsage } from "./schema.js";

// SQLite adapter for the OAuthUsageStore port (providers page Tier 2). One row per
// (provider_id, account, day); `record` is an additive upsert via the composite
// PRIMARY KEY so each served OAuth call folds into today's aggregate. cost_usd is
// null-aware (stays NULL until a measured cost arrives — flat-rate plans report
// none). Pure aggregate counters — no key/payload (principle 7).
export class SqliteOAuthUsageStore implements OAuthUsageStore {
  constructor(private readonly db: SqliteDb) {}

  async record(input: {
    providerId: string;
    account: string;
    bucketMs: number;
    tokens: number;
    costUsd: number | null;
    nowMs: number;
  }): Promise<void> {
    this.db
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
          // null-aware sum: NULL only while BOTH sides are NULL (never measured);
          // any measured value makes the running total concrete (treating the
          // missing side as 0) — keeps "unpriced" distinct from a measured 0.
          costUsd: sql`CASE WHEN ${oauthUsage.costUsd} IS NULL AND ${input.costUsd ?? null} IS NULL
            THEN NULL ELSE COALESCE(${oauthUsage.costUsd}, 0) + COALESCE(${input.costUsd ?? null}, 0) END`,
          firstSeenMs: sql`MIN(${oauthUsage.firstSeenMs}, ${input.nowMs})`,
          updatedAt: input.nowMs,
        },
      })
      .run();
  }

  // Roll the per-hour buckets up to per-(provider, account) totals over the
  // half-open window [startMs, endMs). SUM(cost_usd) is intrinsically null-aware in
  // SQL — it ignores NULL inputs and returns NULL only when EVERY row is unpriced,
  // so "unpriced" stays distinct from a measured 0. firstSeenMs is the MIN across
  // the window (anchors RPM); updatedAt is the latest write (MAX). The GROUP BY
  // emits a row per account that had any traffic in the window.
  async queryRange(startMs: number, endMs: number): Promise<OAuthUsageRow[]> {
    const rows = this.db
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
      .groupBy(oauthUsage.providerId, oauthUsage.account)
      .all();
    return rows.map((r) => this.toRow(r));
  }

  // Aggregated row -> OAuthUsageRow. Re-validates through the shared schema so a
  // corrupted row surfaces loudly rather than leaking a malformed shape.
  private toRow(row: {
    providerId: string;
    account: string;
    requests: number;
    tokens: number;
    costUsd: number | null;
    firstSeenMs: number;
    updatedAt: number;
  }): OAuthUsageRow {
    return OAuthUsageRowSchema.parse({
      providerId: row.providerId,
      account: row.account,
      requests: row.requests,
      tokens: row.tokens,
      costUsd: row.costUsd,
      firstSeenMs: row.firstSeenMs,
      updatedAt: row.updatedAt,
    });
  }
}
