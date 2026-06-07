import { describe, expect, it, vi } from "vitest";
import {
  anthropicToOpenAIResponse,
  createAnthropicClient,
  openaiToAnthropicRequest,
  translateAnthropicSSE,
} from "./anthropic.js";
import { UpstreamError } from "./openai.js";

describe("openaiToAnthropicRequest", () => {
  it("prepends the Claude-Code system spoof and maps messages + max_tokens", () => {
    const body = openaiToAnthropicRequest({
      model: "claude-opus-4-6",
      messages: [
        { role: "system", content: "Be terse." },
        { role: "user", content: "Hi" },
        { role: "assistant", content: "Hello" },
      ],
      temperature: 0.5,
    });
    const sys = body.system as Array<{ text: string }>;
    expect(sys[0]?.text).toBe("You are Claude Code, Anthropic's official CLI for Claude.");
    expect(sys[1]?.text).toBe("Be terse.");
    expect(body.max_tokens).toBe(4096); // defaulted
    expect(body.temperature).toBe(0.5);
    const msgs = body.messages as Array<{
      role: string;
      content: Array<{ type: string; text?: string }>;
    }>;
    expect(msgs).toHaveLength(2);
    expect(msgs[0]).toMatchObject({ role: "user" });
    expect(msgs[0]?.content[0]).toMatchObject({ type: "text", text: "Hi" });
  });

  it("maps assistant tool_calls -> tool_use and tool results -> tool_result", () => {
    const body = openaiToAnthropicRequest({
      model: "m",
      messages: [
        {
          role: "assistant",
          content: null,
          tool_calls: [
            { id: "t1", type: "function", function: { name: "get", arguments: '{"x":1}' } },
          ],
        },
        { role: "tool", tool_call_id: "t1", content: "result" },
      ],
      tools: [{ type: "function", function: { name: "get", parameters: { type: "object" } } }],
    });
    const msgs = body.messages as Array<{ role: string; content: Array<Record<string, unknown>> }>;
    expect(msgs[0]?.content[0]).toMatchObject({
      type: "tool_use",
      id: "t1",
      name: "get",
      input: { x: 1 },
    });
    expect(msgs[1]?.content[0]).toMatchObject({ type: "tool_result", tool_use_id: "t1" });
    expect(body.tools as unknown[]).toHaveLength(1);
  });

  it("emits metadata.user_id when provided, omits it otherwise (anti-ban stable device identity)", () => {
    // The Claude subscription anti-ban measure (ref claude-relay-service): a STABLE
    // per-account identity travels in metadata.user_id. The transformer only forwards
    // the ready-made string; the stable value is computed once per account upstream.
    const uid = '{"device_id":"d0","account_uuid":"","session_id":"s0"}';
    const withId = openaiToAnthropicRequest(
      { model: "m", messages: [{ role: "user", content: "hi" }] },
      { metadataUserId: uid },
    );
    expect(withId.metadata).toEqual({ user_id: uid });
    // Back-compat: no opts → no metadata key at all (older callers unaffected).
    const without = openaiToAnthropicRequest({
      model: "m",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(without.metadata).toBeUndefined();
  });

  it("folds the `developer` role into system (after spoof, in message order), never a user turn (issue #50)", () => {
    // `developer` is OpenAI's renamed system tier. On the native Anthropic
    // subscription path it must fold into the top-level system param (like
    // `system`), NOT fall through to a user turn — otherwise instruction
    // precedence shifts and hidden instructions leak into the conversation.
    // Matches LiteLLM's map_developer_role_to_system_role (developer == system,
    // original order) and Gemini's collectSystemText policy.
    const body = openaiToAnthropicRequest({
      model: "claude-opus-4-6",
      messages: [
        { role: "system", content: "Be terse." },
        { role: "developer", content: "Prefer metric units." },
        { role: "user", content: "weather in SF?" },
      ],
    });
    const sys = body.system as Array<{ text: string }>;
    expect(sys.map((b) => b.text)).toEqual([
      "You are Claude Code, Anthropic's official CLI for Claude.",
      "Be terse.",
      "Prefer metric units.",
    ]);
    // developer must NOT leak into the conversation as a user message.
    const msgs = body.messages as Array<{ role: string }>;
    expect(msgs).toHaveLength(1);
    expect(msgs[0]?.role).toBe("user");
    expect(JSON.stringify(body.messages)).not.toContain("Prefer metric units.");
  });
});

describe("anthropicToOpenAIResponse", () => {
  it("maps text + usage + stop_reason", () => {
    const out = anthropicToOpenAIResponse(
      {
        id: "msg_1",
        content: [{ type: "text", text: "hello world" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 10, output_tokens: 5 },
      },
      "claude-opus-4-6",
    ) as Record<string, unknown>;
    const choice = (out.choices as Array<Record<string, unknown>>)[0];
    expect((choice?.message as Record<string, unknown>).content).toBe("hello world");
    expect(choice?.finish_reason).toBe("stop");
    expect(out.usage).toEqual({ prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 });
  });

  it("maps tool_use -> tool_calls with finish_reason tool_calls", () => {
    const out = anthropicToOpenAIResponse(
      {
        id: "msg_2",
        content: [{ type: "tool_use", id: "t1", name: "get", input: { x: 1 } }],
        stop_reason: "tool_use",
        usage: { input_tokens: 1, output_tokens: 1 },
      },
      "m",
    ) as Record<string, unknown>;
    const choice = (out.choices as Array<Record<string, unknown>>)[0];
    const tc = (choice?.message as Record<string, unknown>).tool_calls as Array<
      Record<string, unknown>
    >;
    expect(tc[0]).toMatchObject({ id: "t1", type: "function" });
    expect((tc[0]?.function as Record<string, unknown>).arguments).toBe('{"x":1}');
    expect(choice?.finish_reason).toBe("tool_calls");
  });
});

function sseResponse(events: object[]): Response {
  const body = events
    .map((e) => `event: ${(e as { type: string }).type}\ndata: ${JSON.stringify(e)}\n\n`)
    .join("");
  return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } });
}

