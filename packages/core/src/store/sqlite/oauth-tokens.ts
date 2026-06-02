import { and, eq } from "drizzle-orm";
import type { OAuthTokenRecord, OAuthTokenStore } from "../ports.js";
import type { SqliteDb } from "./migrate.js";
import { oauthTokens } from "./schema.js";

type OAuthTokenRow = typeof oauthTokens.$inferSelect;

// SQLite adapter for the OAuthTokenStore port (issue #38). Stores the AES-GCM
// ciphertext blobs VERBATIM — it never encrypts or decrypts (that stays in the
// caller, exactly as SqliteKeyStore never hashes; principle 7). upsert is the
// login + rotation write-back: ON CONFLICT on the (provider_id, account) PK it
// overwrites the secret/expiry columns so a rotated refresh token replaces the
// old one without touching a sibling row.
export class SqliteOAuthTokenStore implements OAuthTokenStore {
  constructor(private readonly db: SqliteDb) {}

  async get(providerId: string, account: string): Promise<OAuthTokenRecord | null> {
    const row = this.db
      .select()
      .from(oauthTokens)
      .where(and(eq(oauthTokens.providerId, providerId), eq(oauthTokens.account, account)))
      .get();
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
    this.db
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
      })
      .run();
  }

  async delete(providerId: string, account: string): Promise<void> {
    this.db
      .delete(oauthTokens)
      .where(and(eq(oauthTokens.providerId, providerId), eq(oauthTokens.account, account)))
      .run();
  }

  async list(): Promise<
    Array<Pick<OAuthTokenRecord, "providerId" | "account" | "expiresAt" | "updatedAt">>
  > {
    return this.db
      .select({
        providerId: oauthTokens.providerId,
        account: oauthTokens.account,
        expiresAt: oauthTokens.expiresAt,
        updatedAt: oauthTokens.updatedAt,
      })
      .from(oauthTokens)
      .all()
      .map((r) => ({
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
