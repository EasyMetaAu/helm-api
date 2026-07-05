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
      .values({ key, value })
      .onConflictDoUpdate({ target: configKv.key, set: { value } })
      .run();
  }

  async setIfMissingOrNumericLte(key: string, value: string, lte: number): Promise<boolean> {
    const res = this.db.$sqlite
      .prepare(`
        INSERT INTO config_kv (key, value)
        VALUES (?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
        WHERE config_kv.value GLOB '[0-9]*'
          AND config_kv.value NOT GLOB '*[^0-9]*'
          AND CAST(config_kv.value AS INTEGER) <= ?
      `)
      .run(key, value, Math.trunc(lte));
    return res.changes > 0;
  }
}
