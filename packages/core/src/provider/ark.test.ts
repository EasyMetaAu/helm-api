import { ProxyAgent, fetch as undiciFetch } from "undici";
import { describe, expect, it, vi } from "vitest";
import { createResponseWorkAdmission } from "../runtime/response-work-admission.js";
import { createArkMediaClient } from "./ark.js";
import { type ProviderConfig, UpstreamError } from "./openai.js";
import { makeProxyFetch } from "./proxy.js";

vi.mock("undici", async (importOriginal) => {
  const actual = await importOriginal<typeof import("undici")>();
  return { ...actual, fetch: vi.fn() };
});

const baseUrl = "https://ark.example.test/api/v3";
const apiKey = "offline-secret-key";
const image = {
  model: "doubao-seedream-5-0-pro-260628",
  image: ["https://example.test/i.png"],
  layer_decomposition: true,
  watermark: true,
  output_format: "png",
};
const video = {
  model: "doubao-seedance-2-5-260628",
  content: [{ type: "text", text: "offline fixture" }],
  omni_reference_task_type: "reference",
  output_format: "mp4",
};
const threeD = {
  model: "doubao-seed3d-2-0-260328",
  content: [{ type: "image_url", image_url: { url: "https://example.test/i.png" } }],
  file_format: "glb",
  subdivision_level: "medium",
};
const creates = ["imageGeneration", "videoGeneration", "threeDGeneration"] as const;
function setup(
  fetch: typeof globalThis.fetch,
  config: Partial<ProviderConfig> = {},
  capacityBytes = 4096,
) {
  const admission = createResponseWorkAdmission({
    capacityBytes,
    jsonAmplification: 1,
    minChargeBytes: 1,
  });
  return {
    client: createArkMediaClient({
      config: { baseUrl, apiKey, ...config },
      fetch,
      responseWorkAdmission: admission,
    }),
    admission,
  };
}
async function caught(promise: Promise<unknown>) {
  return promise.catch((error: unknown) => error);
}

