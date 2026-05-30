import { describe, expect, it } from "vitest";
import { HelmConfigSchema } from "./schema.js";

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
    expect(parsed.runtime.max_request_bytes).toBe(2_000_000);
    expect(parsed.runtime.request_timeout_ms).toBe(60_000);
    expect(parsed.runtime.rate_limit.enabled).toBe(false);
    expect(parsed.runtime.rate_limit.default.rpm).toBe(0);
    expect(parsed.runtime.rate_limit.default.tpm).toBe(0);
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
});
