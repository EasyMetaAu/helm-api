import { ProviderConfigSchema } from "@helm/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildProviderClients, testStaticProviderKey } from "./server.js";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("Ark provider wiring", () => {
  const config = ProviderConfigSchema.parse({
    name: "custom-ark",
    type: "ark",
    api_key_env: "ARK_TEST_KEY",
    models: [{ alias: "custom/image", provider_model: "doubao-seedream-5-0-pro-260628" }],
  });

  it("uses the Ark default and exposes all media methods without chat network access", async () => {
    vi.stubEnv("ARK_TEST_KEY", "test-only-placeholder");
    const fetch = vi.fn().mockImplementation(
      async () =>
        new Response('{"id":"task-1"}', {
          headers: { "content-type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetch);
    const client = buildProviderClients([config], "https://api.openai.com/v1", 1000).get(
      config.name,
    );
    expect(client?.mediaOnly).toBe(true);
    expect(client?.threeDGeneration).toBeTypeOf("function");
    await client?.imageGeneration?.({ model: "image", prompt: "test" });
    await client?.videoGeneration?.({ model: "video", content: [] });
    await client?.threeDGeneration?.({ model: "3d", content: [] });
    await client?.threeDRetrieve?.("task-1");
    expect(
      fetch.mock.calls.map(([request]) =>
        String(request instanceof Request ? request.url : request),
      ),
    ).toEqual([
      "https://ark.cn-beijing.volces.com/api/v3/images/generations",
      "https://ark.cn-beijing.volces.com/api/v3/contents/generations/tasks",
      "https://ark.cn-beijing.volces.com/api/v3/contents/generations/tasks",
      "https://ark.cn-beijing.volces.com/api/v3/contents/generations/tasks/task-1",
    ]);
    await expect(client?.chatCompletion({ model: "image", messages: [] })).rejects.toThrow(
      "dedicated media endpoint",
    );
    expect(() => client?.chatCompletionStream({ model: "image", messages: [] })).toThrow(
      "dedicated media endpoint",
    );
    expect(fetch).toHaveBeenCalledTimes(4);
  });

  it("rejects the admin chat connectivity probe before any Ark request", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    await expect(testStaticProviderKey(config, "test-only-placeholder")).rejects.toThrow(
      "chat connectivity",
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it("does not construct an optional Ark client without its credential", () => {
    vi.stubEnv("ARK_TEST_KEY", "");
    expect(buildProviderClients([config], "https://api.openai.com/v1", 1000).has(config.name)).toBe(
      false,
    );
  });
});
