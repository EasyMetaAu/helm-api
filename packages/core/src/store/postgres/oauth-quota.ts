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

  async upsert(snapshot: Omit<OAuthQuotaSnapshot, "usageLimitedUntilMs">): Promise<void> {
    const values = {
      providerId: snapshot.providerId,
      account: snapshot.account,
      windows: snapshot.windows,
      capturedAt: snapshot.capturedAt,
      source: snapshot.source,
      ...(snapshot.resetCredits !== undefined ? { resetCredits: snapshot.resetCredits } : {}),
    };
    const set = {
      windows: snapshot.windows,
      capturedAt: snapshot.capturedAt,
      source: snapshot.source,
      ...(snapshot.resetCredits !== undefined ? { resetCredits: snapshot.resetCredits } : {}),
    };
    // usage_limited_until_ms is intentionally absent from BOTH insert values (NULL on
    // a new row) and the conflict SET — a window refresh must not clobber a cooldown.
    // reset_credits is updated only when the caller has a fresh Codex PULL count;
    // Codex header PUSHes preserve it.
    await this.db
      .insert(oauthQuota)
      .values(values)
      .onConflictDoUpdate({
        target: [oauthQuota.providerId, oauthQuota.account],
        set,
      });
  }

  async setUsageLimit(providerId: string, account: string, untilMs: number | null): Promise<void> {
    // Upsert ONLY the cooldown; synthesize an empty snapshot on a brand-new row (a
    // 429 parking an account before any quota PULL).
    await this.db
      .insert(oauthQuota)
      .values({
        providerId,
        account,
        windows: [],
        capturedAt: 0,
        source: providerId === "anthropic" ? "anthropic" : "codex-headers",
        usageLimitedUntilMs: untilMs,
        resetCredits: null,
      })
      .onConflictDoUpdate({
        target: [oauthQuota.providerId, oauthQuota.account],
        set: { usageLimitedUntilMs: untilMs },
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

  async delete(providerId: string, account: string): Promise<void> {
    await this.db
      .delete(oauthQuota)
      .where(and(eq(oauthQuota.providerId, providerId), eq(oauthQuota.account, account)));
  }

  private toSnapshot(row: QuotaRow): OAuthQuotaSnapshot {
    return OAuthQuotaSnapshotSchema.parse({
      providerId: row.providerId,
      account: row.account,
      windows: row.windows,
      capturedAt: row.capturedAt,
      source: row.source,
      usageLimitedUntilMs: row.usageLimitedUntilMs ?? null,
      resetCredits: row.resetCredits ?? null,
    });
  }
}
