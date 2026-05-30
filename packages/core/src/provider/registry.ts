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

// A single provider's config (post-validation). Note the NAME divergence from
// `@helm/shared`'s ProviderConfig (`alias`/`type`, no models[]): that Phase-0
// schema describes the OpenAI-compatible passthrough provider; this registry
// shape is the richer per-model mapping the spec contracts. The two are kept
// distinct on purpose — see implementation-notes 2026-05-31.
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
