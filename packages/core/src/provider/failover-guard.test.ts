import { describe, expect, it } from "vitest";
import {
  guardPreOutputFailure,
  MAX_PRE_OUTPUT_BUFFER_BYTES,
  preOutputClassifierFor,
} from "./failover-guard.js";
import { UpstreamError } from "./openai.js";

// failover-guard — the pre-output streaming failure detector. A native upstream that
// returns HTTP 200 then fails IN-BAND (e.g. Responses `response.failed` /
// `server_is_overloaded` after only the unconditional `response.created` preamble)
// must count as a FAILED attempt so the executor falls back — not stream the error to
// the client as a success. The guard buffers preamble, commits on the first REAL
// output (flushing buffered bytes verbatim), and throws on a terminal error frame seen
// before any output (→ peekStream surfaces it as a pre-first-chunk failure).

async function* fromChunks(chunks: string[]): AsyncGenerator<string> {
  for (const c of chunks) yield c;
}

async function collect(gen: AsyncIterable<string>): Promise<string[]> {
  const out: string[] = [];
  for await (const c of gen) out.push(c);
  return out;
}

const responses = preOutputClassifierFor("openai_responses");
const anthropic = preOutputClassifierFor("anthropic_messages");
const chat = preOutputClassifierFor("openai_chat");
if (!responses || !anthropic || !chat) throw new Error("classifier missing");

