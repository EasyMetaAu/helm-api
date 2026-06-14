import { describe, expect, it, vi } from "vitest";
import { UpstreamError } from "./openai.js";
import {
  aggregateResponsesStream,
  codexAccountIdFromToken,
  createCodexResponsesClient,
  createGenericOpenAIResponsesClient,
  openaiToResponsesRequest,
  readResponsesEvents,
  readResponsesSSERaw,
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

function rawSSEResponse(body: string): Response {
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

  it("returns '' when the payload segment is not valid JSON (decode/parse throws)", () => {
    // A 3-part token whose middle segment decodes to non-JSON bytes -> JSON.parse throws
    // -> the catch returns "" (lines 87-89).
    const garbage = Buffer.from("not-json-at-all").toString("base64url");
    expect(codexAccountIdFromToken(`hdr.${garbage}.sig`)).toBe("");
  });

  it("returns '' when the auth claim is present but chatgpt_account_id is not a string", () => {
    const payload = Buffer.from(
      JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: 42 } }),
    ).toString("base64url");
    expect(codexAccountIdFromToken(`hdr.${payload}.sig`)).toBe("");
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

  it("forwards reasoning_effort to the Codex body as reasoning.effort (incl. xhigh)", () => {
    // Load-bearing: the Codex subscription speaks Responses; without this map the
    // client's effort was silently dropped and the backend ran at its default.
    const withEffort = openaiToResponsesRequest({
      model: "gpt-5.5",
      messages: [{ role: "user", content: "Hi" }],
      reasoning_effort: "xhigh",
    });
    expect(withEffort.reasoning).toEqual({ effort: "xhigh" });
    // Absent -> no reasoning key (preserve the existing Codex contract).
    const without = openaiToResponsesRequest({
      model: "gpt-5.5",
      messages: [{ role: "user", content: "Hi" }],
    });
    expect(without.reasoning).toBeUndefined();
    expect(without.text).toEqual({ verbosity: "low" });
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

  it("preserves client prompt_cache_key and prompt_cache_retention over the session fallback", () => {
    const body = openaiToResponsesRequest(
      {
        model: "gpt-5.5",
        messages: [{ role: "user", content: "Hi" }],
        prompt_cache_key: "client-thread",
        prompt_cache_retention: "24h",
      },
      { sessionId: "sess-123" },
    );
    expect(body.prompt_cache_key).toBe("client-thread");
    expect(body.prompt_cache_retention).toBe("24h");
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

  it("normalizes Chat tool_choice to the Responses top-level-name shape", () => {
    const body = openaiToResponsesRequest({
      model: "gpt-5.5",
      messages: [{ role: "user", content: "weather?" }],
      tools: [
        { type: "function", function: { name: "get_weather", parameters: { type: "object" } } },
      ],
      tool_choice: { type: "function", function: { name: "get_weather" } },
    });

    expect(body.tool_choice).toEqual({ type: "function", name: "get_weather" });
  });

  it("defaults instructions when no system message is present", () => {
    const body = openaiToResponsesRequest({
      model: "m",
      messages: [{ role: "user", content: "x" }],
    });
    expect(body.instructions).toBe("You are a helpful assistant.");
  });

  it("maps multimodal user content (text + image_url) to Responses input_text / input_image parts", () => {
    // inputPartsFromContent array branch: text -> input_text, image_url -> input_image.
    const body = openaiToResponsesRequest({
      model: "gpt-5.5",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "describe" },
            { type: "image_url", image_url: { url: "https://img/x.png" } },
            // Unknown part shapes are dropped.
            { type: "audio", data: "..." },
          ],
        },
      ],
    });
    const input = body.input as Array<{ role: string; content: Array<Record<string, unknown>> }>;
    expect(input[0]?.content).toEqual([
      { type: "input_text", text: "describe" },
      { type: "input_image", image_url: "https://img/x.png" },
    ]);
  });

  it("joins assistant array content via plainText when building Responses input", () => {
    // plainText array branch (lines 126-133): assistant content as parts is flattened.
    const body = openaiToResponsesRequest({
      model: "gpt-5.5",
      messages: [
        {
          role: "assistant",
          content: [
            { type: "text", text: "part one " },
            { type: "text", text: "part two" },
            { foo: "ignored" },
          ],
        },
      ],
    });
    const input = body.input as Array<{ role?: string; content?: Array<Record<string, unknown>> }>;
    expect(input[0]?.content?.[0]).toEqual({ type: "output_text", text: "part one part two" });
  });

  it("joins multiple system messages into instructions and skips empty ones", () => {
    const body = openaiToResponsesRequest({
      model: "gpt-5.5",
      messages: [
        { role: "system", content: "Rule A." },
        { role: "system", content: "" },
        { role: "system", content: "Rule B." },
        { role: "user", content: "hi" },
      ],
    });
    expect(body.instructions).toBe("Rule A.\n\nRule B.");
  });

  it("serializes a non-string tool result (object) to JSON in function_call_output", () => {
    const body = openaiToResponsesRequest({
      model: "gpt-5.5",
      messages: [{ role: "tool", tool_call_id: "c1", content: { ok: true } }],
    });
    const input = body.input as Array<Record<string, unknown>>;
    expect(input[0]).toMatchObject({
      type: "function_call_output",
      call_id: "c1",
      output: '{"ok":true}',
    });
  });

  it("serializes non-string assistant tool_call arguments to JSON", () => {
    const body = openaiToResponsesRequest({
      model: "gpt-5.5",
      messages: [
        {
          role: "assistant",
          content: null,
          tool_calls: [
            { id: "c1", type: "function", function: { name: "run", arguments: { x: 1 } } },
          ],
        },
      ],
    });
    const input = body.input as Array<Record<string, unknown>>;
    expect(input[0]).toMatchObject({ type: "function_call", arguments: '{"x":1}' });
  });

  it("treats a non-string, non-array user content as empty input parts", () => {
    // inputPartsFromContent final return (lines 120-121): content that is neither a
    // string nor an array (here null) yields no parts.
    const body = openaiToResponsesRequest({
      model: "gpt-5.5",
      messages: [{ role: "user", content: null }],
    });
    const input = body.input as Array<{ role: string; content: unknown[] }>;
    expect(input[0]).toEqual({ type: "message", role: "user", content: [] });
  });

  it("passes a non-object tool_choice (a bare string) through unchanged", () => {
    // chatToolChoiceToResponses early-return for non-object input (lines 188-190).
    const body = openaiToResponsesRequest({
      model: "gpt-5.5",
      messages: [{ role: "user", content: "hi" }],
      tool_choice: "required",
    });
    expect(body.tool_choice).toBe("required");
  });

  it("leaves a tool_choice that already carries a top-level name untouched", () => {
    const body = openaiToResponsesRequest({
      model: "gpt-5.5",
      messages: [{ role: "user", content: "hi" }],
      tool_choice: { type: "function", name: "already" } as never,
    });
    expect(body.tool_choice).toEqual({ type: "function", name: "already" });
  });

  it("passes through an object tool_choice whose type is not 'function' unchanged", () => {
    // chatToolChoiceToResponses: a non-function object (e.g. {type:"allowed_tools"})
    // returns the original (line 192).
    const choice = { type: "allowed_tools", tools: ["a"] };
    const body = openaiToResponsesRequest({
      model: "gpt-5.5",
      messages: [{ role: "user", content: "hi" }],
      tool_choice: choice as never,
    });
    expect(body.tool_choice).toEqual(choice);
  });

  it("passes through a function tool_choice whose nested function is not an object", () => {
    // type:"function" with no usable name and a non-object `function` -> returned as-is
    // (line 194).
    const choice = { type: "function", function: "oops" };
    const body = openaiToResponsesRequest({
      model: "gpt-5.5",
      messages: [{ role: "user", content: "hi" }],
      tool_choice: choice as never,
    });
    expect(body.tool_choice).toEqual(choice);
  });

  it("emits an empty call_id for a tool result missing tool_call_id", () => {
    // The `m.tool_call_id ?? ""` fallback (line 154).
    const body = openaiToResponsesRequest({
      model: "gpt-5.5",
      messages: [{ role: "tool", content: "orphan result" }],
    });
    const input = body.input as Array<Record<string, unknown>>;
    expect(input[0]).toMatchObject({
      type: "function_call_output",
      call_id: "",
      output: "orphan result",
    });
  });

  it("omits an assistant text item when the assistant message has no textual content", () => {
    // plainText("") is empty -> no `message` item is pushed for the assistant, only the
    // function_call (covers the `if (text)` false arm at line 161).
    const body = openaiToResponsesRequest({
      model: "gpt-5.5",
      messages: [
        {
          role: "assistant",
          content: "",
          tool_calls: [{ id: "c1", type: "function", function: { name: "run", arguments: "{}" } }],
        },
      ],
    });
    const input = body.input as Array<Record<string, unknown>>;
    expect(input).toHaveLength(1);
    expect(input[0]).toMatchObject({ type: "function_call", name: "run" });
  });
});