describe("translateAnthropicSSE", () => {
  it("maps message_start/content_block_delta/message_delta/message_stop to OpenAI chunks + [DONE]", async () => {
    const res = sseResponse([
      { type: "message_start", message: { id: "m" } },
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hel" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "lo" } },
      { type: "message_delta", delta: { stop_reason: "end_turn" } },
      { type: "message_stop" },
    ]);
    const chunks: string[] = [];
    for await (const c of translateAnthropicSSE(res, "m")) chunks.push(c);
    const joined = chunks.join("");
    expect(joined).toContain('"role":"assistant"');
    expect(joined).toContain('"content":"Hel"');
    expect(joined).toContain('"content":"lo"');
    expect(joined).toContain('"finish_reason":"stop"');
    expect(joined.trimEnd().endsWith("data: [DONE]")).toBe(true);
  });

  it("returns at message_stop without waiting on the idle guard (terminal event stops the read)", async () => {
    vi.useFakeTimers();
    try {
      const enc = new TextEncoder();
      const events = [
        'event: message_start\ndata: {"type":"message_start","message":{"id":"m"}}\n\n',
        'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}\n\n',
        'event: message_stop\ndata: {"type":"message_stop"}\n\n',
      ];
      // Enqueue the terminal event then DELIBERATELY hold the body open (no close):
      // the generator must return at message_stop, never issuing the idle-guarded read.
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          for (const e of events) controller.enqueue(enc.encode(e));
        },
      });
      const res = new Response(stream, { status: 200 });
      const chunks: string[] = [];
      const run = (async () => {
        for await (const c of translateAnthropicSSE(res, "m", 500)) chunks.push(c);
      })();
      // A regression (no early return) would pend on the next read; advancing past
      // the deadline would then reject. With the fix, run already resolved.
      await vi.advanceTimersByTimeAsync(500);
      await run;
      expect(chunks.join("").trimEnd().endsWith("data: [DONE]")).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("throws UpstreamError(timeout) and cancels when the stream stalls past idleMs", async () => {
    vi.useFakeTimers();
    try {
      let cancelled = false;
      // Emit one event, then hang (no close) so the next read pends.
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(
            new TextEncoder().encode(
              'event: message_start\ndata: {"type":"message_start","message":{"id":"m"}}\n\n',
            ),
          );
        },
        cancel() {
          cancelled = true;
        },
      });
      const res = new Response(stream, { status: 200 });
      const run = (async () => {
        for await (const _ of translateAnthropicSSE(res, "m", 500)) {
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

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("createAnthropicClient", () => {
  it("sends Bearer + Claude-Code identity headers + system spoof; 401-retries once", async () => {
    let calls = 0;
    const seenAuth: string[] = [];
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      calls += 1;
      const h = new Headers(init?.headers);
      seenAuth.push(h.get("Authorization") ?? "");
      expect(h.get("anthropic-beta")).toContain("oauth-2025-04-20");
      expect(h.get("user-agent")).toContain("claude-cli/");
      expect(h.get("x-app")).toBe("cli");
      const sys = (JSON.parse(String(init?.body)) as { system: Array<{ text: string }> }).system;
      expect(sys[0]?.text).toContain("You are Claude Code");
      if (calls === 1) return jsonResponse({ error: "expired" }, 401);
      return jsonResponse({
        id: "msg",
        content: [{ type: "text", text: "ok" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 1, output_tokens: 1 },
      });
    });
    let token = "AT1";
    const client = createAnthropicClient({
      config: {
        baseUrl: "https://api.anthropic.com",
        getAuthHeader: async () => `Bearer ${token}`,
        onUnauthorized: () => {
          token = "AT2";
        },
        currentSecrets: () => [token],
      },
      fetch: fetchMock as unknown as typeof fetch,
    });
    const resp = (await client.chatCompletion({
      model: "claude-x",
      messages: [{ role: "user", content: "hi" }],
    })) as Record<string, unknown>;
    expect(calls).toBe(2);
    expect(seenAuth).toEqual(["Bearer AT1", "Bearer AT2"]);
    expect(
      ((resp.choices as Array<Record<string, unknown>>)[0]?.message as Record<string, unknown>)
        .content,
    ).toBe("ok");
  });

  it("sends openclaw header parity + a STABLE metadata.user_id on every request (Device ID never rotates)", async () => {
    // Header parity with openclaw's OAuth recipe (accept + dangerous-direct-browser-access)
    // and the anti-ban requirement: the SAME device identity must ride on EVERY request —
    // never regenerated per call (the claude-relay-service session_id-rotation anti-pattern).
    const uid = '{"device_id":"D","account_uuid":"","session_id":"S"}';
    const seenMeta: unknown[] = [];
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const h = new Headers(init?.headers);
      expect(h.get("accept")).toBe("application/json");
      expect(h.get("anthropic-dangerous-direct-browser-access")).toBe("true");
      seenMeta.push((JSON.parse(String(init?.body)) as { metadata?: unknown }).metadata);
      return jsonResponse({
        id: "m",
        content: [{ type: "text", text: "ok" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 1, output_tokens: 1 },
      });
    });
    const client = createAnthropicClient({
      config: {
        baseUrl: "https://api.anthropic.com",
        getAuthHeader: async () => "Bearer T",
        metadataUserId: uid,
      },
      fetch: fetchMock as unknown as typeof fetch,
    });
    await client.chatCompletion({ model: "m", messages: [{ role: "user", content: "a" }] });
    await client.chatCompletion({ model: "m", messages: [{ role: "user", content: "b" }] });
    expect(seenMeta).toHaveLength(2);
    expect(seenMeta[0]).toEqual({ user_id: uid });
    expect(seenMeta[1]).toEqual(seenMeta[0]); // identical across requests → no rotation
  });

  it("throws UpstreamError on a persistent non-401 error", async () => {
    const client = createAnthropicClient({
      config: { baseUrl: "https://api.anthropic.com", apiKey: "sk-static" },
      fetch: (async () => jsonResponse({ error: "boom" }, 500)) as unknown as typeof fetch,
    });
    await expect(
      client.chatCompletion({ model: "m", messages: [{ role: "user", content: "x" }] }),
    ).rejects.toBeInstanceOf(UpstreamError);
  });

  it("requires exactly one of apiKey / getAuthHeader", () => {
    expect(() =>
      createAnthropicClient({
        config: { baseUrl: "https://x", apiKey: "k", getAuthHeader: async () => "Bearer y" },
      }),
    ).toThrow(/exactly one/);
  });
});
