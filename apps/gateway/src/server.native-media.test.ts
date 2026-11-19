import { ProviderConfigSchema } from "@helm/shared";
import { afterEach, expect, it, vi } from "vitest";
import { buildProviderClients, testStaticProviderKey } from "./server.js";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});
for (const type of ["bailian-media", "minimax-media"] as const) {
  const config = ProviderConfigSchema.parse({
    name: type,
    type,
    api_key_env: "NATIVE_TEST_KEY",
    media_account_id: "fixture-account",
    base_url:
      type === "bailian-media" ? "https://dashscope.aliyuncs.com/api/v1" : "https://api.minimax.io",
    models: [{ alias: `${type}/video`, provider_model: "fixture" }],
  });
  it(`${type} exposes dedicated media methods and never probes chat`, async () => {
    vi.stubEnv("NATIVE_TEST_KEY", "fixture-key");
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const client = buildProviderClients([config], "https://api.openai.com/v1", 1000).get(type);
    expect(client?.mediaOnly).toBe(true);
    expect(client?.videoGeneration).toBeTypeOf("function");
    expect(client?.ttsSpeech).toBeTypeOf("function");
    if (type === "bailian-media") {
      expect(client?.imageGeneration).toBeTypeOf("function");
      expect(client?.transcriptionCreate).toBeTypeOf("function");
    }
    await expect(client?.chatCompletion({ model: "fixture", messages: [] })).rejects.toThrow(
      "dedicated media endpoint",
    );
    await expect(testStaticProviderKey(config, "fixture-key")).rejects.toThrow("chat connectivity");
    expect(fetch).not.toHaveBeenCalled();
  });
}

for (const type of ["openai-audio", "deepgram", "whisperx-asr", "doubao-speech"] as const) {
  it(`${type} wires file transcription and rejects chat probes`, async () => {
    vi.stubEnv("AUDIO_TEST_KEY", "fixture-key");
    const config = ProviderConfigSchema.parse({
      name: type,
      type,
      api_key_env: "AUDIO_TEST_KEY",
      media_account_id: "test-account",
      base_url:
        type === "deepgram"
          ? "https://api.deepgram.com/v1"
          : type === "openai-audio"
            ? "https://api.openai.com/v1"
            : type === "doubao-speech"
              ? "https://openspeech.bytedance.com"
              : "https://gpu.example.test",
      models: [],
    });
    const client = buildProviderClients([config], "https://example.test", 1000).get(type);
    if (type === "doubao-speech") {
      expect(client?.ttsSpeech).toBeTypeOf("function");
      expect(client?.transcriptionCreate).toBeTypeOf("function");
    } else expect(client?.transcribe).toBeTypeOf("function");
    expect(client?.mediaOnly).toBe(true);
    await expect(testStaticProviderKey(config, "fixture-key")).rejects.toThrow("chat connectivity");
  });
}

it("keeps pooled audio credentials on the official origin under a runtime URL override", async () => {
  const config = ProviderConfigSchema.parse({
    name: "audio",
    type: "openai-audio",
    base_url: "https://api.openai.com/v1",
    api_key_env: "TEST_AUDIO_KEY",
    api_key_pool: { id: "openai" },
    models: [],
  });
  vi.stubEnv("TEST_AUDIO_KEY", "fixture");
  const fetch = vi.fn().mockResolvedValue(Response.json({ text: "test" }));
  vi.stubGlobal("fetch", fetch);
  const clients = buildProviderClients(
    [{ ...config, base_url: "https://override.example/v1" }],
    "",
    1000,
  );
  await expect(
    clients.get("audio")!.transcribe!(
      { model: "gpt-transcribe" },
      new File(["fixture"], "test.wav"),
    ),
  ).rejects.toMatchObject({ code: "provider_unavailable" });
  expect(fetch).not.toHaveBeenCalled();
});

it("enforces the configured WhisperX duration before sending anything upstream", async () => {
  vi.stubEnv("AUDIO_TEST_KEY", "fixture-key");
  const fetch = vi
    .fn()
    .mockResolvedValue(
      Response.json({ status: "success", result: { segments: [], audio_duration: 1 } }),
    );
  vi.stubGlobal("fetch", fetch);
  const config = ProviderConfigSchema.parse({
    name: "gpu",
    type: "whisperx-asr",
    api_key_env: "AUDIO_TEST_KEY",
    base_url: "https://gpu.example.test",
    whisperx_max_audio_seconds: 1,
  });
  const client = buildProviderClients([config], "https://example.test", 1000).get("gpu");
  if (!client?.transcribe) throw new Error("WhisperX client is unavailable");
  const wav = (frames: number) => {
    const bytes = Buffer.alloc(44 + frames * 2);
    bytes.write("RIFF", 0);
    bytes.writeUInt32LE(bytes.length - 8, 4);
    bytes.write("WAVEfmt ", 8);
    bytes.writeUInt32LE(16, 16);
    bytes.writeUInt16LE(1, 20);
    bytes.writeUInt16LE(1, 22);
    bytes.writeUInt32LE(8000, 24);
    bytes.writeUInt32LE(16000, 28);
    bytes.writeUInt16LE(2, 32);
    bytes.writeUInt16LE(16, 34);
    bytes.write("data", 36);
    bytes.writeUInt32LE(frames * 2, 40);
    return new File([bytes], "clip.wav", { type: "audio/wav" });
  };
  const unsupported = new File(["unverified audio"], "audio.wav", { type: "audio/wav" });
  for (const file of [unsupported, wav(8001)]) {
    await expect(client.transcribe({ model: "whisperx" }, file)).rejects.toThrow(
      "configured time limit",
    );
  }
  expect(fetch).not.toHaveBeenCalled();

  await expect(client.transcribe({ model: "whisperx" }, wav(8000))).resolves.toMatchObject({
    usage: { type: "duration", seconds: 1 },
  });
  expect(fetch).toHaveBeenCalledTimes(1);
});
