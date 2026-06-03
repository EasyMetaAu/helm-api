import { type OAuthQuotaSnapshot, OAuthQuotaSnapshotSchema } from "@helm/shared";
import { and, eq } from "drizzle-orm";
import type { OAuthQuotaStore } from "../ports.js";
import type { PgDb } from "./migrate.js";
import { oauthQuota } from "./schema.js";

type QuotaRow = typeof oauthQuota.$inferSelect;

// Postgres adapter for the OAuthQuotaStore port (providers page Tier 3) — the
// supabase mirror of the sqlite adapter. `windows` is native jsonb; latest-wins
// upsert per (provider_id, account). Pure observability — no secret column.
export class PgOAuthQuotaStore implements OAuthQuotaStore {
  constructor(private readonly db: PgDb) {}

  async upsert(snapshot: OAuthQuotaSnapshot): Promise<void> {
    await this.db
      .insert(oauthQuota)
      .values({
        providerId: snapshot.providerId,
        account: snapshot.account,
        windows: snapshot.windows,
        capturedAt: snapshot.capturedAt,
        source: snapshot.source,
      })
      .onConflictDoUpdate({
        target: [oauthQuota.providerId, oauthQuota.account],
        set: {
          windows: snapshot.windows,
          capturedAt: snapshot.capturedAt,
          source: snapshot.source,
        },
      });
  }

  async get(providerId: string, account: string): Promise<OAuthQuotaSnapshot | null> {
    const rows = await this.db
      .select()
      .from(oauthQuota)
      .where(and(eq(oauthQuota.providerId, providerId), eq(oauthQuota.account, account)))
      .limit(1);
    const row = rows[0];
    return row ? this.toSnapshot(row) : null;
  }

  async getAll(): Promise<OAuthQuotaSnapshot[]> {
    const rows = await this.db.select().from(oauthQuota);
    return rows.map((r) => this.toSnapshot(r));
  }

  private toSnapshot(row: QuotaRow): OAuthQuotaSnapshot {
    return OAuthQuotaSnapshotSchema.parse({
      providerId: row.providerId,
      account: row.account,
      windows: row.windows,
      capturedAt: row.capturedAt,
      source: row.source,
    });
  }
}
