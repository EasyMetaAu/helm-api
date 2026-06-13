import { describe, expect, it, vi } from "vitest";
import {
  anthropicToOpenAIResponse,
  createAnthropicClient,
  openaiToAnthropicRequest,
  readAnthropicSSERaw,
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
    // system[0] is the Claude-Code billing attribution block; the spoof + folded
    // client system follow it (real-CC layout).
    expect(sys[0]?.text).toMatch(/^x-anthropic-billing-header: cc_version=2\.1\.175\./);
    expect(sys[1]?.text).toBe("You are Claude Code, Anthropic's official CLI for Claude.");
    expect(sys[2]?.text).toBe("Be terse.");
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

  it("preserves multipart tool-result content blocks for native Anthropic", () => {
    const body = openaiToAnthropicRequest({
      model: "m",
      messages: [
        {
          role: "assistant",
          content: null,
          tool_calls: [
            { id: "t1", type: "function", function: { name: "inspect", arguments: "{}" } },
          ],
        },
        {
          role: "tool",
          tool_call_id: "t1",
          content: [
            { type: "text", text: "chart screenshot" },
            { type: "image", url: "data:image/png;base64,abc123", mediaType: "image/png" },
            { type: "document", data: "JVBERi0=", mediaType: "application/pdf", filename: "r.pdf" },
          ],
        },
      ],
    });

    const msgs = body.messages as Array<{ role: string; content: Array<Record<string, unknown>> }>;
    expect(msgs[1]?.content[0]).toEqual({
      type: "tool_result",
      tool_use_id: "t1",
      content: [
        { type: "text", text: "chart screenshot" },
        { type: "image", source: { type: "base64", media_type: "image/png", data: "abc123" } },
        {
          type: "document",
          source: { type: "base64", media_type: "application/pdf", data: "JVBERi0=" },
          title: "r.pdf",
        },
      ],
    });
  });

  it("preserves document filename for uploaded file and remote url sources", () => {
    const body = openaiToAnthropicRequest({
      model: "m",
      messages: [
        {
          role: "user",
          content: [
            { type: "document", fileId: "file_123", filename: "uploaded.pdf" },
            { type: "document", url: "https://example.com/report.pdf", filename: "remote.pdf" },
          ],
        },
      ],
    });

    const msgs = body.messages as Array<{ role: string; content: Array<Record<string, unknown>> }>;
    expect(msgs[0]?.content).toEqual([
      {
        type: "document",
        source: { type: "file", file_id: "file_123" },
        title: "uploaded.pdf",
      },
      {
        type: "document",
        source: { type: "url", url: "https://example.com/report.pdf" },
        title: "remote.pdf",
      },
    ]);
  });

  it("preserves assistant thinking history blocks for native Anthropic", () => {
    const body = openaiToAnthropicRequest({
      model: "m",
      messages: [
        {
          role: "assistant",
          content: "visible answer",
          thinking_blocks: [
            { type: "thinking", thinking: "private chain", signature: "sig-1" },
            { type: "redacted_thinking", data: "encrypted" },
          ],
        },
      ],
    });

    const msgs = body.messages as Array<{ role: string; content: Array<Record<string, unknown>> }>;
    expect(msgs[0]?.content).toEqual([
      { type: "thinking", thinking: "private chain", signature: "sig-1" },
      { type: "redacted_thinking", data: "encrypted" },
      { type: "text", text: "visible answer" },
    ]);
  });

  it("groups consecutive tool results into one immediate Anthropic user turn", () => {
    const body = openaiToAnthropicRequest({
      model: "m",
      messages: [
        {
          role: "assistant",
          content: null,
          tool_calls: [
            { id: "t1", type: "function", function: { name: "get", arguments: "{}" } },
            { id: "t2", type: "function", function: { name: "get", arguments: "{}" } },
          ],
        },
        { role: "tool", tool_call_id: "t1", content: "one" },
        { role: "tool", tool_call_id: "t2", content: "two" },
        { role: "user", content: "next question" },
      ],
    });

    const msgs = body.messages as Array<{ role: string; content: Array<Record<string, unknown>> }>;
    expect(msgs.map((m) => m.role)).toEqual(["assistant", "user"]);
    expect(msgs[1]?.content).toEqual([
      { type: "tool_result", tool_use_id: "t1", content: "one" },
      { type: "tool_result", tool_use_id: "t2", content: "two" },
      { type: "text", text: "next question" },
    ]);
  });

  it("keeps image parts when a tool-result continuation carries a fresh user correction", () => {
    const body = openaiToAnthropicRequest({
      model: "m",
      messages: [
        {
          role: "assistant",
          content: "I will inspect the chart.",
          tool_calls: [{ id: "t1", type: "function", function: { name: "Bash", arguments: "{}" } }],
        },
        { role: "tool", tool_call_id: "t1", content: "ok" },
        {
          role: "user",
          content: [
            { type: "text", text: "这些图表上的数字都应该格式化一下" },
            { type: "image", url: "data:image/png;base64,abc123", mediaType: "image/png" },
          ],
        },
      ],
    });

    const msgs = body.messages as Array<{ role: string; content: Array<Record<string, unknown>> }>;
    expect(msgs.map((m) => m.role)).toEqual(["assistant", "user"]);
    expect(msgs[1]?.content).toContainEqual({
      type: "tool_result",
      tool_use_id: "t1",
      content: "ok",
    });
    expect(msgs[1]?.content).toContainEqual({
      type: "image",
      source: { type: "base64", media_type: "image/png", data: "abc123" },
    });
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

  it("maps max_completion_tokens to Anthropic max_tokens (LiteLLM parity)", () => {
    const body = openaiToAnthropicRequest({
      model: "m",
      messages: [{ role: "user", content: "hi" }],
      max_completion_tokens: 321,
    });

    expect(body.max_tokens).toBe(321);
  });

  it("forwards Anthropic/LiteLLM-native controls: top_k, thinking, and tool_choice", () => {
    const body = openaiToAnthropicRequest({
      model: "m",
      messages: [{ role: "user", content: "hi" }],
      top_k: 20,
      thinking: { type: "enabled", budget_tokens: 1024 },
      tool_choice: { type: "function", function: { name: "get_weather" } },
      parallel_tool_calls: false,
    });

    expect(body.top_k).toBe(20);
    expect(body.thinking).toEqual({ type: "enabled", budget_tokens: 1024 });
    expect(body.tool_choice).toEqual({
      type: "tool",
      name: "get_weather",
      disable_parallel_tool_use: true,
    });
  });

  it("forwards Anthropic-native context, speed, output_config, mcp, and container controls", () => {
    const body = openaiToAnthropicRequest({
      model: "m",
      messages: [{ role: "user", content: "hi" }],
      context_management: { edits: [{ type: "clear_tool_uses_20250919" }] },
      speed: "fast",
      output_config: { effort: "medium" },
      mcp_servers: [{ type: "url", url: "https://mcp.example/sse", name: "docs" }],
      container: { id: "container_1" },
    });

    expect(body.context_management).toEqual({
      edits: [{ type: "clear_tool_uses_20250919" }],
    });
    expect(body.speed).toBe("fast");
    expect(body.output_config).toEqual({ effort: "medium" });
    expect(body.mcp_servers).toEqual([
      { type: "url", url: "https://mcp.example/sse", name: "docs" },
    ]);
    expect(body.container).toEqual({ id: "container_1" });
  });

  it("preserves top-level automatic cache_control when no explicit cache breakpoints exist", () => {
    const body = openaiToAnthropicRequest({
      model: "m",
      cache_control: { type: "ephemeral" },
      messages: [{ role: "user", content: "long context" }],
    });

    expect(body.cache_control).toEqual({ type: "ephemeral" });
  });

  it("drops top-level automatic cache_control when explicit block/tool cache controls exist", () => {
    const body = openaiToAnthropicRequest({
      model: "m",
      cache_control: { type: "ephemeral" },
      messages: [
        {
          role: "system",
          content: [{ type: "text", text: "long system", cache_control: { type: "ephemeral" } }],
        },
        {
          role: "user",
          content: [
            { type: "text", text: "long context", cache_control: { type: "ephemeral", ttl: "1h" } },
          ],
        },
      ],
      tools: [
        {
          type: "function",
          function: {
            name: "lookup",
            parameters: { type: "object" },
            cache_control: { type: "ephemeral" },
          },
        },
      ],
    });

    expect(body.cache_control).toBeUndefined();
    const system = body.system as Array<Record<string, unknown>>;
    // [0]=billing, [1]=spoof, [2]=client system block (carries the cache_control).
    expect(system[2]?.cache_control).toEqual({ type: "ephemeral" });
    const messages = body.messages as Array<{ content: Array<Record<string, unknown>> }>;
    expect(messages[0]?.content[0]?.cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
    const tools = body.tools as Array<Record<string, unknown>>;
    expect(tools[0]?.cache_control).toEqual({ type: "ephemeral" });
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
    expect(sys[0]?.text).toMatch(/^x-anthropic-billing-header:/);
    expect(sys.slice(1).map((b) => b.text)).toEqual([
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

// The OAuth subscription endpoint expects real Claude-Code traffic. Real CC injects
// an x-anthropic-billing-header block as system[0] whose cc_version suffix + cch are
// content-derived and recomputed every request — that per-turn churn is what guts
// prompt caching. helm reproduces the block (real 2.1.175 version, system[0] slot)
// but derives the hash from the STABLE system text, so it reads as a normal content
// hash to Anthropic yet stays byte-identical across a conversation's turns. (Pairs
// with the inbound strip of the CLIENT's own rotating header in protocol/anthropic.)
describe("openaiToAnthropicRequest — Claude-Code billing header (anti-ban + cacheable)", () => {
  const billingOf = (b: Record<string, unknown>): string =>
    (b.system as Array<{ text: string }>)[0]?.text ?? "";

  it("emits the billing block as system[0] with the real version, cli entrypoint, and a 5-hex cch", () => {
    const body = openaiToAnthropicRequest({
      model: "m",
      messages: [
        { role: "system", content: "house rules" },
        { role: "user", content: "hi" },
      ],
    });
    expect(billingOf(body)).toMatch(
      /^x-anthropic-billing-header: cc_version=2\.1\.175\.[0-9a-f]{3}; cc_entrypoint=cli; cch=[0-9a-f]{5};$/,
    );
    // No cache_control on the billing block (matches real CC — the breakpoints ride
    // the prompt blocks that follow, not the attribution line).
    expect((body.system as Array<Record<string, unknown>>)[0]?.cache_control).toBeUndefined();
  });

  it("stays byte-identical across turns of the same conversation (cache prefix holds)", () => {
    const turn = (last: string) =>
      billingOf(
        openaiToAnthropicRequest({
          model: "m",
          messages: [
            { role: "system", content: "stable system prompt" },
            { role: "user", content: last },
          ],
        }),
      );
    // Same system, different latest user message → identical billing header.
    expect(turn("first question")).toBe(turn("a much longer follow-up question"));
  });

  it("changes when the system text changes (genuine content derivation)", () => {
    const withSystem = (s: string) =>
      billingOf(
        openaiToAnthropicRequest({
          model: "m",
          messages: [
            { role: "system", content: s },
            { role: "user", content: "x" },
          ],
        }),
      );
    expect(withSystem("alpha")).not.toBe(withSystem("beta"));
  });

  it("re-emits the CLIENT's real version/entrypoint verbatim when the route captured it", () => {
    const body = openaiToAnthropicRequest({
      model: "m",
      messages: [
        { role: "system", content: "house rules" },
        { role: "user", content: "hi" },
      ],
      // The route stamps the inbound CLI's identity here (cch dropped).
      metadata: { client_billing_header: "cc_version=2.1.173.d11; cc_entrypoint=cli" },
    } as unknown as Parameters<typeof openaiToAnthropicRequest>[0]);
    // Real version 2.1.173.d11 passed through; only a stable 5-hex cch is appended.
    expect(billingOf(body)).toMatch(
      /^x-anthropic-billing-header: cc_version=2\.1\.173\.d11; cc_entrypoint=cli; cch=[0-9a-f]{5};$/,
    );
  });

  it("still stabilizes cch (cache) even with a passed-through client identity", () => {
    const turn = (last: string) =>
      billingOf(
        openaiToAnthropicRequest({
          model: "m",
          messages: [
            { role: "system", content: "stable system" },
            { role: "user", content: last },
          ],
          metadata: { client_billing_header: "cc_version=2.1.173.d11; cc_entrypoint=cli" },
        } as unknown as Parameters<typeof openaiToAnthropicRequest>[0]),
      );
    expect(turn("q1")).toBe(turn("a longer q2"));
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

  it("maps Anthropic cache read/write usage into OpenAI prompt token details", () => {
    const out = anthropicToOpenAIResponse(
      {
        id: "msg_cache",
        content: [{ type: "text", text: "cached" }],
        stop_reason: "end_turn",
        usage: {
          input_tokens: 100,
          cache_read_input_tokens: 40,
          cache_creation_input_tokens: 10,
          output_tokens: 5,
        },
      },
      "m",
    ) as Record<string, unknown>;

    expect(out.usage).toEqual({
      prompt_tokens: 150,
      completion_tokens: 5,
      total_tokens: 155,
      prompt_tokens_details: { cached_tokens: 40, cache_creation_tokens: 10 },
    });
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

  // order 14: an OpenAI client sends stream_options.include_usage (execute.ts forces
  // it). The Anthropic->OpenAI SSE translation must emit a terminal usage-bearing
  // chunk (choices:[] + usage) before [DONE], else the client (and budget settle) see
  // no token counts. Anthropic carries input/cache on message_start, output on message_delta.
  it("emits a terminal usage chunk (include_usage) before [DONE]", async () => {
    const res = sseResponse([
      {
        type: "message_start",
        message: {
          id: "m",
          usage: {
            input_tokens: 12,
            output_tokens: 1,
            cache_read_input_tokens: 3,
            cache_creation_input_tokens: 2,
          },
        },
      },
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hi" } },
      { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 7 } },
      { type: "message_stop" },
    ]);
    const chunks: string[] = [];
    for await (const c of translateAnthropicSSE(res, "m")) chunks.push(c);
    // The usage chunk is the last data frame before [DONE].
    const dataFrames = chunks
      .join("")
      .trimEnd()
      .split("\n\n")
      .filter((f) => f.startsWith("data:"));
    const doneIdx = dataFrames.findIndex((f) => f.includes("[DONE]"));
    const usageFrame = dataFrames[doneIdx - 1];
    expect(usageFrame).toBeDefined();
    const parsed = JSON.parse((usageFrame as string).slice(5).trim()) as {
      choices: unknown[];
      usage?: {
        prompt_tokens?: number;
        completion_tokens?: number;
        total_tokens?: number;
        prompt_tokens_details?: { cached_tokens?: number; cache_creation_tokens?: number };
      };
    };
    expect(parsed.choices).toEqual([]);
    expect(parsed.usage).toMatchObject({
      prompt_tokens: 17,
      completion_tokens: 7,
      total_tokens: 24,
      prompt_tokens_details: { cached_tokens: 3, cache_creation_tokens: 2 },
    });
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
      expect(sys[0]?.text).toMatch(/^x-anthropic-billing-header:/);
      expect(sys[1]?.text).toContain("You are Claude Code");
      expect(h.get("user-agent")).toBe("claude-cli/2.1.175 (external, cli)");
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

  it("derives the user-agent from the CLIENT's captured version so header + billing block agree", async () => {
    let seenUA = "";
    let seenBilling = "";
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      seenUA = new Headers(init?.headers).get("user-agent") ?? "";
      seenBilling =
        (JSON.parse(String(init?.body)) as { system: Array<{ text: string }> }).system[0]?.text ??
        "";
      return jsonResponse({
        id: "m",
        content: [{ type: "text", text: "ok" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 1, output_tokens: 1 },
      });
    });
    const client = createAnthropicClient({
      config: { baseUrl: "https://api.anthropic.com", apiKey: "k" },
      fetch: fetchMock as unknown as typeof fetch,
    });
    await client.chatCompletion({
      model: "claude-x",
      messages: [{ role: "user", content: "hi" }],
      metadata: { client_billing_header: "cc_version=2.1.173.d11; cc_entrypoint=cli" },
    } as unknown as Parameters<typeof client.chatCompletion>[0]);
    // user-agent uses the client's semver (no 3-hex suffix); billing block carries the
    // full version+suffix — both reflect 2.1.173, never the fallback 2.1.175.
    expect(seenUA).toBe("claude-cli/2.1.173 (external, cli)");
    expect(seenBilling).toMatch(/^x-anthropic-billing-header: cc_version=2\.1\.173\.d11;/);
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

  it("adds feature beta headers for Anthropic context_management and fast mode", async () => {
    let seen: Headers | null = null;
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      seen = new Headers(init?.headers);
      return jsonResponse({
        id: "m",
        content: [{ type: "text", text: "ok" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 1, output_tokens: 1 },
      });
    });
    const client = createAnthropicClient({
      config: { baseUrl: "https://api.anthropic.com", apiKey: "sk-static" },
      fetch: fetchMock as unknown as typeof fetch,
    });

    await client.chatCompletion({
      model: "m",
      messages: [{ role: "user", content: "hi" }],
      context_management: { edits: [{ type: "clear_tool_uses_20250919" }] },
      speed: "fast",
    });

    const beta = (seen as unknown as Headers).get("anthropic-beta") ?? "";
    expect(beta).toContain("context-management-2025-06-27");
    expect(beta).toContain("fast-mode-2026-02-01");
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

// Native protocol passthrough (issue #217, Phase 1): an Anthropic-native /v1/messages
// body routed to an Anthropic subscription backend skips BOTH translators — the body
// is forwarded VERBATIM (no openai->anthropic mangling, no system spoof injection) and
// the upstream JSON is returned VERBATIM (no anthropic->openai response translation).
// Reuses the same HTTP core (headers/withTimeout/401-retry/scrub/errorFromResponse).
describe("createAnthropicClient — nativePassthrough", () => {
  // The verbatim native Anthropic body a real Claude Code request would send. Note it
  // ALREADY carries its own system[0] billing block + spoof preamble; passthrough must
  // NOT re-derive or inject anything.
  function nativeBody(): Record<string, unknown> {
    return {
      model: "claude-opus-4-6",
      system: [
        { type: "text", text: "x-anthropic-billing-header: cc_version=2.1.173.d11; cch=abcde;" },
        { type: "text", text: "You are Claude Code, Anthropic's official CLI for Claude." },
        { type: "text", text: "house rules" },
      ],
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      max_tokens: 1024,
      context_management: { edits: [{ type: "clear_tool_uses_20250919" }] },
      speed: "fast",
    };
  }

  it("forwards the native body VERBATIM (no spoof injection, no openai->anthropic mangling)", async () => {
    const body = nativeBody();
    let sentBody: unknown;
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      sentBody = JSON.parse(String(init?.body));
      return jsonResponse({
        id: "msg_pt",
        type: "message",
        role: "assistant",
        content: [{ type: "text", text: "ok" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 1, output_tokens: 1 },
      });
    });
    const client = createAnthropicClient({
      config: { baseUrl: "https://api.anthropic.com", apiKey: "sk-static" },
      fetch: fetchMock as unknown as typeof fetch,
    });
    await client.nativePassthrough?.(body);
    // Byte-for-byte equal to the input — the body is the carrier, unmodified.
    expect(sentBody).toEqual(body);
  });

  it("returns the upstream native JSON VERBATIM (no anthropicToOpenAIResponse translation)", async () => {
    const upstream = {
      id: "msg_pt",
      type: "message",
      role: "assistant",
      content: [
        { type: "text", text: "native answer" },
        { type: "tool_use", id: "tu1", name: "Bash", input: { cmd: "ls" } },
      ],
      stop_reason: "tool_use",
      usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 3 },
    };
    const client = createAnthropicClient({
      config: { baseUrl: "https://api.anthropic.com", apiKey: "sk-static" },
      fetch: (async () => jsonResponse(upstream)) as unknown as typeof fetch,
    });
    const out = await client.nativePassthrough?.(nativeBody());
    // Native shape preserved — `content` blocks survive, no `choices` wrapping.
    expect(out).toEqual(upstream);
  });

  it("derives anthropic-version/beta/auth headers from the native body (system/context_management/speed)", async () => {
    let seen: Headers | null = null;
    let seenUrl = "";
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      seen = new Headers(init?.headers);
      seenUrl = url;
      return jsonResponse({
        id: "m",
        content: [{ type: "text", text: "ok" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 1, output_tokens: 1 },
      });
    });
    const client = createAnthropicClient({
      config: { baseUrl: "https://api.anthropic.com", getAuthHeader: async () => "Bearer ATX" },
      fetch: fetchMock as unknown as typeof fetch,
    });
    await client.nativePassthrough?.(nativeBody());
    const h = seen as unknown as Headers;
    expect(seenUrl).toBe("https://api.anthropic.com/v1/messages");
    expect(h.get("anthropic-version")).toBe("2023-06-01");
    expect(h.get("Authorization")).toBe("Bearer ATX");
    const beta = h.get("anthropic-beta") ?? "";
    // Betas derived from the native body's context_management + speed:fast.
    expect(beta).toContain("oauth-2025-04-20");
    expect(beta).toContain("context-management-2025-06-27");
    expect(beta).toContain("fast-mode-2026-02-01");
    // user-agent derived from the body's system[0] billing version (2.1.173).
    expect(h.get("user-agent")).toBe("claude-cli/2.1.173 (external, cli)");
  });

  it("throws UpstreamError with the real upstreamStatus + scrubbed body on a non-2xx", async () => {
    const client = createAnthropicClient({
      config: {
        baseUrl: "https://api.anthropic.com",
        getAuthHeader: async () => "Bearer SECRET-TOKEN",
        currentSecrets: () => ["SECRET-TOKEN"],
      },
      fetch: (async () =>
        jsonResponse(
          { error: { type: "rate_limit", token: "SECRET-TOKEN" } },
          429,
        )) as unknown as typeof fetch,
    });
    let caught: unknown;
    try {
      await client.nativePassthrough?.(nativeBody());
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(UpstreamError);
    const err = caught as UpstreamError;
    expect(err.upstreamStatus).toBe(429);
    // The redacted body must not leak the secret token.
    expect(JSON.stringify(err.providerRaw)).not.toContain("SECRET-TOKEN");
    expect(JSON.stringify(err.providerRaw)).toContain("[redacted]");
  });

  it("triggers onUnauthorized and replays once on a 401", async () => {
    let calls = 0;
    let token = "AT1";
    const seenAuth: string[] = [];
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      calls += 1;
      seenAuth.push(new Headers(init?.headers).get("Authorization") ?? "");
      if (calls === 1) return jsonResponse({ error: "expired" }, 401);
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
        getAuthHeader: async () => `Bearer ${token}`,
        onUnauthorized: () => {
          token = "AT2";
        },
      },
      fetch: fetchMock as unknown as typeof fetch,
    });
    const out = await client.nativePassthrough?.(nativeBody());
    expect(calls).toBe(2);
    expect(seenAuth).toEqual(["Bearer AT1", "Bearer AT2"]);
    expect((out as Record<string, unknown>).id).toBe("m");
  });
});

// readAnthropicSSERaw (issue #217, Phase 2): the BYTE-FAITHFUL passthrough reader.
// It yields the upstream Anthropic SSE body's decoded text VERBATIM — same reader
// pattern (getReader + TextDecoder + readChunkWithIdle idle guard + StreamStalledError
// → UpstreamError("timeout")) as translateAnthropicSSE, but with NO frame splitting and
// NO translation. The data JSON payload reaches the client untouched; this ELIMINATES
// the convertOpenAIStreamToAnthropic state machine (the #221/#222 bug source) instead
// of replacing it.
describe("readAnthropicSSERaw", () => {
  it("yields the upstream SSE chunks VERBATIM (no openai chunk shape, no translation)", async () => {
    // Two distinct upstream writes; each must surface unchanged (raw passthrough, not
    // re-framed per-event, not converted to chat.completion.chunk).
    const enc = new TextEncoder();
    const writes = [
      'event: message_start\ndata: {"type":"message_start","message":{"id":"m","usage":{"input_tokens":10}}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hi"}}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n',
    ];
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const w of writes) controller.enqueue(enc.encode(w));
        controller.close();
      },
    });
    const res = new Response(stream, { status: 200 });
    const chunks: string[] = [];
    for await (const c of readAnthropicSSERaw(res)) chunks.push(c);
    // Each decoded chunk equals the upstream write byte-for-byte (no per-event split).
    expect(chunks).toEqual(writes);
    const joined = chunks.join("");
    // Native Anthropic event names survive; nothing got converted to OpenAI shape.
    expect(joined).toContain("message_start");
    expect(joined).toContain("content_block_delta");
    expect(joined).toContain("message_stop");
    expect(joined).not.toContain("chat.completion.chunk");
    expect(joined).not.toContain("[DONE]");
  });

  it("returns immediately on an empty body", async () => {
    const res = new Response(null, { status: 200 });
    const chunks: string[] = [];
    for await (const c of readAnthropicSSERaw(res)) chunks.push(c);
    expect(chunks).toEqual([]);
  });

  it("throws UpstreamError(timeout) and cancels when the stream stalls past idleMs", async () => {
    vi.useFakeTimers();
    try {
      let cancelled = false;
      // Emit one chunk then hang (no close) so the next read pends past the deadline.
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
        for await (const _ of readAnthropicSSERaw(res, 500)) {
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

// nativePassthroughStream (issue #217, Phase 2): the streaming sibling of
// nativePassthrough. The native body (from a STREAMING client) ALREADY carries
// stream:true, so it is forwarded VERBATIM (no stream:true injection, no
// openaiToAnthropicRequest). The upstream SSE is byte-relayed via readAnthropicSSERaw.
describe("createAnthropicClient — nativePassthroughStream", () => {
  // A verbatim native Anthropic STREAMING body: it carries its own stream:true and
  // system[0] billing block — passthrough must NOT re-derive or inject anything.
  function nativeStreamBody(): Record<string, unknown> {
    return {
      model: "claude-opus-4-6",
      stream: true,
      system: [
        { type: "text", text: "x-anthropic-billing-header: cc_version=2.1.173.d11; cch=abcde;" },
        { type: "text", text: "You are Claude Code, Anthropic's official CLI for Claude." },
      ],
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      max_tokens: 1024,
      context_management: { edits: [{ type: "clear_tool_uses_20250919" }] },
      speed: "fast",
    };
  }

  function sseStreamResponse(writes: string[]): Response {
    const enc = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const w of writes) controller.enqueue(enc.encode(w));
        controller.close();
      },
    });
    return new Response(stream, { status: 200 });
  }

  it("forwards the native body VERBATIM and yields upstream SSE chunks unchanged", async () => {
    const body = nativeStreamBody();
    let sentBody: unknown;
    const writes = [
      'event: message_start\ndata: {"type":"message_start","message":{"id":"m"}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"yo"}}\n\n',
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    ];
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      sentBody = JSON.parse(String(init?.body));
      return sseStreamResponse(writes);
    });
    const client = createAnthropicClient({
      config: { baseUrl: "https://api.anthropic.com", apiKey: "sk-static" },
      fetch: fetchMock as unknown as typeof fetch,
    });
    const chunks: string[] = [];
    for await (const c of client.nativePassthroughStream?.(body) ?? []) chunks.push(c);
    // Body sent byte-for-byte equal to the input — stream:true was already present, NOT
    // injected; no openaiToAnthropicRequest spoof mangling.
    expect(sentBody).toEqual(body);
    // Each upstream chunk relayed verbatim (no translation, no [DONE]).
    expect(chunks).toEqual(writes);
    expect(chunks.join("")).not.toContain("chat.completion.chunk");
  });

  it("does NOT inject stream:true when the native body omits it (forwards verbatim)", async () => {
    // A native body WITHOUT stream:true is forwarded exactly as given — the method must
    // not mutate it (the streaming face is the caller's contract, not the client's).
    const body = nativeStreamBody();
    delete body.stream;
    let sentBody: Record<string, unknown> | undefined;
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      sentBody = JSON.parse(String(init?.body));
      return sseStreamResponse(['event: message_stop\ndata: {"type":"message_stop"}\n\n']);
    });
    const client = createAnthropicClient({
      config: { baseUrl: "https://api.anthropic.com", apiKey: "sk-static" },
      fetch: fetchMock as unknown as typeof fetch,
    });
    for await (const _ of client.nativePassthroughStream?.(body) ?? []) {
      // drain
    }
    expect(sentBody).toEqual(body);
    expect(Object.hasOwn(sentBody ?? {}, "stream")).toBe(false);
  });

  it("derives version/beta/auth headers from the native body and hits /v1/messages", async () => {
    let seen: Headers | null = null;
    let seenUrl = "";
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      seen = new Headers(init?.headers);
      seenUrl = url;
      return sseStreamResponse(['event: message_stop\ndata: {"type":"message_stop"}\n\n']);
    });
    const client = createAnthropicClient({
      config: { baseUrl: "https://api.anthropic.com", getAuthHeader: async () => "Bearer ATX" },
      fetch: fetchMock as unknown as typeof fetch,
    });
    for await (const _ of client.nativePassthroughStream?.(nativeStreamBody()) ?? []) {
      // drain
    }
    const h = seen as unknown as Headers;
    expect(seenUrl).toBe("https://api.anthropic.com/v1/messages");
    expect(h.get("anthropic-version")).toBe("2023-06-01");
    expect(h.get("Authorization")).toBe("Bearer ATX");
    const beta = h.get("anthropic-beta") ?? "";
    expect(beta).toContain("oauth-2025-04-20");
    expect(beta).toContain("context-management-2025-06-27");
    expect(beta).toContain("fast-mode-2026-02-01");
    expect(h.get("user-agent")).toBe("claude-cli/2.1.173 (external, cli)");
  });

  it("throws UpstreamError with the real upstreamStatus + scrubbed body before the first chunk on a non-2xx", async () => {
    const client = createAnthropicClient({
      config: {
        baseUrl: "https://api.anthropic.com",
        getAuthHeader: async () => "Bearer SECRET-TOKEN",
        currentSecrets: () => ["SECRET-TOKEN"],
      },
      fetch: (async () =>
        jsonResponse(
          { error: { type: "rate_limit", token: "SECRET-TOKEN" } },
          429,
        )) as unknown as typeof fetch,
    });
    let caught: unknown;
    try {
      for await (const _ of client.nativePassthroughStream?.(nativeStreamBody()) ?? []) {
        // should never yield
      }
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(UpstreamError);
    const err = caught as UpstreamError;
    expect(err.upstreamStatus).toBe(429);
    expect(JSON.stringify(err.providerRaw)).not.toContain("SECRET-TOKEN");
    expect(JSON.stringify(err.providerRaw)).toContain("[redacted]");
  });

  it("triggers onUnauthorized and replays once on a 401 before yielding", async () => {
    let calls = 0;
    let token = "AT1";
    const seenAuth: string[] = [];
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      calls += 1;
      seenAuth.push(new Headers(init?.headers).get("Authorization") ?? "");
      if (calls === 1) return jsonResponse({ error: "expired" }, 401);
      return sseStreamResponse([
        'event: message_start\ndata: {"type":"message_start","message":{"id":"m"}}\n\n',
        'event: message_stop\ndata: {"type":"message_stop"}\n\n',
      ]);
    });
    const client = createAnthropicClient({
      config: {
        baseUrl: "https://api.anthropic.com",
        getAuthHeader: async () => `Bearer ${token}`,
        onUnauthorized: () => {
          token = "AT2";
        },
      },
      fetch: fetchMock as unknown as typeof fetch,
    });
    const chunks: string[] = [];
    for await (const c of client.nativePassthroughStream?.(nativeStreamBody()) ?? []) {
      chunks.push(c);
    }
    expect(calls).toBe(2);
    expect(seenAuth).toEqual(["Bearer AT1", "Bearer AT2"]);
    expect(chunks.join("")).toContain("message_start");
  });
});
