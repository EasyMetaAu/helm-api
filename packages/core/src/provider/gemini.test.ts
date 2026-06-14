import { describe, expect, it, vi } from "vitest";
import { createGeminiClient } from "./gemini.js";

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json", ...(init.headers ?? {}) },
    ...init,
  });
}

function streamResponse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        controller.close();
      },
    }),
    { status: 200, headers: { "Content-Type": "text/event-stream" } },
  );
}

describe("createGeminiClient — native passthrough", () => {
  it("marks the client as the Gemini native protocol profile", () => {
    const client = createGeminiClient({
      config: { baseUrl: "https://generativelanguage.googleapis.com/v1beta", apiKey: "g" },
      fetch: vi.fn() as unknown as typeof fetch,
    });

    expect(client.nativeProtocolProfile).toBe("gemini");
  });

  it("posts a native GenerateContent body to the Gemini model path, not OpenAI Chat shape", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const client = createGeminiClient({
      config: {
        baseUrl: "https://generativelanguage.googleapis.com/v1beta",
        apiKey: "gemini-secret",
      },
      fetch: vi.fn(async (url, init) => {
        calls.push({ url: String(url), init: init ?? {} });
        return jsonResponse({
          candidates: [{ content: { role: "model", parts: [{ text: "native" }] } }],
        });
      }),
    });

    const out = await client.nativePassthrough?.({
      model: "gemini-2.0-flash",
      contents: [{ role: "user", parts: [{ text: "hi" }] }],
      generationConfig: { temperature: 0 },
    });

    expect(out).toMatchObject({
      candidates: [{ content: { parts: [{ text: "native" }] } }],
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent",
    );
    const headers = new Headers(calls[0]?.init.headers);
    expect(headers.get("x-goog-api-key")).toBe("gemini-secret");
    expect(headers.get("Content-Type")).toBe("application/json");
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({
      contents: [{ role: "user", parts: [{ text: "hi" }] }],
      generationConfig: { temperature: 0 },
    });
    expect(String(calls[0]?.init.body)).not.toContain('"messages"');
  });

  it("byte-relays Gemini SSE from streamGenerateContent?alt=sse without adding [DONE]", async () => {
    const chunks = [
      'data: {"candidates":[{"content":{"parts":[{"text":"Hel"}]}}]}\n\n',
      'data: {"candidates":[{"content":{"parts":[{"text":"lo"}]},"finishReason":"STOP"}]}\n\n',
    ];
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const client = createGeminiClient({
      config: { baseUrl: "https://generativelanguage.googleapis.com/v1beta", apiKey: "g" },
      fetch: vi.fn(async (url, init) => {
        calls.push({ url: String(url), init: init ?? {} });
        return streamResponse(chunks);
      }),
    });

    const seen: string[] = [];
    for await (const chunk of client.nativePassthroughStream?.({
      model: "publishers/google/models/gemini-2.0-flash",
      contents: [{ role: "user", parts: [{ text: "hi" }] }],
    }) ?? []) {
      seen.push(chunk);
    }

    expect(calls[0]?.url).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/publishers/google/models/gemini-2.0-flash:streamGenerateContent?alt=sse",
    );
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({
      contents: [{ role: "user", parts: [{ text: "hi" }] }],
    });
    expect(seen.join("")).toBe(chunks.join(""));
    expect(seen.join("")).not.toContain("[DONE]");
  });

  it("optionally forwards countTokens to the Gemini countTokens endpoint", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const client = createGeminiClient({
      config: { baseUrl: "https://generativelanguage.googleapis.com/v1beta", apiKey: "g" },
      fetch: vi.fn(async (url, init) => {
        calls.push({ url: String(url), init: init ?? {} });
        return jsonResponse({ totalTokens: 7 });
      }),
    });

    const out = await client.countTokens?.({
      model: "gemini-2.0-flash",
      contents: [{ role: "user", parts: [{ text: "count me" }] }],
    });

    expect(out).toEqual({ totalTokens: 7 });
    expect(calls[0]?.url).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:countTokens",
    );
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({
      contents: [{ role: "user", parts: [{ text: "count me" }] }],
    });
  });

  it("materializes translated HTTPS image placeholders when remote media fetch is enabled", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const client = createGeminiClient({
      config: {
        baseUrl: "https://generativelanguage.googleapis.com/v1beta",
        apiKey: "g",
        remoteMediaFetch: {
          enabled: true,
          maxBytes: 1024,
          timeoutMs: 1_000,
          allowedMimeTypes: ["image/*"],
        },
      },
      // Hermetic DNS: example.test resolves to a public address (no real lookup).
      dnsLookup: async () => ["93.184.216.34"],
      fetch: vi.fn(async (url, init) => {
        calls.push({ url: String(url), init: init ?? {} });
        if (String(url) === "https://example.test/cat.png") {
          return new Response(new Uint8Array([1, 2, 3]), {
            status: 200,
            headers: { "content-type": "image/png", "content-length": "3" },
          });
        }
        return jsonResponse({
          candidates: [{ content: { role: "model", parts: [{ text: "native" }] } }],
        });
      }),
    });

    await client.nativePassthrough?.({
      model: "gemini-2.0-flash",
      contents: [
        {
          role: "user",
          parts: [
            {
              text: "[remote image unsupported by Gemini nativeOut: https://example.test/cat.png]",
            },
          ],
        },
      ],
    });

    expect(calls.map((c) => c.url)).toEqual([
      "https://example.test/cat.png",
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent",
    ]);
    expect(JSON.parse(String(calls[1]?.init.body))).toEqual({
      contents: [
        {
          role: "user",
          parts: [{ inlineData: { mimeType: "image/png", data: "AQID" } }],
        },
      ],
    });
  });

  it("leaves remote media placeholders untouched when remote media fetch is disabled", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const client = createGeminiClient({
      config: { baseUrl: "https://generativelanguage.googleapis.com/v1beta", apiKey: "g" },
      fetch: vi.fn(async (url, init) => {
        calls.push({ url: String(url), init: init ?? {} });
        return jsonResponse({
          candidates: [{ content: { role: "model", parts: [{ text: "native" }] } }],
        });
      }),
    });

    await client.nativePassthrough?.({
      model: "gemini-2.0-flash",
      contents: [
        {
          role: "user",
          parts: [
            {
              text: "[remote image unsupported by Gemini nativeOut: https://example.test/cat.png]",
            },
          ],
        },
      ],
    });

    expect(calls).toHaveLength(1);
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({
      contents: [
        {
          role: "user",
          parts: [
            {
              text: "[remote image unsupported by Gemini nativeOut: https://example.test/cat.png]",
            },
          ],
        },
      ],
    });
  });

  // SSRF guard (P2-GEM-02 security): remote media fetch is opt-in, but once enabled a
  // client-supplied URL must NOT be able to reach internal/link-local/loopback targets
  // (e.g. the cloud metadata endpoint 169.254.169.254). The guard runs BEFORE the
  // fetch, so a blocked target is never contacted at all.
  function fetchSpyOk() {
    return vi.fn(async () =>
      jsonResponse({ candidates: [{ content: { role: "model", parts: [{ text: "native" }] } }] }),
    );
  }

  function fileUriRequest(fileUri: string) {
    return {
      model: "gemini-2.0-flash",
      contents: [{ role: "user", parts: [{ fileData: { fileUri, mimeType: "image/png" } }] }],
    };
  }

  it("blocks a remote media fetch to a private/reserved IP literal without contacting it", async () => {
    const fetch = fetchSpyOk();
    const client = createGeminiClient({
      config: {
        baseUrl: "https://generativelanguage.googleapis.com/v1beta",
        apiKey: "g",
        remoteMediaFetch: { enabled: true },
      },
      fetch,
    });
    await expect(
      client.nativePassthrough?.(fileUriRequest("https://169.254.169.254/latest/meta-data/")),
    ).rejects.toThrow(/private or reserved/);
    // Fail-closed: neither the metadata endpoint NOR the upstream generateContent was hit.
    expect(fetch).not.toHaveBeenCalled();
  });

  it("blocks a remote media fetch to a loopback hostname", async () => {
    const fetch = fetchSpyOk();
    const client = createGeminiClient({
      config: {
        baseUrl: "https://generativelanguage.googleapis.com/v1beta",
        apiKey: "g",
        remoteMediaFetch: { enabled: true },
      },
      fetch,
    });
    await expect(
      client.nativePassthrough?.(fileUriRequest("https://localhost/secret.png")),
    ).rejects.toThrow(/local hostname/);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("blocks a hostname that DNS-resolves to a private address (rebinding guard)", async () => {
    const fetch = fetchSpyOk();
    const client = createGeminiClient({
      config: {
        baseUrl: "https://generativelanguage.googleapis.com/v1beta",
        apiKey: "g",
        remoteMediaFetch: { enabled: true },
      },
      dnsLookup: async () => ["10.0.0.5"],
      fetch,
    });
    await expect(
      client.nativePassthrough?.(fileUriRequest("https://internal.evil.example/x.png")),
    ).rejects.toThrow(/resolved to a private/);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("blocks a redirect that lands on a private address", async () => {
    const fetch = vi.fn(async (url: unknown) => {
      if (String(url) === "https://cdn.example.test/img.png") {
        return new Response(null, {
          status: 302,
          headers: { location: "https://169.254.169.254/x" },
        });
      }
      return jsonResponse({ candidates: [{ content: { role: "model", parts: [{ text: "x" }] } }] });
    });
    const client = createGeminiClient({
      config: {
        baseUrl: "https://generativelanguage.googleapis.com/v1beta",
        apiKey: "g",
        remoteMediaFetch: { enabled: true },
      },
      dnsLookup: async () => ["93.184.216.34"],
      fetch,
    });
    await expect(
      client.nativePassthrough?.(fileUriRequest("https://cdn.example.test/img.png")),
    ).rejects.toThrow(/private or reserved/);
    // The first (public) hop was contacted; the upstream generateContent never ran.
    expect(fetch.mock.calls.map((c) => String(c[0]))).toEqual(["https://cdn.example.test/img.png"]);
  });
});
