import { describe, expect, it, vi } from "vitest";
import { UpstreamError } from "./openai.js";
import {
  aggregateResponsesStream,
  codexAccountIdFromToken,
  createCodexResponsesClient,
  openaiToResponsesRequest,
  translateResponsesSSE,
} from "./openai-responses.js";

// A fake access-token JWT carrying the chatgpt_account_id claim (header.payload.sig).
function jwt(accountId: string): string {
  const payload = Buffer.from(
    JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: accountId } }),
  ).toString("base64url");
  return `eyJhbGciOiJSUzI1NiJ9.${payload}.sig`;
}

// Codex Responses SSE: one `data: {json}` block per event.
function sseResponse(events: object[]): Response {
  const body = events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("");
  return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } });
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("codexAccountIdFromToken", () => {
  it("decodes the chatgpt_account_id claim from the JWT payload", () => {
    expect(codexAccountIdFromToken(jwt("acct_42"))).toBe("acct_42");
  });
  it("returns '' for a non-JWT / claim-less token", () => {
    expect(codexAccountIdFromToken("opaque")).toBe("");
    expect(codexAccountIdFromToken(`eyJ.${Buffer.from("{}").toString("base64url")}.s`)).toBe("");
  });
});

describe("openaiToResponsesRequest", () => {
  it("maps system -> instructions, user/assistant -> input, sets store=false stream=true", () => {
    const body = openaiToResponsesRequest({
      model: "gpt-5.5",
      messages: [
        { role: "system", content: "Be terse." },
        { role: "user", content: "Hi" },
        { role: "assistant", content: "Hello" },
      ],
      temperature: 0.3,
      max_tokens: 256,
    });
    expect(body.model).toBe("gpt-5.5");
    expect(body.store).toBe(false);
    expect(body.stream).toBe(true);
    expect(body.instructions).toBe("Be terse.");
    expect(body.temperature).toBe(0.3);
    // Codex/ChatGPT-account contract (ported from openclaw): NO max_output_tokens,
    // and a store:false request MUST request encrypted reasoning back + set verbosity.
    expect(body.max_output_tokens).toBeUndefined();
    expect(body.include).toEqual(["reasoning.encrypted_content"]);
    expect(body.text).toEqual({ verbosity: "low" });
    const input = body.input as Array<Record<string, unknown>>;
    expect(input[0]).toMatchObject({ type: "message", role: "user" });
    expect((input[0]?.content as Array<{ type: string }>)[0]).toMatchObject({ type: "input_text" });
    expect(input[1]).toMatchObject({ type: "message", role: "assistant" });
    expect((input[1]?.content as Array<{ type: string }>)[0]).toMatchObject({
      type: "output_text",
    });
  });

  it("sets prompt_cache_key from a stable sessionId (omitted when absent)", () => {
    const withSession = openaiToResponsesRequest(
      { model: "gpt-5.5", messages: [{ role: "user", content: "Hi" }] },
      { sessionId: "sess-123" },
    );
    expect(withSession.prompt_cache_key).toBe("sess-123");
    const without = openaiToResponsesRequest({
      model: "gpt-5.5",
      messages: [{ role: "user", content: "Hi" }],
    });
    expect(without.prompt_cache_key).toBeUndefined();
  });

  it("maps assistant tool_calls -> function_call items and tool results -> function_call_output", () => {
    const body = openaiToResponsesRequest({
      model: "gpt-5.5",
      messages: [
        {
          role: "assistant",
          content: null,
          tool_calls: [
            { id: "call_1", type: "function", function: { name: "get", arguments: '{"x":1}' } },
          ],
        },
        { role: "tool", tool_call_id: "call_1", content: "result" },
      ],
      tools: [{ type: "function", function: { name: "get", parameters: { type: "object" } } }],
    });
    const input = body.input as Array<Record<string, unknown>>;
    expect(input[0]).toMatchObject({
      type: "function_call",
      call_id: "call_1",
      name: "get",
      arguments: '{"x":1}',
    });
    expect(input[1]).toMatchObject({
      type: "function_call_output",
      call_id: "call_1",
      output: "result",
    });
    expect((body.tools as Array<Record<string, unknown>>)[0]).toMatchObject({
      type: "function",
      name: "get",
    });
  });

  it("defaults instructions when no system message is present", () => {
    const body = openaiToResponsesRequest({
      model: "m",
      messages: [{ role: "user", content: "x" }],
    });
    expect(body.instructions).toBe("You are a helpful assistant.");
  });
});

