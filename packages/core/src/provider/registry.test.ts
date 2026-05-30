import { describe, expect, it } from "vitest";
import { createProviderRegistry, type ProviderConfig } from "./registry.js";

// Provider Registry — turns validated multi-provider config into a lookup table
// keyed by internal ALIAS, and resolves alias -> { provider, model, base_url,
// api_key_env }. lane/policy only reference aliases (principle 6); credentials
// are referenced by env-var NAME only, never plaintext (principle 7). Unknown
// alias => structured Result error (fail-open signal), NOT a thrown exception;
// duplicate alias at build time => fail-closed (principle 2). See task
// provider.registry, docs/02.

const openai: ProviderConfig = {
  name: "openai",
  base_url: "https://api.openai.com/v1",
  api_key_env: "OPENAI_API_KEY",
  models: [
    { alias: "cheap_model", provider_model: "gpt-4o-mini" },
    { alias: "openai/auto", provider_model: "gpt-4o" },
  ],
};

const anthropic: ProviderConfig = {
  name: "anthropic",
  base_url: "https://api.anthropic.com/v1",
  api_key_env: "ANTHROPIC_API_KEY",
  models: [{ alias: "best_reasoning_model", provider_model: "claude-opus-4" }],
};

describe("createProviderRegistry / resolve", () => {
  it("resolves an alias to its provider + model + base_url + api_key_env", () => {
    const reg = createProviderRegistry([openai]);
    const res = reg.resolve("cheap_model");
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value).toEqual({
        alias: "cheap_model",
        providerName: "openai",
        providerModel: "gpt-4o-mini",
        baseUrl: "https://api.openai.com/v1",
        apiKeyEnv: "OPENAI_API_KEY",
      });
    }
  });

  it("returns a structured unknown_alias error (no throw) for an unknown alias", () => {
    const reg = createProviderRegistry([openai]);
    let res: ReturnType<typeof reg.resolve>;
    expect(() => {
      res = reg.resolve("nope");
    }).not.toThrow();
    res = reg.resolve("nope");
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toEqual({ kind: "unknown_alias", alias: "nope" });
    }
  });

  it("keeps multiple providers separate — each alias hits the correct provider + base_url", () => {
    const reg = createProviderRegistry([openai, anthropic]);

    const a = reg.resolve("cheap_model");
    expect(a.ok).toBe(true);
    if (a.ok) {
      expect(a.value.providerName).toBe("openai");
      expect(a.value.baseUrl).toBe("https://api.openai.com/v1");
      expect(a.value.providerModel).toBe("gpt-4o-mini");
    }

    const b = reg.resolve("best_reasoning_model");
    expect(b.ok).toBe(true);
    if (b.ok) {
      expect(b.value.providerName).toBe("anthropic");
      expect(b.value.baseUrl).toBe("https://api.anthropic.com/v1");
      expect(b.value.providerModel).toBe("claude-opus-4");
      expect(b.value.apiKeyEnv).toBe("ANTHROPIC_API_KEY");
    }
  });

  it("fails closed on a duplicate alias across providers (no silent override)", () => {
    const dupB: ProviderConfig = {
      name: "anthropic",
      base_url: "https://api.anthropic.com/v1",
      api_key_env: "ANTHROPIC_API_KEY",
      models: [{ alias: "cheap_model", provider_model: "claude-haiku" }],
    };
    expect(() => createProviderRegistry([openai, dupB])).toThrowError(/duplicate_alias/);
    // The error must carry the structured duplicate_alias kind + offending alias.
    try {
      createProviderRegistry([openai, dupB]);
      throw new Error("expected createProviderRegistry to throw");
    } catch (err) {
      expect((err as { error?: unknown }).error).toEqual({
        kind: "duplicate_alias",
        alias: "cheap_model",
      });
    }
  });

  it("never exposes a plaintext credential — only api_key_env (env NAME)", () => {
    const reg = createProviderRegistry([openai]);
    const res = reg.resolve("cheap_model");
    expect(res.ok).toBe(true);
    if (res.ok) {
      const keys = Object.keys(res.value);
      expect(keys).toContain("apiKeyEnv");
      // No plaintext-key-shaped field leaks into the resolved target.
      expect(keys).not.toContain("apiKey");
      expect(keys).not.toContain("api_key");
      expect(keys).not.toContain("key");
      expect(keys).not.toContain("secret");
      expect(JSON.stringify(res.value)).not.toMatch(/sk-/);
    }
  });

  it("registers and resolves a `*/auto` alias (Lane Resolver owns its ordering)", () => {
    const reg = createProviderRegistry([openai]);
    const res = reg.resolve("openai/auto");
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value.providerName).toBe("openai");
      expect(res.value.providerModel).toBe("gpt-4o");
    }
  });

  it("list() returns every registered alias", () => {
    const reg = createProviderRegistry([openai, anthropic]);
    expect(reg.list().sort()).toEqual(
      ["best_reasoning_model", "cheap_model", "openai/auto"].sort(),
    );
  });
});
