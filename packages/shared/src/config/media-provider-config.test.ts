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

it("accepts an official OpenAI transcription provider with an existing API key pool", () => {
  const pooled = {
    name: "openai-transcription",
    type: "openai-audio",
    base_url: "https://api.openai.com/v1",
    api_key_pool: { id: "openai" },
  };
  expect(ProviderConfigSchema.safeParse(pooled).success).toBe(true);
  expect(ProviderConfigSchema.safeParse({ ...pooled, type: "deepgram" }).success).toBe(false);
  expect(
    ProviderConfigSchema.safeParse({ ...pooled, base_url: "http://api.openai.com" }).success,
  ).toBe(false);
  expect(
    ProviderConfigSchema.safeParse({ ...pooled, base_url: "https://proxy.example/v1" }).success,
  ).toBe(false);
});

for (const type of ["openai-audio", "deepgram", "doubao-speech", "whisperx-asr"]) {
  it(`${type} requires an explicit authenticated HTTPS configuration`, () => {
    expect(
      ProviderConfigSchema.safeParse({ ...base, type, base_url: "https://voice.example.test" })
        .success,
    ).toBe(true);
    for (const base_url of [
      undefined,
      "http://voice.example.test",
      "https://user:pass@voice.example.test",
      "https://voice.example.test?key=value",
    ])
      expect(ProviderConfigSchema.safeParse({ ...base, type, base_url }).success).toBe(false);
  });
}

it("accepts a positive WhisperX-only audio duration limit", () => {
  const config = { ...base, type: "whisperx-asr", base_url: "https://gpu.example.test" };
  expect(
    ProviderConfigSchema.parse({ ...config, whisperx_max_audio_seconds: 360 })
      .whisperx_max_audio_seconds,
  ).toBe(360);
  for (const max of [0, -1, 1.5, "360", Infinity]) {
    expect(
      ProviderConfigSchema.safeParse({ ...config, whisperx_max_audio_seconds: max }).success,
    ).toBe(false);
  }
  expect(
    ProviderConfigSchema.safeParse({
      ...config,
      type: "deepgram",
      whisperx_max_audio_seconds: 360,
    }).success,
  ).toBe(false);
});

it("accepts positive integer shared concurrency limits only for WhisperX", () => {
  const config = { ...base, type: "whisperx-asr", base_url: "https://gpu.example.test" };
  expect(
    ProviderConfigSchema.parse({ ...config, whisperx_max_concurrent: 1 }).whisperx_max_concurrent,
  ).toBe(1);
  for (const limit of [0, -1, 1.5, "2", Infinity]) {
    expect(
      ProviderConfigSchema.safeParse({ ...config, whisperx_max_concurrent: limit }).success,
    ).toBe(false);
  }
  expect(
    ProviderConfigSchema.safeParse({ ...config, type: "deepgram", whisperx_max_concurrent: 1 })
      .success,
  ).toBe(false);
});
