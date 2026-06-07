import { z } from "zod";
import { ClassifierConfigSchema } from "./classifier-schema.js";
import { LanesConfigSchema } from "./lanes-schema.js";
import { MemoryConfigSchema } from "./memory-schema.js";
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

// One alias -> provider_model mapping inside a provider. The internal `alias`
// is what lanes/policies reference (principle 6); `provider_model` is the
// provider's real model id (internal supply-chain detail). Both required so a
// half-specified mapping fails closed (principle 2).
export const ProviderModelSchema = z.object({
  alias: z.string().min(1),
  provider_model: z.string().min(1),
});

// OAuth credential reference for subscription / SSO upstreams (issue #38). Like
// api_key_env, this carries env-var NAMES only — never a plaintext token, secret,
// or client id (principle 7). Helm refreshes the access token non-interactively
// (refresh_token / client_credentials grants); the interactive authorization_code
// flow is out of scope (no redirect/callback route — see implementation-notes D1).
//   - grant: which non-interactive grant to use (default refresh_token).
//   - token_url: the OAuth token endpoint (URL, validated).
//   - client_id_env / client_secret_env: env var NAMES holding the OAuth client
//     credentials (both required — the token request is client-authenticated).
//   - refresh_token_env: env var NAME holding the refresh token. REQUIRED for the
//     refresh_token grant (enforced below); unused by client_credentials.
//   - scopes / audience: optional OAuth parameters forwarded in the token request.
export const OAuthConfigSchema = z
  .object({
    grant: z.enum(["refresh_token", "client_credentials"]).default("refresh_token"),
    token_url: z.url().refine(
      (url) => {
        try {
          const parsed = new URL(url);
          if (parsed.protocol === "https:") return true;
          if (parsed.protocol !== "http:") return false;
          return ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname);
        } catch {
          return false;
        }
      },
      { message: "oauth token_url must use https except localhost/127.0.0.1/[::1]" },
    ),
    client_id_env: z.string().min(1), // env var NAME, not a plaintext client id
    client_secret_env: z.string().min(1), // env var NAME, not a plaintext secret
    refresh_token_env: z.string().min(1).optional(), // env var NAME; required for refresh_token
    scopes: z.array(z.string()).default([]),
    audience: z.string().min(1).optional(),
  })
  .refine((o) => o.grant !== "refresh_token" || o.refresh_token_env !== undefined, {
    message: "oauth grant `refresh_token` requires `refresh_token_env`",
    path: ["refresh_token_env"],
  });

// PRESET subscription OAuth (issue #38): a built-in interactive provider whose
// client id / endpoints / scopes are baked in and whose credentials live in the
// OAuthTokenStore (populated by `helm oauth login <provider>`), NOT in env. So,
// unlike the confidential block above, this carries NO env names and NO secret —
// just which provider preset to use. `.strict()` keeps it disjoint from the
// confidential block in the union below (a confidential object's token_url/
// *_env keys are rejected here, so it can only match the confidential branch).
//   - provider: which built-in subscription flow — anthropic (Claude Pro/Max),
//     github-copilot, or openai-codex (ChatGPT Plus/Pro).
//   - account: logical account label for multi-account installs (default 'default').
export const OAuthPresetConfigSchema = z
  .object({
    provider: z.enum(["anthropic", "github-copilot", "openai-codex"]),
    account: z.string().min(1).default("default"),
  })
  .strict();

// A provider's `oauth` block is EITHER the confidential-client config (generic
// SSO / client_credentials) OR a subscription preset. The union tries confidential
// first; a preset object (no token_url / *_env) falls through to the preset branch.
export const OAuthCredentialSchema = z.union([OAuthConfigSchema, OAuthPresetConfigSchema]);

// Discriminate the two oauth modes at the use site (server wiring): a preset block
// is the one carrying a `provider` field.
export function isOAuthPreset(
  o: z.infer<typeof OAuthCredentialSchema>,
): o is z.infer<typeof OAuthPresetConfigSchema> {
  return "provider" in o;
}

