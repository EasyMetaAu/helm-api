import type { ApiKeyRecord } from "@helm/shared";
import { eq } from "drizzle-orm";
import type { CreateKeyInput, KeyStore } from "../ports.js";
import type { SqliteDb } from "./migrate.js";
import { apiKeys } from "./schema.js";

type ApiKeyRow = typeof apiKeys.$inferSelect;

// SQLite adapter for the KeyStore port. Encodes/decodes Drizzle rows to the
// port's ApiKeyRecord (boolean/array dialect restored). Stores hash + prefix
// ONLY — never plaintext (principle 7). Revocation is a soft flag, never an
// in-place rewrite of other fields. The adapter never hashes: createKey accepts
// an already-computed hash (hashing lives in auth.keygen).
export class SqliteKeyStore implements KeyStore {
  constructor(
    private readonly db: SqliteDb,
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
      allowedLanes: input.allowedLanes ? JSON.stringify(input.allowedLanes) : null,
      allowCustomModel: input.allowCustomModel ?? false,
      disabled: false,
      // Per-key rate-limit override: undefined input => NULL => inherit system default.
      rateLimitRpm: input.rateLimitRpm ?? null,
      rateLimitTpm: input.rateLimitTpm ?? null,
      createdAt: this.now(),
    };
    this.db.insert(apiKeys).values(row).run();
    return this.toRecord({ ...row });
  }

  async getByHash(hash: string): Promise<ApiKeyRecord | null> {
    const row = this.db.select().from(apiKeys).where(eq(apiKeys.hash, hash)).get();
    return row ? this.toRecord(row) : null;
  }

  async list(): Promise<ApiKeyRecord[]> {
    return this.db
      .select()
      .from(apiKeys)
      .all()
      .map((r) => this.toRecord(r));
  }

  async disable(keyId: string): Promise<void> {
    const res = this.db
      .update(apiKeys)
      .set({ disabled: true })
      .where(eq(apiKeys.keyId, keyId))
      .run();
    if (res.changes === 0) {
      throw new Error(`key not found: ${keyId}`);
    }
  }

  // Edit ONLY the two rate-limit columns (null clears back to inherit). Other
  // fields untouched — no in-place rewrite of role/caps. Throws on unknown id.
  async updateRateLimit(
    keyId: string,
    rpm: number | null,
    tpm: number | null,
  ): Promise<void> {
    const res = this.db
      .update(apiKeys)
      .set({ rateLimitRpm: rpm, rateLimitTpm: tpm })
      .where(eq(apiKeys.keyId, keyId))
      .run();
    if (res.changes === 0) {
      throw new Error(`key not found: ${keyId}`);
    }
  }

  // Row -> port record. Restores dialect encodings; exposes hash + prefix only.
  private toRecord(row: ApiKeyRow): ApiKeyRecord {
    return {
      key_id: row.keyId,
      hash: row.hash,
      prefix: row.prefix,
      account_id: row.accountId,
      role: row.role === "root" ? "root" : "user",
      max_lane: row.maxLane ?? null,
      allowed_lanes: row.allowedLanes ? (JSON.parse(row.allowedLanes) as string[]) : null,
      allow_custom_model: row.allowCustomModel,
      disabled: row.disabled,
      rate_limit_rpm: row.rateLimitRpm ?? null,
      rate_limit_tpm: row.rateLimitTpm ?? null,
    };
  }
}
