import { type OAuthUsageRow, OAuthUsageRowSchema } from "@helm/shared";
import { eq, sql } from "drizzle-orm";
import type { OAuthUsageStore } from "../ports.js";
import type { PgDb } from "./migrate.js";
import { oauthUsage } from "./schema.js";

type UsageRow = typeof oauthUsage.$inferSelect;

// Postgres adapter for the OAuthUsageStore port (providers page Tier 2) — the
// supabase mirror of the sqlite adapter. Additive upsert per (provider_id,
// account, day); cost_usd null-aware (NULL only while never measured). Pure
// aggregate counters — no key/payload (principle 7).
export class PgOAuthUsageStore implements OAuthUsageStore {
  constructor(private readonly db: PgDb) {}

  async record(input: {
    providerId: string;
    account: string;
    dayMs: number;
    tokens: number;
    costUsd: number | null;
    nowMs: number;
  }): Promise<void> {
    await this.db
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
          // null-aware sum: NULL only while BOTH sides are NULL (never measured).
          costUsd: sql`CASE WHEN ${oauthUsage.costUsd} IS NULL AND ${input.costUsd ?? null}::double precision IS NULL
            THEN NULL ELSE COALESCE(${oauthUsage.costUsd}, 0) + COALESCE(${input.costUsd ?? null}::double precision, 0) END`,
          firstSeenMs: sql`LEAST(${oauthUsage.firstSeenMs}, ${input.nowMs})`,
          updatedAt: input.nowMs,
        },
      });
  }

  async queryDay(dayMs: number): Promise<OAuthUsageRow[]> {
    const rows = await this.db.select().from(oauthUsage).where(eq(oauthUsage.day, dayMs));
    return rows.map((r) => this.toRow(r));
  }

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
