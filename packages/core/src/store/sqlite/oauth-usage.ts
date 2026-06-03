import { type OAuthUsageRow, OAuthUsageRowSchema } from "@helm/shared";
import { eq, sql } from "drizzle-orm";
import type { OAuthUsageStore } from "../ports.js";
import type { SqliteDb } from "./migrate.js";
import { oauthUsage } from "./schema.js";

type UsageRow = typeof oauthUsage.$inferSelect;

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
    dayMs: number;
    tokens: number;
    costUsd: number | null;
    nowMs: number;
  }): Promise<void> {
    this.db
      .insert(oauthUsage)
      .values({
        providerId: input.providerId,
        account: input.account,
        day: input.dayMs,
        requests: 1,
        tokens: input.tokens,
        costUsd: input.costUsd,
        firstSeenMs: input.nowMs,
        updatedAt: input.nowMs,
      })
      .onConflictDoUpdate({
        target: [oauthUsage.providerId, oauthUsage.account, oauthUsage.day],
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

  async queryDay(dayMs: number): Promise<OAuthUsageRow[]> {
    const rows = this.db.select().from(oauthUsage).where(eq(oauthUsage.day, dayMs)).all();
    return rows.map((r) => this.toRow(r));
  }

  // Row -> OAuthUsageRow. Re-validates through the shared schema so a corrupted
  // row surfaces loudly rather than leaking a malformed shape.
  private toRow(row: UsageRow): OAuthUsageRow {
    return OAuthUsageRowSchema.parse({
      providerId: row.providerId,
      account: row.account,
      day: row.day,
      requests: row.requests,
      tokens: row.tokens,
      costUsd: row.costUsd,
      firstSeenMs: row.firstSeenMs,
      updatedAt: row.updatedAt,
    });
  }
}
