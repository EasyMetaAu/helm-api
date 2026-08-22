import { beforeEach, describe, expect, it, vi } from "vitest";
import { createRuntimeMemoryCoordinator } from "../runtime/memory-budget.js";
import {
  createResponseWorkAdmission,
  runtimeResponseWorkAdmission,
} from "../runtime/response-work-admission.js";
import { createOpenAIClient } from "./openai.js";

const CONFIG = { baseUrl: "https://upstream.test/v1", apiKey: "sk-secret-key" };

beforeEach(() => {
  runtimeResponseWorkAdmission(
    createRuntimeMemoryCoordinator({ capacityBytes: () => Number.MAX_SAFE_INTEGER }),
  );
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("createOpenAIClient.imageGeneration", () => {
  it("POSTs to /images/generations with Bearer auth + verbatim body, returns the JSON", async () => {
    const upstream = { created: 0, data: [{ b64_json: "IMG" }], usage: { output_tokens: 196 } };
    const fetch = vi.fn().mockResolvedValue(jsonResponse(upstream));
    const client = createOpenAIClient({ config: CONFIG, fetch });
    const req = { model: "openai/gpt-image-2", prompt: "a cat", size: "1024x1024" };

    const out = await client.imageGeneration?.(req);

    expect(out).toEqual(upstream);
    const [url, init] = fetch.mock.calls[0] as [
      string,
      RequestInit & { headers: Record<string, string> },
    ];
    expect(url).toBe("https://upstream.test/v1/images/generations");
    expect(init.method).toBe("POST");
    expect(init.headers.Authorization).toBe("Bearer sk-secret-key");
    expect(JSON.parse(init.body as string)).toEqual(req);
  });

  it("surfaces captureUpstream with the exact wire body exactly once", async () => {
    const fetch = vi.fn().mockResolvedValue(jsonResponse({ data: [] }));
    const client = createOpenAIClient({ config: CONFIG, fetch });
    const captured: string[] = [];

    await client.imageGeneration?.(
      { model: "m", prompt: "p" },
      { captureUpstream: (b) => captured.push(b) },
    );

    expect(captured).toHaveLength(1);
    expect(JSON.parse(captured[0] as string)).toEqual({ model: "m", prompt: "p" });
  });

  it("throws UpstreamError on a non-2xx response, preserving the upstream status", async () => {
    const fetch = vi.fn().mockResolvedValue(jsonResponse({ error: { message: "bad" } }, 400));
    const client = createOpenAIClient({ config: CONFIG, fetch });

    await expect(client.imageGeneration?.({ model: "m", prompt: "p" })).rejects.toMatchObject({
      name: "UpstreamError",
      errorClass: "upstream_error",
      upstreamStatus: 400,
    });
  });

  it.each([503, 529])("does not retry a paid image write after an overload %s", async (status) => {
    const fetch = vi.fn().mockResolvedValue(jsonResponse({ error: { message: "busy" } }, status));
    const client = createOpenAIClient({ config: CONFIG, fetch });

    await expect(client.imageGeneration?.({ model: "m", prompt: "p" })).rejects.toMatchObject({
      upstreamStatus: status,
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("does not replay a paid image write to refresh OAuth after 401", async () => {
    const fetch = vi.fn().mockResolvedValue(jsonResponse({ error: { message: "expired" } }, 401));
    const onUnauthorized = vi.fn();
    const client = createOpenAIClient({
      config: {
        baseUrl: "https://upstream.test/v1",
        getAuthHeader: async () => "Bearer oauth",
        onUnauthorized,
      },
      fetch,
    });

    await expect(client.imageGeneration?.({ model: "m", prompt: "p" })).rejects.toMatchObject({
      upstreamStatus: 401,
    });
    expect(onUnauthorized).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

describe("createOpenAIClient TTS", () => {
  it("POSTs JSON to /tts and returns bounded audio bytes", async () => {
    const audio = new Uint8Array([0, 1, 2, 255]);
    const fetch = vi
      .fn()
      .mockResolvedValue(new Response(audio, { headers: { "content-type": "audio/mpeg" } }));
    const client = createOpenAIClient({ config: CONFIG, fetch });
    const req = { text: "hello", voice_id: "eve", language: "en" };
    const out = await client.ttsSpeech?.(req);
    expect(out?.audio).toEqual(audio);
    expect(out?.contentType).toBe("audio/mpeg");
    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch.mock.calls[0]?.[0]).toBe("https://upstream.test/v1/tts");
    expect(JSON.parse((fetch.mock.calls[0]?.[1] as RequestInit).body as string)).toEqual(req);
  });

  it("does not replay a paid TTS POST after 401", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response("expired", { status: 401 }));
    const onUnauthorized = vi.fn();
    const client = createOpenAIClient({
      config: {
        baseUrl: CONFIG.baseUrl,
        getAuthHeader: async () => "Bearer oauth",
        onUnauthorized,
      },
      fetch,
    });
    await expect(client.ttsSpeech?.({ text: "hello" })).rejects.toMatchObject({
      upstreamStatus: 401,
    });
    expect(fetch).toHaveBeenCalledOnce();
    expect(onUnauthorized).not.toHaveBeenCalled();
  });

  it("GETs /tts/voices and refreshes once on 401", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response("expired", { status: 401 }))
      .mockResolvedValueOnce(jsonResponse({ voices: [{ id: "eve" }] }));
    const onUnauthorized = vi.fn();
    const client = createOpenAIClient({
      config: {
        baseUrl: CONFIG.baseUrl,
        getAuthHeader: async () => "Bearer oauth",
        onUnauthorized,
      },
      fetch,
    });
    await expect(client.ttsVoices?.()).resolves.toEqual({ voices: [{ id: "eve" }] });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(onUnauthorized).toHaveBeenCalledOnce();
    expect(fetch.mock.calls[0]?.[0]).toBe("https://upstream.test/v1/tts/voices");
  });
});

describe("createOpenAIClient.imageEdit", () => {
  it("forwards the Codex JSON edit body to /images/edits", async () => {
    const upstream = { created: 0, data: [{ b64_json: "EDITED" }] };
    const fetch = vi.fn().mockResolvedValue(jsonResponse(upstream));
    const client = createOpenAIClient({ config: CONFIG, fetch });
    const body = {
      model: "gpt-image-2",
      prompt: "add a red hat",
      images: [{ image_url: "data:image/png;base64,AAA=" }],
    };

    const out = await client.imageEdit?.({ kind: "json", body });

    expect(out).toEqual(upstream);
    const [url, init] = fetch.mock.calls[0] as [
      string,
      RequestInit & { headers: Record<string, string> },
    ];
    expect(url).toBe("https://upstream.test/v1/images/edits");
    expect(init.headers["Content-Type"]).toBe("application/json");
    expect(JSON.parse(init.body as string)).toEqual(body);
  });

  it("rebuilds a repeatable multipart edit with binary files", async () => {
    const fetch = vi.fn().mockResolvedValue(jsonResponse({ data: [] }));
    const client = createOpenAIClient({ config: CONFIG, fetch });

    await client.imageEdit?.({
      kind: "multipart",
      fields: [
        { name: "model", value: "gpt-image-2" },
        { name: "prompt", value: "add snow" },
        {
          name: "image[]",
          value: new Uint8Array([1, 2, 3]),
          filename: "source.png",
          contentType: "image/png",
        },
      ],
    });

    const [url, init] = fetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://upstream.test/v1/images/edits");
    expect(init.body).toBeInstanceOf(FormData);
    const form = init.body as FormData;
    expect(form.get("prompt")).toBe("add snow");
    const image = form.get("image[]") as File;
    expect(image.name).toBe("source.png");
    expect([...new Uint8Array(await image.arrayBuffer())]).toEqual([1, 2, 3]);
  });

  it("does not retry a paid edit after a transport error", async () => {
    const transportError = Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });
    const fetch = vi.fn().mockRejectedValue(transportError);
    const client = createOpenAIClient({ config: CONFIG, fetch });

    await expect(
      client.imageEdit?.({
        kind: "json",
        body: { model: "m", prompt: "p", images: [{ image_url: "x" }] },
      }),
    ).rejects.toMatchObject({ name: "UpstreamError" });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

describe("createOpenAIClient.videoGeneration", () => {
  it.each([503, 529])("POSTs a single paid video write without retrying a %s", async (status) => {
    const fetch = vi.fn().mockResolvedValue(jsonResponse({ error: { message: "busy" } }, status));
    const client = createOpenAIClient({ config: CONFIG, fetch });

    await expect(
      client.videoGeneration?.({ model: "grok-imagine-video", prompt: "x" }),
    ).rejects.toMatchObject({
      upstreamStatus: status,
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0]?.[0]).toBe("https://upstream.test/v1/videos/generations");
  });

  it("does not retry a paid video write after a transport error", async () => {
    const transportError = Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });
    const fetch = vi.fn().mockRejectedValue(transportError);
    const client = createOpenAIClient({ config: CONFIG, fetch });

    await expect(
      client.videoGeneration?.({ model: "grok-imagine-video", prompt: "x" }),
    ).rejects.toMatchObject({
      name: "UpstreamError",
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("returns a valid start response and rejects a successful response without request_id", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ request_id: "req_123" }))
      .mockResolvedValueOnce(jsonResponse({ status: "processing" }));
    const client = createOpenAIClient({ config: CONFIG, fetch });

    await expect(
      client.videoGeneration?.({ model: "grok-imagine-video", prompt: "x" }),
    ).resolves.toEqual({
      request_id: "req_123",
    });
    await expect(
      client.videoGeneration?.({ model: "grok-imagine-video", prompt: "x" }),
    ).rejects.toMatchObject({
      name: "UpstreamError",
      upstreamStatus: 200,
    });
  });
});

describe("createOpenAIClient.videoExtension", () => {
  it("POSTs the verbatim body to /videos/extensions and requires a request_id", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ request_id: "ext_123" }))
      .mockResolvedValueOnce(jsonResponse({ status: "processing" }));
    const client = createOpenAIClient({ config: CONFIG, fetch });
    const body = {
      model: "grok-imagine-video",
      prompt: "continue",
      video: { url: "https://example.test/source.mp4" },
      duration: 30,
    };

    await expect(client.videoExtension?.(body)).resolves.toEqual({ request_id: "ext_123" });
    expect(fetch.mock.calls[0]?.[0]).toBe("https://upstream.test/v1/videos/extensions");
    expect(fetch.mock.calls[0]?.[1]).toMatchObject({ method: "POST", body: JSON.stringify(body) });
    await expect(client.videoExtension?.(body)).rejects.toMatchObject({
      name: "UpstreamError",
      upstreamStatus: 200,
    });
  });

  it.each([503, 529])("never retries an ambiguous extension response %s", async (status) => {
    const fetch = vi.fn().mockResolvedValue(jsonResponse({ error: { message: "busy" } }, status));
    const client = createOpenAIClient({ config: CONFIG, fetch });

    await expect(
      client.videoExtension?.({ model: "grok-imagine-video", prompt: "continue" }),
    ).rejects.toMatchObject({ upstreamStatus: status });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("never retries an extension transport error", async () => {
    const transportError = Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });
    const fetch = vi.fn().mockRejectedValue(transportError);
    const client = createOpenAIClient({ config: CONFIG, fetch });

    await expect(
      client.videoExtension?.({ model: "grok-imagine-video", prompt: "continue" }),
    ).rejects.toMatchObject({ name: "UpstreamError" });
    expect(fetch).toHaveBeenCalledOnce();
  });
});

describe("createOpenAIClient.videoRetrieve", () => {
  it("GETs an encoded task id, accepts 202, and refreshes auth once after 401", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ error: { message: "expired" } }, 401))
      .mockResolvedValueOnce(jsonResponse({ status: "processing" }, 202));
    const onUnauthorized = vi.fn();
    const client = createOpenAIClient({
      config: {
        baseUrl: "https://upstream.test/v1",
        getAuthHeader: async () => "Bearer oauth",
        onUnauthorized,
      },
      fetch,
    });

    await expect(client.videoRetrieve?.("request/id?x=1")).resolves.toEqual({
      status: "processing",
    });
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls[0]?.[0]).toBe("https://upstream.test/v1/videos/request%2Fid%3Fx%3D1");
    expect(fetch.mock.calls[0]?.[1]).toMatchObject({ method: "GET" });
  });

  it("rejects a poll response whose status is not a string", async () => {
    const fetch = vi.fn().mockResolvedValue(jsonResponse({ status: 1 }));
    const client = createOpenAIClient({ config: CONFIG, fetch });

    await expect(client.videoRetrieve?.("req_123")).rejects.toMatchObject({
      name: "UpstreamError",
      upstreamStatus: 200,
    });
  });

  it("rejects a completed poll response without a playable video URL", async () => {
    const fetch = vi.fn().mockResolvedValue(jsonResponse({ status: "done" }));
    const client = createOpenAIClient({ config: CONFIG, fetch });

    await expect(client.videoRetrieve?.("req_123")).rejects.toMatchObject({
      name: "UpstreamError",
      upstreamStatus: 200,
    });
  });

  it("scrubs an echoed credential from a poll error", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue(jsonResponse({ error: { message: "Bearer sk-secret-key expired" } }, 401));
    const client = createOpenAIClient({
      config: CONFIG,
      fetch,
      responseWorkAdmission: createResponseWorkAdmission({
        capacityBytes: 1024,
        jsonAmplification: 1,
        minChargeBytes: 1,
      }),
    });

    await expect(client.videoRetrieve?.("req_secret")).rejects.toMatchObject({
      name: "UpstreamError",
      providerRaw: { error: { message: "Bearer [redacted] expired" } },
    });
  });

  it("bounds a poll transport wait with the configured timeout", async () => {
    const fetch = vi.fn((_input: string | URL | Request, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
        );
      });
    });
    const client = createOpenAIClient({ config: { ...CONFIG, timeoutMs: 5 }, fetch });

    await expect(client.videoRetrieve?.("req_timeout")).rejects.toMatchObject({
      name: "UpstreamError",
      errorClass: "timeout",
    });
    expect(fetch).toHaveBeenCalledOnce();
  });
});
