import { and, eq } from "drizzle-orm";
import type { OAuthTokenRecord, OAuthTokenStore } from "../ports.js";
import type { PgDb } from "./migrate.js";
import { oauthTokens } from "./schema.js";

type OAuthTokenRow = typeof oauthTokens.$inferSelect;

// Postgres (supabase) adapter for the OAuthTokenStore port (issue #38). Same
// contract as the sqlite adapter, but async. Stores the AES-GCM ciphertext blobs
// VERBATIM — never encrypts/decrypts (that stays in the caller; principle 7).
// upsert is the login + rotation write-back via ON CONFLICT on the
// (provider_id, account) PK.
export class PgOAuthTokenStore implements OAuthTokenStore {
  constructor(private readonly db: PgDb) {}

  async get(providerId: string, account: string): Promise<OAuthTokenRecord | null> {
    const rows = await this.db
      .select()
      .from(oauthTokens)
      .where(and(eq(oauthTokens.providerId, providerId), eq(oauthTokens.account, account)))
      .limit(1);
    const row = rows[0];
    return row ? this.toRecord(row) : null;
  }

  async upsert(rec: OAuthTokenRecord): Promise<void> {
    const row = {
      providerId: rec.providerId,
      account: rec.account,
      accessEnc: rec.accessEnc,
      refreshEnc: rec.refreshEnc,
      expiresAt: rec.expiresAt,
      meta: rec.meta,
      updatedAt: rec.updatedAt,
    };
    await this.db
      .insert(oauthTokens)
      .values(row)
      .onConflictDoUpdate({
        target: [oauthTokens.providerId, oauthTokens.account],
        set: {
          accessEnc: row.accessEnc,
          refreshEnc: row.refreshEnc,
          expiresAt: row.expiresAt,
          meta: row.meta,
          updatedAt: row.updatedAt,
        },
      });
  }

  async delete(providerId: string, account: string): Promise<void> {
    await this.db
      .delete(oauthTokens)
      .where(and(eq(oauthTokens.providerId, providerId), eq(oauthTokens.account, account)));
  }

  async list(): Promise<
    Array<Pick<OAuthTokenRecord, "providerId" | "account" | "expiresAt" | "updatedAt">>
  > {
    const rows = await this.db
      .select({
        providerId: oauthTokens.providerId,
        account: oauthTokens.account,
        expiresAt: oauthTokens.expiresAt,
        updatedAt: oauthTokens.updatedAt,
      })
      .from(oauthTokens);
    return rows.map((r) => ({
      providerId: r.providerId,
      account: r.account,
      expiresAt: r.expiresAt ?? null,
      updatedAt: r.updatedAt,
    }));
  }

  private toRecord(row: OAuthTokenRow): OAuthTokenRecord {
    return {
      providerId: row.providerId,
      account: row.account,
      accessEnc: row.accessEnc ?? null,
      refreshEnc: row.refreshEnc ?? null,
      expiresAt: row.expiresAt ?? null,
      meta: row.meta ?? null,
      updatedAt: row.updatedAt,
    };
  }
}