// Unified provider config — the SINGLE shape both config-loader and the provider
// registry agree on (reconciles the two divergent ProviderConfig shapes noted in
// implementation-notes provider.registry). A provider carries:
//   - a stable id: `name` (preferred) OR the legacy `alias` (Phase-0 passthrough
//     used `alias`); when only `alias` is given, `name` is derived from it so the
//     registry always has a provider id.
//   - `type` (openai | anthropic | ...): optional, defaults to "openai".
//   - `base_url?`, and EXACTLY ONE credential reference:
//       * `api_key_env` (static key — env var NAME, never a plaintext key), OR
//       * `oauth` (OAuth subscription/SSO credential — env var NAMES only).
//     The exactly-one rule is fail-closed below (principle 2): a half-specified
//     credential (both / neither) refuses to start.
//   - `models[]`: per-model alias mapping. OPTIONAL (defaults to []) so the
//     Phase-0 OpenAI-compatible passthrough provider (no models[]) keeps working.
// Credentials are stored as a REFERENCE (env var name) only — never plaintext.
export const ProviderConfigSchema = z
  .object({
    // At least one of name/alias identifies the provider. `alias` is the legacy
    // Phase-0 field; `name` is the registry-facing id. Kept optional individually
    // and reconciled by the transform below (refine guards "neither given").
    name: z.string().min(1).optional(),
    alias: z.string().min(1).optional(),
    type: z.string().min(1).default("openai"), // openai | anthropic | openai-responses | ... (not locked in MVP)
    base_url: z.url().optional(),
    // Credential reference: env var name, not plaintext. OPTIONAL now that an
    // `oauth` block is an alternative; the exactly-one refine below keeps a
    // provider from booting with both / neither.
    api_key_env: z.string().min(1).optional(),
    oauth: OAuthCredentialSchema.optional(),
    models: z.array(ProviderModelSchema).default([]),
  })
  .refine((p) => p.name !== undefined || p.alias !== undefined, {
    message: "provider requires `name` or `alias`",
    path: ["name"],
  })
  // Exactly one credential mechanism. Applied BEFORE the transform so it reads the
  // raw `api_key_env`/`oauth` fields (the transform only re-keys name/alias and
  // does not touch credentials, but ordering the refine first keeps the guard on
  // the original shape). A provider with both OR neither fails closed (principle 2).
  .refine((p) => (p.api_key_env !== undefined) !== (p.oauth !== undefined), {
    message: "provider requires exactly one of `api_key_env` or `oauth`",
    path: ["api_key_env"],
  })
  .transform((p) => ({
    // Single source of truth for the provider id: prefer `name`, fall back to the
    // legacy `alias`. Both are kept so existing consumers (auth/server) that read
    // `alias` still work, while the registry reads `name`.
    ...p,
    name: p.name ?? (p.alias as string),
    alias: p.alias ?? (p.name as string),
  }));

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

// DB abstraction layer (CLAUDE.md "DB abstraction layer"). The gateway switches its Store
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
  // Memory subtree (config/memory.yaml). NEW per docs/12 — docs/08 left it
  // deferred. Prefaulted so an absent memory.yaml stays on all-defaults
  // (forgetting.enabled:false → behaviour identical to today); a present-but-
  // invalid file still fails closed (principle 2). Empty prefault lets
  // MemoryConfigSchema's own field defaults supply the nested tree.
  memory: MemoryConfigSchema.prefault({}),
});

export type ServerConfig = z.infer<typeof ServerConfigSchema>;
export type BootstrapConfig = z.infer<typeof BootstrapConfigSchema>;
export type AuthConfig = z.infer<typeof AuthConfigSchema>;
export type ProviderModel = z.infer<typeof ProviderModelSchema>;
export type OAuthConfig = z.infer<typeof OAuthConfigSchema>;
export type OAuthPresetConfig = z.infer<typeof OAuthPresetConfigSchema>;
export type OAuthCredential = z.infer<typeof OAuthCredentialSchema>;
export type ProviderConfig = z.infer<typeof ProviderConfigSchema>;
export type RateLimitQuota = z.infer<typeof RateLimitQuotaSchema>;
export type RateLimitQuotaOverride = z.infer<typeof RateLimitQuotaOverrideSchema>;
export type RateLimitConfig = z.infer<typeof RateLimitConfigSchema>;
export type StoreConfig = z.infer<typeof StoreConfigSchema>;
export type RuntimeConfig = z.infer<typeof RuntimeConfigSchema>;
export type HelmConfig = z.infer<typeof HelmConfigSchema>;

// Re-export the memory subtree's public surface from the config barrel so
// consumers import the whole config model from one place (schema-first).
export {
  type CompactionOverrides,
  CompactionOverridesSchema,
  type ForgettingConfig,
  ForgettingSchema,
  type MemoryConfig,
  MemoryConfigSchema,
} from "./memory-schema.js";