describe("guardPreOutputFailure — openai_responses", () => {
  it.each([
    { type: "response.metadata", headers: { "x-codex-turn-state": "opaque-state" } },
    { type: "response.metadata", metadata: { type: "safety_buffering", retry_model: "gpt-test" } },
    { type: "codex.response.metadata", metadata: {} },
    { type: "responsesapi.websocket_timing", duration_ms: 1 },
    { type: "codex.rate_limits", rate_limits: { allowed: true, limit_reached: false } },
    { type: "keepalive" },
  ])("keeps Codex control event $type before output eligible for recovery", async (event) => {
    const forwarded: string[] = [];
    const frames = [
      { type: "response.created", response: { id: "resp_test" } },
      event,
      { type: "error", error: { code: "server_is_overloaded", message: "busy" } },
    ].map((value) => `data: ${JSON.stringify(value)}\n\n`);
    await expect(
      (async () => {
        for await (const chunk of guardPreOutputFailure(fromChunks(frames), responses))
          forwarded.push(chunk);
      })(),
    ).rejects.toMatchObject({ providerRaw: { error: { code: "server_is_overloaded" } } });
    expect(forwarded).toEqual([]);
  });

  it("does not replay an accepted Responses request when its pre-output buffer overflows", async () => {
    const chunk = `event: response.created\ndata: {"type":"response.created"}\n\n${"x".repeat(
      Math.floor(MAX_PRE_OUTPUT_BUFFER_BYTES / 2),
    )}`;
    let yielded = 0;
    async function* src(): AsyncGenerator<string> {
      yielded += 1;
      yield chunk;
      yielded += 1;
      yield "y".repeat(Math.floor(MAX_PRE_OUTPUT_BUFFER_BYTES / 2));
      yielded += 1;
      yield "z";
    }

    await expect(collect(guardPreOutputFailure(src(), responses))).rejects.toMatchObject({
      providerRaw: { error: { code: "response_create_outcome_unknown" } },
    });
    expect(yielded).toBe(2);
  });

  it("preamble then a terminal error frame → throws UpstreamError (no output yielded)", async () => {
    const src = fromChunks([
      'event: response.created\ndata: {"type":"response.created"}\n\n',
      'event: response.in_progress\ndata: {"type":"response.in_progress"}\n\n',
      'event: error\ndata: {"type":"error","error":{"message":"server_is_overloaded"}}\n\n',
    ]);
    await expect(collect(guardPreOutputFailure(src, responses))).rejects.toThrow(
      /server_is_overloaded/,
    );
  });

  it("response.failed (nested error) before output → throws UpstreamError", async () => {
    const src = fromChunks([
      'event: response.created\ndata: {"type":"response.created"}\n\n',
      'event: response.failed\ndata: {"type":"response.failed","response":{"error":{"message":"overloaded"}}}\n\n',
    ]);
    await expect(collect(guardPreOutputFailure(src, responses))).rejects.toThrow(UpstreamError);
  });

  const emptyEvents = [
    { type: "response.output_item.added", item: { type: "reasoning", summary: [] } },
    { type: "response.output_item.added", item: { type: "message", content: [] } },
    {
      type: "response.output_item.done",
      item: { type: "reasoning", summary: [], encrypted_content: null },
    },
    { type: "response.content_part.added", part: { type: "output_text", text: "" } },
    { type: "response.content_part.done", part: { type: "refusal", refusal: "" } },
    { type: "response.reasoning_summary_part.added", part: { type: "summary_text", text: "" } },
    { type: "response.output_text.delta", delta: "" },
    { type: "response.reasoning_summary_text.delta", delta: "" },
    { type: "response.reasoning_text.delta", delta: "" },
    { type: "response.refusal.delta", delta: "" },
  ];
  const frame = (event: unknown) => `data: ${JSON.stringify(event)}\n\n`;
  const overloaded = frame({
    type: "error",
    error: { code: "server_is_overloaded", message: "upstream overloaded" },
  });

  it.each(
    emptyEvents,
  )("keeps content-free $type before overload eligible for recovery", async (event) => {
    const forwarded: string[] = [];
    await expect(
      (async () => {
        for await (const chunk of guardPreOutputFailure(
          fromChunks([frame({ type: "response.created" }), frame(event), overloaded]),
          responses,
        ))
          forwarded.push(chunk);
      })(),
    ).rejects.toMatchObject({ providerRaw: { error: { code: "server_is_overloaded" } } });
    expect(forwarded).toEqual([]);
  });

  it("replays content-free lifecycle frames verbatim when real output arrives", async () => {
    const chunks = [
      ...emptyEvents.map(frame),
      frame({ type: "response.output_text.delta", delta: "hello" }),
    ];
    expect(await collect(guardPreOutputFailure(fromChunks(chunks), responses))).toEqual(chunks);
  });

  it("does not replay an accepted empty item when the upstream closes without a terminal error", async () => {
    await expect(
      collect(guardPreOutputFailure(fromChunks([frame(emptyEvents[0])]), responses)),
    ).rejects.toMatchObject({
      providerRaw: { error: { code: "response_create_outcome_unknown" } },
    });
  });

  it.each([
    {
      type: "response.output_item.added",
      item: { type: "message", content: [{ type: "output_text", text: "hello" }] },
    },
    {
      type: "response.output_item.done",
      item: { type: "reasoning", summary: [{ type: "summary_text", text: "thinking" }] },
    },
    { type: "response.output_item.added", item: { type: "message", content: "unexpected" } },
    { type: "response.content_part.added", part: { type: "output_text", text: "hello" } },
    {
      type: "response.reasoning_summary_part.added",
      part: { type: "summary_text", text: "thinking" },
    },
    { type: "response.content_part.added", part: { type: "refusal", refusal: "cannot help" } },
    {
      type: "response.output_item.done",
      item: { type: "reasoning", summary: [], encrypted_content: "opaque" },
    },
    {
      type: "response.output_item.added",
      item: { type: "function_call", name: "write_file", arguments: "" },
    },
    {
      type: "response.output_item.added",
      item: { type: "web_search_call", status: "in_progress" },
    },
    { type: "response.output_item.added", item: { type: "future_tool" } },
    { type: "response.content_part.added", part: { type: "future_content" } },
    { type: "response.output_item.added", item: null },
  ])("preserves the no-replay boundary for content, tools and unknown $type", async (event) => {
    const chunks = [frame(event), overloaded];
    expect(await collect(guardPreOutputFailure(fromChunks(chunks), responses))).toEqual(chunks);
  });

  it("preserves the structured terminal error for fallback classification", async () => {
    const raw = {
      type: "error",
      code: "context_length_exceeded",
      message: "Please reduce the input",
      response: { instructions: "private request content" },
    };
    const src = fromChunks([
      'event: response.created\ndata: {"type":"response.created"}\n\n',
      `event: error\ndata: ${JSON.stringify(raw)}\n\n`,
    ]);

    try {
      await collect(guardPreOutputFailure(src, responses));
      throw new Error("expected a terminal error");
    } catch (error) {
      expect(error).toBeInstanceOf(UpstreamError);
      expect(error).toMatchObject({ message: raw.message });
      expect((error as UpstreamError).providerRaw).toEqual({
        type: raw.type,
        code: raw.code,
        message: raw.message,
      });
    }
  });

  it("preamble then real output → commits, replays every byte in order (preamble kept)", async () => {
    const chunks = [
      'event: response.created\ndata: {"type":"response.created"}\n\n',
      'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"Hi"}\n\n',
      'event: response.completed\ndata: {"type":"response.completed","response":{"status":"completed"}}\n\n',
    ];
    const out = await collect(guardPreOutputFailure(fromChunks(chunks), responses));
    expect(out.join("")).toBe(chunks.join(""));
  });

  it("commits CRLF-framed preamble and output when the delimiter crosses chunks", async () => {
    const chunks = [
      'event: response.created\r\ndata: {"type":"response.created"}\r\n\r',
      '\nevent: response.output_text.delta\r\ndata: {"type":"response.output_text.delta","delta":"Hi"}\r\n\r\n',
    ];
    const out = await collect(guardPreOutputFailure(fromChunks(chunks), responses));
    expect(out.join("")).toBe(chunks.join(""));
  });

  it("an SSE event split across chunk boundaries still classifies correctly", async () => {
    const chunks = [
      "event: response.created\nda",
      'ta: {"type":"response.created"}\n\nevent: response.output_text.delta\ndata: {"type":"resp',
      'onse.output_text.delta","delta":"Hi"}\n\n',
    ];
    const out = await collect(guardPreOutputFailure(fromChunks(chunks), responses));
    expect(out.join("")).toBe(chunks.join(""));
  });

  it("error and preamble batched in ONE chunk (error before any output) → throws", async () => {
    const src = fromChunks([
      'event: response.created\ndata: {"type":"response.created"}\n\nevent: response.failed\ndata: {"type":"response.failed","response":{"error":{"message":"overloaded"}}}\n\n',
    ]);
    await expect(collect(guardPreOutputFailure(src, responses))).rejects.toThrow(UpstreamError);
  });

  it("output THEN error in the same chunk → commits (error relayed as bytes, NOT a failure)", async () => {
    const chunks = [
      'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"Hi"}\n\nevent: error\ndata: {"type":"error","error":{"message":"late"}}\n\n',
    ];
    const out = await collect(guardPreOutputFailure(fromChunks(chunks), responses));
    expect(out.join("")).toBe(chunks.join(""));
  });

  it("response.created then EOF is outcome-unknown and must not fall back", async () => {
    const src = fromChunks([
      'event: response.created\ndata: {"type":"response.created"}\n\n',
      'event: response.in_progress\ndata: {"type":"response.in_progress"}\n\n',
    ]);
    await expect(collect(guardPreOutputFailure(src, responses))).rejects.toMatchObject({
      upstreamStatus: 400,
      providerRaw: {
        error: { code: "response_create_outcome_unknown" },
        http: { lifecycle_phase: "after_response_created_before_output" },
      },
    });
  });

  it("response.created then a reader failure is outcome-unknown and must not fall back", async () => {
    async function* src(): AsyncGenerator<string> {
      yield 'event: response.created\ndata: {"type":"response.created"}\n\n';
      throw new Error("socket reset while reading");
    }

    await expect(collect(guardPreOutputFailure(src(), responses))).rejects.toMatchObject({
      upstreamStatus: 400,
      providerRaw: {
        error: { code: "response_create_outcome_unknown" },
        http: { lifecycle_phase: "after_response_created_before_output" },
      },
    });
  });

  it("recognizes an unterminated response.created frame before EOF", async () => {
    const src = fromChunks(['event: response.created\ndata: {"type":"response.created"}']);

    await expect(collect(guardPreOutputFailure(src, responses))).rejects.toMatchObject({
      upstreamStatus: 400,
      providerRaw: { error: { code: "response_create_outcome_unknown" } },
    });
  });

  it("recognizes an unterminated response.created frame before a reader failure", async () => {
    async function* src(): AsyncGenerator<string> {
      yield 'event: response.created\ndata: {"type":"response.created"}';
      throw new Error("socket reset while reading");
    }

    await expect(collect(guardPreOutputFailure(src(), responses))).rejects.toMatchObject({
      upstreamStatus: 400,
      providerRaw: { error: { code: "response_create_outcome_unknown" } },
    });
  });

  it("preserves an unterminated explicit response.failed as a safe fallback signal", async () => {
    const src = fromChunks([
      'event: response.failed\ndata: {"type":"response.failed","response":{"error":{"message":"overloaded"}}}',
    ]);

    await expect(collect(guardPreOutputFailure(src, responses))).rejects.toMatchObject({
      upstreamStatus: null,
      message: "overloaded",
    });
  });

  it("treats an empty HTTP 200 Responses stream as outcome-unknown", async () => {
    await expect(collect(guardPreOutputFailure(fromChunks([]), responses))).rejects.toMatchObject({
      upstreamStatus: 400,
      providerRaw: { error: { code: "response_create_outcome_unknown" } },
    });
  });
});

