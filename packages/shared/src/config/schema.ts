import { z } from "zod";
import { ClassifierConfigSchema } from "./classifier-schema.js";
import { LanesConfigSchema } from "./lanes-schema.js";
import { PoliciesConfigSchema } from "./policy-schema.js";

// Config-as-code: behavior is driven by config/*.yaml + env, not code changes.
// These schemas validate server / auth / providers / runtime / classifier /
// lanes / policies. Per CLAUDE.md principle 2, invalid config is fail-closed
// (the loader parse()s and refuses to start on failure). Single source of truth
// via z.infer. See docs/02, 04, 06.
//
// lanes/policies validate against the SAME LanesConfigSchema/PoliciesConfigSchema
// the router consumes (re-exported by @helm/core) — schema-first, no duplicate
// shapes.

export const ServerConfigSchema = z.object({
  host: z.string().default("0.0.0.0"),
  port: z.number().int().min(1).max(65535).default(8080),
  base_path: z.string().default("/"),
});

export const BootstrapConfigSchema = z.object({
  generate_if_missing: z.boolean().default(true),
  persist_to: z.string().min(1), // file path / env / DB reference
  print_once: z.boolean().default(true),
});

export const AuthConfigSchema = z.object({
  require_api_key: z.boolean().default(true),
  bootstrap: BootstrapConfigSchema,
});

// Credentials are stored as a REFERENCE (env var name) only — never plaintext.
export const ProviderConfigSchema = z.object({
  alias: z.string().min(1),
  type: z.string().min(1), // openai | anthropic | ... (not locked in MVP)
  base_url: z.url().optional(),
  api_key_env: z.string().min(1), // credential reference: env var name, not plaintext
});

// A single quota dimension pair. 0 = that dimension is unlimited (skip the check).
export const RateLimitQuotaSchema = z.object({
  rpm: z.number().int().nonnegative().default(0), // 0 = unlimited
  tpm: z.number().int().nonnegative().default(0),
});

// Per-key partial override: a key may override rpm and/or tpm; absent dimensions
// fall back to `default`. Invalid (negative / non-int) values are fail-closed at
// load time (principle 2) — the limiter never runs on a malformed quota.
export const RateLimitQuotaOverrideSchema = z
  .object({
    rpm: z.number().int().nonnegative().optional(),
    tpm: z.number().int().nonnegative().optional(),
  })
  .strict(); // an override pointing at a non-existent dimension is rejected

export const RateLimitConfigSchema = z.object({
  enabled: z.boolean().default(false), // off by default, zero friction
  default: RateLimitQuotaSchema,
  // key_id -> partial quota override. Missing dimensions fall back to default.
  overrides: z.record(z.string(), RateLimitQuotaOverrideSchema).default({}),
});

// DB abstraction layer (CLAUDE.md "DB 抽象层"). The gateway switches its Store
// adapter set by config: `sqlite` (default, local file) or `supabase` (hosted
// Postgres). The connection string is referenced by ENV VAR NAME (`url_env`) —
// NEVER a plaintext DSN in config/yaml (mirrors providers[].api_key_env,
// principle 7: no credentials in the repo). An unknown driver is fail-closed
// (the enum rejects it) so a typo can never silently fall back to a wrong store.
export const StoreConfigSchema = z.object({
  driver: z.enum(["sqlite", "supabase"]).default("sqlite"),
  // env var name holding the Postgres connection string (supabase driver). A
  // reference only — the loader/factory resolves it at startup, never logged.
  url_env: z.string().min(1).optional(),
});

export const RuntimeConfigSchema = z.object({
  max_request_bytes: z.number().int().positive().default(2_000_000),
  request_timeout_ms: z.number().int().positive().default(60_000),
  rate_limit: RateLimitConfigSchema,
  // Store driver selection. Defaulted so an absent runtime.store stays on sqlite
  // (back-compat); overridable via HELM_STORE_DRIVER (see env-map).
  store: StoreConfigSchema.prefault({ driver: "sqlite" }),
});

export const HelmConfigSchema = z.object({
  server: ServerConfigSchema,
  auth: AuthConfigSchema,
  providers: z.array(ProviderConfigSchema).min(1),
  runtime: RuntimeConfigSchema,
  // classifier config (config/classifier.yaml). Defaulted so the existing
  // server/auth/providers/runtime yaml load is not broken if classifier.yaml is
  // absent; schema lives in its own module (classifier-schema.ts).
  classifier: ClassifierConfigSchema.prefault({
    rules: {
      tier_boundaries: {},
      dimensions: {},
      task_keywords: {},
      tool_prefixes: {},
      overrides: {},
      momentum: {},
    },
    // eval omitted: let ClassifierConfigSchema's own eval prefault supply the
    // default model (the hardened eval schema requires `model`).
  }),
  // Lanes (config/lanes.yaml). OPTIONAL at the config level: when lanes.yaml is
  // absent the gateway falls back to core's DEFAULT_LANES (principle 6, the lane
  // abstraction is always present). When PRESENT, it must be a valid LanesConfig
  // (with a `balanced` terminal) or the loader fails closed (principle 2). Not
  // defaulted here so the server can distinguish "config provided none" (use
  // DEFAULT_LANES) from "config provided lanes".
  lanes: LanesConfigSchema.optional(),
  // Policies (config/policies.yaml). Defaulted to an empty list so an absent
  // policies.yaml is a no-op (the router runs on lanes alone). A present-but-
  // invalid file still fails closed.
  policies: PoliciesConfigSchema.prefault({ policies: [] }),
});

export type ServerConfig = z.infer<typeof ServerConfigSchema>;
export type BootstrapConfig = z.infer<typeof BootstrapConfigSchema>;
export type AuthConfig = z.infer<typeof AuthConfigSchema>;
export type ProviderConfig = z.infer<typeof ProviderConfigSchema>;
export type RateLimitQuota = z.infer<typeof RateLimitQuotaSchema>;
export type RateLimitQuotaOverride = z.infer<typeof RateLimitQuotaOverrideSchema>;
export type RateLimitConfig = z.infer<typeof RateLimitConfigSchema>;
export type StoreConfig = z.infer<typeof StoreConfigSchema>;
export type RuntimeConfig = z.infer<typeof RuntimeConfigSchema>;
export type HelmConfig = z.infer<typeof HelmConfigSchema>;
