import { describe, expect, it, vi } from "vitest";
import type { CodexModelInfo } from "./oauth/codex-model-info.js";
import { UpstreamError } from "./openai.js";
import {
  aggregateResponsesStream,
  CODEX_RESPONSES_WEBSOCKET_SESSION_HEADER,
  CodexResponsesWebSocketConnectError,
  type CodexResponsesWebSocketConnectInput,
  type CodexResponsesWebSocketConnection,
  codexAccountIdFromToken,
  createCodexResponsesClient,
  createGenericOpenAIResponsesClient,
  hoistResponsesInstructions,
  openaiToGenericResponsesRequest,
  openaiToResponsesRequest,
  readResponsesEvents,
  readResponsesSSERaw,
  sanitizeCodexResponsesNativeBody,
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

function codexModelInfo(
  overrides: Partial<{
    use_responses_lite: boolean;
    support_verbosity: boolean;
    default_verbosity: string | null;
    supports_reasoning_summaries: boolean;
    default_reasoning_summary: "auto" | "concise" | "detailed" | "none";
    default_reasoning_level: string | null;
    supported_reasoning_levels: Array<{ effort: string; description: string }>;
    service_tiers: Array<{ id: string; name: string; description: string }>;
    supports_parallel_tool_calls: boolean;
  }> = {},
): CodexModelInfo {
  return {
    use_responses_lite: false,
    support_verbosity: true,
    default_verbosity: "low",
    supports_reasoning_summaries: true,
    default_reasoning_summary: "auto",
    default_reasoning_level: "medium",
    supported_reasoning_levels: [
      { effort: "low", description: "low" },
      { effort: "medium", description: "medium" },
      { effort: "high", description: "high" },
    ],
    service_tiers: [{ id: "priority", name: "Fast", description: "Priority" }],
    supports_parallel_tool_calls: true,
    ...overrides,
  } as CodexModelInfo;
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
  it("maps system -> instructions, user/assistant -> input, sets Codex request defaults", () => {
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
    expect(body.temperature).toBeUndefined();
    // Codex/ChatGPT-account contract (ported from openclaw): NO max_output_tokens
    // or temperature, and a store:false request MUST request encrypted reasoning
    // back + set verbosity.
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

  it("uses the Responses Lite input contract for GPT-5.6 model metadata", () => {
    const body = openaiToResponsesRequest(
      {
        model: "gpt-5.6-sol",
        messages: [
          { role: "system", content: "Use the workspace carefully." },
          { role: "user", content: "Fix it" },
        ],
        tools: [
          {
            type: "function",
            function: {
              name: "exec_command",
              description: "Run a command",
              parameters: { type: "object" },
            },
          },
        ],
        reasoning_effort: "high",
        verbosity: "medium",
        service_tier: "priority",
        parallel_tool_calls: true,
      },
      {
        modelInfo: codexModelInfo({
          use_responses_lite: true,
          default_reasoning_level: "low",
        }),
      },
    );

    expect(body.instructions).toBeUndefined();
    expect(body.tools).toBeUndefined();
    expect(body.parallel_tool_calls).toBe(false);
    expect(body.reasoning).toEqual({
      effort: "high",
      summary: "auto",
      context: "all_turns",
    });
    expect(body.text).toEqual({ verbosity: "medium" });
    expect(body.service_tier).toBe("priority");
    expect(body.input).toEqual([
      {
        type: "additional_tools",
        role: "developer",
        tools: [
          {
            type: "function",
            name: "exec_command",
            description: "Run a command",
            parameters: { type: "object" },
            strict: false,
          },
        ],
      },
      {
        type: "message",
        role: "developer",
        content: [{ type: "input_text", text: "Use the workspace carefully." }],
      },
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "Fix it" }],
      },
    ]);
  });

  it("keeps effort independent from summary support and maps the ultra UI label to max", () => {
    const body = openaiToResponsesRequest(
      {
        model: "gpt-5.6-terra",
        messages: [{ role: "user", content: "Hi" }],
        reasoning_effort: "ultra",
        service_tier: "unsupported",
        parallel_tool_calls: true,
      },
      {
        modelInfo: codexModelInfo({
          use_responses_lite: false,
          default_reasoning_level: "medium",
          supported_reasoning_levels: [
            { effort: "medium", description: "medium" },
            { effort: "max", description: "max" },
          ],
          supports_parallel_tool_calls: false,
        }),
      },
    );
    expect(body.reasoning).toEqual({ effort: "max", summary: "auto" });
    expect(body.text).toEqual({ verbosity: "low" });
    expect(body.service_tier).toBeUndefined();
    expect(body.parallel_tool_calls).toBe(false);

    const unsupported = openaiToResponsesRequest(
      {
        model: "no-reasoning",
        messages: [{ role: "user", content: "Hi" }],
        reasoning_effort: "high",
        verbosity: "high",
        service_tier: "default",
      },
      {
        modelInfo: codexModelInfo({
          supports_reasoning_summaries: false,
          default_reasoning_summary: "detailed",
          support_verbosity: false,
          default_verbosity: null,
          service_tiers: [],
        }),
      },
    );
    expect(unsupported.reasoning).toEqual({ effort: "high" });
    expect(unsupported.text).toBeUndefined();
    expect(unsupported.include).toEqual(["reasoning.encrypted_content"]);
    expect(unsupported.service_tier).toBeUndefined();

    const withoutMetadata = openaiToResponsesRequest({
      model: "gpt-5.6",
      messages: [{ role: "user", content: "Hi" }],
      reasoning_effort: "ultra",
    });
    expect(withoutMetadata.reasoning).toEqual({ effort: "max" });
  });

  it("falls back unsupported reasoning effort to the lower median supported level", () => {
    const body = openaiToResponsesRequest(
      {
        model: "gpt-5.6-terra",
        messages: [{ role: "user", content: "Hi" }],
        reasoning_effort: "max",
      },
      {
        modelInfo: codexModelInfo({
          default_reasoning_level: "high",
          supported_reasoning_levels: [
            { effort: "minimal", description: "minimal" },
            { effort: "low", description: "low" },
            { effort: "medium", description: "medium" },
            { effort: "high", description: "high" },
          ],
        }),
      },
    );

    expect(body.reasoning).toMatchObject({ effort: "low" });
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

  it("preserves complete PTC input, callers, tools, reasoning, and cache controls on translated Responses fallback", () => {
    const input = [
      {
        type: "program",
        id: "prog_1",
        call_id: "call_program",
        code: "const result = await tools.lookup({id: 1}); return result;",
      },
      {
        type: "function_call",
        call_id: "call_lookup",
        name: "lookup",
        arguments: '{"id":1}',
        caller: { type: "program", caller_id: "call_program" },
      },
      {
        type: "function_call_output",
        call_id: "call_lookup",
        output: '{"ok":true}',
        caller: { type: "program", caller_id: "call_program" },
      },
      {
        type: "program_output",
        call_id: "call_program",
        result: '{"ok":true}',
      },
    ];
    const tools = [
      { type: "programmatic_tool_calling" },
      {
        type: "function",
        name: "lookup",
        description: "Lookup one record",
        parameters: { type: "object" },
        allowed_callers: ["programmatic_tool_calling"],
      },
    ];

    const body = openaiToResponsesRequest(
      {
        model: "gpt-5.6-sol",
        messages: [{ role: "user", content: "continue" }],
        responses_input_items: input,
        responses_tools: tools,
        reasoning_config: { effort: "high", mode: "pro", context: "all_turns" },
        prompt_cache_options: { mode: "explicit", ttl: "30m" },
      } as never,
      { modelInfo: codexModelInfo({ use_responses_lite: false }) },
    );

    expect(body.input).toEqual(input);
    expect(body.tools).toEqual(tools);
    expect(body.reasoning).toEqual({
      effort: "high",
      mode: "pro",
      context: "all_turns",
      summary: "auto",
    });
    expect(body.prompt_cache_options).toEqual({ mode: "explicit", ttl: "30m" });
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
    expect((caught as UpstreamError).providerRaw).toMatchObject({
      type: "response.failed",
      response: { error: { message: "model exploded" } },
    });
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
    expect((caught as UpstreamError).providerRaw).toMatchObject({
      type: "response.failed",
      response: {},
    });
  });

  it("throws when the stream ends without response.completed", async () => {
    const res = sseResponse([
      { type: "response.output_item.added", item: { type: "message", role: "assistant" } },
      { type: "response.output_text.delta", delta: "partial" },
    ]);
    await expect(async () => {
      for await (const _ of translateResponsesSSE(res, "gpt-5.5")) {
        // drain
      }
    }).rejects.toMatchObject({ message: "stream closed before response.completed" });
  });

  it("throws when an empty stream reaches EOF without response.completed", async () => {
    const res = sseResponse([]);
    await expect(async () => {
      for await (const _ of translateResponsesSSE(res, "m")) {
        // drain
      }
    }).rejects.toMatchObject({ message: "stream closed before response.completed" });
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

  it("treats response.incomplete as an upstream error", async () => {
    const res = sseResponse([
      { type: "response.created", response: { id: "r" } },
      { type: "response.output_text.delta", delta: "partial" },
      {
        type: "response.incomplete",
        response: {
          status: "incomplete",
          incomplete_details: { reason: "max_output_tokens" },
          usage: { input_tokens: 9, output_tokens: 4 },
        },
      },
    ]);
    await expect(async () => {
      for await (const _ of translateResponsesSSE(res, "gpt-5.5")) {
        // drain
      }
    }).rejects.toMatchObject({
      message: "Incomplete response returned, reason: max_output_tokens",
    });
  });

  it("maps output_item.done function calls and buffers custom tool input deltas", async () => {
    const res = sseResponse([
      {
        type: "response.output_item.done",
        item: {
          type: "function_call",
          call_id: "call_fn",
          name: "lookup",
          arguments: '{"q":"done"}',
        },
      },
      {
        type: "response.custom_tool_call_input.delta",
        item_id: "ctc_1",
        call_id: "call_custom",
        delta: "*** Begin",
      },
      {
        type: "response.custom_tool_call_input.delta",
        item_id: "ctc_1",
        call_id: "call_custom",
        delta: " Patch",
      },
      {
        type: "response.output_item.done",
        item: {
          type: "custom_tool_call",
          id: "ctc_1",
          call_id: "call_custom",
          name: "apply_patch",
          input: "*** Begin Patch",
        },
      },
      { type: "response.completed", response: { status: "completed", usage: {} } },
    ]);
    const chunks: string[] = [];
    for await (const chunk of translateResponsesSSE(res, "gpt-5.6-sol")) chunks.push(chunk);
    const joined = chunks.join("");
    expect(joined).toContain('"id":"call_fn"');
    expect(joined).toContain('"name":"lookup"');
    expect(joined).toContain('{\\"q\\":\\"done\\"}');
    expect(joined).toContain('"id":"call_custom"');
    expect(joined).toContain('"name":"apply_patch"');
    expect(joined).toContain("*** Begin Patch");
    expect(joined).toContain('"finish_reason":"tool_calls"');
  });

  it("marks in-band rate limits and quota failures with upstreamStatus 429", async () => {
    for (const code of ["rate_limit_exceeded", "insufficient_quota"]) {
      const res = sseResponse([
        {
          type: "response.failed",
          response: { error: { code, message: `failed: ${code}` } },
        },
      ]);
      let caught: unknown;
      try {
        for await (const _ of translateResponsesSSE(res, "m")) {
          // drain
        }
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(UpstreamError);
      expect((caught as UpstreamError).upstreamStatus).toBe(429);
    }
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

  it("throws on response.incomplete instead of returning a truncated completion", async () => {
    const res = sseResponse([
      { type: "response.created", response: { id: "resp_i" } },
      { type: "response.output_text.delta", delta: "partial" },
      {
        type: "response.incomplete",
        response: {
          status: "incomplete",
          incomplete_details: { reason: "content_filter" },
          usage: { input_tokens: 5, output_tokens: 2 },
        },
      },
    ]);
    await expect(aggregateResponsesStream(res, "m")).rejects.toMatchObject({
      message: "Incomplete response returned, reason: content_filter",
    });
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

  it("folds output_item.done function/custom tool calls and custom input deltas", async () => {
    const res = sseResponse([
      {
        type: "response.output_item.done",
        item: {
          type: "function_call",
          call_id: "call_fn",
          name: "lookup",
          arguments: '{"q":"done"}',
        },
      },
      {
        type: "response.custom_tool_call_input.delta",
        item_id: "ctc_1",
        call_id: "call_custom",
        delta: "*** Begin",
      },
      {
        type: "response.custom_tool_call_input.delta",
        item_id: "ctc_1",
        call_id: "call_custom",
        delta: " Patch",
      },
      {
        type: "response.output_item.done",
        item: {
          type: "custom_tool_call",
          id: "ctc_1",
          call_id: "call_custom",
          name: "apply_patch",
          input: "*** Begin Patch",
        },
      },
      { type: "response.completed", response: { status: "completed", usage: {} } },
    ]);
    const out = await aggregateResponsesStream(res, "gpt-5.6-sol");
    const message = (out.choices as Array<{ message: Record<string, unknown> }>)[0]?.message;
    expect(message?.tool_calls).toEqual([
      {
        id: "call_fn",
        type: "function",
        function: { name: "lookup", arguments: '{"q":"done"}' },
      },
      {
        id: "call_custom",
        type: "function",
        function: { name: "apply_patch", arguments: "*** Begin Patch" },
      },
    ]);
  });

  it("throws when aggregation reaches EOF without response.completed", async () => {
    const res = sseResponse([{ type: "response.output_text.delta", delta: "partial" }]);
    await expect(aggregateResponsesStream(res, "m")).rejects.toMatchObject({
      message: "stream closed before response.completed",
    });
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
  it("sends Bearer + account id + Codex originator without obsolete OpenAI-Beta; 401-retries once", async () => {
    let calls = 0;
    const seenAuth: string[] = [];
    let seenAccount = "";
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      calls += 1;
      expect(String(url)).toBe("https://chatgpt.com/backend-api/codex/responses");
      const h = new Headers(init?.headers);
      seenAuth.push(h.get("Authorization") ?? "");
      seenAccount = h.get("chatgpt-account-id") ?? "";
      expect(h.get("originator")).toBe("codex_cli_rs");
      expect(h.get("OpenAI-Beta")).toBeNull();
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

  it("resolves model metadata, sends Lite/FedRAMP headers, and reports X-Models-Etag", async () => {
    let seenHeaders: Headers | null = null;
    let seenBody: Record<string, unknown> | null = null;
    const seenEtags: string[] = [];
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      seenHeaders = new Headers(init?.headers);
      seenBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(
        [
          `data: ${JSON.stringify({ type: "response.output_text.delta", delta: "ok" })}\n\n`,
          `data: ${JSON.stringify({ type: "response.completed", response: { status: "completed", usage: {} } })}\n\n`,
        ].join(""),
        {
          status: 200,
          headers: {
            "Content-Type": "text/event-stream",
            "X-Models-Etag": '"models-v2"',
          },
        },
      );
    });
    const client = createCodexResponsesClient({
      config: {
        baseUrl: "https://chatgpt.com/backend-api/codex",
        getAuthHeader: async () => `Bearer ${jwt("acct")}`,
        resolveModelInfo: (model) =>
          model === "gpt-5.6-sol"
            ? codexModelInfo({ use_responses_lite: true, default_reasoning_level: "low" })
            : undefined,
        onModelsEtag: (etag) => seenEtags.push(etag),
        isFedramp: true,
      },
      fetch: fetchMock as unknown as typeof fetch,
    });

    await client.chatCompletion({
      model: "gpt-5.6-sol",
      messages: [{ role: "user", content: "hi" }],
    });

    const headers = seenHeaders as unknown as Headers;
    expect(headers.get("x-openai-internal-codex-responses-lite")).toBe("true");
    expect(headers.get("x-openai-fedramp")).toBe("true");
    expect(seenBody).toMatchObject({
      parallel_tool_calls: false,
      reasoning: { effort: "medium", context: "all_turns" },
    });
    expect(seenBody).not.toHaveProperty("instructions");
    expect(seenEtags).toEqual(['"models-v2"']);
  });

  it("forces service_tier=priority when per-account Fast mode is enabled", async () => {
    let sentBody: Record<string, unknown> | null = null;
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      sentBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return sseResponse([
        { type: "response.output_item.added", item: { type: "message", role: "assistant" } },
        { type: "response.output_text.delta", delta: "ok" },
        { type: "response.completed", response: { status: "completed", usage: {} } },
      ]);
    });
    const client = createCodexResponsesClient({
      config: {
        baseUrl: "https://chatgpt.com/backend-api/codex",
        getAuthHeader: async () => `Bearer ${jwt("acct")}`,
        fastMode: true,
      },
      fetch: fetchMock as unknown as typeof fetch,
    });

    await client.chatCompletion({
      model: "gpt-5.5",
      messages: [{ role: "user", content: "hi" }],
      service_tier: "default",
    });

    expect(sentBody).toEqual(expect.objectContaining({ service_tier: "priority" }));
  });

  it("fires global and per-call response metadata exactly once without perturbing streamed chunks", async () => {
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
    const globalSeen: Headers[] = [];
    const callSeen: Headers[] = [];
    const client = createCodexResponsesClient({
      config: {
        baseUrl: "https://chatgpt.com/backend-api/codex",
        getAuthHeader: async () => `Bearer ${jwt("acct")}`,
        onResponseMeta: (h) => globalSeen.push(h),
      },
      fetch: fetchMock as unknown as typeof fetch,
    });
    const chunks: string[] = [];
    for await (const ch of client.chatCompletionStream(
      {
        model: "gpt-5.5",
        messages: [{ role: "user", content: "hi" }],
      },
      { onResponseMeta: (headers) => callSeen.push(headers) },
    )) {
      chunks.push(ch);
    }
    // Both channels fire once, BEFORE/at stream open, with the live quota headers.
    expect(globalSeen).toHaveLength(1);
    expect(callSeen).toHaveLength(1);
    expect(globalSeen[0]?.get("x-codex-primary-used-percent")).toBe("7");
    expect(callSeen[0]?.get("x-codex-primary-used-percent")).toBe("7");
    // The streamed body is untouched: both deltas survive, in order.
    const joined = chunks.join("");
    expect(joined.indexOf("hel")).toBeGreaterThanOrEqual(0);
    expect(joined.indexOf("hel")).toBeLessThan(joined.indexOf("lo"));
  });

  it("sends the Codex session-id/thread-id headers and derives x-client-request-id from thread-id", async () => {
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
        threadId: "thread-abc",
        userAgent: "helm-codex/9.9.9",
      },
      fetch: fetchMock as unknown as typeof fetch,
    });
    await client.chatCompletion({ model: "gpt-5.5", messages: [{ role: "user", content: "hi" }] });
    const h = seen as unknown as Headers;
    expect(h.get("user-agent")).toMatch(/^helm-codex\/9\.9\.9 \(.+ .+; .+\) \S+$/);
    expect(h.get("user-agent")).not.toMatch(/\bnode\//i);
    expect(h.get("session-id")).toBe("sess-abc");
    expect(h.get("thread-id")).toBe("thread-abc");
    expect(h.get("x-client-request-id")).toBe("thread-abc");
    expect(h.get("session_id")).toBeNull();
  });

  it("keeps session-id independent from thread-id and x-client-request-id", async () => {
    const seen: Headers[] = [];
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      seen.push(new Headers(init?.headers));
      return sseResponse([
        { type: "response.output_text.delta", delta: "ok" },
        { type: "response.completed", response: { status: "completed", usage: {} } },
      ]);
    });
    const sessionOnly = createCodexResponsesClient({
      config: {
        baseUrl: "https://chatgpt.com/backend-api/codex",
        getAuthHeader: async () => `Bearer ${jwt("acct")}`,
        sessionId: "session-only",
      },
      fetch: fetchMock as unknown as typeof fetch,
    });
    const threadOnly = createCodexResponsesClient({
      config: {
        baseUrl: "https://chatgpt.com/backend-api/codex",
        getAuthHeader: async () => `Bearer ${jwt("acct")}`,
        threadId: "thread-only",
      },
      fetch: fetchMock as unknown as typeof fetch,
    });

    await sessionOnly.chatCompletion({
      model: "gpt-5.5",
      messages: [{ role: "user", content: "hi" }],
    });
    await threadOnly.chatCompletion({
      model: "gpt-5.5",
      messages: [{ role: "user", content: "hi" }],
    });

    expect(seen[0]?.get("session-id")).toBe("session-only");
    expect(seen[0]?.get("thread-id")).toBeNull();
    expect(seen[0]?.get("x-client-request-id")).toBeNull();
    expect(seen[1]?.get("session-id")).toBeNull();
    expect(seen[1]?.get("thread-id")).toBe("thread-only");
    expect(seen[1]?.get("x-client-request-id")).toBe("thread-only");
  });

  it("emits a Codex-format default User-Agent without a Node.js token", async () => {
    let seen = new Headers();
    const client = createCodexResponsesClient({
      config: {
        baseUrl: "https://chatgpt.com/backend-api/codex",
        getAuthHeader: async () => `Bearer ${jwt("acct")}`,
      },
      fetch: (async (_url: string, init?: RequestInit) => {
        seen = new Headers(init?.headers);
        return sseResponse([
          { type: "response.output_text.delta", delta: "ok" },
          { type: "response.completed", response: { status: "completed", usage: {} } },
        ]);
      }) as unknown as typeof fetch,
    });

    await client.chatCompletion({ model: "gpt-5.5", messages: [{ role: "user", content: "hi" }] });

    expect(seen.get("user-agent")).toMatch(/^codex_cli_rs\/0\.0\.0 \(.+ .+; .+\) \S+$/);
    expect(seen.get("user-agent")).not.toMatch(/\bnode\//i);
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

  it("retries a transient network error then re-throws it unchanged", async () => {
    // ECONNREFUSED is transient → retried at the fetch boundary ([0,0] backoff keeps
    // the test instant); the ORIGINAL error propagates once the budget is exhausted.
    const boom = new Error("ECONNREFUSED");
    const fetch = vi.fn(async () => {
      throw boom;
    });
    const client = createCodexResponsesClient({
      config: {
        baseUrl: "https://chatgpt.com/backend-api/codex",
        getAuthHeader: async () => `Bearer ${jwt("acct")}`,
        connectRetryBackoffMs: [0, 0],
      },
      fetch: fetch as unknown as typeof globalThis.fetch,
    });
    await expect(
      client.chatCompletion({ model: "m", messages: [{ role: "user", content: "x" }] }),
    ).rejects.toBe(boom);
    expect(fetch).toHaveBeenCalledTimes(3); // 1 initial + 2 retries
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

  it("stops after response.completed and discards trailing native frames", async () => {
    const completed =
      'data: {"type":"response.completed","response":{"status":"completed","usage":{}}}\n\n';
    const trailing = 'data: {"type":"response.output_text.delta","delta":"must-not-leak"}\n\n';
    const chunks: string[] = [];

    for await (const chunk of readResponsesSSERaw(rawSSEResponse(completed + trailing))) {
      chunks.push(chunk);
    }

    expect(chunks.join("")).toBe(completed);
  });

  it("rejects an empty body because no response.completed event arrived", async () => {
    const res = new Response(null, { status: 200 });
    await expect(async () => {
      for await (const _ of readResponsesSSERaw(res)) {
        // drain
      }
    }).rejects.toMatchObject({ message: "stream closed before response.completed" });
  });

  it("rejects premature EOF after forwarding partial native events", async () => {
    const partial =
      'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"partial"}\n\n';
    const res = new Response(partial, {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    });
    const chunks: string[] = [];
    let caught: unknown;

    try {
      for await (const chunk of readResponsesSSERaw(res)) chunks.push(chunk);
    } catch (error) {
      caught = error;
    }

    expect(chunks.join("")).toBe(partial);
    expect(caught).toMatchObject({ message: "stream closed before response.completed" });
  });

  it("forwards response.failed as the single terminal frame and ends normally", async () => {
    const created = 'data: {"type":"response.created","response":{"id":"resp_1"}}\n\n';
    const failed =
      'data: {"type":"response.failed","response":{"error":{"message":"subscription model failed"}}}\n\n';
    const trailing =
      'data: {"type":"response.completed","response":{"status":"completed","usage":{}}}\n\n';
    const chunks: string[] = [];

    for await (const chunk of readResponsesSSERaw(rawSSEResponse(created + failed + trailing))) {
      chunks.push(chunk);
    }

    expect(chunks.join("")).toBe(created + failed);
  });

  it("forwards response.incomplete as the single terminal frame and ends normally", async () => {
    const incomplete =
      'data: {"type":"response.incomplete","response":{"incomplete_details":{"reason":"max_output_tokens"}}}\n\n';
    const trailing = 'data: {"type":"response.output_text.delta","delta":"must-not-leak"}\n\n';
    const chunks: string[] = [];

    for await (const chunk of readResponsesSSERaw(rawSSEResponse(incomplete + trailing))) {
      chunks.push(chunk);
    }

    expect(chunks.join("")).toBe(incomplete);
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
// Current identity headers (Bearer + chatgpt-account-id + originator) still ride via
// the shared HTTP core, applied automatically to both methods.
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

  it("overrides native passthrough service_tier when per-account Fast mode is enabled", async () => {
    const body = { ...nativeStreamBody(), service_tier: "default" };
    let sentBody: Record<string, unknown> | null = null;
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      sentBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return sseStreamResponse([
        'event: response.completed\ndata: {"type":"response.completed","response":{"status":"completed","usage":{}}}\n\n',
      ]);
    });
    const client = createCodexResponsesClient({
      config: {
        baseUrl: "https://chatgpt.com/backend-api/codex",
        getAuthHeader: async () => `Bearer ${jwt("acct")}`,
        fastMode: true,
      },
      fetch: fetchMock as unknown as typeof fetch,
    });

    for await (const chunk of client.nativePassthroughStream?.(body) ?? []) {
      void chunk;
    }

    expect(sentBody).toEqual(expect.objectContaining({ service_tier: "priority" }));
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

  it("applies the current ChatGPT identity headers via the HTTP core", async () => {
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
        threadId: "thread-z",
        userAgent: "codex_cli_rs/4.5.6 (darwin 24.0; arm64) Apple_Terminal/455",
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
    expect(h.get("originator")).toBe("codex_cli_rs");
    expect(h.get("OpenAI-Beta")).toBeNull();
    expect(h.get("session-id")).toBe("sess-z");
    expect(h.get("thread-id")).toBe("thread-z");
    expect(h.get("x-client-request-id")).toBe("thread-z");
    expect(h.get("version")).toBe("4.5.6");
    expect(h.get("session_id")).toBeNull();
  });

  it("uses persisted ChatGPT identity when the refreshed access token has no identity claims", async () => {
    let seen: Headers | null = null;
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      seen = new Headers(init?.headers);
      return sseStreamResponse([
        'event: response.completed\ndata: {"type":"response.completed","response":{"status":"completed","usage":{}}}\n\n',
      ]);
    });
    const client = createCodexResponsesClient({
      config: {
        baseUrl: "https://chatgpt.com/backend-api/codex",
        getAuthHeader: async () => "Bearer opaque-access-token",
        getAccountIdentity: () => ({ accountId: "workspace-42", isFedramp: true }),
      },
      fetch: fetchMock as unknown as typeof fetch,
    });

    for await (const _ of client.nativePassthroughStream?.(nativeStreamBody()) ?? []) {
      // drain
    }

    const headers = seen as unknown as Headers;
    expect(headers.get("chatgpt-account-id")).toBe("workspace-42");
    expect(headers.get("X-OpenAI-Fedramp")).toBe("true");
  });

  it("preserves Lite developer items detected from a native header or model metadata", async () => {
    const bodies: Record<string, unknown>[] = [];
    const headers: Headers[] = [];
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      headers.push(new Headers(init?.headers));
      return sseStreamResponse([
        'data: {"type":"response.completed","response":{"status":"completed","usage":{}}}\n\n',
      ]);
    });
    const client = createCodexResponsesClient({
      config: {
        baseUrl: "https://chatgpt.com/backend-api/codex",
        getAuthHeader: async () => `Bearer ${jwt("acct")}`,
        resolveModelInfo: (model) =>
          model === "gpt-5.6-terra" ? codexModelInfo({ use_responses_lite: true }) : undefined,
      },
      fetch: fetchMock as unknown as typeof fetch,
    });
    const liteBody = {
      model: "gpt-5.6-terra",
      input: [
        { type: "additional_tools", role: "developer", tools: [] },
        { type: "message", role: "developer", content: "Keep me in input." },
        { type: "message", role: "user", content: "hi" },
      ],
      stream: true,
      store: false,
    };

    for await (const _ of client.nativePassthroughStream?.({
      protocol: "openai_responses",
      body: liteBody,
      headers: { "x-openai-internal-codex-responses-lite": "true" },
      mutations: {},
    }) ?? []) {
      // drain
    }
    for await (const _ of client.nativePassthroughStream?.({
      protocol: "openai_responses",
      body: liteBody,
      headers: {},
      mutations: {},
    }) ?? []) {
      // drain
    }

    expect(bodies).toEqual([
      { ...liteBody, parallel_tool_calls: false },
      { ...liteBody, parallel_tool_calls: false },
    ]);
    expect(headers[0]?.get("x-openai-internal-codex-responses-lite")).toBe("true");
    expect(headers[1]?.get("x-openai-internal-codex-responses-lite")).toBe("true");
  });

  it("canonicalizes a native GPT-5.6 alias request using dynamic Responses Lite metadata", async () => {
    let sentBody: Record<string, unknown> | null = null;
    let sentHeaders = new Headers();
    const client = createCodexResponsesClient({
      config: {
        baseUrl: "https://chatgpt.com/backend-api/codex",
        getAuthHeader: async () => `Bearer ${jwt("acct")}`,
        resolveModelInfo: (model) =>
          model === "gpt-5.6"
            ? codexModelInfo({
                use_responses_lite: true,
                default_reasoning_level: "medium",
              })
            : undefined,
      },
      fetch: (async (_url: string, init?: RequestInit) => {
        sentBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        sentHeaders = new Headers(init?.headers);
        return rawSSEResponse(
          'data: {"type":"response.completed","response":{"status":"completed","usage":{}}}\n\n',
        );
      }) as unknown as typeof fetch,
    });
    const input = {
      model: "gpt-5.6",
      instructions: "Use the repository instructions.",
      input: [
        {
          type: "message",
          role: "user",
          content: [
            {
              type: "input_image",
              image_url: "https://example.test/image.png",
              detail: "high",
            },
          ],
        },
      ],
      tools: [{ type: "function", name: "run", parameters: { type: "object" } }],
      reasoning: {
        effort: "high",
        mode: "pro",
        context: "current_turn",
      },
      prompt_cache_options: { mode: "explicit", ttl: "24h" },
      parallel_tool_calls: true,
      store: true,
      stream: true,
    };

    for await (const _ of client.nativePassthroughStream?.(input) ?? []) {
      // drain
    }

    const body = sentBody as unknown as Record<string, unknown>;
    expect(body.model).toBe("gpt-5.6-sol");
    expect(body.store).toBe(false);
    expect(body).not.toHaveProperty("instructions");
    expect(body).not.toHaveProperty("tools");
    expect(body.parallel_tool_calls).toBe(false);
    expect(body.reasoning).toEqual({
      effort: "high",
      mode: "pro",
      context: "all_turns",
    });
    expect(body.prompt_cache_options).toEqual({ mode: "explicit", ttl: "24h" });
    expect(body.input).toEqual([
      {
        type: "additional_tools",
        role: "developer",
        tools: [{ type: "function", name: "run", parameters: { type: "object" } }],
      },
      {
        type: "message",
        role: "developer",
        content: [{ type: "input_text", text: "Use the repository instructions." }],
      },
      {
        type: "message",
        role: "user",
        content: [
          {
            type: "input_image",
            image_url: "https://example.test/image.png",
          },
        ],
      },
    ]);
    expect(sentHeaders.get("x-openai-internal-codex-responses-lite")).toBe("true");
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
        version: "1.2.3",
        originator: "codex_vscode",
        "session-id": "client-session",
        "thread-id": "client-thread",
        "x-client-request-id": "client-request-id",
        "x-codex-turn-state": "turn-state-1",
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
        threadId: "thread-z",
        userAgent: "codex_cli_rs/9.9.9 (darwin 24.0; arm64) node/v22.0.0",
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
    expect(h.get("version")).toBe("1.2.3");
    expect(h.get("originator")).toBe("codex_vscode");
    expect(h.get("session-id")).toBe("client-session");
    expect(h.get("thread-id")).toBe("client-thread");
    expect(h.get("x-client-request-id")).toBe("client-request-id");
    expect(h.get("x-codex-turn-state")).toBe("turn-state-1");
    expect(h.get("session_id")).toBeNull();
    expect(h.get("content-length")).toBeNull();
    expect(h.get("x-helm-trace")).toBeNull();
    expect(h.get("accept")).toBe("application/json");
    expect(h.get("openai-beta")).toBeNull();
    expect(carrier.mutations).toMatchObject({
      auth_replaced: true,
      content_length_recomputed: true,
    });
    expect((carrier.mutations as Record<string, unknown>).headers_dropped).toEqual(
      expect.arrayContaining(["authorization", "content-length", "openai-beta", "x-helm-trace"]),
    );
    expect((carrier.mutations as Record<string, unknown>).headers_overwritten).not.toEqual(
      expect.arrayContaining([
        "accept",
        "originator",
        "session-id",
        "thread-id",
        "user-agent",
        "version",
        "x-client-request-id",
        "x-codex-turn-state",
      ]),
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
        new Response(JSON.stringify({ error: `rate_limit ${token}` }), {
          status: 429,
          headers: {
            "Content-Type": "application/json",
            "Retry-After": "42",
            "X-Codex-Primary-Used-Percent": "100",
            "X-Request-Id": `req-${token}`,
            "CF-Ray": "ray-429",
          },
        })) as unknown as typeof fetch,
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
    expect(err.providerRaw).toEqual({
      body: { error: "rate_limit [redacted]" },
      headers: {
        "cf-ray": "ray-429",
        "retry-after": "42",
        "x-codex-primary-used-percent": "100",
        "x-request-id": "req-[redacted]",
      },
    });
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

  it("captures the first turn state, replays it within the same turn, and isolates new turns", async () => {
    const seen: Headers[] = [];
    const responseStates = ["turn-state-1", "turn-state-ignored", undefined, undefined];
    let call = 0;
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      seen.push(new Headers(init?.headers));
      const state = responseStates[call];
      call += 1;
      return sseStreamResponse(
        [
          'event: response.completed\ndata: {"type":"response.completed","response":{"status":"completed","usage":{}}}\n\n',
        ],
        state === undefined ? undefined : { "x-codex-turn-state": state },
      );
    });
    const client = createCodexResponsesClient({
      config: {
        baseUrl: "https://chatgpt.com/backend-api/codex",
        getAuthHeader: async () => `Bearer ${jwt("acct")}`,
      },
      fetch: fetchMock as unknown as typeof fetch,
    });
    const carrier = (turnId: string) => ({
      protocol: "openai_responses" as const,
      body: nativeStreamBody(),
      headers: {
        "x-codex-turn-metadata": JSON.stringify({ turn_id: turnId }),
      },
      mutations: {},
    });

    for (const turnId of ["turn-a", "turn-a", "turn-b", "turn-a"]) {
      for await (const _ of client.nativePassthroughStream?.(carrier(turnId)) ?? []) {
        // drain
      }
    }

    expect(seen.map((headers) => headers.get("x-codex-turn-state"))).toEqual([
      null,
      "turn-state-1",
      null,
      "turn-state-1",
    ]);
    expect(seen.map((headers) => headers.get("x-codex-turn-metadata"))).toEqual([
      '{"turn_id":"turn-a"}',
      '{"turn_id":"turn-a"}',
      '{"turn_id":"turn-b"}',
      '{"turn_id":"turn-a"}',
    ]);
  });
});

describe("createCodexResponsesClient — native Responses WebSocket", () => {
  function carrier(
    sessionId: string,
    body: Record<string, unknown>,
    headers: Record<string, string> = {},
  ) {
    return {
      protocol: "openai_responses" as const,
      body,
      headers: {
        [CODEX_RESPONSES_WEBSOCKET_SESSION_HEADER]: sessionId,
        "session-id": "client-session",
        "thread-id": "client-thread",
        "x-client-request-id": "client-thread",
        ...headers,
      },
      mutations: {},
    };
  }

  function fakeConnection(
    replies: Array<Array<Record<string, unknown> | string>>,
    responseHeaders = new Headers({
      "x-models-etag": '"models-ws-1"',
      "x-reasoning-included": "true",
    }),
  ): CodexResponsesWebSocketConnection & {
    sent: string[];
    closeCalls: number;
  } {
    const pending: string[] = [];
    const waiters: Array<(value: string | null) => void> = [];
    const connection = {
      responseHeaders,
      sent: [] as string[],
      closeCalls: 0,
      async send(text: string) {
        connection.sent.push(text);
        const events = replies[connection.sent.length - 1] ?? [];
        for (const event of events) {
          const payload = typeof event === "string" ? event : JSON.stringify(event);
          const waiter = waiters.shift();
          if (waiter) waiter(payload);
          else pending.push(payload);
        }
      },
      async receive() {
        const next = pending.shift();
        if (next !== undefined) return next;
        return await new Promise<string | null>((resolve) => waiters.push(resolve));
      },
      async close() {
        connection.closeCalls += 1;
        for (const waiter of waiters.splice(0)) waiter(null);
      },
    };
    return connection;
  }

  it("reuses one upstream websocket for prewarm and previous_response_id continuation", async () => {
    const connection = fakeConnection([
      [
        { type: "response.created", response: { id: "warm-1" } },
        {
          type: "response.completed",
          response: { id: "warm-1", status: "completed", usage: {} },
        },
      ],
      [
        { type: "response.created", response: { id: "resp-1" } },
        {
          type: "response.output_item.added",
          item: { type: "function_call", call_id: "call-1", name: "exec_command" },
        },
        {
          type: "response.completed",
          response: { id: "resp-1", status: "completed", usage: {} },
        },
      ],
      [
        { type: "response.created", response: { id: "resp-2" } },
        { type: "response.output_text.delta", delta: "done" },
        {
          type: "response.completed",
          response: { id: "resp-2", status: "completed", usage: {} },
        },
      ],
    ]);
    const connect = vi.fn(async (_input: CodexResponsesWebSocketConnectInput) => connection);
    const fetchMock = vi.fn();
    const responseMetadata: Headers[] = [];
    const client = createCodexResponsesClient({
      config: {
        baseUrl: "https://chatgpt.com/backend-api/codex",
        getAuthHeader: async () => `Bearer ${jwt("acct_ws")}`,
        responsesWebSocketConnector: connect,
        onResponseMeta: (headers) => responseMetadata.push(headers),
        userAgent: "codex_cli_rs/9.9.9",
      },
      fetch: fetchMock as unknown as typeof fetch,
    });

    const requests = [
      carrier(
        "ingress-1",
        {
          model: "gpt-5.6-sol",
          input: [],
          stream: true,
          store: false,
          generate: false,
        },
        {
          "user-agent": "codex_cli_rs/1.2.3 (Mac OS 15.5; arm64) Apple_Terminal/455",
          version: "1.2.3",
        },
      ),
      carrier("ingress-1", {
        model: "gpt-5.6-sol",
        input: [{ type: "message", role: "user", content: [] }],
        stream: true,
        store: false,
        previous_response_id: "warm-1",
      }),
      carrier("ingress-1", {
        model: "gpt-5.6-sol",
        input: [{ type: "function_call_output", call_id: "call-1", output: "ok" }],
        stream: true,
        store: false,
        previous_response_id: "resp-1",
      }),
    ];
    const turns: string[] = [];
    for (const request of requests) {
      const chunks: string[] = [];
      for await (const chunk of client.nativePassthroughStream?.(request) ?? []) {
        chunks.push(chunk);
      }
      turns.push(chunks.join(""));
    }

    expect(fetchMock).not.toHaveBeenCalled();
    expect(connect).toHaveBeenCalledTimes(1);
    const connectArgs = connect.mock.calls[0]?.[0];
    expect(connectArgs?.url).toBe("wss://chatgpt.com/backend-api/codex/responses");
    expect(new Headers(connectArgs?.headers).get("authorization")).toContain("Bearer ");
    expect(new Headers(connectArgs?.headers).get("chatgpt-account-id")).toBe("acct_ws");
    expect(new Headers(connectArgs?.headers).get("openai-beta")).toBe(
      "responses_websockets=2026-02-06",
    );
    expect(new Headers(connectArgs?.headers).get("user-agent")).toBe(
      "codex_cli_rs/1.2.3 (Mac OS 15.5; arm64) Apple_Terminal/455",
    );
    expect(new Headers(connectArgs?.headers).get("version")).toBe("1.2.3");
    expect(new Headers(connectArgs?.headers).get("session-id")).toBe("client-session");
    expect(
      new Headers(connectArgs?.headers).get(CODEX_RESPONSES_WEBSOCKET_SESSION_HEADER),
    ).toBeNull();
    expect(connection.sent.map((text) => JSON.parse(text))).toEqual([
      expect.objectContaining({
        type: "response.create",
        model: "gpt-5.6-sol",
        generate: false,
      }),
      expect.objectContaining({
        type: "response.create",
        previous_response_id: "warm-1",
      }),
      expect.objectContaining({
        type: "response.create",
        previous_response_id: "resp-1",
      }),
    ]);
    expect(turns[0]).toContain("response.completed");
    expect(turns[1]).toContain("function_call");
    expect(turns[2]).toContain('"delta":"done"');
    expect(responseMetadata).toHaveLength(1);
    expect(responseMetadata[0]?.get("x-models-etag")).toBe('"models-ws-1"');
  });

  it("falls back to HTTP after a websocket 426 and keeps the named session on HTTP", async () => {
    const connect = vi.fn(async () => {
      throw new CodexResponsesWebSocketConnectError("upgrade required", {
        status: 426,
        body: JSON.stringify({ error: { message: "websocket unavailable" } }),
      });
    });
    const fetchMock = vi.fn(async () =>
      rawSSEResponse(
        'event: response.completed\ndata: {"type":"response.completed","response":{"status":"completed","usage":{}}}\n\n',
      ),
    );
    const client = createCodexResponsesClient({
      config: {
        baseUrl: "https://chatgpt.com/backend-api/codex",
        getAuthHeader: async () => `Bearer ${jwt("acct_426")}`,
        responsesWebSocketConnector: connect,
      },
      fetch: fetchMock as unknown as typeof fetch,
    });
    const request = carrier("ingress-426", {
      model: "gpt-5.6-sol",
      input: [],
      stream: true,
      store: false,
    });

    for (let turn = 0; turn < 2; turn += 1) {
      const chunks: string[] = [];
      for await (const chunk of client.nativePassthroughStream?.(request) ?? []) {
        chunks.push(chunk);
      }
      expect(chunks.join("")).toContain("response.completed");
    }

    expect(connect).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it.each([
    "response.failed",
    "response.incomplete",
    "error",
  ] as const)("closes the upstream websocket before yielding %s and reconnects after iterator.return", async (terminalType) => {
    const first = fakeConnection([
      [
        {
          type: terminalType,
          ...(terminalType === "error"
            ? { code: "synthetic_error", message: "synthetic websocket error" }
            : {
                response: {
                  status: terminalType === "response.failed" ? "failed" : "incomplete",
                },
              }),
        },
      ],
      [
        {
          type: "response.completed",
          response: { id: "unexpected-reuse", status: "completed", usage: {} },
        },
      ],
    ]);
    const second = fakeConnection([
      [
        { type: "response.created", response: { id: "resp-next" } },
        {
          type: "response.completed",
          response: { id: "resp-next", status: "completed", usage: {} },
        },
      ],
    ]);
    const connect = vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(second);
    const client = createCodexResponsesClient({
      config: {
        baseUrl: "https://chatgpt.com/backend-api/codex",
        getAuthHeader: async () => `Bearer ${jwt("acct_terminal")}`,
        responsesWebSocketConnector: connect,
      },
    });
    const request = carrier("ingress-terminal", {
      model: "gpt-5.6-sol",
      input: [],
      stream: true,
      store: false,
    });

    const firstIterator = client.nativePassthroughStream?.(request)[Symbol.asyncIterator]();
    expect(firstIterator).toBeDefined();
    const terminal = await firstIterator?.next();
    expect(terminal).toMatchObject({ done: false });
    expect(terminal?.value).toContain(terminalType);
    expect(first.closeCalls).toBe(1);
    await firstIterator?.return?.();

    const secondTurn: string[] = [];
    for await (const chunk of client.nativePassthroughStream?.(request) ?? []) {
      secondTurn.push(chunk);
    }

    expect(connect).toHaveBeenCalledTimes(2);
    expect(secondTurn.join("")).toContain("response.completed");
  });

  it.each([
    ["status", 401],
    ["status_code", 429],
  ] as const)("closes and throws a wrapped websocket error carrying %s=%i", async (statusField, status) => {
    const responseMetadata: Headers[] = [];
    const connection = fakeConnection([
      [
        {
          type: "error",
          [statusField]: status,
          error: {
            code: status === 429 ? "rate_limit_exceeded" : "invalid_api_key",
            message: status === 429 ? "quota exhausted" : "credential rejected",
          },
          headers: {
            "retry-after": 17,
            "x-codex-active-limit": "codex_luna",
            "x-codex-luna-primary-used-percent": 100,
          },
        },
      ],
    ]);
    const connect = vi.fn(async () => connection);
    const client = createCodexResponsesClient({
      config: {
        baseUrl: "https://chatgpt.com/backend-api/codex",
        getAuthHeader: async () => `Bearer ${jwt("acct_wrapped_error")}`,
        responsesWebSocketConnector: connect,
        onResponseMeta: (headers) => responseMetadata.push(headers),
      },
    });
    const iterator = client
      .nativePassthroughStream?.(
        carrier(`ingress-wrapped-${status}`, {
          model: "gpt-5.6-luna",
          input: [],
          stream: true,
          store: false,
        }),
      )
      [Symbol.asyncIterator]();

    let caught: unknown;
    try {
      await iterator?.next();
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(UpstreamError);
    expect((caught as UpstreamError).upstreamStatus).toBe(status);
    expect((caught as UpstreamError).message).toBe(
      status === 429 ? "quota exhausted" : "credential rejected",
    );
    expect(connection.closeCalls).toBe(1);
    expect(connect).toHaveBeenCalledTimes(1);
    if (status === 429) {
      expect((caught as UpstreamError).providerRaw).toMatchObject({
        headers: {
          "retry-after": "17",
          "x-codex-active-limit": "codex_luna",
          "x-codex-luna-primary-used-percent": "100",
        },
      });
      expect(
        responseMetadata.some(
          (headers) => headers.get("x-codex-luna-primary-used-percent") === "100",
        ),
      ).toBe(true);
    }
  });

  it("reconnects after websocket_connection_limit_reached and completes the same turn", async () => {
    const first = fakeConnection([
      [
        {
          type: "error",
          status: 400,
          error: {
            code: "websocket_connection_limit_reached",
            message: "Create a new websocket connection to continue.",
          },
        },
      ],
    ]);
    const second = fakeConnection([
      [
        { type: "response.created", response: { id: "resp-reconnected" } },
        {
          type: "response.completed",
          response: { id: "resp-reconnected", status: "completed", usage: {} },
        },
      ],
    ]);
    const connect = vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(second);
    const client = createCodexResponsesClient({
      config: {
        baseUrl: "https://chatgpt.com/backend-api/codex",
        getAuthHeader: async () => `Bearer ${jwt("acct_connection_limit")}`,
        responsesWebSocketConnector: connect,
        connectRetries: 1,
        connectRetryBackoffMs: [0],
      },
    });
    const chunks: string[] = [];

    for await (const chunk of client.nativePassthroughStream?.(
      carrier("ingress-connection-limit", {
        model: "gpt-5.6-sol",
        input: [],
        stream: true,
        store: false,
      }),
    ) ?? []) {
      chunks.push(chunk);
    }

    expect(first.closeCalls).toBe(1);
    expect(connect).toHaveBeenCalledTimes(2);
    expect(chunks.join("")).toContain("response.completed");
  });

  it("retries a status-less websocket handshake failure then keeps the session on HTTP", async () => {
    const connect = vi.fn(async () => {
      throw new CodexResponsesWebSocketConnectError("socket hang up");
    });
    const fetchMock = vi.fn(async () =>
      rawSSEResponse(
        'event: response.completed\ndata: {"type":"response.completed","response":{"status":"completed","usage":{}}}\n\n',
      ),
    );
    const client = createCodexResponsesClient({
      config: {
        baseUrl: "https://chatgpt.com/backend-api/codex",
        getAuthHeader: async () => `Bearer ${jwt("acct_ws_fallback")}`,
        responsesWebSocketConnector: connect,
        connectRetries: 2,
        connectRetryBackoffMs: [0],
      },
      fetch: fetchMock as unknown as typeof fetch,
    });
    const request = carrier("ingress-network-fallback", {
      model: "gpt-5.6-sol",
      input: [],
      stream: true,
      store: false,
    });

    for (let turn = 0; turn < 2; turn += 1) {
      const chunks: string[] = [];
      for await (const chunk of client.nativePassthroughStream?.(request) ?? []) {
        chunks.push(chunk);
      }
      expect(chunks.join("")).toContain("response.completed");
    }

    expect(connect).toHaveBeenCalledTimes(3);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("consumes codex.rate_limits events and publishes them through response metadata", async () => {
    const connection = fakeConnection([
      [
        {
          type: "codex.rate_limits",
          plan_type: "plus",
          rate_limits: {
            allowed: true,
            limit_reached: false,
            primary: {
              used_percent: 42,
              window_minutes: 60,
              reset_at: 1_700_000_000,
            },
            secondary: null,
          },
          credits: {
            has_credits: true,
            unlimited: false,
            balance: "123",
          },
        },
        { type: "response.created", response: { id: "resp-quota" } },
        {
          type: "response.completed",
          response: { id: "resp-quota", status: "completed", usage: {} },
        },
      ],
    ]);
    const globalMetadata: Headers[] = [];
    const callMetadata: Headers[] = [];
    const client = createCodexResponsesClient({
      config: {
        baseUrl: "https://chatgpt.com/backend-api/codex",
        getAuthHeader: async () => `Bearer ${jwt("acct_rate_limits")}`,
        responsesWebSocketConnector: vi.fn(async () => connection),
        onResponseMeta: (headers) => globalMetadata.push(headers),
      },
    });
    const chunks: string[] = [];

    for await (const chunk of client.nativePassthroughStream?.(
      carrier("ingress-rate-limits", {
        model: "gpt-5.6-sol",
        input: [],
        stream: true,
        store: false,
      }),
      { onResponseMeta: (headers) => callMetadata.push(headers) },
    ) ?? []) {
      chunks.push(chunk);
    }

    expect(chunks.join("")).not.toContain("codex.rate_limits");
    expect(chunks.join("")).toContain("response.created");
    expect(chunks.join("")).toContain("response.completed");
    for (const metadata of [globalMetadata, callMetadata]) {
      const quota = metadata.find(
        (headers) => headers.get("x-codex-primary-used-percent") === "42",
      );
      expect(quota?.get("x-codex-primary-window-minutes")).toBe("60");
      expect(quota?.get("x-codex-primary-reset-at")).toBe("1700000000");
      expect(quota?.get("x-codex-credits-has-credits")).toBe("true");
      expect(quota?.get("x-codex-credits-unlimited")).toBe("false");
      expect(quota?.get("x-codex-credits-balance")).toBe("123");
      expect(quota?.get("x-codex-plan-type")).toBe("plus");
    }
  });

  it.each([
    ["invalid JSON", "not-json"],
    ["an untyped JSON event", JSON.stringify({ response: { status: "in_progress" } })],
  ])("destroys the upstream websocket session after %s", async (_label, malformedEvent) => {
    const first = fakeConnection([[malformedEvent]]);
    const second = fakeConnection([
      [
        { type: "response.created", response: { id: "resp-next" } },
        {
          type: "response.completed",
          response: { id: "resp-next", status: "completed", usage: {} },
        },
      ],
    ]);
    const connect = vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(second);
    const client = createCodexResponsesClient({
      config: {
        baseUrl: "https://chatgpt.com/backend-api/codex",
        getAuthHeader: async () => `Bearer ${jwt("acct_malformed")}`,
        responsesWebSocketConnector: connect,
      },
    });
    const request = carrier("ingress-malformed", {
      model: "gpt-5.6-sol",
      input: [],
      stream: true,
      store: false,
    });

    const firstIterator = client.nativePassthroughStream?.(request)[Symbol.asyncIterator]();
    await expect(firstIterator?.next()).rejects.toMatchObject({
      name: "UpstreamError",
      errorClass: "upstream_error",
    });
    const secondTurn: string[] = [];
    for await (const chunk of client.nativePassthroughStream?.(request) ?? []) {
      secondTurn.push(chunk);
    }

    expect(first.closeCalls).toBe(1);
    expect(connect).toHaveBeenCalledTimes(2);
    expect(secondTurn.join("")).toContain("response.completed");
  });

  it("preserves a Responses Lite incremental continuation without re-inserting tools", async () => {
    const connection = fakeConnection([
      [
        { type: "response.created", response: { id: "resp-2" } },
        { type: "response.output_text.delta", delta: "done" },
        {
          type: "response.completed",
          response: { id: "resp-2", status: "completed", usage: {} },
        },
      ],
    ]);
    const connect = vi.fn(async (_input: CodexResponsesWebSocketConnectInput) => connection);
    const client = createCodexResponsesClient({
      config: {
        baseUrl: "https://chatgpt.com/backend-api/codex",
        getAuthHeader: async () => `Bearer ${jwt("acct_ws_lite")}`,
        responsesWebSocketConnector: connect,
        resolveModelInfo: (model) =>
          model === "gpt-5.6-sol" ? codexModelInfo({ use_responses_lite: true }) : undefined,
      },
    });
    const output = {
      type: "custom_tool_call_output",
      call_id: "call-1",
      output: "HELM_TOOL_OK\n",
    };

    for await (const _chunk of client.nativePassthroughStream?.(
      carrier("ingress-lite-continuation", {
        model: "gpt-5.6-sol",
        input: [output],
        stream: true,
        store: false,
        previous_response_id: "resp-1",
        client_metadata: {
          ws_request_header_x_openai_internal_codex_responses_lite: "true",
        },
      }),
    ) ?? []) {
      // drain
    }

    expect(connection.sent.map((text) => JSON.parse(text))).toEqual([
      expect.objectContaining({
        type: "response.create",
        previous_response_id: "resp-1",
        input: [output],
      }),
    ]);
  });

  it("closes a named websocket session and reconnects on its next request", async () => {
    const first = fakeConnection([
      [
        { type: "response.created", response: { id: "resp-1" } },
        { type: "response.completed", response: { id: "resp-1", status: "completed" } },
      ],
    ]);
    const second = fakeConnection([
      [
        { type: "response.created", response: { id: "resp-2" } },
        { type: "response.completed", response: { id: "resp-2", status: "completed" } },
      ],
    ]);
    const connect = vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(second);
    const client = createCodexResponsesClient({
      config: {
        baseUrl: "https://chatgpt.com/backend-api/codex",
        getAuthHeader: async () => `Bearer ${jwt("acct")}`,
        responsesWebSocketConnector: connect,
        userAgent: "codex_cli_rs/7.8.9 (darwin 24.0; arm64) Apple_Terminal/455",
      },
    });
    const request = carrier("ingress-close", {
      model: "gpt-5.6-terra",
      input: [],
      stream: true,
      store: false,
    });

    for await (const _chunk of client.nativePassthroughStream?.(request) ?? []) {
      // drain
    }
    await client.closeResponsesWebSocketSession?.("ingress-close");
    for await (const _chunk of client.nativePassthroughStream?.(request) ?? []) {
      // drain
    }

    expect(first.closeCalls).toBe(1);
    expect(connect).toHaveBeenCalledTimes(2);
    expect(new Headers(connect.mock.calls[0]?.[0].headers).get("version")).toBe("7.8.9");
  });

  it("invalidates and retries the websocket handshake once after a 401", async () => {
    let token = "expired-token";
    const authHeaders: string[] = [];
    const connection = fakeConnection([
      [
        { type: "response.created", response: { id: "resp-ok" } },
        { type: "response.completed", response: { id: "resp-ok", status: "completed" } },
      ],
    ]);
    const connect = vi.fn(async (input: { headers: Record<string, string> }) => {
      authHeaders.push(new Headers(input.headers).get("authorization") ?? "");
      if (authHeaders.length === 1) {
        throw new CodexResponsesWebSocketConnectError("unauthorized", {
          status: 401,
          body: JSON.stringify({ error: { message: "expired" } }),
        });
      }
      return connection;
    });
    const client = createCodexResponsesClient({
      config: {
        baseUrl: "https://chatgpt.com/backend-api/codex",
        getAuthHeader: async () => `Bearer ${token}`,
        onUnauthorized: () => {
          token = jwt("acct_refreshed");
        },
        responsesWebSocketConnector: connect,
      },
    });

    for await (const _chunk of client.nativePassthroughStream?.(
      carrier("ingress-401", {
        model: "gpt-5.6-luna",
        input: [],
        stream: true,
        store: false,
      }),
    ) ?? []) {
      // drain
    }

    expect(connect).toHaveBeenCalledTimes(2);
    expect(authHeaders).toEqual(["Bearer expired-token", `Bearer ${jwt("acct_refreshed")}`]);
  });

  it("maps a websocket handshake 429 to an account-scoped UpstreamError", async () => {
    const connect = vi.fn(async () => {
      throw new CodexResponsesWebSocketConnectError("rate limited", {
        status: 429,
        headers: new Headers({
          "retry-after": "17",
          "x-codex-primary-used-percent": "100",
        }),
        body: JSON.stringify({ error: { message: "quota exhausted" } }),
      });
    });
    const client = createCodexResponsesClient({
      config: {
        baseUrl: "https://chatgpt.com/backend-api/codex",
        getAuthHeader: async () => `Bearer ${jwt("acct")}`,
        responsesWebSocketConnector: connect,
      },
    });

    let caught: unknown;
    try {
      for await (const _chunk of client.nativePassthroughStream?.(
        carrier("ingress-429", {
          model: "gpt-5.6-sol",
          input: [],
          stream: true,
          store: false,
        }),
      ) ?? []) {
        // should not yield
      }
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(UpstreamError);
    expect((caught as UpstreamError).upstreamStatus).toBe(429);
    expect((caught as UpstreamError).providerRaw).toEqual({
      body: { error: { message: "quota exhausted" } },
      headers: {
        "retry-after": "17",
        "x-codex-primary-used-percent": "100",
      },
    });
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

describe("createCodexResponsesClient — responsesCompact", () => {
  it("posts the native carrier to /responses/compact with Codex headers and per-call metadata", async () => {
    const body = {
      model: "gpt-5.6-sol",
      input: [{ type: "message", role: "user", content: "compact this" }],
      instructions: "Keep the useful context.",
      parallel_tool_calls: false,
      reasoning: { effort: "high", summary: "auto", context: "all_turns" },
    };
    const rawBody = JSON.stringify(body, null, 2);
    const carrier = {
      protocol: "openai_responses" as const,
      body,
      raw_body: rawBody,
      headers: {
        authorization: "Bearer client-secret",
        accept: "application/json",
        "user-agent": "codex_cli_rs/1.2.3 (Mac OS 15.5; arm64) Apple_Terminal/455",
        version: "1.2.3",
        originator: "codex_vscode",
        "session-id": "client-session",
        "thread-id": "client-thread",
        "x-client-request-id": "client-request",
        "x-codex-turn-state": "turn-before",
        "x-codex-beta-features": "responses_lite_v2",
        "x-codex-installation-id": "install-1",
        "x-openai-internal-codex-responses-lite": "true",
        "x-openai-fedramp": "true",
        "x-helm-trace": "drop-me",
        "content-length": "999",
      },
      mutations: {},
    };
    let seenUrl = "";
    let seenHeaders = new Headers();
    let seenBody = "";
    const globalMetadata: Headers[] = [];
    const callMetadata: Headers[] = [];
    const client = createCodexResponsesClient({
      config: {
        baseUrl: "https://chatgpt.com/backend-api/codex/responses",
        getAuthHeader: async () => `Bearer ${jwt("acct_compact")}`,
        sessionId: "provider-session",
        threadId: "provider-thread",
        userAgent: "codex_cli_rs/9.9.9 (darwin 24.0; arm64) node/v22.0.0",
        isFedramp: true,
        resolveModelInfo: () => codexModelInfo({ use_responses_lite: true }),
        onResponseMeta: (headers) => globalMetadata.push(headers),
      },
      fetch: (async (url: string, init?: RequestInit) => {
        seenUrl = String(url);
        seenHeaders = new Headers(init?.headers);
        seenBody = String(init?.body);
        return new Response(JSON.stringify({ output: [{ type: "message", role: "assistant" }] }), {
          status: 200,
          headers: {
            "Content-Type": "application/json",
            "x-codex-turn-state": "turn-after",
            "x-request-id": "req-compact",
          },
        });
      }) as unknown as typeof fetch,
    });

    const output = await client.responsesCompact?.(carrier, {
      onResponseMeta: (headers) => callMetadata.push(headers),
    });

    expect(output).toEqual({ output: [{ type: "message", role: "assistant" }] });
    expect(seenUrl).toBe("https://chatgpt.com/backend-api/codex/responses/compact");
    expect(JSON.parse(seenBody)).toEqual({
      model: "gpt-5.6-sol",
      input: [
        { type: "additional_tools", role: "developer", tools: [] },
        {
          type: "message",
          role: "developer",
          content: [{ type: "input_text", text: "Keep the useful context." }],
        },
        { type: "message", role: "user", content: "compact this" },
      ],
      parallel_tool_calls: false,
      reasoning: { effort: "high", summary: "auto", context: "all_turns" },
    });
    expect(seenHeaders.get("authorization")).toContain("Bearer ");
    expect(seenHeaders.get("authorization")).not.toContain("client-secret");
    expect(seenHeaders.get("chatgpt-account-id")).toBe("acct_compact");
    expect(seenHeaders.get("accept")).toBe("application/json");
    expect(seenHeaders.get("user-agent")).toBe(
      "codex_cli_rs/1.2.3 (Mac OS 15.5; arm64) Apple_Terminal/455",
    );
    expect(seenHeaders.get("version")).toBe("1.2.3");
    expect(seenHeaders.get("originator")).toBe("codex_vscode");
    expect(seenHeaders.get("session-id")).toBe("client-session");
    expect(seenHeaders.get("thread-id")).toBe("client-thread");
    expect(seenHeaders.get("x-client-request-id")).toBe("client-request");
    expect(seenHeaders.get("x-codex-turn-state")).toBe("turn-before");
    expect(seenHeaders.get("x-codex-beta-features")).toBe("responses_lite_v2");
    expect(seenHeaders.get("x-codex-installation-id")).toBe("install-1");
    expect(seenHeaders.get("x-openai-internal-codex-responses-lite")).toBe("true");
    expect(seenHeaders.get("x-openai-fedramp")).toBe("true");
    expect(seenHeaders.get("session_id")).toBeNull();
    expect(seenHeaders.get("x-helm-trace")).toBeNull();
    expect(seenHeaders.get("content-length")).toBeNull();
    expect(carrier.mutations).toMatchObject({
      auth_replaced: true,
      content_length_recomputed: true,
      headers_dropped: expect.arrayContaining(["authorization", "content-length", "x-helm-trace"]),
    });
    expect(globalMetadata).toHaveLength(1);
    expect(callMetadata).toHaveLength(1);
    expect(globalMetadata[0]?.get("x-codex-turn-state")).toBe("turn-after");
    expect(callMetadata[0]?.get("x-codex-turn-state")).toBe("turn-after");
  });

  it("uses a Codex-format configured fallback UA when a native carrier has no User-Agent", async () => {
    let seen = new Headers();
    const client = createCodexResponsesClient({
      config: {
        baseUrl: "https://chatgpt.com/backend-api/codex",
        getAuthHeader: async () => `Bearer ${jwt("acct")}`,
        userAgent: "codex_cli_rs/1.2.3 (darwin 24.0; arm64) node/v22.0.0",
      },
      fetch: (async (_url: string, init?: RequestInit) => {
        seen = new Headers(init?.headers);
        return jsonResponse({ output: [] });
      }) as unknown as typeof fetch,
    });

    await client.responsesCompact?.({
      protocol: "openai_responses",
      body: { model: "gpt-5.5", input: [] },
      headers: {},
      mutations: {},
    });

    expect(seen.get("user-agent")).toMatch(/^codex_cli_rs\/1\.2\.3 \(.+ .+; .+\) \S+$/);
    expect(seen.get("user-agent")).not.toMatch(/\bnode\//i);
    expect(seen.get("version")).toBe("1.2.3");
  });

  it.each([
    "nativePassthrough",
    "responsesCompact",
  ] as const)("keeps the timeout active while %s reads the complete unary response body", async (method) => {
    vi.useFakeTimers();
    try {
      const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
        const signal = init?.signal;
        const encoder = new TextEncoder();
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(encoder.encode('{"output":['));
              const abort = () =>
                controller.error(new DOMException("The operation was aborted", "AbortError"));
              if (signal?.aborted) abort();
              else signal?.addEventListener("abort", abort, { once: true });
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      });
      const client = createCodexResponsesClient({
        config: {
          baseUrl: "https://chatgpt.com/backend-api/codex",
          getAuthHeader: async () => `Bearer ${jwt("acct")}`,
          timeoutMs: 50,
        },
        fetch: fetchMock as unknown as typeof fetch,
      });
      const run =
        method === "nativePassthrough"
          ? client.nativePassthrough?.({ model: "gpt-5.5", input: [] })
          : client.responsesCompact?.({ model: "gpt-5.5", input: [] });
      let outcome: unknown = "pending";
      void run?.then(
        (value) => {
          outcome = value;
        },
        (error: unknown) => {
          outcome = error;
        },
      );

      await vi.advanceTimersByTimeAsync(50);
      await Promise.resolve();

      expect(outcome).toBeInstanceOf(UpstreamError);
      expect(outcome).toMatchObject({ errorClass: "timeout" });
    } finally {
      vi.useRealTimers();
    }
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

  it("redacts a static apiKey echoed in a generic Responses upstream error body", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({ error: { message: "invalid key sk-secret-1234 supplied" } }, 500),
    );
    const client = createGenericOpenAIResponsesClient({
      config: { baseUrl: "https://api.openai.test/v1", apiKey: "sk-secret-1234" },
      fetch: fetchMock as unknown as typeof fetch,
    });

    await expect(client.nativePassthrough?.({ model: "gpt-5.5", input: "hi" })).rejects.toThrow();
    try {
      await client.nativePassthrough?.({ model: "gpt-5.5", input: "hi" });
      throw new Error("expected throw");
    } catch (err) {
      const raw = JSON.stringify((err as UpstreamError).providerRaw);
      expect(raw).not.toContain("sk-secret-1234");
      expect(raw).toContain("[redacted]");
    }
  });

  it("rebuilds the Authorization header after a 401 so the OAuth retry uses the refreshed token", async () => {
    let token = "old-token";
    const seen: string[] = [];
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const auth = new Headers(init?.headers).get("Authorization") ?? "";
      seen.push(auth);
      if (auth === "Bearer old-token") return jsonResponse({ error: "unauthorized" }, 401);
      return jsonResponse({ id: "resp_ok", object: "response", status: "completed" });
    });
    const client = createGenericOpenAIResponsesClient({
      config: {
        baseUrl: "https://api.openai.test/v1",
        getAuthHeader: async () => `Bearer ${token}`,
        onUnauthorized: () => {
          token = "new-token";
        },
      },
      fetch: fetchMock as unknown as typeof fetch,
    });

    const out = (await client.nativePassthrough?.({ model: "gpt-5.5", input: "hi" })) as {
      id: string;
    };
    // Retry carried the REFRESHED token, not the stale one.
    expect(seen).toEqual(["Bearer old-token", "Bearer new-token"]);
    expect(out.id).toBe("resp_ok");
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

// hoistResponsesInstructions — the native-passthrough repair for the ChatGPT-account
// Codex backend, which MANDATES a non-empty top-level `instructions`. Standard-OpenAI
// Responses clients (e.g. pi-ai / pi-coding-agent) put the system prompt as a leading
// `developer`/`system` item inside `input` and omit `instructions` — valid for the
// public API but rejected by the Codex backend ("Instructions are required"). On the
// verbatim passthrough path this pure shim hoists that content into `instructions` and
// strips the hoisted items, mirroring the translate path's buildInstructions split.
describe("hoistResponsesInstructions", () => {
  it("hoists a leading developer item (pi-ai reasoning shape) into instructions and strips it", () => {
    const { body, fix } = hoistResponsesInstructions({
      model: "gpt-5.5",
      input: [
        { role: "developer", content: "You are Mimi, an AI employee at AgentCrew." },
        { role: "user", content: "hi" },
      ],
      stream: true,
    });
    expect(fix).toBe("hoisted_from_input");
    expect(body.instructions).toBe("You are Mimi, an AI employee at AgentCrew.");
    expect(body.input).toEqual([{ role: "user", content: "hi" }]);
    // top-level siblings preserved
    expect(body.model).toBe("gpt-5.5");
    expect(body.stream).toBe(true);
  });

  it("hoists a leading system item (non-reasoning shape) into instructions", () => {
    const { body, fix } = hoistResponsesInstructions({
      input: [
        { role: "system", content: "You are helpful." },
        { role: "user", content: "q" },
      ],
    });
    expect(fix).toBe("hoisted_from_input");
    expect(body.instructions).toBe("You are helpful.");
    expect(body.input).toEqual([{ role: "user", content: "q" }]);
  });

  it("joins multiple system/developer items with a blank line, in order", () => {
    const { body, fix } = hoistResponsesInstructions({
      input: [
        { role: "system", content: "A" },
        { role: "developer", content: "B" },
        { role: "user", content: "q" },
      ],
    });
    expect(fix).toBe("hoisted_from_input");
    expect(body.instructions).toBe("A\n\nB");
    expect(body.input).toEqual([{ role: "user", content: "q" }]);
  });

  it("extracts text from array (input_text) content", () => {
    const { body, fix } = hoistResponsesInstructions({
      input: [
        { role: "developer", content: [{ type: "input_text", text: "SYS" }] },
        { role: "user", content: "q" },
      ],
    });
    expect(fix).toBe("hoisted_from_input");
    expect(body.instructions).toBe("SYS");
    expect(body.input).toEqual([{ role: "user", content: "q" }]);
  });

  it("leaves the body verbatim (same reference) when instructions is already present", () => {
    const original = {
      instructions: "real codex base prompt",
      input: [{ role: "user", content: "hi" }],
    };
    const { body, fix } = hoistResponsesInstructions(original);
    expect(fix).toBe("none");
    expect(body).toBe(original);
  });

  it("treats whitespace-only instructions as empty and hoists", () => {
    const { body, fix } = hoistResponsesInstructions({
      instructions: "   ",
      input: [
        { role: "developer", content: "SYS" },
        { role: "user", content: "q" },
      ],
    });
    expect(fix).toBe("hoisted_from_input");
    expect(body.instructions).toBe("SYS");
  });

  it("falls back to the default when instructions is absent and there is no system content", () => {
    const { body, fix } = hoistResponsesInstructions({
      input: [{ role: "user", content: "hi" }],
    });
    expect(fix).toBe("defaulted");
    expect(body.instructions).toBe("You are a helpful assistant.");
    // input is untouched in the defaulted branch
    expect(body.input).toEqual([{ role: "user", content: "hi" }]);
  });

  it("does not mutate the input body (returns a new object on repair)", () => {
    const original: Record<string, unknown> = {
      input: [
        { role: "developer", content: "SYS" },
        { role: "user", content: "q" },
      ],
    };
    const { body } = hoistResponsesInstructions(original);
    expect(body).not.toBe(original);
    expect("instructions" in original).toBe(false);
    expect(original.input).toHaveLength(2);
  });

  it("does not hoist developer items when Responses Lite is detected", () => {
    const original = {
      model: "gpt-5.6-sol",
      input: [
        { type: "additional_tools", role: "developer", tools: [] },
        { type: "message", role: "developer", content: "Stay in input." },
        { role: "user", content: "q" },
      ],
    };
    const fromHeader = hoistResponsesInstructions(original, {
      headers: { "x-openai-internal-codex-responses-lite": "true" },
    });
    const fromMetadata = hoistResponsesInstructions(original, {
      modelInfo: codexModelInfo({ use_responses_lite: true }),
    });
    expect(fromHeader).toEqual({ body: original, fix: "none" });
    expect(fromMetadata).toEqual({ body: original, fix: "none" });
  });
});

describe("sanitizeCodexResponsesNativeBody", () => {
  it("removes Codex-unsupported caps and store:false persisted item references", () => {
    const { body, fixes } = sanitizeCodexResponsesNativeBody({
      model: "gpt-5.5",
      store: false,
      max_output_tokens: 512,
      temperature: 0.2,
      input: [
        {
          type: "reasoning",
          id: "rs_missing",
          status: "completed",
          content: [],
          summary: [],
        },
        {
          type: "message",
          role: "assistant",
          id: "msg_missing",
          status: "completed",
          phase: "final_answer",
          content: [{ type: "output_text", text: "NO_REPLY" }],
        },
        { role: "user", content: [{ type: "input_text", text: "next" }] },
      ],
    });

    expect(fixes).toEqual([
      "empty_reasoning_items_dropped",
      "input_item_references_stripped",
      "max_output_tokens_removed",
      "temperature_removed",
    ]);
    expect(body).toEqual({
      model: "gpt-5.5",
      store: false,
      input: [
        {
          type: "message",
          role: "assistant",
          status: "completed",
          phase: "final_answer",
          content: [{ type: "output_text", text: "NO_REPLY" }],
        },
        { role: "user", content: [{ type: "input_text", text: "next" }] },
      ],
    });
  });

  it("preserves useful encrypted reasoning while stripping its volatile item metadata", () => {
    const { body } = sanitizeCodexResponsesNativeBody({
      model: "gpt-5.5",
      store: false,
      input: [
        {
          type: "reasoning",
          id: "rs_1",
          encrypted_content: "enc",
          summary: [],
        },
      ],
    });

    expect(body.input).toEqual([{ type: "reasoning", encrypted_content: "enc", summary: [] }]);
  });

  it("handles non-array input: passes through unchanged when store:false but input is not an array", () => {
    // Lines 247-248: sanitizeStoreFalseInputItems returns early when input is not an array
    const { body, fixes } = sanitizeCodexResponsesNativeBody({
      model: "gpt-5.5",
      store: false,
      input: "a plain string input",
    });
    // No mutation, no fixes related to input items
    expect(body.input).toBe("a plain string input");
    expect(fixes).not.toContain("input_item_references_stripped");
    expect(fixes).not.toContain("empty_reasoning_items_dropped");
  });

  it("passes through non-record items (primitives) in the input array unchanged", () => {
    // Lines 255-257: non-record items (e.g. strings/numbers) in the array are passed through
    const { body } = sanitizeCodexResponsesNativeBody({
      model: "gpt-5.5",
      store: false,
      input: ["a string item", 42, { role: "user", content: "normal item" }],
    });
    // The string and number primitives must survive unchanged
    const input = body.input as unknown[];
    expect(input[0]).toBe("a string item");
    expect(input[1]).toBe(42);
  });
});

describe("openaiToGenericResponsesRequest — tools and reasoning_effort", () => {
  it("maps reasoning_effort to body.reasoning.effort", () => {
    const body = openaiToGenericResponsesRequest({
      model: "gpt-5.5",
      messages: [{ role: "user", content: "hi" }],
      reasoning_effort: "high",
    } as unknown as Parameters<typeof openaiToGenericResponsesRequest>[0]);
    expect(body.reasoning).toEqual({ effort: "high" });
  });

  it("maps tools array to Responses function format", () => {
    const body = openaiToGenericResponsesRequest({
      model: "gpt-5.5",
      messages: [{ role: "user", content: "go" }],
      tools: [
        {
          type: "function",
          function: {
            name: "search",
            description: "Web search",
            parameters: { type: "object", properties: { q: { type: "string" } } },
          },
        },
      ],
    } as unknown as Parameters<typeof openaiToGenericResponsesRequest>[0]);
    expect(body.tools).toEqual([
      {
        type: "function",
        name: "search",
        description: "Web search",
        parameters: { type: "object", properties: { q: { type: "string" } } },
        strict: false,
      },
    ]);
  });

  it("drops tools with no function.name", () => {
    const body = openaiToGenericResponsesRequest({
      model: "gpt-5.5",
      messages: [],
      tools: [{ type: "function", function: { description: "no name" } }],
    } as unknown as Parameters<typeof openaiToGenericResponsesRequest>[0]);
    expect(body.tools).toBeUndefined();
  });

  it("sets stream:true when req.stream is true", () => {
    const body = openaiToGenericResponsesRequest({
      model: "gpt-5.5",
      messages: [],
      stream: true,
    } as unknown as Parameters<typeof openaiToGenericResponsesRequest>[0]);
    expect(body.stream).toBe(true);
  });
});

describe("createGenericOpenAIResponsesClient — chatCompletionStream", () => {
  it("translates an OpenAI chat request to generic Responses and yields SSE chunks", async () => {
    const fetchMock = vi.fn(async () =>
      sseResponse([
        { type: "response.created", response: { id: "r1", status: "in_progress" } },
        { type: "response.output_item.added", item: { type: "message", content: [] } },
        { type: "response.output_text.delta", delta: "Hello", output_index: 0, content_index: 0 },
        { type: "response.output_text.done", text: "Hello", output_index: 0, content_index: 0 },
        { type: "response.completed", response: { id: "r1", status: "completed" } },
      ]),
    );
    const client = createGenericOpenAIResponsesClient({
      config: { baseUrl: "https://api.openai.test/v1", apiKey: "sk-test" },
      fetch: fetchMock as unknown as typeof fetch,
    });

    const chunks: string[] = [];
    for await (const c of client.chatCompletionStream({
      model: "gpt-5.5",
      messages: [{ role: "user", content: "hi" }],
    })) {
      chunks.push(c);
    }
    const joined = chunks.join("");
    expect(joined).toContain('"content":"Hello"');
    expect(chunks.length).toBeGreaterThan(0);
  });

  it("throws UpstreamError before first chunk on non-2xx", async () => {
    const client = createGenericOpenAIResponsesClient({
      config: { baseUrl: "https://api.openai.test/v1", apiKey: "sk-test" },
      fetch: (async () => jsonResponse({ error: "rate limited" }, 429)) as unknown as typeof fetch,
    });
    let caught: unknown;
    try {
      for await (const _ of client.chatCompletionStream({
        model: "gpt-5.5",
        messages: [{ role: "user", content: "hi" }],
      })) {
        // must not yield
      }
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(UpstreamError);
    expect((caught as UpstreamError).upstreamStatus).toBe(429);
  });

  it("preserves generic Responses incomplete and EOF terminal behavior", async () => {
    const responses = [
      sseResponse([
        { type: "response.output_text.delta", delta: "partial" },
        {
          type: "response.incomplete",
          response: {
            status: "incomplete",
            usage: { input_tokens: 3, output_tokens: 1 },
          },
        },
      ]),
      sseResponse([{ type: "response.output_text.delta", delta: "legacy eof" }]),
      sseResponse([]),
    ];
    const fetchMock = vi.fn(async () => responses.shift() as Response);
    const client = createGenericOpenAIResponsesClient({
      config: { baseUrl: "https://api.openai.test/v1", apiKey: "sk-test" },
      fetch: fetchMock as unknown as typeof fetch,
    });

    const incomplete: string[] = [];
    for await (const chunk of client.chatCompletionStream({
      model: "gpt-5.5",
      messages: [{ role: "user", content: "hi" }],
    })) {
      incomplete.push(chunk);
    }
    expect(incomplete.join("")).toContain('"finish_reason":"length"');
    expect(incomplete.join("")).toContain('"prompt_tokens":3');
    expect(incomplete.join("")).toContain('"completion_tokens":1');
    expect(incomplete.join("")).toContain("data: [DONE]");

    const eof: string[] = [];
    for await (const chunk of client.chatCompletionStream({
      model: "gpt-5.5",
      messages: [{ role: "user", content: "hi" }],
    })) {
      eof.push(chunk);
    }
    expect(eof.join("")).toContain('"finish_reason":"stop"');
    expect(eof.join("")).toContain("data: [DONE]");

    const emptyEof: string[] = [];
    for await (const chunk of client.chatCompletionStream({
      model: "gpt-5.5",
      messages: [{ role: "user", content: "hi" }],
    })) {
      emptyEof.push(chunk);
    }
    expect(emptyEof).toEqual([]);
  });
});

describe("createGenericOpenAIResponsesClient — nativePassthroughStream", () => {
  it("byte-relays native Responses SSE without re-framing or [DONE]", async () => {
    const writes = [
      'data: {"type":"response.created","response":{"id":"r1"}}\n\n',
      'data: {"type":"response.completed","response":{"id":"r1"}}\n\n',
    ];
    const enc = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const w of writes) controller.enqueue(enc.encode(w));
        controller.close();
      },
    });
    const fetchMock = vi.fn(
      async () =>
        new Response(stream, { status: 200, headers: { "Content-Type": "text/event-stream" } }),
    );
    const client = createGenericOpenAIResponsesClient({
      config: { baseUrl: "https://api.openai.test/v1", apiKey: "sk-test" },
      fetch: fetchMock as unknown as typeof fetch,
    });

    const chunks: string[] = [];
    for await (const c of client.nativePassthroughStream?.({
      model: "gpt-5.5",
      input: "hi",
      stream: true,
    }) ?? []) {
      chunks.push(c);
    }
    expect(chunks).toEqual(writes);
    expect(chunks.join("")).not.toContain("[DONE]");
    expect(chunks.join("")).not.toContain("chat.completion.chunk");
  });

  it("throws UpstreamError before first chunk on non-2xx", async () => {
    const client = createGenericOpenAIResponsesClient({
      config: { baseUrl: "https://api.openai.test/v1", apiKey: "sk-test" },
      fetch: (async () => jsonResponse({ error: "server error" }, 503)) as unknown as typeof fetch,
    });
    let caught: unknown;
    try {
      for await (const _ of client.nativePassthroughStream?.({ model: "gpt-5.5", input: "hi" }) ??
        []) {
        // must not yield
      }
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(UpstreamError);
    expect((caught as UpstreamError).upstreamStatus).toBe(503);
  });
});

describe("createGenericOpenAIResponsesClient — resolveBaseUrl", () => {
  it("calls resolveBaseUrl() to get the dynamic endpoint at request time", async () => {
    let seenUrl = "";
    const fetchMock = vi.fn(async (url: string) => {
      seenUrl = url;
      return jsonResponse({ id: "resp_dyn", object: "response", status: "completed" });
    });
    const client = createGenericOpenAIResponsesClient({
      config: {
        baseUrl: "https://static.base/v1",
        resolveBaseUrl: async () => "https://dynamic.base/v1",
        apiKey: "sk-test",
      },
      fetch: fetchMock as unknown as typeof fetch,
    });
    await client.nativePassthrough?.({ model: "gpt-5.5", input: "hi" });
    expect(seenUrl).toBe("https://dynamic.base/v1/responses");
  });
});

describe("createGenericOpenAIResponsesClient — providerHeaders: no-auth path", () => {
  it("sends no Authorization header when neither apiKey nor getAuthHeader is configured", async () => {
    let seen: Headers | null = null;
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      seen = new Headers(init?.headers);
      return jsonResponse({ id: "resp", object: "response" });
    });
    // Deliberately no apiKey, no getAuthHeader — the empty-string authorization branch
    const client = createGenericOpenAIResponsesClient({
      config: { baseUrl: "https://api.openai.test/v1" } as never,
      fetch: fetchMock as unknown as typeof fetch,
    });
    await client.nativePassthrough?.({ model: "gpt-5.5", input: "hi" });
    expect((seen as unknown as Headers).get("Authorization")).toBeNull();
  });
});

describe("createGenericOpenAIResponsesClient — scrub via currentSecrets", () => {
  it("redacts currentSecrets from upstream error body", async () => {
    const client = createGenericOpenAIResponsesClient({
      config: {
        baseUrl: "https://api.openai.test/v1",
        apiKey: "sk-visible",
        currentSecrets: () => ["super-secret"],
      },
      fetch: (async () =>
        jsonResponse({ error: "denied: super-secret token" }, 403)) as unknown as typeof fetch,
    });
    let caught: unknown;
    try {
      await client.nativePassthrough?.({ model: "gpt-5.5", input: "hi" });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(UpstreamError);
    expect(JSON.stringify((caught as UpstreamError).providerRaw)).not.toContain("super-secret");
    expect(JSON.stringify((caught as UpstreamError).providerRaw)).toContain("[redacted]");
  });
});
