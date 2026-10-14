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
