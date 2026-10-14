import { describe, expect, it, vi } from "vitest";
import { createBailianAsrClient } from "./bailian-asr.js";

const config = { baseUrl: "https://workspace.example.test/api/v1", apiKey: "offline-key" };
const request = {
  model: "qwen3-asr-flash",
  messages: [
    {
      role: "user",
      content: [{ type: "input_audio", input_audio: { data: "data:audio/wav;base64,UklGRg==" } }],
    },
  ],
  asr_options: { language: "zh", enable_itn: false },
};
describe("Bailian ASR Chat transport", () => {
  it("keeps the unary ASR deadline active while reading its response body", async () => {
    let source: ReadableStreamDefaultController<Uint8Array> | undefined;
    const cancel = vi.fn();
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          source = controller;
        },
        cancel,
      }),
    );
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response);
    const pending = createBailianAsrClient({ config: { ...config, timeoutMs: 20 }, fetch })
      .chatCompletion(request)
      .catch((error: unknown) => error);
    let limit: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([
        pending,
        new Promise((resolve) => {
          limit = setTimeout(() => resolve("stalled"), 150);
        }),
      ]);
      expect(result).toMatchObject({ errorClass: "timeout", outcome: "unknown" });
      expect(cancel).toHaveBeenCalled();
    } finally {
      clearTimeout(limit);
      if (!cancel.mock.calls.length) source?.close();
      await pending;
    }
  });
  it("forwards Data URL/asr_options exactly via the compatible Chat endpoint", async () => {
    const result = {
      choices: [{ message: { content: "hello" } }],
      usage: { prompt_tokens: 3, completion_tokens: 1 },
    };
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(Response.json(result));
    expect(await createBailianAsrClient({ config, fetch }).chatCompletion(request)).toEqual(result);
    expect(String(fetch.mock.calls[0]?.[0])).toBe(
      "https://workspace.example.test/compatible-mode/v1/chat/completions",
    );
    expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toEqual({
      ...request,
      stream: false,
    });
  });
  it("preserves the terminal empty-choice usage SSE chunk", async () => {
    const wire =
      'data: {"choices":[{"delta":{"content":"hello"}}]}\n\ndata: {"choices":[],"usage":{"prompt_tokens":3,"completion_tokens":1}}\n\ndata: [DONE]\n\n';
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(new Response(wire, { headers: { "content-type": "text/event-stream" } }));
    const chunks = [];
    for await (const chunk of createBailianAsrClient({ config, fetch }).chatCompletionStream({
      ...request,
      stream: true,
      stream_options: { include_usage: true },
    }))
      chunks.push(chunk);
    expect(chunks.join("")).toBe(wire);
    expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toEqual({
      ...request,
      stream: true,
      stream_options: { include_usage: true },
    });
  });
  it("rejects other models before sending and disables connection/overload retries", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockRejectedValue(new TypeError("fetch failed"));
    const client = createBailianAsrClient({ config: { ...config, connectRetries: 4 }, fetch });
    await expect(
      client.chatCompletion({ ...request, model: "ordinary-chat" }),
    ).rejects.toMatchObject({ outcome: "not_sent" });
    expect(fetch).not.toHaveBeenCalled();
    await expect(client.chatCompletion(request)).rejects.toThrow();
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it.each([
    false,
    true,
  ])("does not resend paid ASR on overload responses (stream=%s)", async (stream) => {
    vi.useFakeTimers();
    try {
      const fetch = vi
        .fn<typeof globalThis.fetch>()
        .mockImplementation(async () =>
          Response.json({ error: { code: "overloaded" } }, { status: 503 }),
        );
      const client = createBailianAsrClient({ config, fetch });
      const run = async () => {
        if (!stream) return client.chatCompletion(request);
        const chunks: string[] = [];
        for await (const chunk of client.chatCompletionStream(request)) chunks.push(chunk);
        return chunks;
      };
      const pending = run().catch((error: unknown) => error);
      await vi.runAllTimersAsync();
      expect(await pending).toMatchObject({ upstreamStatus: 503 });
      expect(fetch).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
