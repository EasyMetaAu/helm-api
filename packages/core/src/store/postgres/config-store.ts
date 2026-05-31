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
      .values({ key, value })
      .onConflictDoUpdate({ target: configKv.key, set: { value: sql`excluded.value` } });
  }
}
