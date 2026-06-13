import { describe, expect, it } from "vitest";
import {
  HelmConfigSchema,
  isOAuthPreset,
  type OAuthConfig,
  ProviderConfigSchema,
} from "./schema.js";

// Narrow a provider's oauth union to the CONFIDENTIAL block for assertions
// (fails loudly if it is actually a preset block).
function confidential(oauth: unknown): OAuthConfig {
  if (!oauth || typeof oauth !== "object" || isOAuthPreset(oauth as never)) {
    throw new Error("expected a confidential oauth block");
  }
  return oauth as OAuthConfig;
}

function fullConfig() {
  return {
    server: { host: "127.0.0.1", port: 9000, base_path: "/" },
    auth: {
      require_api_key: true,
      bootstrap: {
        generate_if_missing: true,
        persist_to: "./data/helm-keys.json",
        print_once: true,
      },
    },
    providers: [
      {
        alias: "openai",
        type: "openai",
        base_url: "https://api.openai.com/v1",
        api_key_env: "OPENAI_API_KEY",
      },
    ],
    runtime: {
      max_request_bytes: 1_000_000,
      request_timeout_ms: 30_000,
      rate_limit: {
        enabled: false,
        default: { rpm: 0, tpm: 0 },
        overrides: {} as Record<string, { rpm?: number; tpm?: number }>,
      },
    },
  };
}

// Minimal config relying on defaults to fill the rest.
function minimalConfig() {
  return {
    server: {},
    auth: { bootstrap: { persist_to: "./data/helm-keys.json" } },
    providers: [{ alias: "openai", type: "openai", api_key_env: "OPENAI_API_KEY" }],
    runtime: { rate_limit: { default: {} } },
  };
}

describe("ProviderConfigSchema targetProviderProtocol", () => {
  function provider(overrides: Record<string, unknown> = {}) {
    return ProviderConfigSchema.parse({
      name: "provider",
      api_key_env: "PROVIDER_API_KEY",
      ...overrides,
    });
  }

  it("uses openai_chat for default and explicit openai provider types", () => {
    expect(provider().targetProviderProtocol).toBe("openai_chat");
    expect(provider({ type: "openai" }).targetProviderProtocol).toBe("openai_chat");
  });

  it.each([
    ["openai-responses", "openai_responses"],
    ["anthropic", "anthropic_messages"],
    ["gemini", "gemini"],
  ] as const)("infers targetProviderProtocol for type %s", (type, targetProviderProtocol) => {
    expect(provider({ type }).targetProviderProtocol).toBe(targetProviderProtocol);
  });

  it("transforms explicit target_provider_protocol override to targetProviderProtocol", () => {
    expect(
      provider({ type: "openai", target_provider_protocol: "openai_responses" })
        .targetProviderProtocol,
    ).toBe("openai_responses");
  });

  it("intentionally defaults unknown provider type to openai_chat", () => {
    expect(provider({ type: "unknown-provider" }).targetProviderProtocol).toBe("openai_chat");
  });
});