describe("translateResponsesSSE", () => {
  it("maps output_text deltas + completed to OpenAI chunks + finish + [DONE]", async () => {
    const res = sseResponse([
      { type: "response.created", response: { id: "resp_1" } },
      { type: "response.output_item.added", item: { type: "message", role: "assistant" } },
      { type: "response.output_text.delta", delta: "Hel" },
      { type: "response.output_text.delta", delta: "lo" },
      { type: "response.completed", response: { status: "completed", usage: {} } },
    ]);
    const chunks: string[] = [];
    for await (const c of translateResponsesSSE(res, "gpt-5.5")) chunks.push(c);
    const joined = chunks.join("");
    expect(joined).toContain('"role":"assistant"');
    expect(joined).toContain('"content":"Hel"');
    expect(joined).toContain('"content":"lo"');
    expect(joined).toContain('"finish_reason":"stop"');
    expect(joined.trimEnd().endsWith("data: [DONE]")).toBe(true);
  });

  it("maps a function_call (added + args deltas + completed) to tool_call deltas + finish=tool_calls", async () => {
    const res = sseResponse([
      {
        type: "response.output_item.added",
        item: { type: "function_call", call_id: "call_9", name: "lookup" },
      },
      { type: "response.function_call_arguments.delta", delta: '{"q":' },
      { type: "response.function_call_arguments.delta", delta: '"hi"}' },
      { type: "response.completed", response: { status: "completed" } },
    ]);
    const chunks: string[] = [];
    for await (const c of translateResponsesSSE(res, "m")) chunks.push(c);
    const joined = chunks.join("");
    expect(joined).toContain('"id":"call_9"');
    expect(joined).toContain('"name":"lookup"');
    // The args deltas ride inside the chunk JSON, so the inner quotes are escaped.
    expect(joined).toContain('{\\"q\\":');
    expect(joined).toContain('\\"hi\\"}');
    expect(joined).toContain('"finish_reason":"tool_calls"');
    expect(joined.trimEnd().endsWith("data: [DONE]")).toBe(true);
  });

  it("throws UpstreamError on an error event", async () => {
    const res = sseResponse([{ type: "error", code: "bad", message: "nope" }]);
    await expect(async () => {
      for await (const _ of translateResponsesSSE(res, "m")) {
        // drain
      }
    }).rejects.toBeInstanceOf(UpstreamError);
  });

  it("throws UpstreamError(timeout) and cancels when the stream stalls past idleMs", async () => {
    vi.useFakeTimers();
    try {
      let cancelled = false;
      // One event, then hang so the next read pends and the idle guard fires.
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(
            new TextEncoder().encode('data: {"type":"response.created","response":{}}\n\n'),
          );
        },
        cancel() {
          cancelled = true;
        },
      });
      const res = new Response(stream, { status: 200 });
      const run = (async () => {
        for await (const _ of translateResponsesSSE(res, "m", 500)) {
          // drain
        }
      })();
      const assertion = expect(run).rejects.toMatchObject({ errorClass: "timeout" });
      await vi.advanceTimersByTimeAsync(500);
      await assertion;
      expect(cancelled).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("aggregateResponsesStream", () => {
  it("returns at response.completed without waiting on the idle guard (terminal event stops the read)", async () => {
    vi.useFakeTimers();
    try {
      const enc = new TextEncoder();
      const events = [
        'data: {"type":"response.created","response":{"id":"resp_1"}}\n\n',
        'data: {"type":"response.output_text.delta","delta":"hi"}\n\n',
        'data: {"type":"response.completed","response":{"status":"completed","usage":{"input_tokens":1,"output_tokens":1}}}\n\n',
      ];
      // Terminal event enqueued, then the body is held open (no close): aggregation
      // must break at response.completed, not block on the idle-guarded next read.
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          for (const e of events) controller.enqueue(enc.encode(e));
        },
      });
      const res = new Response(stream, { status: 200 });
      const p = aggregateResponsesStream(res, "m", 500);
      // A regression (no break) would pend on the next read and reject here.
      await vi.advanceTimersByTimeAsync(500);
      const out = await p;
      const msg = (out.choices as Array<Record<string, unknown>>)[0]?.message as Record<
        string,
        unknown
      >;
      expect(msg.content).toBe("hi");
    } finally {
      vi.useRealTimers();
    }
  });

  it("folds text + usage into a single chat response (Codex is stream-only)", async () => {
    const res = sseResponse([
      { type: "response.created", response: { id: "resp_7" } },
      { type: "response.output_item.added", item: { type: "message", role: "assistant" } },
      { type: "response.output_text.delta", delta: "Hi " },
      { type: "response.output_text.delta", delta: "there" },
      {
        type: "response.completed",
        response: { status: "completed", usage: { input_tokens: 5, output_tokens: 2 } },
      },
    ]);
    const out = await aggregateResponsesStream(res, "gpt-5.5");
    expect(out.id).toBe("resp_7");
    const msg = (out.choices as Array<Record<string, unknown>>)[0]?.message as Record<
      string,
      unknown
    >;
    expect(msg.content).toBe("Hi there");
    expect((out.choices as Array<Record<string, unknown>>)[0]?.finish_reason).toBe("stop");
    expect(out.usage).toMatchObject({ prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 });
  });

  it("folds a function_call into tool_calls with finish_reason tool_calls", async () => {
    const res = sseResponse([
      {
        type: "response.output_item.added",
        item: { type: "function_call", call_id: "call_3", name: "run" },
      },
      { type: "response.function_call_arguments.delta", delta: '{"a":1' },
      { type: "response.function_call_arguments.done", arguments: '{"a":1}' },
      { type: "response.completed", response: { status: "completed" } },
    ]);
    const out = await aggregateResponsesStream(res, "m");
    const msg = (out.choices as Array<Record<string, unknown>>)[0]?.message as Record<
      string,
      unknown
    >;
    const calls = msg.tool_calls as Array<Record<string, unknown>>;
    expect(calls[0]).toMatchObject({
      id: "call_3",
      type: "function",
      function: { name: "run", arguments: '{"a":1}' },
    });
    expect((out.choices as Array<Record<string, unknown>>)[0]?.finish_reason).toBe("tool_calls");
  });
});

