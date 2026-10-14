import { expect, it } from "vitest";
import { ProviderConfigSchema } from "./schema.js";

const base = { name: "media", api_key_env: "MEDIA_KEY", media_account_id: "account-a" };
it.each([
  ["bailian-media", "https://workspace.example/api/v1"],
  ["minimax-media", "https://api.minimax.io"],
])("accepts explicitly bound %s configuration", (type, base_url) => {
  expect(ProviderConfigSchema.parse({ ...base, type, base_url }).media_account_id).toBe(
    "account-a",
  );
});
it.each([
  { type: "bailian-media", base_url: "https://example.com/compatible-mode/v1" },
  { type: "bailian-media", base_url: "https://example.com/api/v1", media_account_id: undefined },
  { type: "bailian-media", base_url: "http://example.com/api/v1" },
  { type: "minimax-media", base_url: "https://example.com/v1" },
  { type: "minimax-media", base_url: "https://example.com?key=secret" },
  { type: "minimax-media", base_url: "https://user:secret@example.com" },
  { type: "minimax-media" },
  { type: "bailian-media-typo", base_url: "https://example.com" },
])("rejects unsafe or ambiguous native media config: %j", (extra) => {
  expect(ProviderConfigSchema.safeParse({ ...base, ...extra }).success).toBe(false);
});
it("preserves existing provider shapes", () => {
  expect(
    ProviderConfigSchema.safeParse({ name: "x", type: "openai", api_key_env: "KEY" }).success,
  ).toBe(true);
  expect(
    ProviderConfigSchema.safeParse({ name: "x", type: "ark", api_key_env: "KEY" }).success,
  ).toBe(true);
});
