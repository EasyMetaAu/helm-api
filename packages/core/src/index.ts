// @helm/core — framework-agnostic routing, classification, provider execution,
// protocol translation, and Store ports. MUST NOT import any web framework
// (Hono / SvelteKit / Svelte). See CLAUDE.md principle 1.

export const CORE_PACKAGE = "@helm/core" as const;

// Re-export shared types that gateway/adapters need alongside core ports.
export type { ApiKeyRecord, DecisionRecord } from "@helm/shared";
export {
  type BootstrapDeps,
  type BootstrapResult,
  bootstrapRootKey,
} from "./auth/bootstrap.js";
export {
  extractPrefix,
  type GeneratedKey,
  generateKey,
  hashKey,
  KEY_PREFIX,
} from "./auth/keygen.js";
export {
  type Config,
  ConfigError,
  formatIssues,
  type LoadConfigOptions,
  loadConfig,
} from "./config/loader.js";
export {
  type ChatCompletionRequest,
  type ChatCompletionResponse,
  createOpenAIClient,
  type OpenAIClientDeps,
  type ProviderClient,
  type ProviderConfig,
  UpstreamError,
} from "./provider/openai.js";
export {
  createSqliteDb,
  runMigrations,
  type SqliteDb,
  SqliteKeyStore,
  SqliteTelemetryStore,
} from "./store/index.js";
export type {
  ConfigStore,
  CreateKeyInput,
  InsertTelemetryInput,
  KeyStore,
  TelemetryStore,
} from "./store/ports.js";
export { type RedactOptions, redact, redactKey } from "./telemetry/redaction.js";