describe("createCodexResponsesClient", () => {
  it("sends Bearer + chatgpt-account-id (from JWT) + originator + OpenAI-Beta; 401-retries once", async () => {
    let calls = 0;
    const seenAuth: string[] = [];
    let seenAccount = "";
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      calls += 1;
      expect(String(url)).toBe("https://chatgpt.com/backend-api/codex/responses");
      const h = new Headers(init?.headers);
      seenAuth.push(h.get("Authorization") ?? "");
      seenAccount = h.get("chatgpt-account-id") ?? "";
      expect(h.get("originator")).toBe("helm");
      expect(h.get("OpenAI-Beta")).toBe("responses=experimental");
      const body = JSON.parse(String(init?.body)) as { store: boolean; stream: boolean };
      expect(body.store).toBe(false);
      expect(body.stream).toBe(true);
      if (calls === 1) return jsonResponse({ error: "expired" }, 401);
      return sseResponse([
        { type: "response.output_item.added", item: { type: "message", role: "assistant" } },
        { type: "response.output_text.delta", delta: "ok" },
        { type: "response.completed", response: { status: "completed", usage: {} } },
      ]);
    });
    let token = jwt("acct_a");
    const client = createCodexResponsesClient({
      config: {
        baseUrl: "https://chatgpt.com/backend-api/codex",
        getAuthHeader: async () => `Bearer ${token}`,
        onUnauthorized: () => {
          token = jwt("acct_b");
        },
        currentSecrets: () => [token],
      },
      fetch: fetchMock as unknown as typeof fetch,
    });
    const resp = (await client.chatCompletion({
      model: "gpt-5.5",
      messages: [{ role: "user", content: "hi" }],
    })) as Record<string, unknown>;
    expect(calls).toBe(2);
    expect(seenAuth[0]).toContain("Bearer ");
    expect(seenAccount).toBe("acct_b"); // refreshed token's account id on the retry
    expect(
      ((resp.choices as Array<Record<string, unknown>>)[0]?.message as Record<string, unknown>)
        .content,
    ).toBe("ok");
  });

  it("onResponseMeta fires EXACTLY once with the response headers and never perturbs the streamed chunks (Principle 8)", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          [
            `data: ${JSON.stringify({ type: "response.output_text.delta", delta: "hel" })}\n\n`,
            `data: ${JSON.stringify({ type: "response.output_text.delta", delta: "lo" })}\n\n`,
            `data: ${JSON.stringify({ type: "response.completed", response: { status: "completed", usage: {} } })}\n\n`,
          ].join(""),
          {
            status: 200,
            headers: {
              "Content-Type": "text/event-stream",
              "x-codex-primary-used-percent": "7",
              "x-codex-primary-reset-after-seconds": "300",
            },
          },
        ),
    );
    const seen: Headers[] = [];
    const client = createCodexResponsesClient({
      config: {
        baseUrl: "https://chatgpt.com/backend-api/codex",
        getAuthHeader: async () => `Bearer ${jwt("acct")}`,
        onResponseMeta: (h) => seen.push(h),
      },
      fetch: fetchMock as unknown as typeof fetch,
    });
    const chunks: string[] = [];
    for await (const ch of client.chatCompletionStream({
      model: "gpt-5.5",
      messages: [{ role: "user", content: "hi" }],
    })) {
      chunks.push(ch);
    }
    // The hook fired once, BEFORE/at stream open, with the live quota headers.
    expect(seen).toHaveLength(1);
    expect(seen[0]?.get("x-codex-primary-used-percent")).toBe("7");
    // The streamed body is untouched: both deltas survive, in order.
    const joined = chunks.join("");
    expect(joined.indexOf("hel")).toBeGreaterThanOrEqual(0);
    expect(joined.indexOf("hel")).toBeLessThan(joined.indexOf("lo"));
  });

  it("sends User-Agent + stable session_id / x-client-request-id headers when configured", async () => {
    let seen: Headers | null = null;
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      seen = new Headers(init?.headers);
      return sseResponse([
        { type: "response.output_text.delta", delta: "ok" },
        { type: "response.completed", response: { status: "completed", usage: {} } },
      ]);
    });
    const client = createCodexResponsesClient({
      config: {
        baseUrl: "https://chatgpt.com/backend-api/codex",
        getAuthHeader: async () => `Bearer ${jwt("acct")}`,
        sessionId: "sess-abc",
        userAgent: "helm-codex/9.9.9",
      },
      fetch: fetchMock as unknown as typeof fetch,
    });
    await client.chatCompletion({ model: "gpt-5.5", messages: [{ role: "user", content: "hi" }] });
    const h = seen as unknown as Headers;
    expect(h.get("user-agent")).toBe("helm-codex/9.9.9");
    expect(h.get("session_id")).toBe("sess-abc");
    expect(h.get("x-client-request-id")).toBe("sess-abc");
  });

  it("redacts the access token from an echoed upstream error body", async () => {
    const token = jwt("acct_secret_value_1234");
    const client = createCodexResponsesClient({
      config: {
        baseUrl: "https://chatgpt.com/backend-api/codex",
        getAuthHeader: async () => `Bearer ${token}`,
        currentSecrets: () => [token],
      },
      fetch: (async () =>
        jsonResponse({ error: `leaked ${token}` }, 500)) as unknown as typeof fetch,
    });
    await expect(
      client.chatCompletion({ model: "m", messages: [{ role: "user", content: "x" }] }),
    ).rejects.toMatchObject({ providerRaw: { error: expect.stringContaining("[redacted]") } });
  });

  it("requires getAuthHeader", () => {
    expect(() => createCodexResponsesClient({ config: { baseUrl: "https://x/codex" } })).toThrow(
      /getAuthHeader/,
    );
  });
});
