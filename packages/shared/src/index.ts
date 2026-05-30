// @helm/shared — Zod schemas + shared types. Single source of truth for types
// (via z.infer). Framework-agnostic. See CLAUDE.md.

export const SHARED_PACKAGE = "@helm/shared" as const;

// Config model (docs/02, 06).
export {
  type AuthConfig,
  AuthConfigSchema,
  type BootstrapConfig,
  BootstrapConfigSchema,
  type HelmConfig,
  HelmConfigSchema,
  type ProviderConfig,
  ProviderConfigSchema,
  type RateLimitConfig,
  RateLimitConfigSchema,
  type RuntimeConfig,
  RuntimeConfigSchema,
  type ServerConfig,
  ServerConfigSchema,
} from "./config/schema.js";
// Decision record (docs/02, 03, 04, 07).
export {
  type AttemptStatus,
  AttemptStatusSchema,
  type ClassifierDecision,
  ClassifierDecisionSchema,
  type DecidedBy,
  DecidedBySchema,
  type DecisionRecord,
  DecisionRecordSchema,
  type FinalDecision,
  FinalDecisionSchema,
  type LaneDecision,
  LaneDecisionSchema,
  type PolicyDecision,
  PolicyDecisionSchema,
  type ProviderAttempt,
  ProviderAttemptSchema,
} from "./decision/schema.js";
// Structured error model + error_class -> HTTP map (docs/07).
export {
  ERROR_CLASS_HTTP_STATUS,
  type ErrorClass,
  ErrorClassSchema,
  type HelmError,
  HelmErrorSchema,
  makeHelmError,
} from "./error/schema.js";
// API key record (docs/06) — hash + prefix only, never plaintext.
export {
  type ApiKeyRecord,
  ApiKeyRecordSchema,
  type KeyRole,
  KeyRoleSchema,
} from "./key/schema.js";
// Internal request structure (docs/02).
export {
  type InternalRequest,
  InternalRequestSchema,
  type MemoryMode,
  MemoryModeSchema,
  type Protocol,
  ProtocolSchema,
  type RequestMetadata,
  RequestMetadataSchema,
} from "./request/schema.js";
export { version } from "./version.js";
