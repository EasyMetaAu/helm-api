import { type OAuthResetPeriod, OAuthResetPeriodSchema } from "@helm/shared";
import { and, desc, eq, lte, sql } from "drizzle-orm";
import type { OAuthResetPeriodStore } from "../ports.js";
import type { SqliteDb } from "./migrate.js";
import { oauthResetPeriod } from "./schema.js";

// SqliteOAuthResetPeriodStore — append-only history of real reset boundaries. `record`
// is idempotent on the composite PK; a later exact observation may replace an estimate.
// Pure observability — no key/payload.
export class SqliteOAuthResetPeriodStore implements OAuthResetPeriodStore {
  constructor(private readonly db: SqliteDb) {}

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
      insert.onConflictDoNothing({ target }).run();
      return;
    }
    insert
      .onConflictDoUpdate({
        target,
        set: {
          periodEndMs: row.periodEndMs,
          detectedAtMs: row.detectedAtMs,
          usedPercent: row.usedPercent ?? null,
          approximate: false,
        },
        setWhere: eq(oauthResetPeriod.approximate, true),
      })
      .run();
  }

  async queryPeriods(
    providerId: string,
    account: string,
    windowKey: string,
    limit: number,
  ): Promise<OAuthResetPeriod[]> {
    const rows = this.db
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
      .limit(limit)
      .all();
    return rows.map((r) => OAuthResetPeriodSchema.parse(r));
  }

  async latestResetAt(
    providerId: string,
    account: string,
    beforeMs: number,
    windowKey?: string,
  ): Promise<number | null> {
    const row = this.db
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
      .limit(1)
      .get();
    return row?.periodEndMs ?? null;
  }
}
