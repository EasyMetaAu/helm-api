import { z } from "zod";
import { ClassifierConfigSchema } from "./classifier-schema.js";

// Config-as-code: behavior is driven by config/*.yaml + env, not code changes.
// These schemas validate server / auth / providers / runtime. Per CLAUDE.md
// principle 2, invalid config is fail-closed (the loader parse()s and refuses to
// start on failure). Single source of truth via z.infer. See docs/02, 06.
//
// Scope: this task covers server/auth/providers/runtime only. lanes/policies/
// classifier/capabilities/pricing schemas belong to their own module tasks.

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

export const RateLimitConfigSchema = z.object({
  enabled: z.boolean().default(false), // off by default, zero friction
  default: z.object({
    rpm: z.number().int().nonnegative().default(0), // 0 = unlimited
    tpm: z.number().int().nonnegative().default(0),
  }),
});

export const RuntimeConfigSchema = z.object({
  max_request_bytes: z.number().int().positive().default(2_000_000),
  request_timeout_ms: z.number().int().positive().default(60_000),
  rate_limit: RateLimitConfigSchema,
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
    eval: {},
  }),
});

export type ServerConfig = z.infer<typeof ServerConfigSchema>;
export type BootstrapConfig = z.infer<typeof BootstrapConfigSchema>;
export type AuthConfig = z.infer<typeof AuthConfigSchema>;
export type ProviderConfig = z.infer<typeof ProviderConfigSchema>;
export type RateLimitConfig = z.infer<typeof RateLimitConfigSchema>;
export type RuntimeConfig = z.infer<typeof RuntimeConfigSchema>;
export type HelmConfig = z.infer<typeof HelmConfigSchema>;
