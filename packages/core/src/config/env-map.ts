// env -> config path overrides. Environment variables ALWAYS win over file
// values (the credential-injection / container-override contract, docs/10).
//
// NOTE: paths target the real HelmConfigSchema shape (server/auth/providers/
// runtime), reconciled with the illustrative table in the task spec. See
// implementation-notes.md.

export type ConfigPath = readonly string[];

export interface EnvMapping {
  readonly env: string;
  readonly path: ConfigPath;
  /** how to coerce the string env value into the target type before validation */
  readonly kind: "string" | "number" | "boolean";
}

export const ENV_MAPPINGS: readonly EnvMapping[] = [
  { env: "HELM_HOST", path: ["server", "host"], kind: "string" },
  { env: "HELM_PORT", path: ["server", "port"], kind: "number" },
  { env: "HELM_BASE_PATH", path: ["server", "base_path"], kind: "string" },
  { env: "HELM_REQUIRE_API_KEY", path: ["auth", "require_api_key"], kind: "boolean" },
  { env: "HELM_KEYS_PERSIST_TO", path: ["auth", "bootstrap", "persist_to"], kind: "string" },
  {
    env: "HELM_MAX_REQUEST_BYTES",
    path: ["runtime", "max_request_bytes"],
    kind: "number",
  },
  {
    env: "HELM_REQUEST_TIMEOUT_MS",
    path: ["runtime", "request_timeout_ms"],
    kind: "number",
  },
  {
    env: "HELM_RATE_LIMIT_ENABLED",
    path: ["runtime", "rate_limit", "enabled"],
    kind: "boolean",
  },
  // Store driver selection (DB abstraction layer). HELM_STORE_DRIVER picks the adapter set
  // ('sqlite' | 'supabase'); an unknown value is fail-closed by the enum. The
  // connection string itself is referenced indirectly via HELM_STORE_URL_ENV
  // (the NAME of the env var holding the DSN) so no plaintext DSN lands in
  // config — mirrors providers[].api_key_env (principle 7).
  { env: "HELM_STORE_DRIVER", path: ["runtime", "store", "driver"], kind: "string" },
  { env: "HELM_STORE_URL_ENV", path: ["runtime", "store", "url_env"], kind: "string" },
];

// Coerce a string env value into the declared kind. Returns the original string
// for "string"; returns NaN for unparseable numbers so the schema rejects it
// (fail-closed) rather than the loader throwing an opaque error.
export function coerceEnvValue(value: string, kind: EnvMapping["kind"]): unknown {
  switch (kind) {
    case "number": {
      const n = Number(value);
      return Number.isFinite(n) ? n : Number.NaN;
    }
    case "boolean": {
      if (value === "true") return true;
      if (value === "false") return false;
      return value; // anything else stays a string -> schema rejects it
    }
    default:
      return value;
  }
}
