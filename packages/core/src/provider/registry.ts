// Provider Registry — maps internal ALIASES to concrete delivery targets
// (provider + model + base_url + credential env NAME). lane/policy reference
// only aliases; provider/model ids are internal supply-chain detail (CLAUDE.md
// principle 6). Framework-agnostic (principle 1) and does NO file/YAML I/O — it
// receives an already-Zod-validated ProviderConfig[] (validation belongs to
// shared.config-schema). Credentials are referenced by env-var NAME only, never
// a plaintext key (principle 7). See task provider.registry, docs/02.
//
// Failure modes:
//  - Unknown alias  => structured Result error `unknown_alias` (NO throw). This
//    is a fail-OPEN signal: the caller decides to skip the candidate / record a
//    decision, the registry never silently substitutes another model.
//  - Duplicate alias across providers => fail-CLOSED at BUILD time: the factory
//    throws RegistryBuildError so an ambiguous config refuses to start
//    (principle 2), rather than letting a later provider silently shadow an
//    earlier one at runtime.

import type { ProviderConfig as SharedProviderConfig } from "@helm/shared";

// A single provider's config (post-validation). This is structurally a SUBSET of
// `@helm/shared`'s unified ProviderConfig (which now also carries name + models[]
// — the divergence noted in implementation-notes provider.registry is RESOLVED:
// one schema validates config, `toRegistryProviders` adapts it to this shape).
export interface ProviderConfig {
  name: string; // provider id, e.g. "openai" / "anthropic" / "openrouter"
  base_url: string;
  api_key_env: string; // credential reference: env var NAME — never a plaintext key
  models: Array<{
    alias: string; // internal alias, e.g. "cheap_model", "openai/auto"
    provider_model: string; // the provider's real model id, e.g. "gpt-4o-mini"
  }>;
}

// Resolved delivery target for an alias. Holds api_key_env (the env NAME) only;
// the real key is read from process.env by the execution layer, never here.
export interface ResolvedProvider {
  alias: string;
  providerName: string;
  providerModel: string; // the provider's real model id
  baseUrl: string;
  apiKeyEnv: string; // credential env NAME — value is NOT echoed here
}

// Structured resolve/build errors — unknown alias (resolve-time) and duplicate
// alias (build-time). Discriminated union: callers switch on `kind`, no throw.
export type ResolveError =
  | { kind: "unknown_alias"; alias: string }
  | { kind: "duplicate_alias"; alias: string };

// Result of resolve(): success carries the target, failure the structured error.
export type ResolveResult =
  | { ok: true; value: ResolvedProvider }
  | { ok: false; error: ResolveError };

export interface ProviderRegistry {
  resolve(alias: string): ResolveResult;
  list(): string[]; // all registered aliases (debug / validation)
}

// Thrown by createProviderRegistry on a duplicate alias (build-time fail-closed).
// Carries the structured `duplicate_alias` error for programmatic handling.
export class RegistryBuildError extends Error {
  readonly error: Extract<ResolveError, { kind: "duplicate_alias" }>;
  constructor(error: Extract<ResolveError, { kind: "duplicate_alias" }>) {
    super(`${error.kind}: ${error.alias}`);
    this.name = "RegistryBuildError";
    this.error = error;
  }
}

// Build the registry from validated multi-provider config. Alias collisions are
// rejected here (fail-closed) so runtime resolution is deterministic.
export function createProviderRegistry(providers: ProviderConfig[]): ProviderRegistry {
  const byAlias = new Map<string, ResolvedProvider>();

  for (const provider of providers) {
    for (const model of provider.models) {
      if (byAlias.has(model.alias)) {
        throw new RegistryBuildError({ kind: "duplicate_alias", alias: model.alias });
      }
      byAlias.set(model.alias, {
        alias: model.alias,
        providerName: provider.name,
        providerModel: model.provider_model,
        baseUrl: provider.base_url,
        apiKeyEnv: provider.api_key_env,
      });
    }
  }

  return {
    resolve(alias: string): ResolveResult {
      const value = byAlias.get(alias);
      if (value === undefined) {
        return { ok: false, error: { kind: "unknown_alias", alias } };
      }
      return { ok: true, value };
    },
    list(): string[] {
      return [...byAlias.keys()];
    },
  };
}

// Adapt the unified shared ProviderConfig[] (validated by HelmConfigSchema, the
// SINGLE source of truth config-loader uses) into the registry's ProviderConfig[].
// This is the bridge that removes the old two-shape divergence: config-loader and
// the registry now agree on one schema; this only re-keys it for build.
//
// - Provider id := shared `name` (the schema already derives it from `alias` when
//   `name` is absent — Phase-0 back-compat).
// - `base_url` := the provider's own base_url, else the injected fallback (e.g.
//   the HELM_PROVIDER_BASE_URL the e2e/test harness points at the mock upstream),
//   else "" (a provider with models[] but no resolvable base_url is a config gap
//   the caller surfaces).
// - Credentials stay env-NAME only (api_key_env) — never a plaintext key.
// - Providers WITHOUT models[] (the Phase-0 passthrough provider) contribute no
//   aliases here; their aliases come from the active lanes (mapped 1:1 to the
//   primary provider by the caller). Passing them through with empty models[] is
//   harmless (no aliases registered).
export function toRegistryProviders(
  providers: ReadonlyArray<SharedProviderConfig>,
  opts: { fallbackBaseUrl?: string } = {},
): ProviderConfig[] {
  return providers.map((p) => ({
    name: p.name,
    base_url: p.base_url ?? opts.fallbackBaseUrl ?? "",
    api_key_env: p.api_key_env,
    models: p.models.map((m) => ({ alias: m.alias, provider_model: m.provider_model })),
  }));
}
