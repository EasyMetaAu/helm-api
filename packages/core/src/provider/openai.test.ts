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

  it("carries the real upstream status on UpstreamError.upstreamStatus (e.g. 429)", async () => {
    // httpStatus stays 502 for back-compat (client-facing mapping), but the raw
    // upstream status must be preserved so the executor can apply :free 429-skip.
    const fetch = vi
      .fn()
      .mockImplementation(async () => jsonResponse({ error: { message: "slow down" } }, 429));
    const client = createOpenAIClient({ config: CONFIG, fetch });
    await expect(client.chatCompletion({ model: "m" })).rejects.toMatchObject({
      errorClass: "upstream_error",
      httpStatus: 502,
      upstreamStatus: 429,
    });
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

  it("does not retry a 401 on a static-key client (no onUnauthorized)", async () => {
    const fetch = vi
      .fn()
      .mockImplementation(async () => jsonResponse({ error: { message: "nope" } }, 401));
    const client = createOpenAIClient({ config: CONFIG, fetch });
    await expect(client.chatCompletion({ model: "m" })).rejects.toMatchObject({
      errorClass: "upstream_error",
      upstreamStatus: 401,
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

// --- OAuth dynamic-credential client (issue #38). The auth header becomes a
// per-request async lookup, and a single upstream 401 triggers an invalidate +
// one retry with a freshly fetched token. Static-key clients are unchanged.
describe("createOpenAIClient (OAuth dynamic credential)", () => {
  const OAUTH_BASE = { baseUrl: "https://upstream.test/v1" };

  function jsonRes(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  }

  function sse(chunks: string[], status = 200): Response {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const enc = new TextEncoder();
        for (const c of chunks) controller.enqueue(enc.encode(c));
        controller.close();
      },
    });
    return new Response(stream, { status });
  }

  it("awaits getAuthHeader() and sends the dynamic Bearer (non-streaming)", async () => {
    const getAuthHeader = vi.fn().mockResolvedValue("Bearer fetched-token-1");
    const fetch = vi.fn().mockResolvedValue(jsonRes({ ok: true }));
    const client = createOpenAIClient({ config: { ...OAUTH_BASE, getAuthHeader }, fetch });
    await client.chatCompletion({ model: "m" });
    const init = fetch.mock.calls[0]?.[1] as RequestInit & { headers: Record<string, string> };
    expect(init.headers.Authorization).toBe("Bearer fetched-token-1");
    expect(getAuthHeader).toHaveBeenCalled();
  });

  it("recomputes the header per request (refreshed token on the next call)", async () => {
    const getAuthHeader = vi
      .fn()
      .mockResolvedValueOnce("Bearer token-A")
      .mockResolvedValueOnce("Bearer token-B");
    // Fresh Response per call: a Response body can only be read once.
    const fetch = vi.fn().mockImplementation(async () => jsonRes({ ok: true }));
    const client = createOpenAIClient({ config: { ...OAUTH_BASE, getAuthHeader }, fetch });
    await client.chatCompletion({ model: "m" });
    await client.chatCompletion({ model: "m" });
    const h0 = (fetch.mock.calls[0]?.[1] as { headers: Record<string, string> }).headers;
    const h1 = (fetch.mock.calls[1]?.[1] as { headers: Record<string, string> }).headers;
    expect(h0.Authorization).toBe("Bearer token-A");
    expect(h1.Authorization).toBe("Bearer token-B");
  });

  it("on a 401: invalidates, retries once with a new token, succeeds (non-streaming)", async () => {
    const onUnauthorized = vi.fn();
    const getAuthHeader = vi
      .fn()
      .mockResolvedValueOnce("Bearer stale")
      .mockResolvedValueOnce("Bearer fresh");
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(jsonRes({ error: "unauthorized" }, 401))
      .mockResolvedValueOnce(jsonRes({ id: "ok" }, 200));
    const client = createOpenAIClient({
      config: { ...OAUTH_BASE, getAuthHeader, onUnauthorized },
      fetch,
    });
    const out = await client.chatCompletion({ model: "m" });
    expect(out).toEqual({ id: "ok" });
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledTimes(2);
    const retryHeaders = (fetch.mock.calls[1]?.[1] as { headers: Record<string, string> }).headers;
    expect(retryHeaders.Authorization).toBe("Bearer fresh");
  });

  it("on a persistent 401: retries once then throws UpstreamError(upstreamStatus=401)", async () => {
    const onUnauthorized = vi.fn();
    const getAuthHeader = vi.fn().mockResolvedValue("Bearer whatever");
    const fetch = vi.fn().mockImplementation(async () => jsonRes({ error: "unauthorized" }, 401));
    const client = createOpenAIClient({
      config: { ...OAUTH_BASE, getAuthHeader, onUnauthorized },
      fetch,
    });
    await expect(client.chatCompletion({ model: "m" })).rejects.toMatchObject({
      errorClass: "upstream_error",
      upstreamStatus: 401,
    });
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledTimes(2); // original + exactly one retry
  });

  it("scrubs access + refresh tokens from an echoed upstream error body", async () => {
    const currentSecrets = vi.fn().mockReturnValue(["access-XYZ", "refresh-ABC"]);
    const getAuthHeader = vi.fn().mockResolvedValue("Bearer access-XYZ");
    const fetch = vi
      .fn()
      .mockImplementation(async () =>
        jsonRes({ error: { echoed: "access-XYZ and refresh-ABC leaked" } }, 502),
      );
    const client = createOpenAIClient({
      config: { ...OAUTH_BASE, getAuthHeader, currentSecrets },
      fetch,
    });
    try {
      await client.chatCompletion({ model: "m" });
    } catch (e) {
      const raw = JSON.stringify((e as UpstreamError).providerRaw);
      expect(raw).not.toContain("access-XYZ");
      expect(raw).not.toContain("refresh-ABC");
    }
  });

  it("streaming 401 retries before the first chunk and yields the full stream", async () => {
    const onUnauthorized = vi.fn();
    const getAuthHeader = vi
      .fn()
      .mockResolvedValueOnce("Bearer stale")
      .mockResolvedValueOnce("Bearer fresh");
    const chunks = ['data: {"a":1}\n\n', 'data: {"b":2}\n\n', "data: [DONE]\n\n"];
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(jsonRes({ error: "unauthorized" }, 401))
      .mockResolvedValueOnce(sse(chunks));
    const client = createOpenAIClient({
      config: { ...OAUTH_BASE, getAuthHeader, onUnauthorized },
      fetch,
    });
    const received: string[] = [];
    for await (const c of client.chatCompletionStream({ model: "m", stream: true })) {
      received.push(c);
    }
    expect(received.join("")).toBe(chunks.join(""));
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledTimes(2);
    const retryHeaders = (fetch.mock.calls[1]?.[1] as { headers: Record<string, string> }).headers;
    expect(retryHeaders.Authorization).toBe("Bearer fresh");
  });

  it("streaming non-401 error throws before any chunk (breaker contract intact)", async () => {
    const onUnauthorized = vi.fn();
    const getAuthHeader = vi.fn().mockResolvedValue("Bearer t");
    const fetch = vi.fn().mockImplementation(async () => jsonRes({ error: "boom" }, 503));
    const client = createOpenAIClient({
      config: { ...OAUTH_BASE, getAuthHeader, onUnauthorized },
      fetch,
    });
    const iter = client.chatCompletionStream({ model: "m", stream: true });
    await expect(iter[Symbol.asyncIterator]().next()).rejects.toMatchObject({
      errorClass: "upstream_error",
      upstreamStatus: 503,
    });
    expect(onUnauthorized).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("rejects a config that supplies both apiKey and getAuthHeader (fail-closed)", () => {
    const getAuthHeader = vi.fn().mockResolvedValue("Bearer t");
    expect(() =>
      createOpenAIClient({ config: { ...OAUTH_BASE, apiKey: "sk-x", getAuthHeader } }),
    ).toThrow();
  });

  it("rejects a config that supplies neither apiKey nor getAuthHeader (fail-closed)", () => {
    expect(() => createOpenAIClient({ config: { ...OAUTH_BASE } })).toThrow();
  });
});
