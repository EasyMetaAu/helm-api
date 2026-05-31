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
}
