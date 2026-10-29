import { describe, expect, it } from "vitest";
import { ApiKeyAccountInputSchema } from "./api-key-pool.js";
import { ProviderConfigSchema } from "./schema.js";

describe("API key pool configuration boundaries", () => {
  it("accepts a pool without a static key and preserves the legacy key reference", () => {
    const pool = { id: "openai" };
    expect(ProviderConfigSchema.parse({ name: "openai", api_key_pool: pool }).api_key_pool).toEqual(
      { id: "openai", strategy: "round_robin", reset_timezone: "Asia/Shanghai" },
    );
    expect(
      ProviderConfigSchema.parse({
        name: "openai",
        api_key_pool: pool,
        api_key_env: "OPENAI_API_KEY",
      }).api_key_env,
    ).toBe("OPENAI_API_KEY");
  });
  it.each([
    { name: "x", api_key_pool: { id: "x", reset_timezone: "not-a-timezone" } },
    { name: "x", api_key_pool: { id: "x", key: "plaintext" } },
    { name: "x", type: "anthropic", api_key_pool: { id: "x" } },
    { name: "x", api_key_pool: { id: "x" }, oauth: { provider: "openai-codex" } },
  ])("rejects invalid or ambiguous configuration", (config) => {
    expect(ProviderConfigSchema.safeParse(config).success).toBe(false);
  });
  it("accepts project/service credentials but rejects Admin keys", () => {
    expect(ApiKeyAccountInputSchema.safeParse({ name: "a", key: "sk-proj-test-key" }).success).toBe(
      true,
    );
    expect(
      ApiKeyAccountInputSchema.safeParse({ name: "a", key: "sk-svcacct-test-key" }).success,
    ).toBe(true);
    expect(
      ApiKeyAccountInputSchema.safeParse({ name: "a", key: "sk-admin-test-key" }).success,
    ).toBe(false);
  });
});
