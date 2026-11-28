import { eq } from "drizzle-orm";
import type { ConfigStore } from "../ports.js";
import type { SqliteDb } from "./migrate.js";
import { configKv } from "./schema.js";

// SQLite adapter for the ConfigStore port (default driver). MVP is yaml-first;
// this is reserved for admin runtime write-back. A single key/value table; `set`
// upserts. No secrets stored here (config references credentials by env-var name,
// never plaintext — principle 7).
export class SqliteConfigStore implements ConfigStore {
  constructor(private readonly db: SqliteDb) {}

  async get(key: string): Promise<string | null> {
    const row = this.db.select().from(configKv).where(eq(configKv.key, key)).get();
    return row?.value ?? null;
  }

  async set(key: string, value: string): Promise<void> {
    this.db
      .insert(configKv)
      .values({ key, value, expiresAt: null })
      .onConflictDoUpdate({ target: configKv.key, set: { value, expiresAt: null } })
      .run();
  }

  async compareAndSet(
    key: string,
    expected: string | null,
    value: string,
    expiresAtMs?: number,
  ): Promise<boolean> {
    const result =
      expected === null
        ? this.db.$sqlite
            .prepare(
              "INSERT INTO config_kv (key, value, expires_at) VALUES (?, ?, ?) ON CONFLICT(key) DO NOTHING",
            )
            .run(key, value, expiresAtMs ?? null)
        : this.db.$sqlite
            .prepare("UPDATE config_kv SET value = ?, expires_at = ? WHERE key = ? AND value = ?")
            .run(value, expiresAtMs ?? null, key, expected);
    return result.changes === 1;
  }

  async setIfMissingOrNumericLte(
    key: string,
    value: string,
    lte: number,
    expiresAtMs?: number,
  ): Promise<boolean> {
    const res = this.db.$sqlite
      .prepare(`
        INSERT INTO config_kv (key, value, expires_at)
        VALUES (?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, expires_at = excluded.expires_at
        WHERE config_kv.value GLOB '[0-9]*'
          AND config_kv.value NOT GLOB '*[^0-9]*'
          AND CAST(config_kv.value AS INTEGER) <= ?
      `)
      .run(key, value, expiresAtMs ?? null, Math.trunc(lte));
    return res.changes > 0;
  }
  async deleteIfValue(key: string, expected: string): Promise<boolean> {
    return (
      this.db.$sqlite
        .prepare("DELETE FROM config_kv WHERE key = ? AND value = ?")
        .run(key, expected).changes === 1
    );
  }
  async pruneExpired(nowMs: number): Promise<void> {
    this.db.$sqlite
      .prepare(`DELETE FROM config_kv WHERE key IN (
      SELECT key FROM config_kv WHERE expires_at <= ? ORDER BY expires_at LIMIT 1000
    ) AND expires_at <= ?`)
      .run(nowMs, nowMs);
  }
}