describe("Ark SDK media transport", () => {
  it("preserves complete image bodies and raw layer metadata, including optional prompt", async () => {
    const result = {
      data: [
        {
          url: "https://example.test/layer.png",
          z_index: 1,
          bounding_box: { absolute: [1, 2, 3, 4] },
        },
      ],
      usage: { input_images: 2, generated_images: 1 },
    };
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockImplementation(async () => Response.json(result));
    const capture = vi.fn();
    const { client, admission } = setup(fetch);
    for (const model of ["doubao-seedream-5-0-flash-260915", image.model]) {
      const body = { ...image, model };
      expect(await client.imageGeneration(body, { captureUpstream: capture })).toEqual(result);
      const [url, init] = fetch.mock.calls.at(-1) ?? [];
      expect(String(url)).toBe(`${baseUrl}/images/generations`);
      expect(JSON.parse(String(init?.body))).toEqual(body);
      expect(capture.mock.calls.at(-1)?.[0]).toBe(init?.body);
      expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${apiKey}`);
      expect(init?.redirect).toBe("manual");
    }
    expect(admission.reservedBytes).toBe(0);
  });
  it("uses Ark task POST and encoded GET paths without normalization", async () => {
    const result = {
      id: "cgt-fixture",
      status: "succeeded",
      content: { video_url: "https://example.test/v.mp4", file_url: "https://example.test/m.glb" },
      usage: { completion_tokens: 4 },
    };
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockImplementation(async () => Response.json(result));
    const { client } = setup(fetch);
    expect(await client.videoGeneration(video)).toEqual(result);
    expect(await client.threeDGeneration(threeD)).toEqual(result);
    for (const [index, body] of [video, threeD].entries()) {
      expect(String(fetch.mock.calls[index]?.[0])).toBe(`${baseUrl}/contents/generations/tasks`);
      expect(fetch.mock.calls[index]?.[1]?.method).toBe("POST");
      expect(JSON.parse(String(fetch.mock.calls[index]?.[1]?.body))).toEqual(body);
    }
    for (const method of ["videoRetrieve", "threeDRetrieve"] as const) {
      expect(await client[method]("a/b?c#d")).toEqual(result);
      expect(String(fetch.mock.calls.at(-1)?.[0])).toBe(
        `${baseUrl}/contents/generations/tasks/a%2Fb%3Fc%23d`,
      );
      expect(fetch.mock.calls.at(-1)?.[1]?.method).toBe("GET");
    }
  });
  it.each(creates)("%s never repeats a 503 create, despite retry settings", async (method) => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockImplementation(async () =>
        Response.json({ error: { code: "ServiceUnavailable" } }, { status: 503 }),
      );
    const { client } = setup(fetch, { connectRetries: 9, onUnauthorized: vi.fn() });
    const error = await caught(client[method](video, { overloadRetry: { attempt: 0 } }));
    expect(error).toBeInstanceOf(UpstreamError);
    expect(error).toMatchObject({ outcome: "unknown", upstreamStatus: 503 });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it.each([
    400, 401, 403, 429,
  ])("classifies HTTP %i rejection and scrubs credential echoes", async (status) => {
    const refresh = vi.fn();
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockImplementation(async () =>
        Response.json(
          { error: { code: "Rejected", message: apiKey, token: "another-secret" } },
          { status, headers: { "x-detail": apiKey, "set-cookie": "private-cookie" } },
        ),
      );
    const { client } = setup(fetch, { onUnauthorized: refresh });
    const error = await caught(client.videoGeneration(video));
    expect(error).toMatchObject({ outcome: "rejected", upstreamStatus: status });
    expect(JSON.stringify(error)).not.toContain(apiKey);
    expect(JSON.stringify(error)).not.toContain("another-secret");
    expect(JSON.stringify(error)).not.toContain("private-cookie");
    expect(refresh).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it.each(creates)("%s never repeats an ambiguous connection failure", async (method) => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockRejectedValue(new Error(`connection failed ${apiKey}`));
    const error = await caught(setup(fetch).client[method](video));
    expect(error).toMatchObject({ outcome: "unknown", errorClass: "upstream_error" });
    expect(JSON.stringify(error)).not.toContain(apiKey);
    expect(String(error)).not.toContain(apiKey);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("blocks redirect replay", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async (_url, init) => {
      expect(init?.redirect).toBe("manual");
      return new Response(null, {
        status: 307,
        headers: { location: "https://other.example.test/" },
      });
    });
    expect(await caught(setup(fetch).client.videoGeneration(video))).toMatchObject({
      outcome: "unknown",
      upstreamStatus: 307,
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("times out a paid write once", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockImplementation(
        async (_url, init) =>
          new Promise((_resolve, reject) =>
            init?.signal?.addEventListener("abort", () =>
              reject(new DOMException("Aborted", "AbortError")),
            ),
          ),
      );
    expect(
      await caught(setup(fetch, { timeoutMs: 20 }).client.videoGeneration(video)),
    ).toMatchObject({ outcome: "unknown", errorClass: "timeout" });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("honors cancellation before dispatch and while reading a response", async () => {
    const controller = new AbortController();
    controller.abort(new Error(apiKey));
    const fetch = vi.fn<typeof globalThis.fetch>();
    expect(
      await caught(setup(fetch).client.videoGeneration(video, { signal: controller.signal })),
    ).toMatchObject({ name: "AbortError", outcome: "not_sent" });
    expect(fetch).not.toHaveBeenCalled();
    const cancel = vi.fn();
    const next = new AbortController();
    fetch.mockImplementation(async () => {
      setTimeout(() => next.abort(new Error(apiKey)), 10);
      return new Response(new ReadableStream({ cancel }));
    });
    const { client, admission } = setup(fetch);
    const error = await caught(client.videoGeneration(video, { signal: next.signal }));
    expect(error).toMatchObject({ name: "AbortError", outcome: "unknown" });
    expect(String(error)).not.toContain(apiKey);
    expect(cancel).toHaveBeenCalled();
    expect(admission.reservedBytes).toBe(0);
  });
  it("keeps the timeout active through a stalled body", async () => {
    const cancel = vi.fn();
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockImplementation(async () => new Response(new ReadableStream({ cancel })));
    const { client, admission } = setup(fetch, { timeoutMs: 20 });
    expect(await caught(client.videoGeneration(video))).toMatchObject({
      errorClass: "timeout",
      outcome: "unknown",
    });
    expect(cancel).toHaveBeenCalled();
    expect(admission.reservedBytes).toBe(0);
  });
  it.each([200, 503])("bounds HTTP %i bodies without SDK text/json parsing", async (status) => {
    const response = new Response("x".repeat(200), { status });
    const text = vi.spyOn(response, "text");
    const json = vi.spyOn(response, "json");
    const { client, admission } = setup(async () => response, {}, 64);
    expect(await caught(client.videoGeneration(video))).toMatchObject({
      outcome: "unknown",
      providerRaw: { error: { code: "response_body_too_large" } },
    });
    expect(text).not.toHaveBeenCalled();
    expect(json).not.toHaveBeenCalled();
    expect(admission.reservedBytes).toBe(0);
  });
  it("rejects a declared oversized body before consuming it", async () => {
    const cancel = vi.fn();
    const response = new Response(new ReadableStream({ cancel }), {
      headers: { "content-length": "9999" },
    });
    expect(
      await caught(setup(async () => response, {}, 64).client.videoGeneration(video)),
    ).toMatchObject({ providerRaw: { error: { code: "response_body_too_large" } } });
    expect(cancel).toHaveBeenCalled();
  });
  it("fails closed when shared admission is occupied", async () => {
    const { client, admission } = setup(async () => Response.json({ id: "task" }), {}, 64);
    const lease = admission.acquire(64);
    expect(await caught(client.videoGeneration(video))).toMatchObject({
      providerRaw: { error: { code: "response_work_capacity_exhausted" } },
    });
    if (lease.ok) lease.lease.release();
    expect(admission.reservedBytes).toBe(0);
  });
  it.each([
    "{broken",
    "null",
    "[]",
  ])("rejects malformed or non-record success: %s", async (body) => {
    expect(
      await caught(setup(async () => new Response(body)).client.videoGeneration(video)),
    ).toMatchObject({ outcome: "unknown", providerRaw: { error: { code: "invalid_response" } } });
  });
  it("uses only the injected fetch, captures exact bytes fail-open, and resolves runtime auth", async () => {
    const globalFetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("must not call"));
    try {
      const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async (_url, init) => {
        expect(new Headers(init?.headers).get("authorization")).toBe("Bearer runtime-secret");
        return Response.json({ id: "task" });
      });
      const { client } = setup(fetch, {
        apiKey: undefined,
        getAuthHeader: async () => "Bearer runtime-secret",
        resolveBaseUrl: async () => `${baseUrl}/`,
        extraHeaders: () => ({ "x-fixture": "yes" }),
      });
      expect(
        await client.videoGeneration(video, {
          captureUpstream: () => {
            throw new Error("capture failed");
          },
        }),
      ).toEqual({ id: "task" });
      expect(String(fetch.mock.calls[0]?.[0])).toBe(`${baseUrl}/contents/generations/tasks`);
      expect(globalFetch).not.toHaveBeenCalled();
    } finally {
      globalFetch.mockRestore();
    }
  });
});

describe("Ark boundary integration", () => {
  it("preserves the existing proxy dispatcher and disables redirects", async () => {
    const mocked = vi.mocked(undiciFetch);
    let dispatcher: ProxyAgent | undefined;
    mocked.mockImplementation(async (_url, init) => {
      expect(init?.dispatcher).toBeInstanceOf(ProxyAgent);
      dispatcher = init?.dispatcher as ProxyAgent;
      expect(init?.redirect).toBe("manual");
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      return Response.json({ id: "offline-proxy-task" }) as unknown as Awaited<
        ReturnType<typeof undiciFetch>
      >;
    });
    const proxy = { type: "http" as const, host: "127.0.0.1", port: 8080 };
    const proxyFetch = makeProxyFetch(proxy);
    try {
      expect(await setup(proxyFetch).client.videoGeneration(video)).toEqual({
        id: "offline-proxy-task",
      });
      expect(mocked).toHaveBeenCalledTimes(1);
    } finally {
      await dispatcher?.close();
      mocked.mockReset();
    }
  });
  it.each([408, 500, 502, 504])("marks HTTP %i as unknown without a retry", async (status) => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockImplementation(async () =>
        Response.json({ error: { code: "Unavailable" } }, { status }),
      );
    expect(await caught(setup(fetch).client.videoGeneration(video))).toMatchObject({
      outcome: "unknown",
      upstreamStatus: status,
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("cancels an in-flight fetch once, with no exposed abort reason", async () => {
    const controller = new AbortController();
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async (_url, init) => {
      setTimeout(() => controller.abort(new Error(apiKey)), 10);
      return new Promise((_resolve, reject) =>
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason)),
      );
    });
    const error = await caught(
      setup(fetch).client.videoGeneration(video, { signal: controller.signal }),
    );
    expect(error).toMatchObject({ name: "AbortError", outcome: "unknown" });
    expect(String(error)).not.toContain(apiKey);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("bounds a stalled HTTP error body with the same deadline", async () => {
    const cancel = vi.fn();
    const response = new Response(new ReadableStream({ cancel }), { status: 503 });
    const { client, admission } = setup(async () => response, { timeoutMs: 20 });
    expect(await caught(client.videoGeneration(video))).toMatchObject({
      errorClass: "timeout",
      outcome: "unknown",
    });
    expect(cancel).toHaveBeenCalled();
    expect(admission.reservedBytes).toBe(0);
  });
  it.each(["", ".", ".."])("refuses unsafe task path %j before fetch", async (id) => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    expect(await caught(setup(fetch).client.videoRetrieve(id))).toMatchObject({
      outcome: "not_sent",
      providerRaw: { error: { code: "invalid_task_id" } },
    });
    expect(fetch).not.toHaveBeenCalled();
  });
  it("rejects streaming and credential-bearing base URLs before fetch", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    expect(
      await caught(setup(fetch).client.imageGeneration({ ...image, stream: true })),
    ).toMatchObject({ outcome: "not_sent" });
    expect(
      await caught(
        setup(fetch, {
          baseUrl: "https://user:private@ark.example.test/api/v3",
        }).client.videoGeneration(video),
      ),
    ).toMatchObject({ outcome: "not_sent" });
    expect(fetch).not.toHaveBeenCalled();
  });
  it("scrubs dynamic authorization and refresh secrets from errors and metadata", async () => {
    const auth = "access-dynamic-fixture";
    const refresh = "refresh-dynamic-fixture";
    const meta = vi.fn();
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockImplementation(async () =>
        Response.json(
          { error: { message: `${auth} ${refresh}` } },
          { status: 403, headers: { "x-echo": auth, authorization: auth } },
        ),
      );
    const { client } = setup(fetch, {
      apiKey: undefined,
      getAuthHeader: async () => `Bearer ${auth}`,
      currentSecrets: () => [auth, refresh],
      extraHeaders: () => ({ authorization: "Bearer stale-fixture" }),
    });
    const error = await caught(client.videoGeneration(video, { onResponseMeta: meta }));
    expect(error).toMatchObject({ outcome: "rejected" });
    expect(JSON.stringify(error)).not.toContain(auth);
    expect(JSON.stringify(error)).not.toContain(refresh);
    expect(meta.mock.calls[0]?.[0].get("authorization")).toBeNull();
    expect(meta.mock.calls[0]?.[0].get("x-echo")).toBe("[redacted]");
    expect(new Headers(fetch.mock.calls[0]?.[1]?.headers).get("authorization")).toBe(
      `Bearer ${auth}`,
    );
  });
  it("never logs credential-bearing SDK errors even with DEBUG logging enabled", async () => {
    const previous = process.env.OPENAI_LOG;
    process.env.OPENAI_LOG = "debug";
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const debug = vi.spyOn(console, "debug").mockImplementation(() => {});
    try {
      await caught(
        setup(async () => {
          throw new Error(apiKey);
        }).client.videoGeneration(video),
      );
      expect(log).not.toHaveBeenCalled();
      expect(warn).not.toHaveBeenCalled();
      expect(error).not.toHaveBeenCalled();
      expect(debug).not.toHaveBeenCalled();
    } finally {
      if (previous === undefined) delete process.env.OPENAI_LOG;
      else process.env.OPENAI_LOG = previous;
      log.mockRestore();
      warn.mockRestore();
      error.mockRestore();
      debug.mockRestore();
    }
  });
});
