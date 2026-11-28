import { eq, sql } from "drizzle-orm";
import type { ConfigStore } from "../ports.js";
import type { PgDb } from "./migrate.js";
import { configKv } from "./schema.js";

// Postgres adapter for the ConfigStore port — the supabase implementation. MVP
// is yaml-first; this is reserved for admin runtime write-back. A single
// key/value table; `set` upserts. No secrets are stored here (config references
// credentials by env-var name, never plaintext — principle 7).
export class PgConfigStore implements ConfigStore {
  constructor(private readonly db: PgDb) {}

  async get(key: string): Promise<string | null> {
    const rows = await this.db.select().from(configKv).where(eq(configKv.key, key)).limit(1);
    return rows[0]?.value ?? null;
  }

  async set(key: string, value: string): Promise<void> {
    await this.db
      .insert(configKv)
      .values({ key, value, expiresAt: null })
      .onConflictDoUpdate({
        target: configKv.key,
        set: { value: sql`excluded.value`, expiresAt: null },
      });
  }

  async setIfMissingOrNumericLte(
    key: string,
    value: string,
    lte: number,
    expiresAtMs?: number,
  ): Promise<boolean> {
    const result = (await this.db.execute(sql`
      INSERT INTO config_kv (key, value, expires_at)
      VALUES (${key}, ${value}, ${expiresAtMs ?? null})
      ON CONFLICT (key) DO UPDATE SET value = excluded.value, expires_at = excluded.expires_at
      WHERE config_kv.value ~ '^[0-9]+$'
        AND config_kv.value::numeric <= ${Math.trunc(lte)}
      RETURNING key
    `)) as { rows?: Array<{ key: string }> } | Array<{ key: string }>;
    const rows = Array.isArray(result) ? result : (result.rows ?? []);
    return rows[0] !== undefined;
  }

  async compareAndSet(
    key: string,
    expected: string | null,
    value: string,
    expiresAtMs?: number,
  ): Promise<boolean> {
    const result = await this.db.execute(
      expected === null
        ? sql`INSERT INTO config_kv (key, value, expires_at) VALUES (${key}, ${value}, ${expiresAtMs ?? null}) ON CONFLICT(key) DO NOTHING RETURNING key`
        : sql`UPDATE config_kv SET value = ${value}, expires_at = ${expiresAtMs ?? null} WHERE key = ${key} AND value = ${expected} RETURNING key`,
    );
    const rows = Array.isArray(result) ? result : (result as { rows?: unknown[] }).rows;
    return rows?.length === 1;
  }
  async deleteIfValue(key: string, expected: string): Promise<boolean> {
    const result = await this.db.execute(
      sql`DELETE FROM config_kv WHERE key = ${key} AND value = ${expected} RETURNING key`,
    );
    const rows = Array.isArray(result) ? result : (result as { rows?: unknown[] }).rows;
    return rows?.length === 1;
  }
  async pruneExpired(nowMs: number): Promise<void> {
    await this.db.execute(sql`DELETE FROM config_kv WHERE key IN (
      SELECT key FROM config_kv WHERE expires_at <= ${nowMs} ORDER BY expires_at LIMIT 1000
    ) AND expires_at <= ${nowMs}`);
  }
}
