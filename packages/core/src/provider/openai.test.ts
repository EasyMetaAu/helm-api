import { describe, expect, it, vi } from "vitest";
import { createOpenAIClient, UpstreamError } from "./openai.js";

const CONFIG = { baseUrl: "https://upstream.test/v1", apiKey: "sk-secret-key" };

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function sseResponse(chunks: string[]): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const enc = new TextEncoder();
      for (const c of chunks) controller.enqueue(enc.encode(c));
      controller.close();
    },
  });
  return new Response(stream, { status: 200 });
}

describe("createOpenAIClient (Phase 0 passthrough)", () => {
  it("returns the upstream JSON unchanged (non-streaming)", async () => {
    const upstream = { id: "cmpl-1", choices: [{ message: { content: "hi" } }] };
    const fetch = vi.fn().mockResolvedValue(jsonResponse(upstream));
    const client = createOpenAIClient({ config: CONFIG, fetch });
    const out = await client.chatCompletion({ model: "m", messages: [] });
    expect(out).toEqual(upstream);
  });

  it("forwards the request body and auth header verbatim", async () => {
    const fetch = vi.fn().mockResolvedValue(jsonResponse({ ok: true }));
    const client = createOpenAIClient({ config: CONFIG, fetch });
    const req = { model: "gpt-4o-mini", messages: [{ role: "user", content: "x" }], stream: false };
    await client.chatCompletion(req);
    const call = fetch.mock.calls[0];
    expect(call).toBeDefined();
    const [url, init] = call as [string, RequestInit & { headers: Record<string, string> }];
    expect(url).toBe("https://upstream.test/v1/chat/completions");
    expect(init.method).toBe("POST");
    expect(init.headers.Authorization).toBe("Bearer sk-secret-key");
    expect(JSON.parse(init.body as string)).toEqual(req);
  });

  it("yields upstream SSE chunks byte-for-byte (streaming)", async () => {
    const chunks = ['data: {"a":1}\n\n', 'data: {"b":2}\n\n', "data: [DONE]\n\n"];
    const fetch = vi.fn().mockResolvedValue(sseResponse(chunks));
    const client = createOpenAIClient({ config: CONFIG, fetch });
    const received: string[] = [];
    for await (const c of client.chatCompletionStream({ model: "m", stream: true })) {
      received.push(c);
    }
    expect(received.join("")).toBe(chunks.join(""));
  });

  it("maps an upstream 5xx to UpstreamError(upstream_error, 502)", async () => {
    // fresh Response per call (a Response body can only be read once)
    const fetch = vi
      .fn()
      .mockImplementation(async () => jsonResponse({ error: { message: "boom" } }, 502));
    const client = createOpenAIClient({ config: CONFIG, fetch });
    await expect(client.chatCompletion({ model: "m" })).rejects.toMatchObject({
      errorClass: "upstream_error",
      httpStatus: 502,
    });
    try {
      await client.chatCompletion({ model: "m" });
    } catch (e) {
      expect(e).toBeInstanceOf(UpstreamError);
      expect((e as UpstreamError).providerRaw).toMatchObject({ error: { message: "boom" } });
    }
  });

  it("maps a timeout to UpstreamError(timeout, 504)", async () => {
    // fetch that rejects with an AbortError when its signal aborts
    const fetch = vi.fn().mockImplementation(
      (_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => {
            const err = new Error("aborted");
            err.name = "AbortError";
            reject(err);
          });
        }),
    );
    const client = createOpenAIClient({ config: { ...CONFIG, timeoutMs: 10 }, fetch });
    await expect(client.chatCompletion({ model: "m" })).rejects.toMatchObject({
      errorClass: "timeout",
      httpStatus: 504,
    });
  });

  it("never leaks the apiKey in the error message or providerRaw", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue(jsonResponse({ error: { authorization: "Bearer sk-secret-key" } }, 502));
    const client = createOpenAIClient({ config: CONFIG, fetch });
    try {
      await client.chatCompletion({ model: "m" });
    } catch (e) {
      const serialized = `${(e as UpstreamError).message}${JSON.stringify(
        (e as UpstreamError).providerRaw,
      )}`;
      expect(serialized).not.toContain("sk-secret-key");
    }
  });

  it("passes the caller's abort signal through and rethrows AbortError (not UpstreamError)", async () => {
    const fetch = vi.fn().mockImplementation((_url: string, init: RequestInit) => {
      // observe the signal then reject as aborted
      return new Promise((_resolve, reject) => {
        if (init.signal?.aborted) {
          const err = new Error("aborted");
          err.name = "AbortError";
          reject(err);
        }
        init.signal?.addEventListener("abort", () => {
          const err = new Error("aborted");
          err.name = "AbortError";
          reject(err);
        });
      });
    });
    const client = createOpenAIClient({ config: CONFIG, fetch });
    const ac = new AbortController();
    ac.abort();
    await expect(
      client.chatCompletion({ model: "m" }, { signal: ac.signal }),
    ).rejects.not.toBeInstanceOf(UpstreamError);
    expect(fetch).toHaveBeenCalled();
    const init = fetch.mock.calls[0]?.[1] as RequestInit;
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });
});
