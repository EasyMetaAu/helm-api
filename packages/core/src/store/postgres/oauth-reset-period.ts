import { type OAuthResetPeriod, OAuthResetPeriodSchema } from "@helm/shared";
import { and, desc, eq } from "drizzle-orm";
import type { OAuthResetPeriodStore } from "../ports.js";
import type { PgDb } from "./migrate.js";
import { oauthResetPeriod } from "./schema.js";

// PgOAuthResetPeriodStore — pg mirror of the sqlite adapter. Idempotent append via
// onConflictDoNothing; bigint columns marshal as strings, so Number()-normalize before
// the shared schema parse.
export class PgOAuthResetPeriodStore implements OAuthResetPeriodStore {
  constructor(private readonly db: PgDb) {}

  async record(row: OAuthResetPeriod): Promise<void> {
    await this.db
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
      }),
    );
  }
}
