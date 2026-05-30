import { join } from "node:path";
import {
  bootstrapRootKey,
  createOpenAIClient,
  createSqliteDb,
  generateKey,
  loadConfig,
  type ProviderConfig,
  redact,
  SqliteKeyStore,
  SqliteTelemetryStore,
} from "@helm/core";
import { createApp } from "./app.js";
import { readBuildInfo } from "./build-info.js";
import { createJsonLogger, type Logger } from "./logging.js";
import { authMiddleware } from "./middleware/auth.js";
import { registerChatRoutes } from "./routes/chat.js";

export interface ServerHandle {
  app: ReturnType<typeof createApp>;
  port: number;
  host: string;
}

// Full Phase 0 wiring: config -> store -> bootstrap key -> provider -> routes.
// Fail-closed: an invalid config throws (caller exits non-zero). The HTTP listen
// is performed by the caller (index.ts) so this stays testable.
export function buildServer(opts: { logger?: Logger; configDir?: string } = {}): ServerHandle {
  const logger = opts.logger ?? createJsonLogger();
  const config = loadConfig({ configDir: opts.configDir ?? "./config" });

  // Store: SQLite (default). dataDir from the key persist path's directory.
  const dataDir = process.env.HELM_DATA_DIR ?? "./data";
  const db = createSqliteDb(join(dataDir, "helm.db"));
  const keyStore = new SqliteKeyStore(db);
  const telemetry = new SqliteTelemetryStore(db);

  // Bootstrap root key on first start (idempotent; prints once).
  void bootstrapRootKey({
    keyStore,
    generateKey,
    now: () => new Date(),
    log: (line) => logger.log("warn", "bootstrap.root_key", { line }),
  });

  // Provider: the first configured OpenAI-compatible upstream (Phase 0).
  const first = config.providers[0];
  if (!first) throw new Error("no provider configured");
  const apiKey = process.env[first.api_key_env];
  if (!apiKey) throw new Error(`missing provider credential env: ${first.api_key_env}`);
  const providerConfig: ProviderConfig = {
    // HELM_PROVIDER_BASE_URL overrides the configured base_url (used by e2e to
    // point at a local mock upstream; also handy for staging swaps).
    baseUrl: process.env.HELM_PROVIDER_BASE_URL ?? first.base_url ?? "https://api.openai.com/v1",
    apiKey,
    timeoutMs: config.runtime.request_timeout_ms,
  };
  const provider = createOpenAIClient({ config: providerConfig });

  const app = createApp({
    logger,
    health: {
      checkReadiness: async () => ({ ready: true, checks: { store: "ok" } }),
      buildInfo: readBuildInfo(),
    },
    limits: {
      maxBodyBytes: config.runtime.max_request_bytes,
      requestTimeoutMs: config.runtime.request_timeout_ms,
    },
  });

  // Mandatory auth on /v1/*, then the chat passthrough route.
  app.use(
    "/v1/*",
    authMiddleware({ keyStore, log: (l) => logger.log("warn", "auth", { line: l }) }),
  );
  registerChatRoutes(app, {
    provider,
    telemetry,
    redact: (payload) => redact(payload),
    now: () => Date.now(),
  });

  return { app, port: config.server.port, host: config.server.host };
}
