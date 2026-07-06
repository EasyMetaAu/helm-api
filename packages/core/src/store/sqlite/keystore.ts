import type { ApiKeyRecord } from "@helm/shared";
import { asc, eq } from "drizzle-orm";
import type { CreateKeyInput, KeyPatch, KeyStore, RotateKeyInput } from "../ports.js";
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
      secretEnc: input.secretEnc ?? null,
      accountId: input.accountId,
      role: input.role,
      // Human-readable label: undefined input => NULL => unnamed.
      name: input.name ?? null,
      allowedLanes: input.allowedLanes ? JSON.stringify(input.allowedLanes) : null,
      allowCustomModel: input.allowCustomModel ?? false,
      blockedModels: input.blockedModels ? JSON.stringify(input.blockedModels) : null,
      allowFastMode: input.allowFastMode ?? false,
      disabled: false,
      // Per-key rate-limit override: undefined input => NULL => inherit system default.
      rateLimitRpm: input.rateLimitRpm ?? null,
      rateLimitTpm: input.rateLimitTpm ?? null,
      // Per-key usage budgets: undefined => NULL => no cap. behavior defaults to degrade.
      budgetRequests: input.budgetRequests ?? null,
      budgetTokens: input.budgetTokens ?? null,
      budgetSpendUsd: input.budgetSpendUsd ?? null,
      budgetWindowSeconds: input.budgetWindowSeconds ?? null,
      overBudgetBehavior: input.overBudgetBehavior ?? "degrade",
      degradeLane: input.degradeLane ?? null,
      // Max in-flight requests: undefined => NULL => unlimited.
      concurrencyLimit: input.concurrencyLimit ?? null,
      // Memory defaults: omitted stays fail-safe ("off"). Pass memoryMode
      // explicitly to enable observe/inject for this key.
      memoryMode: input.memoryMode ?? "off",
      memoryProjectId: input.memoryProjectId ?? null,
      // undefined => "auto": a memory-on key derives its thread from client signals
      // out of the box (issue #97). Pass "header" explicitly to opt out.
      memoryThreadSource: input.memoryThreadSource ?? "auto",
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
    // Deterministic order: creation time, key_id as the unique tiebreaker. Without an
    // explicit ORDER BY the engine returns rows in an unspecified order that shifts as
    // rows are updated/deleted, so the admin list appeared to reshuffle between loads.
    return this.db
      .select()
      .from(apiKeys)
      .orderBy(asc(apiKeys.createdAt), asc(apiKeys.keyId))
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

  // Hard delete: physically remove the row. The "must be disabled first" policy
  // is enforced by the admin route, not here. Throws on unknown id (fail-loud).
  async deleteKey(keyId: string): Promise<void> {
    const res = this.db.delete(apiKeys).where(eq(apiKeys.keyId, keyId)).run();
    if (res.changes === 0) {
      throw new Error(`key not found: ${keyId}`);
    }
  }

  // Edit ONLY the cap columns PRESENT in `patch` (null clears: rate limit →
  // inherit, allowed_lanes → no whitelist). Omitted fields are left untouched,
  // so a partial PATCH never rewrites a sibling column (no concurrent-clobber).
  // NEVER touches role or the immutable identity. Throws on unknown id.
  async updateKey(keyId: string, patch: KeyPatch): Promise<void> {
    const set: Partial<
      Pick<
        ApiKeyRow,
        | "name"
        | "allowedLanes"
        | "allowCustomModel"
        | "blockedModels"
        | "allowFastMode"
        | "rateLimitRpm"
        | "rateLimitTpm"
        | "budgetRequests"
        | "budgetTokens"
        | "budgetSpendUsd"
        | "budgetWindowSeconds"
        | "overBudgetBehavior"
        | "degradeLane"
        | "concurrencyLimit"
        | "memoryMode"
        | "memoryProjectId"
        | "memoryThreadSource"
      >
    > = {};
    // Rename (null clears back to unnamed). Cosmetic only.
    if (patch.name !== undefined) set.name = patch.name;
    // SQLite has no native array: store the whitelist as JSON text (null = no cap).
    if (patch.allowedLanes !== undefined) {
      set.allowedLanes = patch.allowedLanes === null ? null : JSON.stringify(patch.allowedLanes);
    }
    if (patch.allowCustomModel !== undefined) set.allowCustomModel = patch.allowCustomModel;
    if (patch.blockedModels !== undefined) {
      set.blockedModels = patch.blockedModels === null ? null : JSON.stringify(patch.blockedModels);
    }
    if (patch.allowFastMode !== undefined) set.allowFastMode = patch.allowFastMode;
    if (patch.rateLimitRpm !== undefined) set.rateLimitRpm = patch.rateLimitRpm;
    if (patch.rateLimitTpm !== undefined) set.rateLimitTpm = patch.rateLimitTpm;
    if (patch.budgetRequests !== undefined) set.budgetRequests = patch.budgetRequests;
    if (patch.budgetTokens !== undefined) set.budgetTokens = patch.budgetTokens;
    if (patch.budgetSpendUsd !== undefined) set.budgetSpendUsd = patch.budgetSpendUsd;
    if (patch.budgetWindowSeconds !== undefined)
      set.budgetWindowSeconds = patch.budgetWindowSeconds;
    if (patch.overBudgetBehavior !== undefined) set.overBudgetBehavior = patch.overBudgetBehavior;
    if (patch.degradeLane !== undefined) set.degradeLane = patch.degradeLane;
    if (patch.concurrencyLimit !== undefined) set.concurrencyLimit = patch.concurrencyLimit;
    if (patch.memoryMode !== undefined) set.memoryMode = patch.memoryMode;
    if (patch.memoryProjectId !== undefined) set.memoryProjectId = patch.memoryProjectId;
    if (patch.memoryThreadSource !== undefined) set.memoryThreadSource = patch.memoryThreadSource;
    if (Object.keys(set).length === 0) {
      // No-op patch: still verify the key exists (fail-loud on unknown id).
      const row = this.db.select().from(apiKeys).where(eq(apiKeys.keyId, keyId)).get();
      if (row === undefined) throw new Error(`key not found: ${keyId}`);
      return;
    }
    const res = this.db.update(apiKeys).set(set).where(eq(apiKeys.keyId, keyId)).run();
    if (res.changes === 0) {
      throw new Error(`key not found: ${keyId}`);
    }
  }

  async rotateKey(keyId: string, input: RotateKeyInput): Promise<void> {
    const res = this.db
      .update(apiKeys)
      .set({
        hash: input.hash,
        prefix: input.prefix,
        secretEnc: input.secretEnc ?? null,
      })
      .where(eq(apiKeys.keyId, keyId))
      .run();
    if (res.changes === 0) {
      throw new Error(`key not found: ${keyId}`);
    }
  }

  async getSecretEnc(keyId: string): Promise<string | null> {
    const row = this.db
      .select({ secretEnc: apiKeys.secretEnc })
      .from(apiKeys)
      .where(eq(apiKeys.keyId, keyId))
      .get();
    if (row === undefined) {
      throw new Error(`key not found: ${keyId}`);
    }
    return row.secretEnc ?? null;
  }

  // Row -> port record. Restores dialect encodings; exposes hash + prefix only.
  private toRecord(row: ApiKeyRow): ApiKeyRecord {
    return {
      key_id: row.keyId,
      hash: row.hash,
      prefix: row.prefix,
      account_id: row.accountId,
      role: row.role === "root" ? "root" : "user",
      name: row.name ?? null,
      allowed_lanes: row.allowedLanes ? (JSON.parse(row.allowedLanes) as string[]) : null,
      allow_custom_model: row.allowCustomModel,
      blocked_models: row.blockedModels ? (JSON.parse(row.blockedModels) as string[]) : null,
      allow_fast_mode: row.allowFastMode,
      disabled: row.disabled,
      rate_limit_rpm: row.rateLimitRpm ?? null,
      rate_limit_tpm: row.rateLimitTpm ?? null,
      budget_requests: row.budgetRequests ?? null,
      budget_tokens: row.budgetTokens ?? null,
      budget_spend_usd: row.budgetSpendUsd ?? null,
      budget_window_seconds: row.budgetWindowSeconds ?? null,
      over_budget_behavior: row.overBudgetBehavior === "reject" ? "reject" : "degrade",
      degrade_lane: row.degradeLane ?? null,
      concurrency_limit: row.concurrencyLimit ?? null,
      // Text-column enums narrowed defensively (mirrors over_budget_behavior).
      memory_mode:
        row.memoryMode === "inject" ? "inject" : row.memoryMode === "observe" ? "observe" : "off",
      memory_project_id: row.memoryProjectId ?? null,
      memory_thread_source: row.memoryThreadSource === "auto" ? "auto" : "header",
    };
  }
}