describe("guardPreOutputFailure — anthropic_messages", () => {
  it("message_start + ping then error → throws", async () => {
    const src = fromChunks([
      'event: message_start\ndata: {"type":"message_start"}\n\n',
      'event: ping\ndata: {"type":"ping"}\n\n',
      'event: error\ndata: {"type":"error","error":{"type":"overloaded_error","message":"overloaded"}}\n\n',
    ]);
    await expect(collect(guardPreOutputFailure(src, anthropic))).rejects.toThrow(/overloaded/);
  });

  it("message_start then content_block_delta → commits byte-for-byte", async () => {
    const chunks = [
      'event: message_start\ndata: {"type":"message_start"}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Hi"}}\n\n',
    ];
    const out = await collect(guardPreOutputFailure(fromChunks(chunks), anthropic));
    expect(out.join("")).toBe(chunks.join(""));
  });

  it("empty text block then terminal stop → throws so the executor can fall back", async () => {
    const src = fromChunks([
      'event: message_start\ndata: {"type":"message_start"}\n\n',
      'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
      'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":0}}\n\n',
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    ]);
    await expect(collect(guardPreOutputFailure(src, anthropic))).rejects.toThrow(UpstreamError);
  });

  it("a valid tool_use block start counts as output even before input_json_delta", async () => {
    const chunks = [
      'event: message_start\ndata: {"type":"message_start"}\n\n',
      'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_123","name":"Bash","input":{}}}\n\n',
      'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use","stop_sequence":null},"usage":{"output_tokens":1}}\n\n',
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    ];
    const out = await collect(guardPreOutputFailure(fromChunks(chunks), anthropic));
    expect(out.join("")).toBe(chunks.join(""));
  });

  it("tool argument deltas count as output", async () => {
    const chunks = [
      'event: message_start\ndata: {"type":"message_start"}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"cmd\\":"}}\n\n',
    ];
    const out = await collect(guardPreOutputFailure(fromChunks(chunks), anthropic));
    expect(out.join("")).toBe(chunks.join(""));
  });
});

