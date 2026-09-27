import { createServer } from "node:net";
import { createNativePassthroughCarrier } from "@helm/shared";
import sharp from "sharp";
import { describe, expect, it, vi } from "vitest";
import {
  createCodexResponsesClient,
  createGenericOpenAIResponsesClient,
  hoistResponsesInstructions,
} from "./openai-responses.js";

describe("Native Responses protocol fidelity", () => {
  it.each([
    "function_call_output",
    "custom_tool_call_output",
  ])("adapts Lite image parts inside %s without touching opaque data", async (type) => {
    let sent: Record<string, unknown> = {};
    const image = { type: "input_image", image_url: "data:image/png;base64,AAAA", detail: "high" };
    const opaque = { type: "input_image", detail: "application-data" };
    const input = [
      { type: "additional_tools", role: "developer", tools: [] },
      {
        type,
        call_id: "call_1",
        output: [image, { type: "input_text", text: "Screenshot", extra: opaque }],
      },
      { type: "future_item", output: [opaque] },
    ];
    const client = createCodexResponsesClient({
      config: {
        baseUrl: "https://codex.example.test",
        getAuthHeader: async () => "Bearer test-only",
      },
      fetch: async (_url, init) => {
        sent = JSON.parse(String(init?.body));
        return Response.json({ id: "resp", status: "completed", output: [] });
      },
    });
    await client.nativePassthrough?.({ model: "test-model", input, store: false });
    expect(sent.input).toEqual([
      input[0],
      {
        ...input[1],
        output: [
          { type: "input_image", image_url: image.image_url },
          { type: "input_text", text: "Screenshot", extra: opaque },
        ],
      },
      input[2],
    ]);
    expect(image.detail).toBe("high");
  });
  it("preserves opaque nested tool schema examples in Responses Lite", async () => {
    let sent: Record<string, unknown> = {};
    const client = createCodexResponsesClient({
      config: {
        baseUrl: "https://chatgpt.com/backend-api/codex",
        getAuthHeader: async () => "Bearer test-only",
      },
      fetch: (async (_url, init) => {
        sent = JSON.parse(String(init?.body));
        return new Response(
          JSON.stringify({ id: "resp", status: "completed", output: [], usage: {} }),
          { headers: { "content-type": "application/json" } },
        );
      }) as typeof fetch,
    });
    const example = { type: "input_image", detail: "opaque-user-data" };
    const body = {
      model: "gpt-test",
      store: false,
      input: [
        {
          type: "additional_tools",
          role: "developer",
          tools: [
            {
              type: "function",
              name: "echo",
              parameters: { type: "object", properties: { example: { default: example } } },
            },
          ],
        },
      ],
    };
    await client.nativePassthrough?.(
      createNativePassthroughCarrier({ protocol: "openai_responses", body, headers: {} }),
    );
    expect(sent.input).toEqual(body.input);
  });
  it.each([
    "codex",
    "generic",
  ] as const)("%s drops unrelated client credential headers", async (kind) => {
    let sent = new Headers();
    const fetcher = (async (_url, init) => {
      sent = new Headers(init?.headers);
      return new Response(
        JSON.stringify({ id: "resp", status: "completed", output: [], usage: {} }),
        { headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;
    const client =
      kind === "codex"
        ? createCodexResponsesClient({
            config: {
              baseUrl: "https://chatgpt.com/backend-api/codex",
              getAuthHeader: async () => "Bearer test-only",
            },
            fetch: fetcher,
          })
        : createGenericOpenAIResponsesClient({
            config: { baseUrl: "https://relay.example.test", apiKey: "test-only" },
            fetch: fetcher,
          });
    await client.nativePassthrough?.(
      createNativePassthroughCarrier({
        protocol: "openai_responses",
        body: { model: "test-model", input: "hello", store: false },
        headers: {
          "x-functions-key": "unrelated-test-secret",
          "x-codex-installation-id": "client-install",
          "x-session-key": "affinity-only",
          "session-id": "session-1",
          "idempotency-key": "idempotency-1",
        },
      }),
    );
    expect(sent.get("x-functions-key")).toBeNull();
    expect(sent.get("x-codex-installation-id")).toBe(kind === "codex" ? "client-install" : null);
    expect(sent.get("x-session-key")).toBeNull();
    expect(sent.get("session-id")).toBe("session-1");
    expect(sent.get("idempotency-key")).toBe("idempotency-1");
  });
});

describe("Responses accepted-work boundary", () => {
  it("keeps a real refused TCP connection eligible for provider fallback", async () => {
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (address === null || typeof address === "string") throw new Error("missing port");
    const client = createGenericOpenAIResponsesClient({
      config: {
        baseUrl: `http://127.0.0.1:${address.port}`,
        apiKey: "test-only",
        connectRetries: 0,
      },
    });
    await expect(
      client.nativePassthrough?.({ model: "test-model", input: "hi" }),
    ).rejects.toMatchObject({
      upstreamStatus: null,
      providerRaw: { error: { cause: { code: "ECONNREFUSED" } } },
    });
  });
  it.each([
    "codex",
    "generic",
  ] as const)("%s compact does not expose ambiguous transport as retryable", async (kind) => {
    const fetcher = vi.fn(async () => {
      throw new TypeError("fetch failed", {
        cause: Object.assign(new Error("socket closed"), { code: "UND_ERR_SOCKET" }),
      });
    });
    const client =
      kind === "codex"
        ? createCodexResponsesClient({
            config: {
              baseUrl: "https://chatgpt.com/backend-api/codex",
              getAuthHeader: async () => "Bearer test-only",
            },
            fetch: fetcher,
          })
        : createGenericOpenAIResponsesClient({
            config: { baseUrl: "https://api.example.test", apiKey: "test-only", connectRetries: 0 },
            fetch: fetcher,
          });
    await expect(
      client.responsesCompact?.({ model: "test-model", input: "hello" }),
    ).rejects.toMatchObject({
      providerRaw: { error: { code: "response_create_outcome_unknown" } },
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it.each([
    "native",
    "compact",
  ] as const)("generic %s never replays an unreadable accepted response", async (operation) => {
    const client = createGenericOpenAIResponsesClient({
      config: { baseUrl: "https://api.example.test", apiKey: "test-only" },
      fetch: async () =>
        new Response("{truncated", { headers: { "content-type": "application/json" } }),
    });
    const body = { model: "test-model", input: "hello" };
    const result =
      operation === "native" ? client.nativePassthrough?.(body) : client.responsesCompact?.(body);
    await expect(result).rejects.toMatchObject({
      providerRaw: { error: { code: "response_create_outcome_unknown" } },
    });
  });
});

describe("Codex bounded compatibility", () => {
  it("does not move later or mixed-content developer instructions", () => {
    for (const input of [
      [
        { role: "user", content: "hello" },
        { role: "developer", content: "later rule" },
      ],
      [{ type: "future_item", role: "developer", content: "opaque instruction" }],
      [{ role: "developer", content: "rule", extra: "keep" }],
      [
        {
          role: "developer",
          content: [
            { type: "input_text", text: "rule" },
            { type: "opaque_block", data: "keep" },
          ],
        },
      ],
    ]) {
      expect(hoistResponsesInstructions({ input }).body.input).toEqual(input);
    }
  });
  it("preserves an unfamiliar opaque reasoning encoding", async () => {
    let sent: Record<string, unknown> = {};
    const client = createCodexResponsesClient({
      config: {
        baseUrl: "https://chatgpt.com/backend-api/codex",
        getAuthHeader: async () => "Bearer test-only",
      },
      fetch: async (_url, init) => {
        sent = JSON.parse(String(init?.body));
        return new Response(JSON.stringify({ output: [], status: "completed" }));
      },
    });
    const input = [{ type: "reasoning", encrypted_content: "future-opaque-encoding", summary: [] }];
    await client.nativePassthrough?.({ model: "test-model", input, store: false });
    expect(sent.input).toEqual(input);
  });
});

describe("Responses lifecycle query fidelity", () => {
  it.each([
    "responsesRetrieve",
    "responsesInputItems",
  ] as const)("%s preserves query parameters", async (method) => {
    let seen = "";
    const client = createGenericOpenAIResponsesClient({
      config: { baseUrl: "https://api.example.test/v1", apiKey: "test-only" },
      fetch: async (url) => {
        seen = String(url);
        return new Response("{}");
      },
    });
    const query = new URLSearchParams(
      "include=reasoning.encrypted_content&include=message.input_image.image_url&after=item%2Fa&limit=17&order=asc",
    );
    await client[method]?.("resp/x", { query });
    expect(new URL(seen).searchParams.toString()).toBe(query.toString());
    expect(new URL(seen).pathname).toContain("resp%2Fx");
  });
});

it("custom-tool compatibility does not recompress native images", async () => {
  const png = await sharp({ create: { width: 2, height: 2, channels: 3, background: "white" } })
    .png()
    .toBuffer();
  const input = [
    {
      type: "message",
      role: "user",
      content: [
        { type: "input_image", image_url: `data:image/png;base64,${png.toString("base64")}` },
      ],
    },
  ];
  let sent: Record<string, unknown> = {};
  const client = createGenericOpenAIResponsesClient({
    config: { baseUrl: "https://api.example.test", apiKey: "test-only" },
    requestContract: { translateUnsupportedCustomTools: true },
    fetch: async (_url, init) => {
      sent = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ output: [] }));
    },
  });
  await client.nativePassthrough?.({ model: "test-model", input });
  expect(sent.input).toEqual(input);
});

it("bounds an accepted generic unary body that stops producing data", async () => {
  vi.useFakeTimers();
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  const cancel = vi.fn();
  try {
    const client = createGenericOpenAIResponsesClient({
      config: { baseUrl: "https://api.example.test", apiKey: "test-only", timeoutMs: 25 },
      fetch: async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(c) {
              controller = c;
              c.enqueue(new TextEncoder().encode("{"));
            },
            cancel,
          }),
        ),
    });
    let outcome: unknown = "pending";
    void client.nativePassthrough?.({ model: "test-model", input: "hello" }).then(
      (value) => {
        outcome = value;
      },
      (error) => {
        outcome = error;
      },
    );
    await vi.advanceTimersByTimeAsync(30);
    expect(outcome).toMatchObject({
      providerRaw: { error: { code: "response_create_outcome_unknown" } },
    });
    expect(cancel).toHaveBeenCalled();
  } finally {
    try {
      controller?.close();
    } catch {}
    vi.useRealTimers();
  }
});