describe("translateResponsesSSE", () => {
  it("parses CRLF, multi-line data, event fallback, and an unterminated tail event", async () => {
    const res = rawSSEResponse(
      [
        "event: response.output_text.delta\r\n",
        'data: {"delta":"Hel"}\r\n',
        "\r\n",
        'data: {"type":"response.completed",\r\n',
        'data: "response":{"status":"completed","usage":{"input_tokens":2,"output_tokens":1}}}',
      ].join(""),
    );
    const events: Array<Record<string, unknown>> = [];
    for await (const evt of readResponsesEvents(res)) events.push(evt);
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ type: "response.output_text.delta", delta: "Hel" });
    expect(events[1]).toMatchObject({
      type: "response.completed",
      response: { status: "completed", usage: { input_tokens: 2, output_tokens: 1 } },
    });
  });

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

  it("maps Responses reasoning deltas to OpenAI reasoning_content chunks", async () => {
    const res = sseResponse([
      { type: "response.reasoning_summary_text.delta", delta: "plan " },
      { type: "response.reasoning_text.delta", delta: "more" },
      { type: "response.output_text.delta", delta: "Answer" },
      { type: "response.completed", response: { status: "completed", usage: {} } },
    ]);
    const chunks: string[] = [];
    for await (const c of translateResponsesSSE(res, "gpt-5.5")) chunks.push(c);
    const joined = chunks.join("");
    expect(joined).toContain('"reasoning_content":"plan "');
    expect(joined).toContain('"reasoning_content":"more"');
    expect(joined).toContain('"content":"Answer"');
  });

  // order 14: include_usage — a terminal usage chunk (choices:[] + usage) must
  // precede [DONE] so an OpenAI client and the budget settle get token counts. The
  // Responses API reports usage as input_tokens/output_tokens on response.completed.
  it("emits a terminal usage chunk (include_usage) before [DONE]", async () => {
    const res = sseResponse([
      { type: "response.created", response: { id: "resp_1" } },
      { type: "response.output_text.delta", delta: "Hi" },
      {
        type: "response.completed",
        response: {
          status: "completed",
          usage: {
            input_tokens: 9,
            output_tokens: 4,
            input_tokens_details: { cached_tokens: 3, cache_creation_input_tokens: 2 },
          },
        },
      },
    ]);
    const chunks: string[] = [];
    for await (const c of translateResponsesSSE(res, "gpt-5.5")) chunks.push(c);
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
      prompt_tokens: 9,
      completion_tokens: 4,
      total_tokens: 13,
      prompt_tokens_details: { cached_tokens: 3, cache_creation_tokens: 2 },
    });
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

  it("throws UpstreamError on response.failed using the nested response.error.message", async () => {
    // response.failed without a top-level message -> pull response.error.message
    // (lines 684-693). Distinct from a plain `error` event.
    const res = sseResponse([
      { type: "response.created", response: { id: "r" } },
      { type: "response.failed", response: { error: { message: "model exploded" } } },
    ]);
    let caught: unknown;
    try {
      for await (const _ of translateResponsesSSE(res, "m")) {
        // drain
      }
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(UpstreamError);
    expect((caught as UpstreamError).message).toBe("model exploded");
  });

  it("falls back to a generic message when response.failed carries no error message", async () => {
    const res = sseResponse([{ type: "response.failed", response: {} }]);
    let caught: unknown;
    try {
      for await (const _ of translateResponsesSSE(res, "m")) {
        // drain
      }
    } catch (e) {
      caught = e;
    }
    expect((caught as UpstreamError).message).toBe("codex responses stream error");
  });

  it("closes cleanly with finish + [DONE] when the stream ends without response.completed (EOF path)", async () => {
    // No response.completed/incomplete: after the events drain, the `if (started)` tail
    // emits a finish chunk + [DONE] (lines 696-700).
    const res = sseResponse([
      { type: "response.output_item.added", item: { type: "message", role: "assistant" } },
      { type: "response.output_text.delta", delta: "partial" },
    ]);
    const chunks: string[] = [];
    for await (const c of translateResponsesSSE(res, "gpt-5.5")) chunks.push(c);
    const joined = chunks.join("");
    expect(joined).toContain('"content":"partial"');
    expect(joined).toContain('"finish_reason":"stop"');
    expect(joined.trimEnd().endsWith("data: [DONE]")).toBe(true);
  });

  it("does not emit any chunk when the stream is empty (started stays false)", async () => {
    const res = sseResponse([]);
    const chunks: string[] = [];
    for await (const c of translateResponsesSSE(res, "m")) chunks.push(c);
    expect(chunks).toEqual([]);
  });

  it("includes reasoning_tokens in the terminal usage chunk when reported by the backend", async () => {
    // openaiUsageChunk reads output_tokens_details.reasoning_tokens (lines 595-597, 616-618).
    const res = sseResponse([
      { type: "response.output_text.delta", delta: "Hi" },
      {
        type: "response.completed",
        response: {
          status: "completed",
          usage: {
            input_tokens: 8,
            output_tokens: 20,
            output_tokens_details: { reasoning_tokens: 12 },
          },
        },
      },
    ]);
    const chunks: string[] = [];
    for await (const c of translateResponsesSSE(res, "gpt-5.5")) chunks.push(c);
    const dataFrames = chunks
      .join("")
      .trimEnd()
      .split("\n\n")
      .filter((fr) => fr.startsWith("data:"));
    const doneIdx = dataFrames.findIndex((fr) => fr.includes("[DONE]"));
    const usageFrame = dataFrames[doneIdx - 1] as string;
    expect(JSON.parse(usageFrame.slice(5).trim())).toMatchObject({
      usage: { completion_tokens_details: { reasoning_tokens: 12 } },
    });
  });

  it("re-throws a non-stall reader error unchanged (translateResponsesSSE)", async () => {
    const boom = new Error("stream broke");
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(boom);
      },
    });
    const res = new Response(stream, { status: 200 });
    await expect(async () => {
      for await (const _ of translateResponsesSSE(res, "m")) {
        // drain
      }
    }).rejects.toBe(boom);
  });

  // Codex P1: response.incomplete is terminal too (truncation/content filter). It must
  // finalize with finish_reason=length + a usage frame + [DONE], not fall to the EOF path.
  it("treats response.incomplete as terminal (finish=length + usage + [DONE])", async () => {
    const res = sseResponse([
      { type: "response.created", response: { id: "r" } },
      { type: "response.output_text.delta", delta: "partial" },
      {
        type: "response.incomplete",
        response: { status: "incomplete", usage: { input_tokens: 9, output_tokens: 4 } },
      },
    ]);
    const chunks: string[] = [];
    for await (const c of translateResponsesSSE(res, "gpt-5.5")) chunks.push(c);
    const joined = chunks.join("");
    expect(joined).toContain('"finish_reason":"length"');
    const dataFrames = joined
      .trimEnd()
      .split("\n\n")
      .filter((f) => f.startsWith("data:"));
    const doneIdx = dataFrames.findIndex((f) => f.includes("[DONE]"));
    const usageFrame = dataFrames[doneIdx - 1] as string;
    expect(JSON.parse(usageFrame.slice(5).trim())).toMatchObject({
      usage: { prompt_tokens: 9, completion_tokens: 4 },
    });
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

  // Codex P1: the aggregator must also break on response.incomplete (truncation) and
  // map it to finish_reason=length with the captured usage.
  it("breaks on response.incomplete and maps finish_reason=length", async () => {
    const res = sseResponse([
      { type: "response.created", response: { id: "resp_i" } },
      { type: "response.output_text.delta", delta: "partial" },
      {
        type: "response.incomplete",
        response: { status: "incomplete", usage: { input_tokens: 5, output_tokens: 2 } },
      },
    ]);
    const out = await aggregateResponsesStream(res, "m");
    expect((out.choices as Array<{ finish_reason: string }>)[0]?.finish_reason).toBe("length");
    expect(out.usage).toMatchObject({ prompt_tokens: 5, completion_tokens: 2 });
  });

  it("folds text + usage into a single chat response (Codex is stream-only)", async () => {
    const res = sseResponse([
      { type: "response.created", response: { id: "resp_7" } },
      { type: "response.output_item.added", item: { type: "message", role: "assistant" } },
      { type: "response.output_text.delta", delta: "Hi " },
      { type: "response.output_text.delta", delta: "there" },
      {
        type: "response.completed",
        response: {
          status: "completed",
          usage: {
            input_tokens: 5,
            output_tokens: 2,
            input_tokens_details: { cached_tokens: 1, cache_creation_input_tokens: 1 },
          },
        },
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
    expect(out.usage).toMatchObject({
      prompt_tokens: 5,
      completion_tokens: 2,
      total_tokens: 7,
      prompt_tokens_details: { cached_tokens: 1, cache_creation_tokens: 1 },
    });
  });

  it("folds Responses reasoning deltas onto message.reasoning_content", async () => {
    const res = sseResponse([
      { type: "response.reasoning_summary_text.delta", delta: "think " },
      { type: "response.reasoning_text.delta", delta: "hard" },
      { type: "response.output_text.delta", delta: "done" },
      { type: "response.completed", response: { status: "completed", usage: {} } },
    ]);
    const out = await aggregateResponsesStream(res, "m");
    const msg = (out.choices as Array<Record<string, unknown>>)[0]?.message as Record<
      string,
      unknown
    >;
    expect(msg.content).toBe("done");
    expect(msg.reasoning_content).toBe("think hard");
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

  it("defaults a tool_call's arguments to '{}' when none were streamed", async () => {
    // toolOrder map: a function_call that never received argument deltas serializes to
    // "{}" (the `tc.arguments || "{}"` fallback).
    const res = sseResponse([
      {
        type: "response.output_item.added",
        item: { type: "function_call", call_id: "c0", name: "noargs" },
      },
      { type: "response.completed", response: { status: "completed" } },
    ]);
    const out = await aggregateResponsesStream(res, "m");
    const msg = (out.choices as Array<Record<string, unknown>>)[0]?.message as Record<
      string,
      unknown
    >;
    const calls = msg.tool_calls as Array<Record<string, unknown>>;
    expect((calls[0]?.function as Record<string, unknown>).arguments).toBe("{}");
  });

  it("throws UpstreamError on an error event mid-aggregation (with the event message)", async () => {
    const res = sseResponse([
      { type: "response.created", response: { id: "r" } },
      { type: "error", message: "aggregation boom" },
    ]);
    let caught: unknown;
    try {
      await aggregateResponsesStream(res, "m");
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(UpstreamError);
    expect((caught as UpstreamError).message).toBe("aggregation boom");
  });

  it("throws UpstreamError on response.failed using the nested error message (aggregation)", async () => {
    const res = sseResponse([
      { type: "response.failed", response: { error: { message: "nested failure" } } },
    ]);
    await expect(aggregateResponsesStream(res, "m")).rejects.toMatchObject({
      message: "nested failure",
    });
  });

  it("re-throws a non-stall reader error unchanged (aggregateResponsesStream)", async () => {
    const boom = new Error("stream broke");
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(boom);
      },
    });
    const res = new Response(stream, { status: 200 });
    await expect(aggregateResponsesStream(res, "m")).rejects.toBe(boom);
  });
});

// readResponsesEvents (the shared low-level SSE event reader): exercises the EOF
// trailing-buffer flush, empty-body short-circuit, and the non-stall reader-error
// re-throw arm directly (the translator + aggregator both consume it).
describe("readResponsesEvents", () => {
  it("flushes a final event held in the buffer when the stream ends without a trailing blank line", async () => {
    // A last frame with NO terminating \n\n stays in `buffer` until EOF; the done-branch
    // decodes + parses it (lines 512-518).
    const enc = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          enc.encode('data: {"type":"response.created","response":{"id":"r"}}\n\n'),
        );
        // No trailing blank line on this final frame.
        controller.enqueue(
          enc.encode('data: {"type":"response.output_text.delta","delta":"tail"}'),
        );
        controller.close();
      },
    });
    const res = new Response(stream, { status: 200 });
    const events: Array<Record<string, unknown>> = [];
    for await (const evt of readResponsesEvents(res)) events.push(evt);
    expect(events).toHaveLength(2);
    expect(events[1]).toMatchObject({ type: "response.output_text.delta", delta: "tail" });
  });

  it("returns immediately on an empty body", async () => {
    const res = new Response(null, { status: 200 });
    const events: Array<Record<string, unknown>> = [];
    for await (const evt of readResponsesEvents(res)) events.push(evt);
    expect(events).toEqual([]);
  });

  it("skips frames whose data is valid JSON but not an object, and frames with malformed JSON", async () => {
    // A `data:` array (line 473 filter -> null) and a `data:` with broken JSON (the
    // JSON.parse catch -> null, lines 477-479) are both dropped; the real event survives.
    const res = rawSSEResponse(
      [
        "data: [1,2,3]\n\n", // valid JSON, not an object -> skipped
        "data: {broken json\n\n", // unparseable -> catch -> skipped
        'data: {"type":"response.created","response":{"id":"r"}}\n\n',
      ].join(""),
    );
    const events: Array<Record<string, unknown>> = [];
    for await (const evt of readResponsesEvents(res)) events.push(evt);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "response.created" });
  });

  it("ignores a trailing-buffer that is only whitespace at EOF", async () => {
    const enc = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(enc.encode('data: {"type":"response.created","response":{}}\n\n   '));
        controller.close();
      },
    });
    const res = new Response(stream, { status: 200 });
    const events: Array<Record<string, unknown>> = [];
    for await (const evt of readResponsesEvents(res)) events.push(evt);
    expect(events).toHaveLength(1);
  });

  it("re-throws a non-stall reader error unchanged", async () => {
    const boom = new Error("stream broke");
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(boom);
      },
    });
    const res = new Response(stream, { status: 200 });
    await expect(async () => {
      for await (const _ of readResponsesEvents(res)) {
        // drain
      }
    }).rejects.toBe(boom);
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

  it("uses the baseUrl verbatim when it already ends in /responses (no double suffix)", async () => {
    let seenUrl = "";
    const fetchMock = vi.fn(async (url: string) => {
      seenUrl = url;
      return sseResponse([
        { type: "response.output_text.delta", delta: "ok" },
        { type: "response.completed", response: { status: "completed", usage: {} } },
      ]);
    });
    const client = createCodexResponsesClient({
      config: {
        baseUrl: "https://chatgpt.com/backend-api/codex/responses",
        getAuthHeader: async () => `Bearer ${jwt("acct")}`,
      },
      fetch: fetchMock as unknown as typeof fetch,
    });
    await client.chatCompletion({ model: "gpt-5.5", messages: [{ role: "user", content: "hi" }] });
    expect(seenUrl).toBe("https://chatgpt.com/backend-api/codex/responses");
  });

  it("maps a connect/TTFB timeout (internal abort, no external signal) to UpstreamError(timeout)", async () => {
    vi.useFakeTimers();
    try {
      const fetchMock = vi.fn((_url: string, init?: RequestInit) => {
        const signal = init?.signal;
        return new Promise<Response>((_resolve, reject) => {
          if (signal?.aborted) {
            reject(new Error("aborted"));
            return;
          }
          signal?.addEventListener("abort", () => reject(new Error("aborted")));
        });
      });
      const client = createCodexResponsesClient({
        config: {
          baseUrl: "https://chatgpt.com/backend-api/codex",
          getAuthHeader: async () => `Bearer ${jwt("acct")}`,
          timeoutMs: 50,
        },
        fetch: fetchMock as unknown as typeof fetch,
      });
      const run = client.chatCompletion({ model: "m", messages: [{ role: "user", content: "x" }] });
      const assertion = expect(run).rejects.toMatchObject({ errorClass: "timeout" });
      await vi.advanceTimersByTimeAsync(50);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it("does NOT convert an external client abort into a timeout (client disconnect is not a provider failure)", async () => {
    const ext = new AbortController();
    const fetchMock = vi.fn((_url: string, init?: RequestInit) => {
      const signal = init?.signal;
      return new Promise<Response>((_resolve, reject) => {
        if (signal?.aborted) {
          reject(new Error("aborted"));
          return;
        }
        signal?.addEventListener("abort", () => reject(new Error("aborted")));
      });
    });
    const client = createCodexResponsesClient({
      config: {
        baseUrl: "https://chatgpt.com/backend-api/codex",
        getAuthHeader: async () => `Bearer ${jwt("acct")}`,
        timeoutMs: 600_000,
      },
      fetch: fetchMock as unknown as typeof fetch,
    });
    const run = client.chatCompletion(
      { model: "m", messages: [{ role: "user", content: "x" }] },
      { signal: ext.signal },
    );
    ext.abort();
    const caught = await run.catch((e: unknown) => e);
    expect(caught).toBeInstanceOf(Error);
    expect(caught).not.toBeInstanceOf(UpstreamError);
  });

  it("re-throws a real network error (not a timeout) unchanged", async () => {
    const boom = new Error("ECONNREFUSED");
    const client = createCodexResponsesClient({
      config: {
        baseUrl: "https://chatgpt.com/backend-api/codex",
        getAuthHeader: async () => `Bearer ${jwt("acct")}`,
      },
      fetch: (async () => {
        throw boom;
      }) as unknown as typeof fetch,
    });
    await expect(
      client.chatCompletion({ model: "m", messages: [{ role: "user", content: "x" }] }),
    ).rejects.toBe(boom);
  });

  it("preserves a non-JSON upstream error body as raw text in the UpstreamError", async () => {
    // errorFromResponse: res.text() is not JSON -> the raw string is kept (lines 388-390).
    const client = createCodexResponsesClient({
      config: {
        baseUrl: "https://chatgpt.com/backend-api/codex",
        getAuthHeader: async () => `Bearer ${jwt("acct")}`,
      },
      fetch: (async () =>
        new Response("Service Unavailable (plain text)", {
          status: 503,
        })) as unknown as typeof fetch,
    });
    let caught: unknown;
    try {
      await client.chatCompletion({ model: "m", messages: [{ role: "user", content: "x" }] });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(UpstreamError);
    const err = caught as UpstreamError;
    expect(err.upstreamStatus).toBe(503);
    expect(err.providerRaw).toBe("Service Unavailable (plain text)");
  });

  it("swallows a throwing onResponseMeta hook (quota observability never breaks the request)", async () => {
    // fireResponseMeta wraps the hook in try/catch (lines 360-363): a throw is swallowed
    // and the streamed body is unaffected.
    const fetchMock = vi.fn(async () =>
      sseResponse([
        { type: "response.output_text.delta", delta: "ok" },
        { type: "response.completed", response: { status: "completed", usage: {} } },
      ]),
    );
    const client = createCodexResponsesClient({
      config: {
        baseUrl: "https://chatgpt.com/backend-api/codex",
        getAuthHeader: async () => `Bearer ${jwt("acct")}`,
        onResponseMeta: () => {
          throw new Error("hook blew up");
        },
      },
      fetch: fetchMock as unknown as typeof fetch,
    });
    const out = (await client.chatCompletion({
      model: "gpt-5.5",
      messages: [{ role: "user", content: "hi" }],
    })) as Record<string, unknown>;
    expect(
      ((out.choices as Array<Record<string, unknown>>)[0]?.message as Record<string, unknown>)
        .content,
    ).toBe("ok");
  });
});

// readResponsesSSERaw (issue #217, Phase 3): the BYTE-FAITHFUL Responses passthrough
// reader. It yields the upstream Responses SSE body's decoded text VERBATIM — same
// reader pattern (getReader + TextDecoder + readChunkWithIdle idle guard +
// StreamStalledError → UpstreamError("timeout")) as readResponsesEvents, but with NO
// frame splitting and NO translation. The `data:` JSON payload (reasoning.encrypted_content
// included) reaches the client untouched; this ELIMINATES the responses→IR→responses
// round trip (the reasoning/tool mangling source) instead of replacing it.
describe("readResponsesSSERaw", () => {
  it("yields the upstream SSE chunks VERBATIM (no openai chunk shape, no translation)", async () => {
    // Two distinct upstream writes; each must surface unchanged (raw passthrough, not
    // re-framed per-event, not converted to chat.completion.chunk).
    const enc = new TextEncoder();
    const writes = [
      'event: response.created\ndata: {"type":"response.created","response":{"id":"resp_1"}}\n\n',
      'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"Hi"}\n\nevent: response.completed\ndata: {"type":"response.completed","response":{"status":"completed","usage":{}}}\n\n',
    ];
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const w of writes) controller.enqueue(enc.encode(w));
        controller.close();
      },
    });
    const res = new Response(stream, { status: 200 });
    const chunks: string[] = [];
    for await (const c of readResponsesSSERaw(res)) chunks.push(c);
    // Each decoded chunk equals the upstream write byte-for-byte (no per-event split).
    expect(chunks).toEqual(writes);
    const joined = chunks.join("");
    // Native Responses event names survive; nothing got converted to OpenAI-Chat shape.
    expect(joined).toContain("response.created");
    expect(joined).toContain("response.output_text.delta");
    expect(joined).toContain("response.completed");
    expect(joined).not.toContain("chat.completion.chunk");
  });

  it("returns immediately on an empty body", async () => {
    const res = new Response(null, { status: 200 });
    const chunks: string[] = [];
    for await (const c of readResponsesSSERaw(res)) chunks.push(c);
    expect(chunks).toEqual([]);
  });

  it("re-throws a non-stall reader error unchanged", async () => {
    const boom = new Error("stream broke");
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(boom);
      },
    });
    const res = new Response(stream, { status: 200 });
    await expect(async () => {
      for await (const _ of readResponsesSSERaw(res)) {
        // drain
      }
    }).rejects.toBe(boom);
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
              'event: response.created\ndata: {"type":"response.created","response":{}}\n\n',
            ),
          );
        },
        cancel() {
          cancelled = true;
        },
      });
      const res = new Response(stream, { status: 200 });
      const run = (async () => {
        for await (const _ of readResponsesSSERaw(res, 500)) {
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

// nativePassthrough / nativePassthroughStream (issue #217, Phase 3): same-protocol
// Codex Responses passthrough. The inbound /v1/responses body is ALREADY a native
// Responses body (the real Codex CLI supplies store:false + stream:true + include +
// reasoning + tools …), so it is forwarded VERBATIM (NO openaiToResponsesRequest) and
// the upstream's native Responses SSE / JSON is relayed untranslated. The ChatGPT
// identity headers (Bearer + chatgpt-account-id + originator + OpenAI-Beta) still ride
// via the shared HTTP core, applied automatically to both methods.
describe("createCodexResponsesClient — nativePassthroughStream", () => {
  // A verbatim native Codex Responses STREAMING body, as the real Codex CLI sends it.
  // It carries store:false + stream:true + include + reasoning + tools — passthrough
  // must NOT re-derive, strip, or inject anything (no openaiToResponsesRequest).
  function nativeStreamBody(): Record<string, unknown> {
    return {
      model: "gpt-5.5",
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }],
      instructions: "You are Codex.",
      include: ["reasoning.encrypted_content"],
      reasoning: { effort: "high" },
      store: false,
      stream: true,
      tools: [{ type: "function", name: "run", parameters: { type: "object" } }],
      tool_choice: "auto",
      parallel_tool_calls: true,
      text: { verbosity: "low" },
      prompt_cache_key: "codex-sess-1",
    };
  }

  function sseStreamResponse(writes: string[], extraHeaders?: Record<string, string>): Response {
    const enc = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const w of writes) controller.enqueue(enc.encode(w));
        controller.close();
      },
    });
    return new Response(stream, {
      status: 200,
      headers: { "Content-Type": "text/event-stream", ...extraHeaders },
    });
  }

  it("forwards the native body VERBATIM and yields upstream Responses SSE unchanged", async () => {
    const body = nativeStreamBody();
    let sentBody: unknown;
    const writes = [
      'event: response.created\ndata: {"type":"response.created","response":{"id":"resp_1"}}\n\n',
      'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"yo"}\n\n',
      'event: response.completed\ndata: {"type":"response.completed","response":{"status":"completed","usage":{}}}\n\n',
    ];
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      sentBody = JSON.parse(String(init?.body));
      return sseStreamResponse(writes);
    });
    const client = createCodexResponsesClient({
      config: {
        baseUrl: "https://chatgpt.com/backend-api/codex",
        getAuthHeader: async () => `Bearer ${jwt("acct")}`,
      },
      fetch: fetchMock as unknown as typeof fetch,
    });
    const chunks: string[] = [];
    for await (const c of client.nativePassthroughStream?.(body) ?? []) chunks.push(c);
    // Body sent byte-for-byte equal to the input — no openaiToResponsesRequest mangling,
    // no store/stream/include injection (the native body already carries them).
    expect(sentBody).toEqual(body);
    // Each upstream chunk relayed verbatim (native Responses event names, no chat shape).
    expect(chunks).toEqual(writes);
    const joined = chunks.join("");
    expect(joined).toContain("response.created");
    expect(joined).not.toContain("chat.completion.chunk");
  });

  it("does NOT call openaiToResponsesRequest (the verbatim body has no instructions rewrite)", async () => {
    // openaiToResponsesRequest would REPLACE instructions/build input from `messages`;
    // passthrough must leave the client's own `instructions` + `input` untouched.
    const body = nativeStreamBody();
    body.instructions = "VERBATIM-INSTRUCTIONS-SENTINEL";
    let sentBody: Record<string, unknown> | undefined;
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      sentBody = JSON.parse(String(init?.body));
      return sseStreamResponse([
        'event: response.completed\ndata: {"type":"response.completed","response":{"status":"completed","usage":{}}}\n\n',
      ]);
    });
    const client = createCodexResponsesClient({
      config: {
        baseUrl: "https://chatgpt.com/backend-api/codex",
        getAuthHeader: async () => `Bearer ${jwt("acct")}`,
      },
      fetch: fetchMock as unknown as typeof fetch,
    });
    for await (const _ of client.nativePassthroughStream?.(body) ?? []) {
      // drain
    }
    expect(sentBody).toEqual(body);
    expect(sentBody?.instructions).toBe("VERBATIM-INSTRUCTIONS-SENTINEL");
  });

  it("applies the ChatGPT identity headers (Bearer + account-id + originator + beta) via the HTTP core", async () => {
    let seen: Headers | null = null;
    let seenUrl = "";
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      seen = new Headers(init?.headers);
      seenUrl = url;
      return sseStreamResponse([
        'event: response.completed\ndata: {"type":"response.completed","response":{"status":"completed","usage":{}}}\n\n',
      ]);
    });
    const client = createCodexResponsesClient({
      config: {
        baseUrl: "https://chatgpt.com/backend-api/codex",
        getAuthHeader: async () => `Bearer ${jwt("acct_codex")}`,
        sessionId: "sess-z",
      },
      fetch: fetchMock as unknown as typeof fetch,
    });
    for await (const _ of client.nativePassthroughStream?.(nativeStreamBody()) ?? []) {
      // drain
    }
    const h = seen as unknown as Headers;
    expect(seenUrl).toBe("https://chatgpt.com/backend-api/codex/responses");
    expect(h.get("Authorization")).toContain("Bearer ");
    // account-id derived by the HTTP core from the access-token JWT claim.
    expect(h.get("chatgpt-account-id")).toBe("acct_codex");
    expect(h.get("originator")).toBe("helm");
    expect(h.get("OpenAI-Beta")).toBe("responses=experimental");
    expect(h.get("session_id")).toBe("sess-z");
  });

  it("preserves client headers/raw body through the native carrier while replacing auth", async () => {
    const body = nativeStreamBody();
    const rawBody = JSON.stringify(body, null, 2);
    let sentBody = "";
    let seen: Headers | null = null;
    const carrier = {
      protocol: "openai_responses" as const,
      body,
      raw_body: rawBody,
      headers: {
        authorization: "Bearer client-secret",
        "content-type": "application/json",
        accept: "application/json",
        "openai-beta": "client-beta=1",
        "user-agent": "codex-client/9.9.9",
        session_id: "client-session",
        "x-client-request-id": "client-request-id",
        "x-client-feature": "keep-me",
        "x-helm-trace": "internal",
        "content-length": "999",
      },
      mutations: {},
    };
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      sentBody = String(init?.body);
      seen = new Headers(init?.headers);
      return sseStreamResponse([
        'event: response.completed\ndata: {"type":"response.completed","response":{"status":"completed","usage":{}}}\n\n',
      ]);
    });
    const client = createCodexResponsesClient({
      config: {
        baseUrl: "https://chatgpt.com/backend-api/codex",
        getAuthHeader: async () => `Bearer ${jwt("acct_carrier")}`,
        sessionId: "sess-z",
      },
      fetch: fetchMock as unknown as typeof fetch,
    });

    for await (const _ of client.nativePassthroughStream?.(carrier) ?? []) {
      // drain
    }

    const h = seen as unknown as Headers;
    expect(sentBody).toBe(rawBody);
    expect(h.get("x-client-feature")).toBe("keep-me");
    expect(h.get("Authorization")).toContain("Bearer ");
    expect(h.get("Authorization")).not.toContain("client-secret");
    expect(h.get("chatgpt-account-id")).toBe("acct_carrier");
    expect(h.get("user-agent")).toBe("codex-client/9.9.9");
    expect(h.get("session_id")).toBe("client-session");
    expect(h.get("x-client-request-id")).toBe("client-request-id");
    expect(h.get("content-length")).toBeNull();
    expect(h.get("x-helm-trace")).toBeNull();
    expect(h.get("accept")).toBe("application/json");
    const beta = h.get("openai-beta") ?? "";
    expect(beta).toContain("client-beta=1");
    expect(beta).toContain("responses=experimental");
    expect(carrier.mutations).toMatchObject({
      auth_replaced: true,
      content_length_recomputed: true,
    });
    expect((carrier.mutations as Record<string, unknown>).headers_dropped).toEqual(
      expect.arrayContaining(["authorization", "content-length", "x-helm-trace"]),
    );
    expect((carrier.mutations as Record<string, unknown>).headers_overwritten).toEqual(
      expect.arrayContaining(["openai-beta"]),
    );
    expect((carrier.mutations as Record<string, unknown>).headers_overwritten).not.toEqual(
      expect.arrayContaining(["accept", "session_id", "x-client-request-id", "user-agent"]),
    );
  });

  it("throws UpstreamError with the real upstreamStatus + scrubbed body before the first chunk on a non-2xx", async () => {
    const token = jwt("acct_secret_value_1234");
    const client = createCodexResponsesClient({
      config: {
        baseUrl: "https://chatgpt.com/backend-api/codex",
        getAuthHeader: async () => `Bearer ${token}`,
        currentSecrets: () => [token],
      },
      fetch: (async () =>
        jsonResponse({ error: `rate_limit ${token}` }, 429)) as unknown as typeof fetch,
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
    expect(JSON.stringify(err.providerRaw)).not.toContain(token);
    expect(JSON.stringify(err.providerRaw)).toContain("[redacted]");
  });

  it("triggers onUnauthorized and replays once on a 401 before yielding", async () => {
    let calls = 0;
    let token = jwt("acct_a");
    const seenAuth: string[] = [];
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      calls += 1;
      seenAuth.push(new Headers(init?.headers).get("Authorization") ?? "");
      if (calls === 1) return jsonResponse({ error: "expired" }, 401);
      return sseStreamResponse([
        'event: response.created\ndata: {"type":"response.created","response":{"id":"m"}}\n\n',
        'event: response.completed\ndata: {"type":"response.completed","response":{"status":"completed","usage":{}}}\n\n',
      ]);
    });
    const client = createCodexResponsesClient({
      config: {
        baseUrl: "https://chatgpt.com/backend-api/codex",
        getAuthHeader: async () => `Bearer ${token}`,
        onUnauthorized: () => {
          token = jwt("acct_b");
        },
      },
      fetch: fetchMock as unknown as typeof fetch,
    });
    const chunks: string[] = [];
    for await (const c of client.nativePassthroughStream?.(nativeStreamBody()) ?? []) {
      chunks.push(c);
    }
    expect(calls).toBe(2);
    expect(seenAuth[0]).toContain("Bearer ");
    expect(chunks.join("")).toContain("response.created");
  });

  it("fires onResponseMeta exactly once with the upstream quota headers", async () => {
    const fetchMock = vi.fn(async () =>
      sseStreamResponse(
        [
          'event: response.completed\ndata: {"type":"response.completed","response":{"status":"completed","usage":{}}}\n\n',
        ],
        { "x-codex-primary-used-percent": "11" },
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
    for await (const _ of client.nativePassthroughStream?.(nativeStreamBody()) ?? []) {
      // drain
    }
    expect(seen).toHaveLength(1);
    expect(seen[0]?.get("x-codex-primary-used-percent")).toBe("11");
  });
});

