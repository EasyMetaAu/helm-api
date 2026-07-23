import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { StoreConfig } from "@helm/shared";
import { runtimeMemoryBudget } from "../runtime/memory-budget.js";
import type {
  BudgetStore,
  ConfigStore,
  KeyStore,
  MemoryStore,
  OAuthQuotaStore,
  OAuthTokenStore,
  OAuthUsageStore,
  RateLimitStore,
  SignalStore,
  TelemetryStore,
} from "./ports.js";
import { PgBudgetStore } from "./postgres/budget.js";
import { PgConfigStore } from "./postgres/config-store.js";
import { PgKeyStore } from "./postgres/keystore.js";
import { PgMemoryStore } from "./postgres/memory-store.js";
import { createPgDb } from "./postgres/migrate.js";
import { PgOAuthQuotaStore } from "./postgres/oauth-quota.js";
import { PgOAuthTokenStore } from "./postgres/oauth-tokens.js";
import { PgOAuthUsageStore } from "./postgres/oauth-usage.js";
import { PgRateLimitStore } from "./postgres/rate-limit.js";
import { PgSignalStore } from "./postgres/signals.js";
import { PgTelemetryStore } from "./postgres/telemetry.js";
import { SqliteBudgetStore } from "./sqlite/budget.js";
import { SqliteConfigStore } from "./sqlite/config-store.js";
import { SqliteKeyStore } from "./sqlite/keystore.js";
import { SqliteMemoryStore } from "./sqlite/memory-store.js";
import { createSqliteDb } from "./sqlite/migrate.js";
import { SqliteOAuthQuotaStore } from "./sqlite/oauth-quota.js";
import { SqliteOAuthTokenStore } from "./sqlite/oauth-tokens.js";
import { SqliteOAuthUsageStore } from "./sqlite/oauth-usage.js";
import { SqliteRateLimitStore } from "./sqlite/rate-limit.js";
import { SqliteSignalStore } from "./sqlite/signals.js";
import { SqliteTelemetryStore } from "./sqlite/telemetry.js";
import { vacuumSqlite } from "./sqlite/vacuum.js";

export { vacuumSqlite } from "./sqlite/vacuum.js";

// The full set of Store-port implementations the gateway needs, plus a `close`
// lifecycle hook. The driver (sqlite vs supabase) is chosen ONCE here by config;
// every caller depends only on the port interfaces, never on a concrete adapter
// (CLAUDE.md "DB abstraction layer": core depends on interfaces, not a specific DB).
export interface StoreSet {
  readonly keys: KeyStore;
  readonly telemetry: TelemetryStore;
  readonly signals: SignalStore;
  readonly rateLimit: RateLimitStore;
  readonly budget: BudgetStore;
  readonly memory: MemoryStore;
  readonly config: ConfigStore;
  readonly oauthTokens: OAuthTokenStore;
  // Per-account OAuth subscription observability (providers page). usage = today's
  // served traffic; quota = latest rate-limit window snapshot. Both fail-open.
  readonly oauthUsage: OAuthUsageStore;
  readonly oauthQuota: OAuthQuotaStore;
  // Reclaim on-disk space after a cleanup sweep. sqlite runs VACUUM (rewrites the
  // file under an EXCLUSIVE lock in the gateway's serialized off-hours maintenance
  // window); postgres is a no-op because it autovacuums.
  readonly vacuum: () => Promise<void>;
  readonly close: () => Promise<void>;
}

export interface CreateStoreOptions {
  // Selects the adapter set + per-driver location.
  store: StoreConfig;
  // sqlite: directory holding helm.db (default "./data").
  dataDir?: string;
  // supabase: the resolved Postgres connection string (from env via url_env).
  // Required when store.driver === 'supabase'.
  connectionString?: string;
}

// Build the Store adapter set for the configured driver. Fail-CLOSED: an
// unrecognized driver throws (never silently falls back to a wrong store), and a
// supabase driver without a resolved connection string throws too (a missing
// credential must stop startup, not run on a partial config — principle 2). The
// Zod enum already rejects unknown driver strings at config load; this exhaustive
// switch is the defense-in-depth backstop for any value reaching the factory.
export async function createStore(opts: CreateStoreOptions): Promise<StoreSet> {
  const driver = opts.store.driver;
  switch (driver) {
    case "sqlite": {
      const dataDir = opts.dataDir ?? "./data";
      await mkdir(dataDir, { recursive: true });
      const db = createSqliteDb(join(dataDir, "helm.db"));
      return {
        keys: new SqliteKeyStore(db),
        telemetry: new SqliteTelemetryStore(db),
        signals: new SqliteSignalStore(db),
        rateLimit: new SqliteRateLimitStore(db),
        budget: new SqliteBudgetStore(db),
        memory: new SqliteMemoryStore(db),
        config: new SqliteConfigStore(db),
        oauthTokens: new SqliteOAuthTokenStore(db),
        oauthUsage: new SqliteOAuthUsageStore(db),
        oauthQuota: new SqliteOAuthQuotaStore(db),
        // VACUUM cannot run inside a transaction. The helper checkpoints WAL, sheds
        // SQLite cache memory, uses file-backed temp storage, then restores pragmas.
        vacuum: () =>
          vacuumSqlite(db.$sqlite, {
            maintenanceCacheBytes: runtimeMemoryBudget().sqliteMaintenanceCacheBytes,
          }),
        close: async () => {
          db.$sqlite.close();
        },
      };
    }
    case "supabase": {
      const connectionString = opts.connectionString;
      if (!connectionString) {
        throw new Error(
          "store.driver=supabase requires a connection string (set runtime.store.url_env to the env var holding it)",
        );
      }
      const db = await createPgDb(connectionString);
      return {
        keys: new PgKeyStore(db),
        telemetry: new PgTelemetryStore(db),
        signals: new PgSignalStore(db),
        rateLimit: new PgRateLimitStore(db),
        budget: new PgBudgetStore(db),
        memory: new PgMemoryStore(db),
        config: new PgConfigStore(db),
        oauthTokens: new PgOAuthTokenStore(db),
        oauthUsage: new PgOAuthUsageStore(db),
        oauthQuota: new PgOAuthQuotaStore(db),
        // Postgres autovacuums; an explicit VACUUM needs a non-pooled conn and is
        // unnecessary for managed supabase — no-op keeps the StoreSet contract uniform.
        vacuum: async () => {},
        close: () => db.$close(),
      };
    }
    default: {
      // Exhaustiveness guard: a new driver added to the schema enum without a
      // case here is a compile error; an unknown value at runtime fails closed.
      const exhaustive: never = driver;
      throw new Error(`unknown store driver: ${String(exhaustive)}`);
    }
  }
}