describe("HelmConfigSchema", () => {
  it("accepts a full valid config", () => {
    expect(HelmConfigSchema.safeParse(fullConfig()).success).toBe(true);
  });

  it("applies safe defaults from minimal input", () => {
    const parsed = HelmConfigSchema.parse(minimalConfig());
    expect(parsed.server.host).toBe("0.0.0.0");
    expect(parsed.server.port).toBe(8080);
    expect(parsed.server.base_path).toBe("/");
    expect(parsed.auth.require_api_key).toBe(true);
    expect(parsed.auth.bootstrap.generate_if_missing).toBe(true);
    expect(parsed.auth.bootstrap.print_once).toBe(true);
    expect(parsed.runtime.max_request_bytes).toBe(20_000_000);
    expect(parsed.runtime.request_timeout_ms).toBe(60_000);
    expect(parsed.runtime.rate_limit.enabled).toBe(false);
    expect(parsed.runtime.rate_limit.default.rpm).toBe(0);
    expect(parsed.runtime.rate_limit.default.tpm).toBe(0);
    expect(parsed.runtime.signal_feedback.enabled).toBe(false);
    expect(parsed.runtime.signal_feedback.min_samples).toBe(20);
  });

  it("rejects an out-of-range port with a precise path", () => {
    const bad = fullConfig();
    bad.server.port = 70000;
    const res = HelmConfigSchema.safeParse(bad);
    expect(res.success).toBe(false);
    if (!res.success) {
      expect(res.error.issues[0]?.path).toEqual(["server", "port"]);
    }
  });

  it("rejects an empty providers array", () => {
    const bad = { ...fullConfig(), providers: [] };
    const res = HelmConfigSchema.safeParse(bad);
    expect(res.success).toBe(false);
    if (!res.success) {
      expect(res.error.issues[0]?.path).toEqual(["providers"]);
    }
  });

  it("rejects a provider missing api_key_env with a precise path", () => {
    const bad = fullConfig();
    delete (bad.providers[0] as Record<string, unknown>).api_key_env;
    const res = HelmConfigSchema.safeParse(bad);
    expect(res.success).toBe(false);
    if (!res.success) {
      expect(res.error.issues.some((i) => i.path.join(".") === "providers.0.api_key_env")).toBe(
        true,
      );
    }
  });

  it("rejects a negative rpm with a precise path", () => {
    const bad = fullConfig();
    bad.runtime.rate_limit.default.rpm = -1;
    const res = HelmConfigSchema.safeParse(bad);
    expect(res.success).toBe(false);
    if (!res.success) {
      expect(
        res.error.issues.some((i) => i.path.join(".") === "runtime.rate_limit.default.rpm"),
      ).toBe(true);
    }
  });

  it("rejects a negative override rpm (fail-closed) with a precise path", () => {
    const bad = fullConfig();
    bad.runtime.rate_limit.overrides = { k_app1: { rpm: -1 } };
    const res = HelmConfigSchema.safeParse(bad);
    expect(res.success).toBe(false);
    if (!res.success) {
      expect(
        res.error.issues.some(
          (i) => i.path.join(".") === "runtime.rate_limit.overrides.k_app1.rpm",
        ),
      ).toBe(true);
    }
  });

  it("rejects an override pointing at a non-existent dimension (strict)", () => {
    const bad = fullConfig();
    bad.runtime.rate_limit.overrides = { k_app1: { rps: 5 } as Record<string, number> };
    const res = HelmConfigSchema.safeParse(bad);
    expect(res.success).toBe(false);
  });

  it("accepts a partial override (only rpm) and defaults overrides to {}", () => {
    const ok = fullConfig();
    ok.runtime.rate_limit.overrides = { k_app1: { rpm: 100 } };
    const parsed = HelmConfigSchema.parse(ok);
    expect(parsed.runtime.rate_limit.overrides.k_app1?.rpm).toBe(100);
    expect(parsed.runtime.rate_limit.overrides.k_app1?.tpm).toBeUndefined();
  });

  it("does not coerce a string require_api_key", () => {
    const bad = fullConfig();
    (bad.auth as Record<string, unknown>).require_api_key = "true";
    const res = HelmConfigSchema.safeParse(bad);
    expect(res.success).toBe(false);
    if (!res.success) {
      expect(res.error.issues[0]?.path).toEqual(["auth", "require_api_key"]);
    }
  });

  it("stores only a credential reference (api_key_env), never a plaintext key", () => {
    const parsed = HelmConfigSchema.parse(fullConfig());
    const provider = parsed.providers[0];
    expect(provider?.api_key_env).toBe("OPENAI_API_KEY");
    expect(provider && "api_key" in provider).toBe(false);
  });

  it("defaults runtime.store.driver to sqlite when store is absent", () => {
    const parsed = HelmConfigSchema.parse(fullConfig());
    expect(parsed.runtime.store.driver).toBe("sqlite");
  });

  it("accepts driver=supabase with a url_env credential reference", () => {
    const ok = fullConfig() as Record<string, unknown> & { runtime: Record<string, unknown> };
    ok.runtime.store = { driver: "supabase", url_env: "HELM_STORE_URL" };
    const parsed = HelmConfigSchema.parse(ok);
    expect(parsed.runtime.store.driver).toBe("supabase");
    expect(parsed.runtime.store.url_env).toBe("HELM_STORE_URL");
  });

  it("fails closed on an unknown store driver", () => {
    const bad = fullConfig() as Record<string, unknown> & { runtime: Record<string, unknown> };
    bad.runtime.store = { driver: "mysql" };
    const res = HelmConfigSchema.safeParse(bad);
    expect(res.success).toBe(false);
    if (!res.success) {
      expect(res.error.issues[0]?.path).toEqual(["runtime", "store", "driver"]);
    }
  });

  it("never stores a plaintext DB connection string (url_env reference only)", () => {
    const ok = fullConfig() as Record<string, unknown> & { runtime: Record<string, unknown> };
    ok.runtime.store = { driver: "supabase", url_env: "HELM_STORE_URL" };
    const parsed = HelmConfigSchema.parse(ok);
    expect("url" in parsed.runtime.store).toBe(false);
  });

  it("accepts opt-in routing signal feedback thresholds", () => {
    const ok = fullConfig() as Record<string, unknown> & { runtime: Record<string, unknown> };
    ok.runtime.signal_feedback = {
      enabled: true,
      min_samples: 50,
      max_error_rate: 0.2,
      max_fallback_rate: 0.4,
      min_success_rate_delta: 0.1,
    };

    const parsed = HelmConfigSchema.parse(ok);

    expect(parsed.runtime.signal_feedback.enabled).toBe(true);
    expect(parsed.runtime.signal_feedback.min_samples).toBe(50);
    expect(parsed.runtime.signal_feedback.max_error_rate).toBe(0.2);
  });

  it("fails closed on invalid routing signal feedback thresholds", () => {
    const bad = fullConfig() as Record<string, unknown> & { runtime: Record<string, unknown> };
    bad.runtime.signal_feedback = { enabled: true, max_error_rate: 2 };

    const res = HelmConfigSchema.safeParse(bad);

    expect(res.success).toBe(false);
    if (!res.success) {
      expect(
        res.error.issues.some((i) => i.path.join(".") === "runtime.signal_feedback.max_error_rate"),
      ).toBe(true);
    }
  });

  // --- providers-multi: unified provider shape (alias/name, type, base_url?,
  // api_key_env, models[]) — one schema both config-loader and registry agree on.

  it("accepts a multi-provider config with per-model aliases (models[])", () => {
    const cfg = fullConfig() as Record<string, unknown>;
    cfg.providers = [
      {
        name: "openai",
        type: "openai",
        base_url: "https://api.openai.com/v1",
        api_key_env: "OPENAI_API_KEY",
        models: [
          { alias: "cheap_model", provider_model: "gpt-4o-mini" },
          { alias: "openai/auto", provider_model: "gpt-4o" },
        ],
      },
      {
        name: "deepseek",
        type: "openai",
        base_url: "https://api.deepseek.com/v1",
        api_key_env: "DEEPSEEK_API_KEY",
        models: [{ alias: "deepseek/deepseek-v4-flash", provider_model: "deepseek-chat" }],
      },
    ];
    const res = HelmConfigSchema.safeParse(cfg);
    expect(res.success).toBe(true);
    if (res.success) {
      const p0 = res.data.providers[0];
      expect(p0?.models?.[0]).toEqual({ alias: "cheap_model", provider_model: "gpt-4o-mini" });
      expect(res.data.providers[1]?.name).toBe("deepseek");
    }
  });

  it("keeps the Phase-0 passthrough provider working (alias, no models[])", () => {
    // The existing config-samples/providers.yaml shape: { alias, type, base_url,
    // api_key_env } with NO models[]. Must still parse (models defaults to []).
    const parsed = HelmConfigSchema.parse(fullConfig());
    const p0 = parsed.providers[0];
    expect(p0?.api_key_env).toBe("OPENAI_API_KEY");
    expect(p0?.models).toEqual([]); // absent models[] -> empty (passthrough)
  });

  it("derives a provider id from alias when name is absent (back-compat)", () => {
    const parsed = HelmConfigSchema.parse(fullConfig());
    // fullConfig uses `alias: "openai"`; the unified shape exposes `name` for the
    // registry, derived from alias when `name` is not given.
    expect(parsed.providers[0]?.name).toBe("openai");
  });

  it("rejects a model entry missing provider_model (fail-closed)", () => {
    const cfg = fullConfig() as Record<string, unknown>;
    cfg.providers = [
      {
        name: "openai",
        type: "openai",
        base_url: "https://api.openai.com/v1",
        api_key_env: "OPENAI_API_KEY",
        models: [{ alias: "cheap_model" }],
      },
    ];
    const res = HelmConfigSchema.safeParse(cfg);
    expect(res.success).toBe(false);
    if (!res.success) {
      expect(
        res.error.issues.some((i) => i.path.join(".") === "providers.0.models.0.provider_model"),
      ).toBe(true);
    }
  });

  it("never carries a plaintext key on a model-bearing provider (api_key_env only)", () => {
    const cfg = fullConfig() as Record<string, unknown>;
    cfg.providers = [
      {
        name: "openai",
        type: "openai",
        base_url: "https://api.openai.com/v1",
        api_key_env: "OPENAI_API_KEY",
        models: [{ alias: "cheap_model", provider_model: "gpt-4o-mini" }],
      },
    ];
    const parsed = HelmConfigSchema.parse(cfg);
    expect(JSON.stringify(parsed.providers)).not.toMatch(/sk-/);
    expect(parsed.providers[0] && "api_key" in parsed.providers[0]).toBe(false);
  });

  // --- OAuth subscription providers (issue #38). A provider may reference an
  // OAuth credential (env-NAME-only) INSTEAD of a static api_key_env. The two are
  // mutually exclusive and exactly-one is required (fail-closed, principle 2).

  it("accepts a provider with an oauth credential (refresh_token grant)", () => {
    const cfg = fullConfig() as Record<string, unknown>;
    cfg.providers = [
      {
        name: "claude-sub",
        type: "openai",
        base_url: "https://oauth.example.com/v1",
        oauth: {
          grant: "refresh_token",
          token_url: "https://oauth.example.com/token",
          client_id_env: "CLAUDE_SUB_CLIENT_ID",
          client_secret_env: "CLAUDE_SUB_CLIENT_SECRET",
          refresh_token_env: "CLAUDE_SUB_REFRESH_TOKEN",
        },
      },
    ];
    const res = HelmConfigSchema.safeParse(cfg);
    expect(res.success).toBe(true);
    if (res.success) {
      const p0 = res.data.providers[0];
      const oauth = confidential(p0?.oauth);
      expect(oauth.grant).toBe("refresh_token");
      expect(oauth.token_url).toBe("https://oauth.example.com/token");
      expect(oauth.scopes).toEqual([]); // defaulted
      expect(p0?.api_key_env).toBeUndefined();
    }
  });

  it("defaults the oauth grant to refresh_token", () => {
    const cfg = fullConfig() as Record<string, unknown>;
    cfg.providers = [
      {
        name: "claude-sub",
        type: "openai",
        base_url: "https://oauth.example.com/v1",
        oauth: {
          token_url: "https://oauth.example.com/token",
          client_id_env: "CLIENT_ID",
          client_secret_env: "CLIENT_SECRET",
          refresh_token_env: "REFRESH_TOKEN",
        },
      },
    ];
    const parsed = HelmConfigSchema.parse(cfg);
    expect(confidential(parsed.providers[0]?.oauth).grant).toBe("refresh_token");
  });

  it("accepts a client_credentials oauth provider with no refresh_token_env", () => {
    const cfg = fullConfig() as Record<string, unknown>;
    cfg.providers = [
      {
        name: "sso-gw",
        type: "openai",
        base_url: "https://sso.example.com/v1",
        oauth: {
          grant: "client_credentials",
          token_url: "https://sso.example.com/token",
          client_id_env: "SSO_CLIENT_ID",
          client_secret_env: "SSO_CLIENT_SECRET",
          scopes: ["models.read"],
          audience: "https://sso.example.com/api",
        },
      },
    ];
    const res = HelmConfigSchema.safeParse(cfg);
    expect(res.success).toBe(true);
    if (res.success) {
      const oauth = confidential(res.data.providers[0]?.oauth);
      expect(oauth.grant).toBe("client_credentials");
      expect(oauth.scopes).toEqual(["models.read"]);
    }
  });

  it("rejects a provider that has BOTH api_key_env and oauth (fail-closed)", () => {
    const cfg = fullConfig() as Record<string, unknown>;
    cfg.providers = [
      {
        name: "ambiguous",
        type: "openai",
        base_url: "https://x.example.com/v1",
        api_key_env: "X_API_KEY",
        oauth: {
          grant: "client_credentials",
          token_url: "https://x.example.com/token",
          client_id_env: "X_CLIENT_ID",
          client_secret_env: "X_CLIENT_SECRET",
        },
      },
    ];
    const res = HelmConfigSchema.safeParse(cfg);
    expect(res.success).toBe(false);
  });

  it("rejects a provider that has NEITHER api_key_env nor oauth (fail-closed)", () => {
    const cfg = fullConfig() as Record<string, unknown>;
    cfg.providers = [
      {
        name: "credless",
        type: "openai",
        base_url: "https://x.example.com/v1",
      },
    ];
    const res = HelmConfigSchema.safeParse(cfg);
    expect(res.success).toBe(false);
  });

  it("rejects a refresh_token grant missing refresh_token_env (fail-closed)", () => {
    const cfg = fullConfig() as Record<string, unknown>;
    cfg.providers = [
      {
        name: "claude-sub",
        type: "openai",
        base_url: "https://oauth.example.com/v1",
        oauth: {
          grant: "refresh_token",
          token_url: "https://oauth.example.com/token",
          client_id_env: "CLIENT_ID",
          client_secret_env: "CLIENT_SECRET",
          // refresh_token_env intentionally omitted
        },
      },
    ];
    const res = HelmConfigSchema.safeParse(cfg);
    expect(res.success).toBe(false);
  });

  it("rejects an oauth block with a non-url token_url (fail-closed)", () => {
    const cfg = fullConfig() as Record<string, unknown>;
    cfg.providers = [
      {
        name: "claude-sub",
        type: "openai",
        oauth: {
          token_url: "not-a-url",
          client_id_env: "CLIENT_ID",
          client_secret_env: "CLIENT_SECRET",
          refresh_token_env: "REFRESH_TOKEN",
        },
      },
    ];
    const res = HelmConfigSchema.safeParse(cfg);
    expect(res.success).toBe(false);
  });

  it("rejects a non-localhost http oauth token_url (fail-closed)", () => {
    const cfg = fullConfig() as Record<string, unknown>;
    cfg.providers = [
      {
        name: "claude-sub",
        type: "openai",
        oauth: {
          token_url: "http://oauth.example.com/token",
          client_id_env: "CLIENT_ID",
          client_secret_env: "CLIENT_SECRET",
          refresh_token_env: "REFRESH_TOKEN",
        },
      },
    ];
    const res = HelmConfigSchema.safeParse(cfg);
    expect(res.success).toBe(false);
  });

  it.each([
    "http://127.0.0.1:9876/token",
    "http://localhost:9876/token",
    "http://[::1]:9876/token",
  ])("allows localhost http oauth token_url for local tests: %s", (tokenUrl) => {
    const cfg = fullConfig() as Record<string, unknown>;
    cfg.providers = [
      {
        name: "local-oauth",
        type: "openai",
        oauth: {
          token_url: tokenUrl,
          client_id_env: "CLIENT_ID",
          client_secret_env: "CLIENT_SECRET",
          refresh_token_env: "REFRESH_TOKEN",
        },
      },
    ];
    const res = HelmConfigSchema.safeParse(cfg);
    expect(res.success).toBe(true);
  });

  // ── subscription PRESET oauth (issue #38) ──────────────────────────────────

  it("accepts a subscription preset oauth provider (anthropic) with type: anthropic", () => {
    const cfg = fullConfig() as Record<string, unknown>;
    cfg.providers = [{ name: "claude-pro", type: "anthropic", oauth: { provider: "anthropic" } }];
    const res = HelmConfigSchema.safeParse(cfg);
    expect(res.success).toBe(true);
    if (res.success) {
      const p0 = res.data.providers[0];
      expect(p0?.type).toBe("anthropic");
      const oauth = p0?.oauth;
      expect(oauth && isOAuthPreset(oauth)).toBe(true);
      if (oauth && isOAuthPreset(oauth)) {
        expect(oauth.provider).toBe("anthropic");
        expect(oauth.account).toBe("default"); // defaulted
      }
    }
  });

  it("accepts a github-copilot preset with an explicit account", () => {
    const cfg = fullConfig() as Record<string, unknown>;
    cfg.providers = [
      { name: "copilot", type: "openai", oauth: { provider: "github-copilot", account: "work" } },
    ];
    const parsed = HelmConfigSchema.parse(cfg);
    const oauth = parsed.providers[0]?.oauth;
    expect(oauth && isOAuthPreset(oauth) && oauth.account).toBe("work");
  });

  it("rejects an unknown preset provider (fail-closed)", () => {
    const cfg = fullConfig() as Record<string, unknown>;
    cfg.providers = [{ name: "x", type: "openai", oauth: { provider: "midjourney" } }];
    expect(HelmConfigSchema.safeParse(cfg).success).toBe(false);
  });

  it("rejects mixing a preset provider with confidential fields (fail-closed)", () => {
    const cfg = fullConfig() as Record<string, unknown>;
    cfg.providers = [
      {
        name: "x",
        type: "anthropic",
        oauth: {
          provider: "anthropic",
          token_url: "https://oauth.example.com/token",
          client_id_env: "CID",
        },
      },
    ];
    expect(HelmConfigSchema.safeParse(cfg).success).toBe(false);
  });

  it("still enforces exactly-one credential for a preset (api_key_env + preset oauth fails)", () => {
    const cfg = fullConfig() as Record<string, unknown>;
    cfg.providers = [
      { name: "x", type: "anthropic", api_key_env: "X_KEY", oauth: { provider: "anthropic" } },
    ];
    expect(HelmConfigSchema.safeParse(cfg).success).toBe(false);
  });
});
