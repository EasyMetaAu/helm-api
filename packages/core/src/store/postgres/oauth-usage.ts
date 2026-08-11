import {
  type OAuthUsageBucket,
  OAuthUsageBucketSchema,
  type OAuthUsageRow,
  OAuthUsageRowSchema,
} from "@helm/shared";
import { and, count, eq, gte, lt, sql } from "drizzle-orm";
import type { OAuthUsageStore } from "../ports.js";
import type { PgDb } from "./migrate.js";
import { oauthUsage } from "./schema.js";

const PG_RETENTION_PRUNE_BATCH_ROWS = 1_000;

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

  // Raw hour buckets for ONE account over [startMs, endMs), ascending. pg marshals
  // bigint counters as strings, so Number()-normalize before the shared schema parse.
  async queryBuckets(
    startMs: number,
    endMs: number,
    providerId: string,
    account: string,
  ): Promise<OAuthUsageBucket[]> {
    const rows = await this.db
      .select({
        bucketMs: oauthUsage.bucketMs,
        requests: oauthUsage.requests,
        tokens: oauthUsage.tokens,
        costUsd: oauthUsage.costUsd,
      })
      .from(oauthUsage)
      .where(
        and(
          eq(oauthUsage.providerId, providerId),
          eq(oauthUsage.account, account),
          gte(oauthUsage.bucketMs, startMs),
          lt(oauthUsage.bucketMs, endMs),
        ),
      )
      .orderBy(oauthUsage.bucketMs);
    return rows.map((r) =>
      OAuthUsageBucketSchema.parse({
        bucketMs: Number(r.bucketMs),
        requests: Number(r.requests),
        tokens: Number(r.tokens),
        costUsd: r.costUsd == null ? null : Number(r.costUsd),
      }),
    );
  }

  // Cleanup: count / delete hour buckets strictly older than the cutoff (bucket_ms).
  async countUsageOlderThan(olderThanMs: number): Promise<number> {
    const rows = await this.db
      .select({ value: count() })
      .from(oauthUsage)
      .where(lt(oauthUsage.bucketMs, olderThanMs));
    return rows[0]?.value ?? 0;
  }

  async pruneUsageOlderThan(olderThanMs: number): Promise<number> {
    let total = 0;
    for (;;) {
      const result = (await this.db.execute(sql`
        WITH doomed AS (
          SELECT provider_id, account, bucket_ms FROM oauth_usage
           WHERE bucket_ms < ${olderThanMs}
           ORDER BY bucket_ms, provider_id, account
           LIMIT ${PG_RETENTION_PRUNE_BATCH_ROWS}
        ), deleted AS (
          DELETE FROM oauth_usage u USING doomed d
           WHERE u.provider_id = d.provider_id
             AND u.account = d.account
             AND u.bucket_ms = d.bucket_ms
          RETURNING 1
        )
        SELECT COUNT(*)::int AS deleted FROM deleted
      `)) as { rows?: Array<{ deleted: number | string }> } | Array<{ deleted: number | string }>;
      const rows = Array.isArray(result) ? result : (result.rows ?? []);
      const deleted = Number(rows[0]?.deleted ?? 0);
      total += deleted;
      if (deleted < PG_RETENTION_PRUNE_BATCH_ROWS) return total;
    }
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
