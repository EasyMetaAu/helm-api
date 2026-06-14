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
});
