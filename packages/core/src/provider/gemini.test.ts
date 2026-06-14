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
    const calls: string[] = [];
    let apiBody: unknown;
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
      // Media goes through the dedicated (pinned) media fetcher, NOT the API fetch.
      mediaFetch: vi.fn(async (url) => {
        calls.push(String(url));
        return new Response(new Uint8Array([1, 2, 3]), {
          status: 200,
          headers: { "content-type": "image/png", "content-length": "3" },
        });
      }),
      fetch: vi.fn(async (url, init) => {
        calls.push(String(url));
        apiBody = JSON.parse(String(init?.body));
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

    expect(calls).toEqual([
      "https://example.test/cat.png",
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent",
    ]);
    expect(apiBody).toEqual({
      contents: [
        {
          role: "user",
          parts: [{ inlineData: { mimeType: "image/png", data: "AQID" } }],
        },
      ],
    });
  });

  it("pins the remote media connection to the validated resolved address (rebinding-proof)", async () => {
    let pinnedAddress: string | undefined;
    const client = createGeminiClient({
      config: {
        baseUrl: "https://generativelanguage.googleapis.com/v1beta",
        apiKey: "g",
        remoteMediaFetch: { enabled: true },
      },
      dnsLookup: async () => ["93.184.216.34"],
      mediaFetch: vi.fn(async (_url, init) => {
        pinnedAddress = init.pinnedAddress;
        return new Response(new Uint8Array([1]), {
          status: 200,
          headers: { "content-type": "image/png" },
        });
      }),
      fetch: vi.fn(async () => jsonResponse({ candidates: [] })),
    });

    await client.nativePassthrough?.(fileUriRequest("https://cdn.example.test/a.png"));
    // The media fetch is pinned to the exact IP the guard validated — the connection
    // cannot re-resolve to a private host (no rebinding window).
    expect(pinnedAddress).toBe("93.184.216.34");
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
  function apiFetchSpy() {
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
    const fetch = apiFetchSpy();
    const mediaFetch = vi.fn(async () => new Response(new Uint8Array([1]), { status: 200 }));
    const client = createGeminiClient({
      config: {
        baseUrl: "https://generativelanguage.googleapis.com/v1beta",
        apiKey: "g",
        remoteMediaFetch: { enabled: true },
      },
      fetch,
      mediaFetch,
    });
    await expect(
      client.nativePassthrough?.(fileUriRequest("https://169.254.169.254/latest/meta-data/")),
    ).rejects.toThrow(/private or reserved/);
    // Fail-closed: neither the metadata endpoint NOR the upstream generateContent was hit.
    expect(mediaFetch).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("blocks a remote media fetch to a loopback hostname", async () => {
    const fetch = apiFetchSpy();
    const mediaFetch = vi.fn(async () => new Response(new Uint8Array([1]), { status: 200 }));
    const client = createGeminiClient({
      config: {
        baseUrl: "https://generativelanguage.googleapis.com/v1beta",
        apiKey: "g",
        remoteMediaFetch: { enabled: true },
      },
      fetch,
      mediaFetch,
    });
    await expect(
      client.nativePassthrough?.(fileUriRequest("https://localhost/secret.png")),
    ).rejects.toThrow(/local hostname/);
    expect(mediaFetch).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("blocks a hostname that DNS-resolves to a private address (rebinding guard)", async () => {
    const fetch = apiFetchSpy();
    const mediaFetch = vi.fn(async () => new Response(new Uint8Array([1]), { status: 200 }));
    const client = createGeminiClient({
      config: {
        baseUrl: "https://generativelanguage.googleapis.com/v1beta",
        apiKey: "g",
        remoteMediaFetch: { enabled: true },
      },
      dnsLookup: async () => ["10.0.0.5"],
      fetch,
      mediaFetch,
    });
    await expect(
      client.nativePassthrough?.(fileUriRequest("https://internal.evil.example/x.png")),
    ).rejects.toThrow(/resolved to a private/);
    expect(mediaFetch).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("blocks a redirect that lands on a private address", async () => {
    const fetch = apiFetchSpy();
    const mediaFetch = vi.fn(async (url: URL) => {
      if (String(url) === "https://cdn.example.test/img.png") {
        return new Response(null, {
          status: 302,
          headers: { location: "https://169.254.169.254/x" },
        });
      }
      return new Response(new Uint8Array([1]), { status: 200 });
    });
    const client = createGeminiClient({
      config: {
        baseUrl: "https://generativelanguage.googleapis.com/v1beta",
        apiKey: "g",
        remoteMediaFetch: { enabled: true },
      },
      dnsLookup: async () => ["93.184.216.34"],
      fetch,
      mediaFetch,
    });
    await expect(
      client.nativePassthrough?.(fileUriRequest("https://cdn.example.test/img.png")),
    ).rejects.toThrow(/private or reserved/);
    // The first (public) hop was contacted; the redirect target was blocked BEFORE a
    // second connection, and the upstream generateContent never ran.
    expect(mediaFetch.mock.calls.map((c) => String(c[0]))).toEqual([
      "https://cdn.example.test/img.png",
    ]);
    expect(fetch).not.toHaveBeenCalled();
  });
});

// Translated path (#251 review P1): when a non-Gemini client routes to a Gemini
// provider (cross-protocol lane) — or native passthrough is disabled — the executor
// calls chatCompletion/chatCompletionStream. These must translate OpenAI-Chat ⇄ Gemini
// via the transformers (return OpenAI-shaped output), NOT throw.
describe("createGeminiClient — translated OpenAI<->Gemini path", () => {
  it("chatCompletion translates an OpenAI chat request to Gemini native and back to OpenAI", async () => {
    let sentUrl = "";
    let sentBody: Record<string, unknown> = {};
    const client = createGeminiClient({
      config: { baseUrl: "https://generativelanguage.googleapis.com/v1beta", apiKey: "g" },
      fetch: vi.fn(async (url, init) => {
        sentUrl = String(url);
        sentBody = JSON.parse(String(init?.body));
        return jsonResponse({
          candidates: [
            { content: { role: "model", parts: [{ text: "hi there" }] }, finishReason: "STOP" },
          ],
          usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 2 },
        });
      }),
    });

    const out = (await client.chatCompletion(
      { model: "gemini-2.0-flash", messages: [{ role: "user", content: "hello" }] },
      {},
    )) as {
      object: string;
      choices: Array<{ message: { content: unknown } }>;
    };

    // Upstream got a NATIVE Gemini body (contents/parts), never OpenAI `messages`.
    expect(sentUrl).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent",
    );
    expect(sentBody.contents).toEqual([{ role: "user", parts: [{ text: "hello" }] }]);
    expect(sentBody).not.toHaveProperty("messages");
    // Client got an OpenAI chat.completion back (content may be a string or text parts,
    // per the IR→OpenAI transformer — both carry the assistant text).
    expect(out.object).toBe("chat.completion");
    const content = out.choices[0]?.message.content;
    const text =
      typeof content === "string"
        ? content
        : Array.isArray(content)
          ? content.map((part) => (part as { text?: string }).text ?? "").join("")
          : "";
    expect(text).toBe("hi there");
  });

  it("chatCompletionStream translates Gemini SSE into OpenAI chunks terminated by [DONE]", async () => {
    const client = createGeminiClient({
      config: { baseUrl: "https://generativelanguage.googleapis.com/v1beta", apiKey: "g" },
      fetch: vi.fn(async () =>
        streamResponse([
          'data: {"candidates":[{"content":{"parts":[{"text":"Hel"}]}}]}\n\n',
          'data: {"candidates":[{"content":{"parts":[{"text":"lo"}]},"finishReason":"STOP"}]}\n\n',
        ]),
      ),
    });

    const seen: string[] = [];
    for await (const chunk of client.chatCompletionStream(
      { model: "gemini-2.0-flash", messages: [{ role: "user", content: "hi" }] },
      {},
    )) {
      seen.push(chunk);
    }

    const joined = seen.join("");
    // OpenAI SSE framing with a [DONE] terminator (Gemini native has none).
    expect(joined.endsWith("data: [DONE]\n\n")).toBe(true);
    // Reconstruct the assistant text from the OpenAI-shaped delta chunks.
    const text = seen
      .filter((s) => s.startsWith("data: ") && !s.includes("[DONE]"))
      .map(
        (s) =>
          JSON.parse(s.slice("data: ".length)) as {
            choices?: Array<{ delta?: { content?: string } }>;
          },
      )
      .flatMap((c) => c.choices ?? [])
      .map((ch) => ch.delta?.content ?? "")
      .join("");
    expect(text).toBe("Hello");
  });
});
