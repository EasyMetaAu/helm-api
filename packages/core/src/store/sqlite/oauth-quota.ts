import { type OAuthQuotaSnapshot, OAuthQuotaSnapshotSchema } from "@helm/shared";
import { and, eq } from "drizzle-orm";
import type { OAuthQuotaStore } from "../ports.js";
import type { SqliteDb } from "./migrate.js";
import { oauthQuota } from "./schema.js";

type QuotaRow = typeof oauthQuota.$inferSelect;

// SQLite adapter for the OAuthQuotaStore port (providers page Tier 3). One row per
// (provider_id, account): the LATEST rate-limit window snapshot. `windows` is a
// JSON-text array (SQLite has no native array); `upsert` overwrites via the
// composite PRIMARY KEY (latest wins, no history). Pure observability — fail-open
// readers render "—" on a missing/corrupt row.
export class SqliteOAuthQuotaStore implements OAuthQuotaStore {
  constructor(private readonly db: SqliteDb) {}

  async upsert(snapshot: Omit<OAuthQuotaSnapshot, "usageLimitedUntilMs">): Promise<void> {
    const row = {
      providerId: snapshot.providerId,
      account: snapshot.account,
      windows: JSON.stringify(snapshot.windows),
      capturedAt: snapshot.capturedAt,
      source: snapshot.source,
      ...(snapshot.resetCredits !== undefined ? { resetCredits: snapshot.resetCredits } : {}),
    };
    const set = {
      windows: row.windows,
      capturedAt: row.capturedAt,
      source: row.source,
      ...(snapshot.resetCredits !== undefined ? { resetCredits: snapshot.resetCredits } : {}),
    };
    // Note: usage_limited_until_ms is intentionally absent from BOTH the insert values
    // (defaults to NULL on a brand-new row) and the conflict SET — an observability
    // refresh must never overwrite an active cooldown. reset_credits is updated only
    // when the caller has a fresh Codex PULL count; Codex header PUSHes preserve it.
    this.db
      .insert(oauthQuota)
      .values(row)
      .onConflictDoUpdate({
        target: [oauthQuota.providerId, oauthQuota.account],
        set,
      })
      .run();
  }

  async setUsageLimit(providerId: string, account: string, untilMs: number | null): Promise<void> {
    // Upsert ONLY the cooldown. On a brand-new (provider, account) — a 429 that
    // parks an account before any quota PULL — synthesize an empty snapshot so the
    // row exists; a later upsert overwrites windows/source with the real capture.
    this.db
      .insert(oauthQuota)
      .values({
        providerId,
        account,
        windows: "[]",
        capturedAt: 0,
        source: providerId === "anthropic" ? "anthropic" : "codex-headers",
        usageLimitedUntilMs: untilMs,
        resetCredits: null,
      })
      .onConflictDoUpdate({
        target: [oauthQuota.providerId, oauthQuota.account],
        set: { usageLimitedUntilMs: untilMs },
      })
      .run();
  }

  async get(providerId: string, account: string): Promise<OAuthQuotaSnapshot | null> {
    const row = this.db
      .select()
      .from(oauthQuota)
      .where(and(eq(oauthQuota.providerId, providerId), eq(oauthQuota.account, account)))
      .get();
    return row ? this.toSnapshot(row) : null;
  }

  async getAll(): Promise<OAuthQuotaSnapshot[]> {
    return this.db
      .select()
      .from(oauthQuota)
      .all()
      .map((r) => this.toSnapshot(r));
  }

  async delete(providerId: string, account: string): Promise<void> {
    this.db
      .delete(oauthQuota)
      .where(and(eq(oauthQuota.providerId, providerId), eq(oauthQuota.account, account)))
      .run();
  }

  // Row -> OAuthQuotaSnapshot. Re-validates through the shared schema so a
  // corrupted row surfaces loudly rather than leaking a malformed shape.
  private toSnapshot(row: QuotaRow): OAuthQuotaSnapshot {
    return OAuthQuotaSnapshotSchema.parse({
      providerId: row.providerId,
      account: row.account,
      windows: JSON.parse(row.windows),
      capturedAt: row.capturedAt,
      source: row.source,
      usageLimitedUntilMs: row.usageLimitedUntilMs ?? null,
      resetCredits: row.resetCredits ?? null,
    });
  }
}
