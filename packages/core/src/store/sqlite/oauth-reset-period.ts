import { type OAuthResetPeriod, OAuthResetPeriodSchema } from "@helm/shared";
import { and, desc, eq } from "drizzle-orm";
import type { OAuthResetPeriodStore } from "../ports.js";
import type { SqliteDb } from "./migrate.js";
import { oauthResetPeriod } from "./schema.js";

// SqliteOAuthResetPeriodStore — append-only history of real reset boundaries. `record`
// is idempotent via onConflictDoNothing on the composite PK, so a reset re-seen by
// repeated quota refreshes lands once. Pure observability — no key/payload.
export class SqliteOAuthResetPeriodStore implements OAuthResetPeriodStore {
  constructor(private readonly db: SqliteDb) {}

  async record(row: OAuthResetPeriod): Promise<void> {
    this.db
      .insert(oauthResetPeriod)
      .values({
        providerId: row.providerId,
        account: row.account,
        windowKey: row.windowKey,
        periodStartMs: row.periodStartMs,
        periodEndMs: row.periodEndMs,
        detectedAtMs: row.detectedAtMs,
      })
      .onConflictDoNothing({
        target: [
          oauthResetPeriod.providerId,
          oauthResetPeriod.account,
          oauthResetPeriod.windowKey,
          oauthResetPeriod.periodStartMs,
        ],
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
}