// nativePassthrough (non-stream, issue #217, Phase 3). Codex is stream-only in
// practice (store:false + stream:true), but the non-stream method is implemented for
// completeness: it forwards the body VERBATIM and returns the upstream JSON untranslated
// (NO aggregateResponsesStream, NO openaiToResponsesRequest).
describe("createCodexResponsesClient — nativePassthrough", () => {
  function nativeBody(): Record<string, unknown> {
    return {
      model: "gpt-5.5",
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }],
      instructions: "You are Codex.",
      include: ["reasoning.encrypted_content"],
      store: false,
    };
  }

  it("forwards the native body VERBATIM (no openaiToResponsesRequest)", async () => {
    const body = nativeBody();
    let sentBody: unknown;
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      sentBody = JSON.parse(String(init?.body));
      return jsonResponse({ id: "resp_pt", object: "response", status: "completed" });
    });
    const client = createCodexResponsesClient({
      config: {
        baseUrl: "https://chatgpt.com/backend-api/codex",
        getAuthHeader: async () => `Bearer ${jwt("acct")}`,
      },
      fetch: fetchMock as unknown as typeof fetch,
    });
    await client.nativePassthrough?.(body);
    expect(sentBody).toEqual(body);
  });

  it("returns the upstream native Responses JSON VERBATIM (no aggregateResponsesStream)", async () => {
    const upstream = {
      id: "resp_pt",
      object: "response",
      status: "completed",
      output: [
        {
          type: "reasoning",
          encrypted_content: "ENC-OPAQUE",
        },
        {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "native answer" }],
        },
      ],
      usage: { input_tokens: 10, output_tokens: 5 },
    };
    const client = createCodexResponsesClient({
      config: {
        baseUrl: "https://chatgpt.com/backend-api/codex",
        getAuthHeader: async () => `Bearer ${jwt("acct")}`,
      },
      fetch: (async () => jsonResponse(upstream)) as unknown as typeof fetch,
    });
    const out = await client.nativePassthrough?.(nativeBody());
    // Native Responses shape preserved — `output` blocks (incl. encrypted reasoning)
    // survive, no `choices` wrapping.
    expect(out).toEqual(upstream);
  });

  it("throws UpstreamError with upstreamStatus + scrubbed body on a non-2xx", async () => {
    const token = jwt("acct_secret_value_1234");
    const client = createCodexResponsesClient({
      config: {
        baseUrl: "https://chatgpt.com/backend-api/codex",
        getAuthHeader: async () => `Bearer ${token}`,
        currentSecrets: () => [token],
      },
      fetch: (async () => jsonResponse({ error: `boom ${token}` }, 500)) as unknown as typeof fetch,
    });
    let caught: unknown;
    try {
      await client.nativePassthrough?.(nativeBody());
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(UpstreamError);
    const err = caught as UpstreamError;
    expect(err.upstreamStatus).toBe(500);
    expect(JSON.stringify(err.providerRaw)).not.toContain(token);
    expect(JSON.stringify(err.providerRaw)).toContain("[redacted]");
  });
});

