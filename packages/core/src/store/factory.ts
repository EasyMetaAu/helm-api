import { join } from "node:path";
import type { StoreConfig } from "@helm/shared";
import type {
  ConfigStore,
  CreditStore,
  KeyStore,
  MemoryStore,
  OAuthTokenStore,
  RateLimitStore,
  SignalStore,
  TelemetryStore,
} from "./ports.js";
import { PgConfigStore } from "./postgres/config-store.js";
import { PgCreditStore } from "./postgres/credit.js";
import { PgKeyStore } from "./postgres/keystore.js";
import { PgMemoryStore } from "./postgres/memory-store.js";
import { createPgDb } from "./postgres/migrate.js";
import { PgOAuthTokenStore } from "./postgres/oauth-tokens.js";
import { PgRateLimitStore } from "./postgres/rate-limit.js";
import { PgSignalStore } from "./postgres/signals.js";
import { PgTelemetryStore } from "./postgres/telemetry.js";
import { SqliteConfigStore } from "./sqlite/config-store.js";
import { SqliteCreditStore } from "./sqlite/credit.js";
import { SqliteKeyStore } from "./sqlite/keystore.js";
import { SqliteMemoryStore } from "./sqlite/memory-store.js";
import { createSqliteDb } from "./sqlite/migrate.js";
import { SqliteOAuthTokenStore } from "./sqlite/oauth-tokens.js";
import { SqliteRateLimitStore } from "./sqlite/rate-limit.js";
import { SqliteSignalStore } from "./sqlite/signals.js";
import { SqliteTelemetryStore } from "./sqlite/telemetry.js";

// The full set of Store-port implementations the gateway needs, plus a `close`
// lifecycle hook. The driver (sqlite vs supabase) is chosen ONCE here by config;
// every caller depends only on the port interfaces, never on a concrete adapter
// (CLAUDE.md "DB abstraction layer": core depends on interfaces, not a specific DB).
export interface StoreSet {
  readonly keys: KeyStore;
  readonly telemetry: TelemetryStore;
  readonly signals: SignalStore;
  readonly rateLimit: RateLimitStore;
  readonly credit: CreditStore;
  readonly memory: MemoryStore;
  readonly config: ConfigStore;
  readonly oauthTokens: OAuthTokenStore;
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
      const db = createSqliteDb(join(dataDir, "helm.db"));
      return {
        keys: new SqliteKeyStore(db),
        telemetry: new SqliteTelemetryStore(db),
        signals: new SqliteSignalStore(db),
        rateLimit: new SqliteRateLimitStore(db),
        credit: new SqliteCreditStore(db),
        memory: new SqliteMemoryStore(db),
        config: new SqliteConfigStore(db),
        oauthTokens: new SqliteOAuthTokenStore(db),
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
        credit: new PgCreditStore(db),
        memory: new PgMemoryStore(db),
        config: new PgConfigStore(db),
        oauthTokens: new PgOAuthTokenStore(db),
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
