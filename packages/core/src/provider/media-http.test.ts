import { describe, expect, it, vi } from "vitest";
import { createResponseWorkAdmission } from "../runtime/response-work-admission.js";
import { createBailianMediaClient } from "./bailian-media.js";
import { createMiniMaxVideoClient } from "./minimax-video.js";
import type { OpenAIClientDeps } from "./openai.js";

const image = { model: "qwen-image-3.0", prompt: "bird" };
const video = {
  model: "MiniMax-H3",
  content: [{ type: "text", text: "bird" }],
  resolution: "2K",
  duration: 5,
  ratio: "16:9",
};
const factories = [
  {
    name: "SDK",
    create: (deps: OpenAIClientDeps) => createBailianMediaClient(deps).imageGeneration,
    baseUrl: "https://workspace.example.test/api/v1",
    body: image,
  },
  {
    name: "native HTTP",
    create: (deps: OpenAIClientDeps) => createMiniMaxVideoClient(deps).videoGeneration,
    baseUrl: "https://api.example.test",
    body: video,
  },
];

describe.each(factories)("$name transport boundaries", ({ create, baseUrl, body }) => {
  function setup(fetch: typeof globalThis.fetch, timeoutMs = 1000, capacityBytes = 2048) {
    const admission = createResponseWorkAdmission({
      capacityBytes,
      jsonAmplification: 1,
      minChargeBytes: 1,
    });
    const call = create({
      config: { baseUrl, apiKey: "secret-credential", timeoutMs, connectRetries: 5 },
      fetch,
      responseWorkAdmission: admission,
    });
    return { call, admission };
  }
  it.each([
    400, 401, 429, 500, 503, 408, 302,
  ])("makes one attempt for HTTP %i and classifies uncertainty", async (status) => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockImplementation(async () =>
        Response.json({ error: { message: "secret-credential" } }, { status }),
      );
    const { call } = setup(fetch);
    const error = await call(body).catch((e: unknown) => e);
    expect(error).toMatchObject({
      outcome: status >= 400 && status < 500 && status !== 408 ? "rejected" : "unknown",
      upstreamStatus: status,
    });
    expect(JSON.stringify(error)).not.toContain("secret-credential");
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("does not retry ambiguous connection failures", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockRejectedValue(new TypeError("network secret-credential"));
    await expect(setup(fetch).call(body)).rejects.toMatchObject({ outcome: "unknown" });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it.each([true, false])("bounds %s HTTP response bodies and releases memory", async (ok) => {
    const cancel = vi.fn();
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(
      async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode("x".repeat(4096)));
            },
            cancel,
          }),
          { status: ok ? 200 : 500 },
        ),
    );
    const { call, admission } = setup(fetch, 1000, 128);
    await expect(call(body)).rejects.toMatchObject({
      outcome: "unknown",
      providerRaw: { error: { code: "response_body_too_large" } },
    });
    expect(cancel).toHaveBeenCalled();
    expect(admission.reservedBytes).toBe(0);
  });
  it("cancels a stalled response on timeout", async () => {
    const cancel = vi.fn();
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(new Response(new ReadableStream({ cancel })));
    const { call, admission } = setup(fetch, 20);
    await expect(call(body)).rejects.toMatchObject({ outcome: "unknown", errorClass: "timeout" });
    expect(cancel).toHaveBeenCalled();
    expect(admission.reservedBytes).toBe(0);
  });
  it("records cancellation before and after send without treating it as a provider fault", async () => {
    const cancel = new AbortController();
    cancel.abort();
    const fetch = vi.fn<typeof globalThis.fetch>();
    await expect(setup(fetch).call(body, { signal: cancel.signal })).rejects.toMatchObject({
      name: "AbortError",
      outcome: "not_sent",
    });
    expect(fetch).not.toHaveBeenCalled();
    const active = new AbortController();
    fetch.mockImplementation(async () => {
      active.abort();
      throw new Error("aborted");
    });
    await expect(setup(fetch).call(body, { signal: active.signal })).rejects.toMatchObject({
      name: "AbortError",
      outcome: "unknown",
    });
  });
  it("rejects malformed success bodies without losing the unknown outcome", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(Response.json({ arbitrary: "ok" }));
    await expect(setup(fetch).call(body)).rejects.toMatchObject({
      outcome: "unknown",
      providerRaw: { error: { code: "invalid_response" } },
    });
  });
  it("bounds a stalled credential source before sending", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const call = create({
      config: { baseUrl, getAuthHeader: () => new Promise(() => {}), timeoutMs: 20 },
      fetch,
    });
    await expect(call(body)).rejects.toMatchObject({ outcome: "not_sent", errorClass: "timeout" });
    expect(fetch).not.toHaveBeenCalled();
  });
  it("rejects ambiguous error-shaped success, redacting the active dynamic credential", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(
        Response.json({ error: { code: "InvalidParameter", message: "Bearer dynamic-secret" } }),
      );
    const call = create({
      config: { baseUrl, getAuthHeader: async () => "Bearer dynamic-secret" },
      fetch,
    });
    const error = await call(body).catch((e: unknown) => e);
    expect(error).toMatchObject({ outcome: "rejected" });
    expect(JSON.stringify(error)).not.toContain("dynamic-secret");
  });
});