describe("guardPreOutputFailure — openai_chat", () => {
  it("role-only preamble then an in-band error frame → throws", async () => {
    const src = fromChunks([
      'data: {"choices":[{"delta":{"role":"assistant"},"finish_reason":null}]}\n\n',
      'data: {"error":{"message":"server_is_overloaded"}}\n\n',
    ]);
    await expect(collect(guardPreOutputFailure(src, chat))).rejects.toThrow(/server_is_overloaded/);
  });

  it("role-only preamble then a content delta → commits byte-for-byte", async () => {
    const chunks = [
      'data: {"choices":[{"delta":{"role":"assistant"},"finish_reason":null}]}\n\n',
      'data: {"choices":[{"delta":{"content":"Hi"},"finish_reason":null}]}\n\n',
      "data: [DONE]\n\n",
    ];
    const out = await collect(guardPreOutputFailure(fromChunks(chunks), chat));
    expect(out.join("")).toBe(chunks.join(""));
  });

  it("the translate path's {role,content:''} preamble defers, then content commits", async () => {
    const chunks = [
      'data: {"choices":[{"delta":{"role":"assistant","content":""},"finish_reason":null}]}\n\n',
      'data: {"choices":[{"delta":{"content":"Hi"},"finish_reason":null}]}\n\n',
    ];
    const out = await collect(guardPreOutputFailure(fromChunks(chunks), chat));
    expect(out.join("")).toBe(chunks.join(""));
  });

  it("a bare content-less frame with no role (data: {}) commits immediately (non-regressive)", async () => {
    const chunks = ["data: {}\n\n"];
    const out = await collect(guardPreOutputFailure(fromChunks(chunks), chat));
    expect(out.join("")).toBe(chunks.join(""));
  });

  it("a finish_reason-only terminal chunk counts as output (commits, no fallback)", async () => {
    const chunks = [
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
      "data: [DONE]\n\n",
    ];
    const out = await collect(guardPreOutputFailure(fromChunks(chunks), chat));
    expect(out.join("")).toBe(chunks.join(""));
  });
});

describe("preOutputClassifierFor", () => {
  it("returns null for gemini (no guard → unchanged commit-on-first behavior)", () => {
    expect(preOutputClassifierFor("gemini")).toBeNull();
  });
});
