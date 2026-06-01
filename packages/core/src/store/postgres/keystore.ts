import type { ApiKeyRecord } from "@helm/shared";
import { eq } from "drizzle-orm";
import type { CreateKeyInput, KeyStore, RateLimitPatch } from "../ports.js";
import type { PgDb } from "./migrate.js";
import { apiKeys } from "./schema.js";

type ApiKeyRow = typeof apiKeys.$inferSelect;

// Postgres adapter for the KeyStore port — the supabase implementation. Same
// contract as SqliteKeyStore, but async (postgres-js / pglite). Uses native
// jsonb + boolean (no JSON-string dialect encoding). Stores hash + prefix ONLY —
// never plaintext (principle 7). Revocation is a soft flag, never an in-place
// rewrite of other fields. The adapter never hashes: createKey accepts an
// already-computed hash (hashing lives in auth.keygen).
export class PgKeyStore implements KeyStore {
  constructor(
    private readonly db: PgDb,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async createKey(input: CreateKeyInput): Promise<ApiKeyRecord> {
    const row = {
      keyId: input.keyId,
      hash: input.hash,
      prefix: input.prefix,
      accountId: input.accountId,
      role: input.role,
      maxLane: input.maxLane ?? null,
      allowedLanes: input.allowedLanes ?? null,
      allowCustomModel: input.allowCustomModel ?? false,
      disabled: false,
      // Per-key rate-limit override: undefined input => NULL => inherit system default.
      rateLimitRpm: input.rateLimitRpm ?? null,
      rateLimitTpm: input.rateLimitTpm ?? null,
      createdAt: this.now().getTime(),
    };
    await this.db.insert(apiKeys).values(row);
    return this.toRecord(row as ApiKeyRow);
  }

  async getByHash(hash: string): Promise<ApiKeyRecord | null> {
    const rows = await this.db.select().from(apiKeys).where(eq(apiKeys.hash, hash)).limit(1);
    const row = rows[0];
    return row ? this.toRecord(row) : null;
  }

  async list(): Promise<ApiKeyRecord[]> {
    const rows = await this.db.select().from(apiKeys);
    return rows.map((r) => this.toRecord(r));
  }

  async disable(keyId: string): Promise<void> {
    const res = await this.db
      .update(apiKeys)
      .set({ disabled: true })
      .where(eq(apiKeys.keyId, keyId))
      .returning();
    if (res.length === 0) {
      throw new Error(`key not found: ${keyId}`);
    }
  }

  // Edit ONLY the rate-limit columns PRESENT in `patch` (null clears back to
  // inherit). Omitted dims are left untouched, so a partial PATCH never rewrites
  // the sibling column (no concurrent-clobber). Throws on unknown id.
  async updateRateLimit(keyId: string, patch: RateLimitPatch): Promise<void> {
    const set: Partial<Pick<ApiKeyRow, "rateLimitRpm" | "rateLimitTpm">> = {};
    if (patch.rpm !== undefined) set.rateLimitRpm = patch.rpm;
    if (patch.tpm !== undefined) set.rateLimitTpm = patch.tpm;
    if (Object.keys(set).length === 0) {
      // No-op patch: still verify the key exists (fail-loud on unknown id).
      const rows = await this.db.select().from(apiKeys).where(eq(apiKeys.keyId, keyId)).limit(1);
      if (rows.length === 0) throw new Error(`key not found: ${keyId}`);
      return;
    }
    const res = await this.db.update(apiKeys).set(set).where(eq(apiKeys.keyId, keyId)).returning();
    if (res.length === 0) {
      throw new Error(`key not found: ${keyId}`);
    }
  }

  // Row -> port record. Native jsonb/boolean restored directly; exposes hash +
  // prefix only.
  private toRecord(row: ApiKeyRow): ApiKeyRecord {
    return {
      key_id: row.keyId,
      hash: row.hash,
      prefix: row.prefix,
      account_id: row.accountId,
      role: row.role === "root" ? "root" : "user",
      max_lane: row.maxLane ?? null,
      allowed_lanes: row.allowedLanes ?? null,
      allow_custom_model: row.allowCustomModel,
      disabled: row.disabled,
      rate_limit_rpm: row.rateLimitRpm ?? null,
      rate_limit_tpm: row.rateLimitTpm ?? null,
    };
  }
}
