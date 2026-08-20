import { type OAuthResetPeriod, OAuthResetPeriodSchema } from "@helm/shared";
import { and, desc, eq, lte, sql } from "drizzle-orm";
import type { OAuthResetPeriodStore } from "../ports.js";
import type { PgDb } from "./migrate.js";
import { oauthResetPeriod } from "./schema.js";

// PgOAuthResetPeriodStore — pg mirror of the sqlite adapter. Idempotent append via
// onConflictDoNothing for estimates; a later exact observation may replace one. Bigint
// columns marshal as strings, so Number()-normalize before the shared schema parse.
export class PgOAuthResetPeriodStore implements OAuthResetPeriodStore {
  constructor(private readonly db: PgDb) {}

  async record(row: OAuthResetPeriod): Promise<void> {
    const insert = this.db.insert(oauthResetPeriod).values({
      providerId: row.providerId,
      account: row.account,
      windowKey: row.windowKey,
      periodStartMs: row.periodStartMs,
      periodEndMs: row.periodEndMs,
      detectedAtMs: row.detectedAtMs,
      usedPercent: row.usedPercent ?? null,
      approximate: row.approximate,
    });
    const target = [
      oauthResetPeriod.providerId,
      oauthResetPeriod.account,
      oauthResetPeriod.windowKey,
      oauthResetPeriod.periodStartMs,
    ];
    if (row.approximate) {
      await insert.onConflictDoNothing({ target });
      return;
    }
    await insert.onConflictDoUpdate({
      target,
      set: {
        periodEndMs: row.periodEndMs,
        detectedAtMs: row.detectedAtMs,
        usedPercent: row.usedPercent ?? null,
        approximate: false,
      },
      setWhere: eq(oauthResetPeriod.approximate, true),
    });
  }

  async queryPeriods(
    providerId: string,
    account: string,
    windowKey: string,
    limit: number,
  ): Promise<OAuthResetPeriod[]> {
    const rows = await this.db
      .select()
      .from(oauthResetPeriod)
      .where(
        and(
          eq(oauthResetPeriod.providerId, providerId),
          eq(oauthResetPeriod.account, account),
          eq(oauthResetPeriod.windowKey, windowKey),
        ),
      )
      .orderBy(desc(oauthResetPeriod.periodEndMs))
      .limit(limit);
    return rows.map((r) =>
      OAuthResetPeriodSchema.parse({
        providerId: r.providerId,
        account: r.account,
        windowKey: r.windowKey,
        periodStartMs: Number(r.periodStartMs),
        periodEndMs: Number(r.periodEndMs),
        detectedAtMs: Number(r.detectedAtMs),
        usedPercent: r.usedPercent == null ? null : Number(r.usedPercent),
        approximate: r.approximate,
      }),
    );
  }

  async latestResetAt(
    providerId: string,
    account: string,
    beforeMs: number,
    windowKey?: string,
  ): Promise<number | null> {
    const rows = await this.db
      .select({ periodEndMs: oauthResetPeriod.periodEndMs })
      .from(oauthResetPeriod)
      .where(
        and(
          eq(oauthResetPeriod.providerId, providerId),
          eq(oauthResetPeriod.account, account),
          ...(windowKey === undefined ? [] : [eq(oauthResetPeriod.windowKey, windowKey)]),
          lte(oauthResetPeriod.periodEndMs, beforeMs),
          eq(oauthResetPeriod.approximate, false),
          sql`${oauthResetPeriod.detectedAtMs} >= ${oauthResetPeriod.periodEndMs}`,
        ),
      )
      .orderBy(desc(oauthResetPeriod.periodEndMs))
      .limit(1);
    return rows[0] ? Number(rows[0].periodEndMs) : null;
  }
}
