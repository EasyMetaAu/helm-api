import { describe, expect, it } from "vitest";
import { ManagedProviderInputSchema, ManagedProviderViewSchema } from "./managed-provider.js";

describe("managed provider boundary", () => {
  const provider = {
    id: "kimi",
    label: "Kimi",
    type: "openai",
    base_url: "https://api.kimi.ai/coding/v1",
    models: [{ alias: "kimi/pro", provider_model: "k3.1-pro" }],
  };
  it("accepts custom endpoints and explicit model associations", () => {
    expect(ManagedProviderInputSchema.parse(provider).models[0]?.provider_model).toBe("k3.1-pro");
  });
  it("rejects ambiguous aliases, OAuth identities and credentials in URLs", () => {
    for (const change of [
      { id: "openai-codex" },
      { base_url: "https://user:secret@example.com" },
      { base_url: "https://example.com?key=secret" },
      { models: [provider.models[0], provider.models[0]] },
    ]) {
      expect(ManagedProviderInputSchema.safeParse({ ...provider, ...change }).success).toBe(false);
    }
  });
  it("keeps protocol-specific media validation and supports non-OpenAI keys separately", () => {
    expect(
      ManagedProviderInputSchema.safeParse({
        ...provider,
        type: "bailian-media",
        base_url: "https://example.com/api/v1",
        media_account_id: "bailian",
      }).success,
    ).toBe(true);
    expect(
      ManagedProviderInputSchema.safeParse({ ...provider, type: "bailian-media" }).success,
    ).toBe(false);
  });
});

it("allows listing an unconfigured legacy provider while requiring models when saving", () => {
  const provider = {
    id: "placeholder",
    label: "Placeholder",
    type: "openai",
    base_url: "https://example.com",
    models: [],
    poolId: "placeholder",
    managed: false,
    legacyCredentialAvailable: false,
  };
  expect(ManagedProviderViewSchema.safeParse(provider).success).toBe(true);
  expect(
    ManagedProviderInputSchema.safeParse({
      id: provider.id,
      label: provider.label,
      type: provider.type,
      base_url: provider.base_url,
      models: [],
    }).success,
  ).toBe(false);
});