// Sanity (Phase 2, no change): the OAuth pool + serialize-client forward
// nativePassthrough / nativePassthroughStream generically, so a codex pool member
// exposes both methods. The codex client created above defines them as functions —
// the pool's select-then-delegate wiring (pool.test.ts) simply forwards the calls.
describe("createCodexResponsesClient — passthrough methods are defined (pool feature-detect)", () => {
  it("exposes nativePassthrough and nativePassthroughStream as functions", () => {
    const client = createCodexResponsesClient({
      config: {
        baseUrl: "https://chatgpt.com/backend-api/codex",
        getAuthHeader: async () => `Bearer ${jwt("acct")}`,
      },
    });
    expect(typeof client.nativePassthrough).toBe("function");
    expect(typeof client.nativePassthroughStream).toBe("function");
  });
});

describe("createGenericOpenAIResponsesClient — native passthrough", () => {
  it("forwards generic Responses bodies without Codex-only defaults or headers", async () => {
    const body = {
      model: "gpt-5.5",
      input: "hi",
      include: ["file_search_call.results"],
      background: true,
      max_output_tokens: 128,
      store: true,
    };
    let seenUrl = "";
    let seenHeaders = new Headers();
    let seenBody: unknown;
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      seenUrl = String(url);
      seenHeaders = new Headers(init?.headers);
      seenBody = JSON.parse(String(init?.body));
      return jsonResponse({ id: "resp_generic", object: "response", status: "completed" });
    });

    const client = createGenericOpenAIResponsesClient({
      config: { baseUrl: "https://api.openai.test/v1", apiKey: "sk-test" },
      fetch: fetchMock as unknown as typeof fetch,
    });

    const out = await client.nativePassthrough?.(body);

    expect(client.nativeProtocolProfile).toBe("generic_openai_responses");
    expect(seenUrl).toBe("https://api.openai.test/v1/responses");
    expect(seenHeaders.get("Authorization")).toBe("Bearer sk-test");
    expect(seenHeaders.get("OpenAI-Beta")).toBeNull();
    expect(seenHeaders.get("chatgpt-account-id")).toBeNull();
    expect(seenBody).toEqual(body);
    expect(out).toEqual({ id: "resp_generic", object: "response", status: "completed" });
  });

  it("chatCompletion maps Responses function_call output items to chat tool_calls", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        id: "resp_fc",
        object: "response",
        status: "completed",
        output: [
          {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "calling a tool" }],
          },
          {
            type: "function_call",
            call_id: "call_1",
            name: "get_weather",
            arguments: '{"city":"SF"}',
          },
        ],
        usage: { input_tokens: 5, output_tokens: 3 },
      }),
    );
    const client = createGenericOpenAIResponsesClient({
      config: { baseUrl: "https://api.openai.test/v1", apiKey: "sk-test" },
      fetch: fetchMock as unknown as typeof fetch,
    });

    const out = (await client.chatCompletion({
      model: "gpt-5.5",
      messages: [{ role: "user", content: "weather?" }],
    })) as {
      choices: Array<{
        message: { content: unknown; tool_calls?: unknown };
        finish_reason: string;
      }>;
    };
    const choice = out.choices[0];
    expect(choice?.message.content).toBe("calling a tool");
    expect(choice?.message.tool_calls).toEqual([
      {
        id: "call_1",
        type: "function",
        function: { name: "get_weather", arguments: '{"city":"SF"}' },
      },
    ]);
    expect(choice?.finish_reason).toBe("tool_calls");
  });

  it("chatCompletion returns null content + finish_reason tool_calls for a pure function_call response", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        id: "resp_fc2",
        output: [{ type: "function_call", id: "c2", name: "noop", arguments: "{}" }],
        usage: {},
      }),
    );
    const client = createGenericOpenAIResponsesClient({
      config: { baseUrl: "https://api.openai.test/v1", apiKey: "sk-test" },
      fetch: fetchMock as unknown as typeof fetch,
    });

    const out = (await client.chatCompletion({ model: "gpt-5.5", messages: [] })) as {
      choices: Array<{
        message: { content: unknown; tool_calls?: unknown };
        finish_reason: string;
      }>;
    };
    expect(out.choices[0]?.message.content).toBeNull();
    expect(out.choices[0]?.finish_reason).toBe("tool_calls");
    expect((out.choices[0]?.message.tool_calls as unknown[]).length).toBe(1);
  });

  it("calls generic lifecycle endpoints with OpenAI-shaped auth only", async () => {
    const calls: Array<{ url: string; method: string; body?: unknown }> = [];
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({
        url: String(url),
        method: String(init?.method ?? "GET"),
        ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}),
      });
      return jsonResponse({ ok: true });
    });
    const client = createGenericOpenAIResponsesClient({
      config: { baseUrl: "https://api.openai.test/v1", apiKey: "sk-test" },
      fetch: fetchMock as unknown as typeof fetch,
    });

    await client.responsesRetrieve?.("resp_1");
    await client.responsesDelete?.("resp_1");
    await client.responsesCancel?.("resp_1");
    await client.responsesInputItems?.("resp_1");
    await client.responsesCompact?.({ model: "gpt-5.5", input: "compact me" });
    await client.responsesInputTokens?.({ model: "gpt-5.5", input: "count me" });

    expect(calls).toEqual([
      { url: "https://api.openai.test/v1/responses/resp_1", method: "GET" },
      { url: "https://api.openai.test/v1/responses/resp_1", method: "DELETE" },
      { url: "https://api.openai.test/v1/responses/resp_1/cancel", method: "POST" },
      { url: "https://api.openai.test/v1/responses/resp_1/input_items", method: "GET" },
      {
        url: "https://api.openai.test/v1/responses/compact",
        method: "POST",
        body: { model: "gpt-5.5", input: "compact me" },
      },
      {
        url: "https://api.openai.test/v1/responses/input_tokens",
        method: "POST",
        body: { model: "gpt-5.5", input: "count me" },
      },
    ]);
  });
});
