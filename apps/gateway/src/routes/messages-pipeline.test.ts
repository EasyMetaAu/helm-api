import type { ExecutionResult, InjectDeps, ObserveDeps, RouteOptions } from "@helm/core";
import {
  createNativePassthroughCarrier,
  type InternalRequest,
  type MemoryMessageInput,
  makeHelmError,
  type NativePassthroughCarrier,
  type Protocol,
} from "@helm/shared";
import { describe, expect, it, vi } from "vitest";
import type { MessagesIdentity } from "./messages.js";
import {
  createMessagesPipeline,
  type InjectWiring,
  type PipelineBudgetDeps,
  PipelineError,
  type RouteFn,
} from "./messages-pipeline.js";

// messages-pipeline — the framework-agnostic bridge injected into both
// /v1/messages and /v1/responses. These tests pin the FAILURE seams the route
// handlers depend on: an all-providers-failed routing outcome and an empty
// request must surface as a structured PipelineError (never an empty 200), and
// per-key lane caps must be threaded into the route options.

const IDENTITY: MessagesIdentity = { keyId: "k1", accountId: "acct" };

function irOf(over: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    model: "claude-3-5-sonnet",
    messages: [{ role: "user", content: "hi" }],
    stream: false,
    metadata: { trace_id: "trace-1" },
    ...over,
  };
}

// Build an ExecutionResult-shaped stub. The pipeline reads body/stream/final/error.
function okResult(body: unknown): ExecutionResult {
  return {
    decision: { lane: { selected_lane: "balanced" } } as unknown as ExecutionResult["decision"],
    final: { status: "ok", alias: "x" },
    body,
    stream: null,
    error: null,
  };
}

// A VERBATIM Anthropic-native non-stream response — what provider.nativePassthrough
// returns and the pipeline must hand back UNTOUCHED on the passthrough path. Carries
// Anthropic content blocks (NOT OpenAI choices) + an Anthropic usage block.
const NATIVE_ANTHROPIC_BODY = {
  id: "msg_native_1",
  type: "message",
  role: "assistant",
  model: "claude-3-5-sonnet",
  content: [
    { type: "text", text: "Hello from native" },
    { type: "text", text: " passthrough" },
  ],
  stop_reason: "end_turn",
  stop_sequence: null,
  usage: {
    input_tokens: 7,
    output_tokens: 11,
    cache_read_input_tokens: 3,
    cache_creation_input_tokens: 2,
  },
};

// An ExecutionResult marked nativePassthrough:true carrying the verbatim native body.
function passthroughOkResult(body: unknown = NATIVE_ANTHROPIC_BODY): ExecutionResult {
  return {
    decision: {
      lane: { selected_lane: "balanced" },
      final: { status: "ok", model_alias: "anthropic/claude-3-5-sonnet" },
      cost_breakdown: { total_usd: 0.05, completion_usd: 0.02, eval_usd: null },
      provider_attempts: [],
    } as unknown as ExecutionResult["decision"],
    final: { status: "ok", alias: "anthropic/claude-3-5-sonnet" },
    body,
    stream: null,
    error: null,
    nativePassthrough: true,
  };
}

function errorResult(stream: AsyncIterable<string> | null = null): ExecutionResult {
  return {
    decision: { lane: { selected_lane: "balanced" } } as unknown as ExecutionResult["decision"],
    final: { status: "error" },
    body: null,
    stream,
    error: makeHelmError({
      error_class: "all_providers_failed",
      message: "all providers failed",
      trace_id: "trace-1",
    }),
  };
}

// A minimal OpenAI SSE text stream (one content delta + a stop frame). The
// pipeline parses these via parseOpenAISSE and feeds the chosen state machine.
function sseTextStream(): AsyncIterable<string> {
  const frames = [
    `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "hi" } }] })}\n\n`,
    `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`,
    "data: [DONE]\n\n",
  ];
  return (async function* () {
    for (const f of frames) yield f;
  })();
}

function sseXmlToolStream(xml: string): AsyncIterable<string> {
  const frames = [
    `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: xml } }] })}\n\n`,
    `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] })}\n\n`,
    "data: [DONE]\n\n",
  ];
  return (async function* () {
    for (const frame of frames) yield frame;
  })();
}

function streamOkResult(stream: AsyncIterable<string>): ExecutionResult {
  return {
    decision: { lane: { selected_lane: "balanced" } } as unknown as ExecutionResult["decision"],
    final: { status: "ok", alias: "x" },
    body: null,
    stream,
    error: null,
  };
}

async function drain(it: AsyncIterable<Record<string, unknown>>): Promise<string[]> {
  const out: string[] = [];
  for await (const ev of it) out.push(String(ev.type));
  return out;
}

describe("createMessagesPipeline — streamIR protocol branch", () => {
  it("default (anthropic_messages) yields Anthropic message_* events", async () => {
    const route: RouteFn = async () => streamOkResult(sseTextStream());
    const pipeline = createMessagesPipeline(route);
    const run = await pipeline.run(irOf({ stream: true }), IDENTITY, new AbortController().signal);
    const types = await drain(run.streamIR());
    expect(types[0]).toBe("message_start");
    expect(types).toContain("message_stop");
    expect(types.some((t) => t.startsWith("response."))).toBe(false);
  });

  it("openai_responses yields Responses response.* events", async () => {
    const route: RouteFn = async () => streamOkResult(sseTextStream());
    const pipeline = createMessagesPipeline(route, "openai_responses");
    const run = await pipeline.run(irOf({ stream: true }), IDENTITY, new AbortController().signal);
    const types = await drain(run.streamIR());
    expect(types[0]).toBe("response.created");
    expect(types.at(-1)).toBe("response.completed");
    expect(types.some((t) => t.startsWith("message_"))).toBe(false);
  });

  it("openai_responses uses the route-stamped response id for every streamed event", async () => {
    const route: RouteFn = async () => streamOkResult(sseTextStream());
    const pipeline = createMessagesPipeline(route, "openai_responses");
    const run = await pipeline.run(
      irOf({ stream: true, metadata: { trace_id: "trace-1", responses_stream_id: "resp_route" } }),
      { ...IDENTITY, caps: { allowFastMode: true } },
      new AbortController().signal,
    );
    const events: Array<Record<string, unknown>> = [];
    for await (const ev of run.streamIR()) events.push(ev);

    const responseIds = events
      .map((event) => (event.response as { id?: unknown } | undefined)?.id)
      .filter((id): id is string => typeof id === "string");
    expect(responseIds.length).toBeGreaterThan(0);
    expect(new Set(responseIds)).toEqual(new Set(["resp_route"]));
  });

  it("parses OpenAI SSE with CRLF separators and multi-data lines", async () => {
    const splitJson = JSON.stringify({
      id: "chatcmpl-x",
      model: "gpt-x",
      choices: [{ index: 0, delta: { content: "hi" } }],
    });
    const finishJson = JSON.stringify({
      id: "chatcmpl-x",
      model: "gpt-x",
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    });
    const stream = (async function* () {
      yield `data: ${splitJson.slice(0, 20)}\r\n`;
      yield `data: ${splitJson.slice(20)}\r\n\r\n`;
      yield `event: ignored\r\n`;
      yield `data: ${finishJson}\r\n\r\n`;
    })();
    const route: RouteFn = async () => streamOkResult(stream);
    const pipeline = createMessagesPipeline(route, "openai_responses");
    const run = await pipeline.run(irOf({ stream: true }), IDENTITY, new AbortController().signal);
    const events = [];
    for await (const ev of run.streamIR()) events.push(ev);
    const delta = events.find((e) => e.type === "response.output_text.delta") as
      | { delta?: string }
      | undefined;
    expect(delta?.delta).toBe("hi");
    expect(events.at(-1)?.type).toBe("response.completed");
  });

  it("recovers whitelisted XML in the Anthropic translation stream when the live flag is true", async () => {
    const xml = '<invoke name="Bash"><parameter name="command">git status</parameter></invoke>';
    const route: RouteFn = async () => streamOkResult(sseXmlToolStream(xml));
    let recoveryEnabled = false;
    const pipeline = createMessagesPipeline(
      route,
      "anthropic_messages",
      undefined,
      undefined,
      undefined,
      undefined,
      { toolCallXmlRecoveryEnabled: () => recoveryEnabled },
    );
    const run = await pipeline.run(
      irOf({
        stream: true,
        tools: [
          { type: "custom", function: { name: "NotAFunctionTool" } },
          { type: "function", function: { name: 123 } },
          { type: "function", function: { name: "Bash" } },
        ],
      }),
      IDENTITY,
      new AbortController().signal,
    );

    // The getter is live: changing it after run() but before stream consumption
    // must affect this request without rebuilding the pipeline.
    recoveryEnabled = true;
    const events: Array<Record<string, unknown>> = [];
    for await (const event of run.streamIR()) events.push(event);

    const toolStart = events.find(
      (event) =>
        event.type === "content_block_start" &&
        (event.content_block as { type?: unknown } | undefined)?.type === "tool_use",
    );
    expect(toolStart?.content_block).toMatchObject({ type: "tool_use", name: "Bash", input: {} });
    const args = events.find(
      (event) =>
        event.type === "content_block_delta" &&
        (event.delta as { type?: unknown } | undefined)?.type === "input_json_delta",
    );
    expect((args?.delta as { partial_json?: unknown } | undefined)?.partial_json).toBe(
      JSON.stringify({ command: "git status" }),
    );
    expect(
      events
        .filter(
          (event) =>
            event.type === "content_block_delta" &&
            (event.delta as { type?: unknown } | undefined)?.type === "text_delta",
        )
        .map((event) => (event.delta as { text?: unknown }).text)
        .join(""),
    ).not.toContain("<invoke");
  });

  it("keeps XML text unchanged in the Anthropic translation stream when the live flag is false", async () => {
    const xml = '<invoke name="Bash"><parameter name="command">pwd</parameter></invoke>';
    const route: RouteFn = async () => streamOkResult(sseXmlToolStream(xml));
    const pipeline = createMessagesPipeline(
      route,
      "anthropic_messages",
      undefined,
      undefined,
      undefined,
      undefined,
      { toolCallXmlRecoveryEnabled: () => false },
    );
    const run = await pipeline.run(
      irOf({
        stream: true,
        tools: [{ type: "function", function: { name: "Bash" } }],
      }),
      IDENTITY,
      new AbortController().signal,
    );
    const events: Array<Record<string, unknown>> = [];
    for await (const event of run.streamIR()) events.push(event);

    expect(
      events.some(
        (event) =>
          event.type === "content_block_start" &&
          (event.content_block as { type?: unknown } | undefined)?.type === "tool_use",
      ),
    ).toBe(false);
    expect(
      events
        .filter(
          (event) =>
            event.type === "content_block_delta" &&
            (event.delta as { type?: unknown } | undefined)?.type === "text_delta",
        )
        .map((event) => (event.delta as { text?: unknown }).text)
        .join(""),
    ).toBe(xml);
  });

  it("defaults XML recovery to true but never whitelists non-function tool lookalikes", async () => {
    const skipped = '<invoke name="Bash"><parameter name="command">pwd</parameter></invoke>';
    const xml = `${skipped}<invoke name="Read"><parameter name="path">README.md</parameter></invoke>`;
    const route: RouteFn = async () => streamOkResult(sseXmlToolStream(xml));
    const pipeline = createMessagesPipeline(route);
    const run = await pipeline.run(
      irOf({
        stream: true,
        tools: [
          { type: "custom", function: { name: "Bash" } },
          { type: "function", function: { name: "Read" } },
        ],
      }),
      IDENTITY,
      new AbortController().signal,
    );
    const events: Array<Record<string, unknown>> = [];
    for await (const event of run.streamIR()) events.push(event);

    const toolStarts = events.filter(
      (event) =>
        event.type === "content_block_start" &&
        (event.content_block as { type?: unknown } | undefined)?.type === "tool_use",
    );
    expect(toolStarts).toHaveLength(1);
    expect(toolStarts[0]?.content_block).toMatchObject({ name: "Read" });
    expect(
      events
        .filter(
          (event) =>
            event.type === "content_block_delta" &&
            (event.delta as { type?: unknown } | undefined)?.type === "text_delta",
        )
        .map((event) => (event.delta as { text?: unknown }).text)
        .join(""),
    ).toBe(skipped);
  });
});

describe("createMessagesPipeline — failure surfaces", () => {
  it("collect() throws a structured PipelineError when routing fails (no empty 200)", async () => {
    const route: RouteFn = async () => errorResult();
    const pipeline = createMessagesPipeline(route);
    const run = await pipeline.run(irOf(), IDENTITY, new AbortController().signal);
    await expect(run.collect()).rejects.toBeInstanceOf(PipelineError);
    await expect(run.collect()).rejects.toMatchObject({ error_class: "all_providers_failed" });
  });

  it("streamIR() throws a structured PipelineError when the stream is null after a failure", async () => {
    const route: RouteFn = async () => errorResult(null);
    const pipeline = createMessagesPipeline(route);
    const run = await pipeline.run(irOf({ stream: true }), IDENTITY, new AbortController().signal);
    const iterate = async () => {
      for await (const _ of run.streamIR()) {
        // should never yield — the failure must throw before any event
      }
    };
    await expect(iterate()).rejects.toBeInstanceOf(PipelineError);
  });

  it("run() throws invalid_request when ir.messages is empty (no placeholder, no billing)", async () => {
    let routed = false;
    const route: RouteFn = async () => {
      routed = true;
      return okResult({ id: "x" });
    };
    const pipeline = createMessagesPipeline(route);
    await expect(
      pipeline.run(irOf({ messages: [] }), IDENTITY, new AbortController().signal),
    ).rejects.toMatchObject({ error_class: "invalid_request" });
    expect(routed).toBe(false);
  });

  it("run() throws invalid_request when ir.messages is missing/non-array", async () => {
    const route: RouteFn = async () => okResult({ id: "x" });
    const pipeline = createMessagesPipeline(route);
    await expect(
      pipeline.run(irOf({ messages: undefined }), IDENTITY, new AbortController().signal),
    ).rejects.toMatchObject({ error_class: "invalid_request" });
  });

  it("threads per-key lane caps from identity.caps into the route options", async () => {
    let sawOpts: RouteOptions | null = null;
    const route: RouteFn = async (_req, opts) => {
      sawOpts = opts;
      return okResult({ id: "x" });
    };
    const pipeline = createMessagesPipeline(route);
    const identity: MessagesIdentity = {
      keyId: "k1",
      accountId: "acct",
      caps: { allowCustomModel: false, allowedLanes: ["economy"] },
    };
    await pipeline.run(irOf(), identity, new AbortController().signal);
    expect(sawOpts).not.toBeNull();
    expect((sawOpts as RouteOptions | null)?.keyCaps).toEqual({
      allowedLanes: ["economy"],
      degradeLane: null,
      blockedModels: null,
    });
  });

  it("threads null keyCaps when identity carries no caps", async () => {
    let sawOpts: RouteOptions | null = null;
    const route: RouteFn = async (_req, opts) => {
      sawOpts = opts;
      return okResult({ id: "x" });
    };
    const pipeline = createMessagesPipeline(route);
    await pipeline.run(irOf(), IDENTITY, new AbortController().signal);
    expect((sawOpts as RouteOptions | null)?.keyCaps).toEqual({
      allowedLanes: null,
      degradeLane: null,
      blockedModels: null,
    });
  });

  it("downgrades Anthropic client Fast mode when the API key disallows passthrough", async () => {
    let sawReq: InternalRequest | null = null;
    const route: RouteFn = async (req) => {
      sawReq = req;
      return okResult({ id: "x" });
    };
    const pipeline = createMessagesPipeline(route);
    const native = createNativePassthroughCarrier({
      protocol: "anthropic_messages",
      body: { model: "claude-opus-4-8", messages: [], speed: "fast" },
      rawBody: '{"speed":"fast"}',
      headers: {},
    });

    await pipeline.run(
      irOf({ speed: "fast", metadata: { trace_id: "trace-1", native_request: native } }),
      { keyId: "k1", accountId: "acct", caps: { allowFastMode: false } },
      new AbortController().signal,
    );

    expect(sawReq).not.toBeNull();
    const req = sawReq as unknown as InternalRequest;
    expect(req.provider_raw?.speed).toBe("standard");
    const carrier = req.native_request as NativePassthroughCarrier;
    expect(carrier.body.speed).toBe("standard");
    expect(carrier.raw_body).toBeUndefined();
    expect(carrier.mutations.body_shims_applied).toEqual(["client_fast_speed_downgraded"]);
  });

  it("preserves Anthropic client Fast mode when the API key allows passthrough", async () => {
    let sawReq: InternalRequest | null = null;
    const route: RouteFn = async (req) => {
      sawReq = req;
      return okResult({ id: "x" });
    };
    const pipeline = createMessagesPipeline(route);
    const native = createNativePassthroughCarrier({
      protocol: "anthropic_messages",
      body: { model: "claude-opus-4-8", messages: [], speed: "fast" },
      rawBody: '{"speed":"fast"}',
      headers: {},
    });

    await pipeline.run(
      irOf({ speed: "fast", metadata: { trace_id: "trace-1", native_request: native } }),
      { keyId: "k1", accountId: "acct", caps: { allowFastMode: true } },
      new AbortController().signal,
    );

    expect(sawReq).not.toBeNull();
    const req = sawReq as unknown as InternalRequest;
    expect(req.provider_raw?.speed).toBe("fast");
    const carrier = req.native_request as NativePassthroughCarrier;
    expect(carrier.body.speed).toBe("fast");
    expect(carrier.raw_body).toBe('{"speed":"fast"}');
    expect(carrier.mutations.body_shims_applied).toBeUndefined();
  });

  it("downgrades Responses client service_tier Fast passthrough when the API key disallows it", async () => {
    let sawReq: InternalRequest | null = null;
    const route: RouteFn = async (req) => {
      sawReq = req;
      return okResult({ id: "x" });
    };
    const pipeline = createMessagesPipeline(route, "openai_responses");
    const native = createNativePassthroughCarrier({
      protocol: "openai_responses",
      body: { model: "gpt-5.5", input: "hi", service_tier: "priority" },
      rawBody: '{"service_tier":"priority"}',
      headers: {},
    });

    await pipeline.run(
      irOf({ service_tier: "priority", metadata: { trace_id: "trace-1", native_request: native } }),
      { keyId: "k1", accountId: "acct" },
      new AbortController().signal,
    );

    expect(sawReq).not.toBeNull();
    const req = sawReq as unknown as InternalRequest;
    expect(req.service_tier).toBe("default");
    const carrier = req.native_request as NativePassthroughCarrier;
    expect(carrier.body.service_tier).toBe("default");
    expect(carrier.mutations.body_shims_applied).toEqual(["client_fast_service_tier_downgraded"]);
  });
});

// A minimal MemoryStore fake that records the message inputs observeOutbound
// persists, so a test can assert the reconstructed assistant turn (from the native
// response content) reaches storage. ensureThread/stampThreadModel are no-ops.
function makeObserveSpy(): {
  observe: ObserveDeps;
  persisted: MemoryMessageInput[];
} {
  const persisted: MemoryMessageInput[] = [];
  const memoryStore = {
    ensureThread: async () => {},
    appendMessages: async (inputs: MemoryMessageInput[]) => {
      persisted.push(...inputs);
    },
    appendMessage: async (input: MemoryMessageInput) => {
      persisted.push(input);
    },
  } as unknown as ObserveDeps["memoryStore"];
  const observe: ObserveDeps = {
    memoryStore,
    now: () => new Date(0),
    estimateTokens: (text: string) => text.length,
    log: () => {},
  };
  return { observe, persisted };
}

describe("createMessagesPipeline — native passthrough collect()", () => {
  it("returns the native body UNTOUCHED (no openAIBodyToIR projection) on passthrough", async () => {
    const route: RouteFn = async () => passthroughOkResult();
    const pipeline = createMessagesPipeline(route);
    const run = await pipeline.run(irOf(), IDENTITY, new AbortController().signal);
    const body = (await run.collect()) as Record<string, unknown>;
    // Identity passthrough: the exact native object reference is returned, with its
    // Anthropic content blocks intact (NOT projected into OpenAI `choices`).
    expect(body).toBe(NATIVE_ANTHROPIC_BODY);
    expect(body.content).toEqual([
      { type: "text", text: "Hello from native" },
      { type: "text", text: " passthrough" },
    ]);
    expect(body.choices).toBeUndefined();
  });

  it("threads nativePassthrough:true onto the PipelineRunResult", async () => {
    const route: RouteFn = async () => passthroughOkResult();
    const pipeline = createMessagesPipeline(route);
    const run = await pipeline.run(irOf(), IDENTITY, new AbortController().signal);
    expect((run as { nativePassthrough?: boolean }).nativePassthrough).toBe(true);
  });

  it("the NON-passthrough path stays the IR projection (nativePassthrough absent)", async () => {
    const route: RouteFn = async () =>
      okResult({ id: "x", choices: [{ index: 0, message: { role: "assistant", content: "hi" } }] });
    const pipeline = createMessagesPipeline(route);
    const run = await pipeline.run(irOf(), IDENTITY, new AbortController().signal);
    const body = (await run.collect()) as Record<string, unknown>;
    // The translate path projects into an IRResponse (OpenAI-shaped `choices`).
    expect(Array.isArray(body.choices)).toBe(true);
    expect((run as { nativePassthrough?: boolean }).nativePassthrough).toBeFalsy();
  });

  it("settles the budget + stamps tokens from the Anthropic usage block", async () => {
    let settledTokens: number | null = null;
    const budget: PipelineBudgetDeps = {
      gate: { check: async () => ({ overBudget: false }) as never },
      settle: async (_keyId, _caps, usage) => {
        settledTokens = usage.tokens;
      },
      now: () => 0,
    };
    const route: RouteFn = async () => passthroughOkResult();
    const identity: MessagesIdentity = {
      keyId: "k1",
      accountId: "acct",
      caps: { budget: { spend_usd: { day: 1 } } as never },
    };
    const decisionRef = passthroughOkResult().decision;
    const pipeline = createMessagesPipeline(
      (_req, _opts, _signal) =>
        Promise.resolve({ ...passthroughOkResult(), decision: decisionRef }),
      "anthropic_messages",
      undefined,
      budget,
    );
    void route;
    const run = await pipeline.run(irOf(), identity, new AbortController().signal);
    await run.collect();
    // The passthrough body carries an ANTHROPIC usage block. The settle must read it
    // (via usageFromAnthropicResponse): prompt = input(7)+cache_read(3)+cache_creation(2)
    // = 12, completion = output(11) → 23 served tokens. A regression guard that the
    // passthrough collect still settles the per-key budget off the native usage.
    expect(settledTokens).toBe(23);
    // The decision's served-token breakdown is stamped from the same anthropic usage
    // (cache split collapsed into prompt; cached/cache_creation distinct).
    expect(decisionRef.usage).toMatchObject({
      prompt_tokens: 12,
      completion_tokens: 11,
      cached_tokens: 3,
      cache_creation_tokens: 2,
    });
  });

  it("observe-outbound records the assistant text reconstructed from native content[].text", async () => {
    const { observe, persisted } = makeObserveSpy();
    const route: RouteFn = async () => passthroughOkResult();
    const pipeline = createMessagesPipeline(route, "anthropic_messages", { observe });
    const run = await pipeline.run(
      irOf({ metadata: { trace_id: "t", thread_id: "th-1", memory_mode: "observe" } }),
      IDENTITY,
      new AbortController().signal,
    );
    await run.collect();
    const assistant = persisted.find((m) => m.role === "assistant");
    expect(assistant).toBeDefined();
    // The two native text blocks are concatenated into one assistant turn.
    expect(assistant?.content).toBe("Hello from native passthrough");
  });
});

// A canned Anthropic SSE byte stream (what provider.nativePassthroughStream emits).
// The `data:` payloads carry DELIBERATELY non-canonical JSON formatting (key order +
// spacing) so a test can prove the pipeline forwards the bytes VERBATIM rather than
// JSON.parse→re-stringify (which would canonicalize them). Usage rides message_start
// (input + cache) and the trailing message_delta (output). Split across odd byte
// boundaries (NOT frame-aligned) to exercise the cross-chunk frame buffering.
const NATIVE_SSE_FRAMES = [
  'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_x","usage":{ "input_tokens":7 ,"cache_read_input_tokens":3,"cache_creation_input_tokens":2,"inference_geo":"not_available"}}}\n\n',
  'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
  'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}\n\n',
  'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":" native"}}\n\n',
  'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
  'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":11}}\n\n',
  'event: message_stop\ndata: {"type":"message_stop"}\n\n',
];

// Re-chunk the joined SSE text into arbitrary 17-byte pieces so frames straddle the
// chunk boundaries — the passthrough generator MUST buffer across chunks.
function nativeSseTextStream(): AsyncIterable<string> {
  const joined = NATIVE_SSE_FRAMES.join("");
  const pieces: string[] = [];
  for (let i = 0; i < joined.length; i += 17) pieces.push(joined.slice(i, i + 17));
  return (async function* () {
    for (const p of pieces) yield p;
  })();
}

// An ExecutionResult marked nativePassthrough:true carrying the raw Anthropic SSE
// text stream (NOT OpenAI SSE). The pipeline's streamIR must byte-relay it.
function passthroughStreamResult(
  stream: AsyncIterable<string> = nativeSseTextStream(),
): ExecutionResult {
  return {
    decision: {
      lane: { selected_lane: "balanced" },
      final: { status: "ok", model_alias: "anthropic/claude-3-5-sonnet" },
      cost_breakdown: { total_usd: 0, completion_usd: null, eval_usd: null },
      provider_attempts: [],
    } as unknown as ExecutionResult["decision"],
    final: { status: "ok", alias: "anthropic/claude-3-5-sonnet" },
    body: null,
    stream,
    error: null,
    nativePassthrough: true,
  };
}

describe("createMessagesPipeline — native passthrough streamIR()", () => {
  it("byte-relays the upstream SSE: yields {event,data} with the VERBATIM data string", async () => {
    const route: RouteFn = async () => passthroughStreamResult();
    const pipeline = createMessagesPipeline(route);
    const run = await pipeline.run(irOf({ stream: true }), IDENTITY, new AbortController().signal);
    const frames: Array<{ event: string; data: string }> = [];
    for await (const ev of run.streamIR()) frames.push(ev as { event: string; data: string });

    // The event names are the verbatim upstream `event:` lines.
    expect(frames.map((f) => f.event)).toEqual([
      "message_start",
      "content_block_start",
      "content_block_delta",
      "content_block_delta",
      "content_block_stop",
      "message_delta",
      "message_stop",
    ]);
    // The data payloads are forwarded BYTE-FOR-BYTE — the deliberately non-canonical
    // spacing inside message_start ("input_tokens":7 ,) survives, proving there is NO
    // JSON.parse→stringify round-trip (which would have canonicalized it).
    const startFrame = frames[0];
    expect(startFrame?.data).toBe(
      '{"type":"message_start","message":{"id":"msg_x","usage":{ "input_tokens":7 ,"cache_read_input_tokens":3,"cache_creation_input_tokens":2,"inference_geo":"not_available"}}}',
    );
    // No `type` key — the passthrough path yields {event,data}, NOT the IR event bag.
    expect((frames[0] as unknown as { type?: unknown }).type).toBeUndefined();
  });

  it("preserves no-data native SSE comment/keepalive frames for the route raw writer", async () => {
    async function* stream(): AsyncIterable<string> {
      yield [
        ": keepalive\r\n\r\n",
        "event: ping\r\n\r\n",
        'event: message_start\r\ndata: {"type":"message_start","message":{"usage":{"input_tokens":1}}}\r\n\r\n',
      ].join("");
    }
    const route: RouteFn = async () => passthroughStreamResult(stream());
    const pipeline = createMessagesPipeline(route);
    const run = await pipeline.run(irOf({ stream: true }), IDENTITY, new AbortController().signal);
    const frames: Array<{ event: string; data: string; raw?: string }> = [];
    for await (const ev of run.streamIR()) {
      frames.push(ev as { event: string; data: string; raw?: string });
    }

    expect(frames[0]).toMatchObject({
      event: "",
      data: "",
      raw: ": keepalive\r\n\r\n",
    });
    expect(frames[1]).toMatchObject({
      event: "ping",
      data: "",
      raw: "event: ping\r\n\r\n",
    });
    expect(frames[2]?.raw).toContain("\r\n");
  });

  it("backfills the decision usage from the native SSE (input from message_start, output from message_delta)", async () => {
    const decisionRef = passthroughStreamResult().decision;
    const pipeline = createMessagesPipeline(
      () => Promise.resolve({ ...passthroughStreamResult(), decision: decisionRef }),
      "anthropic_messages",
    );
    const run = await pipeline.run(irOf({ stream: true }), IDENTITY, new AbortController().signal);
    for await (const _ of run.streamIR()) {
      // drain
    }
    // prompt = input(7) + cache_read(3) + cache_creation(2) = 12, completion = output(11)
    expect(decisionRef.usage).toMatchObject({
      prompt_tokens: 12,
      completion_tokens: 11,
      cached_tokens: 3,
      cache_creation_tokens: 2,
      inference_geo: "not_available",
    });
  });

  it("stamps the served generation window (true-TPS denominator) from the stream clock", async () => {
    const decisionRef = passthroughStreamResult().decision;
    // An advancing clock so the first→last yielded-frame span is non-zero. The
    // timer reuses budget.now (production clock); the exact span depends on the
    // frame count, so assert it is a real positive window, not a fixed value.
    let t = 1000;
    const budget: PipelineBudgetDeps = {
      gate: { check: async () => ({ overBudget: false }) as never },
      settle: async () => {},
      now: () => (t += 10),
    };
    const identity: MessagesIdentity = {
      keyId: "k1",
      accountId: "acct",
      caps: { budget: { spend_usd: { day: 1 } } as never },
    };
    const pipeline = createMessagesPipeline(
      () => Promise.resolve({ ...passthroughStreamResult(), decision: decisionRef }),
      "anthropic_messages",
      undefined,
      budget,
    );
    const run = await pipeline.run(irOf({ stream: true }), identity, new AbortController().signal);
    for await (const _ of run.streamIR()) {
      // drain
    }
    expect(typeof decisionRef.generation_ms).toBe("number");
    expect(decisionRef.generation_ms ?? 0).toBeGreaterThan(0);
  });

  it("settles the per-key budget using the native SSE tokens", async () => {
    let settledTokens: number | null = null;
    const budget: PipelineBudgetDeps = {
      gate: { check: async () => ({ overBudget: false }) as never },
      settle: async (_keyId, _caps, usage) => {
        settledTokens = usage.tokens;
      },
      now: () => 0,
    };
    const identity: MessagesIdentity = {
      keyId: "k1",
      accountId: "acct",
      caps: { budget: { spend_usd: { day: 1 } } as never },
    };
    const pipeline = createMessagesPipeline(
      () => Promise.resolve(passthroughStreamResult()),
      "anthropic_messages",
      undefined,
      budget,
    );
    const run = await pipeline.run(irOf({ stream: true }), identity, new AbortController().signal);
    for await (const _ of run.streamIR()) {
      // drain
    }
    // input(7)+cache_read(3)+cache_creation(2)+output(11) = 23 served tokens.
    expect(settledTokens).toBe(23);
  });

  it("observe-outbound records the assistant text reconstructed from text_delta", async () => {
    const { observe, persisted } = makeObserveSpy();
    const pipeline = createMessagesPipeline(
      () => Promise.resolve(passthroughStreamResult()),
      "anthropic_messages",
      { observe },
    );
    const run = await pipeline.run(
      irOf({
        stream: true,
        metadata: { trace_id: "t", thread_id: "th-1", memory_mode: "observe" },
      }),
      IDENTITY,
      new AbortController().signal,
    );
    for await (const _ of run.streamIR()) {
      // drain
    }
    const assistant = persisted.find((m) => m.role === "assistant");
    expect(assistant).toBeDefined();
    // The two text_delta fragments concatenate into one assistant turn.
    expect(assistant?.content).toBe("Hello native");
  });

  it("the NON-passthrough stream path is unchanged (OpenAI SSE → Anthropic events)", async () => {
    const route: RouteFn = async () => streamOkResult(sseTextStream());
    const pipeline = createMessagesPipeline(route);
    const run = await pipeline.run(irOf({ stream: true }), IDENTITY, new AbortController().signal);
    const types = await drain(run.streamIR());
    // Still the translated Anthropic state machine (yields `type`, not `event`/`data`).
    expect(types[0]).toBe("message_start");
    expect(types).toContain("message_stop");
  });
});

// ── openai_responses (Codex) native passthrough (#217 Phase 3) ────────────────

// A VERBATIM Codex Responses NON-stream body — what provider.nativePassthrough
// returns and the pipeline must hand back UNTOUCHED on the passthrough path. Carries
// the native Responses `output` array (NOT OpenAI choices) + a Responses usage block
// (cache counted INSIDE input_tokens, surfaced via input_tokens_details).
const NATIVE_RESPONSES_BODY = {
  id: "resp_native_1",
  object: "response",
  status: "completed",
  model: "gpt-5.5",
  output: [
    {
      type: "message",
      role: "assistant",
      content: [
        { type: "output_text", text: "Hello from Codex" },
        { type: "output_text", text: " passthrough" },
      ],
    },
  ],
  usage: {
    input_tokens: 12,
    output_tokens: 9,
    input_tokens_details: { cached_tokens: 4 },
  },
};

function passthroughResponsesOkResult(body: unknown = NATIVE_RESPONSES_BODY): ExecutionResult {
  return {
    decision: {
      lane: { selected_lane: "balanced" },
      final: { status: "ok", model_alias: "openai-codex/gpt-5.5" },
      cost_breakdown: { total_usd: 0.03, completion_usd: 0.01, eval_usd: null },
      provider_attempts: [],
    } as unknown as ExecutionResult["decision"],
    final: { status: "ok", alias: "openai-codex/gpt-5.5" },
    body,
    stream: null,
    error: null,
    nativePassthrough: true,
  };
}

// A canned Codex Responses SSE byte stream (what provider.nativePassthroughStream
// emits). The `data:` payloads carry DELIBERATELY non-canonical spacing so a test can
// prove byte-verbatim forwarding (no JSON.parse→stringify). Usage rides the TERMINAL
// response.completed event (Responses counts cache inside input_tokens). Output text
// arrives as response.output_text.delta events whose `delta` is a plain STRING.
const NATIVE_RESPONSES_SSE_FRAMES = [
  'event: response.created\ndata: {"type":"response.created","sequence_number":0,"response":{"id":"resp_x","status":"in_progress"}}\n\n',
  'event: response.output_item.added\ndata: {"type":"response.output_item.added","item":{"type":"message","role":"assistant"}}\n\n',
  'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"Hello"}\n\n',
  'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":" Codex"}\n\n',
  'event: response.completed\ndata: {"type":"response.completed","response":{"status":"completed","usage":{ "input_tokens":12 ,"output_tokens":9,"input_tokens_details":{"cached_tokens":4}}}}\n\n',
];

function nativeResponsesSseTextStream(): AsyncIterable<string> {
  const joined = NATIVE_RESPONSES_SSE_FRAMES.join("");
  const pieces: string[] = [];
  for (let i = 0; i < joined.length; i += 19) pieces.push(joined.slice(i, i + 19));
  return (async function* () {
    for (const p of pieces) yield p;
  })();
}

function passthroughResponsesStreamResult(
  stream: AsyncIterable<string> = nativeResponsesSseTextStream(),
): ExecutionResult {
  return {
    decision: {
      lane: { selected_lane: "balanced" },
      final: { status: "ok", model_alias: "openai-codex/gpt-5.5" },
      cost_breakdown: { total_usd: 0, completion_usd: null, eval_usd: null },
      provider_attempts: [],
    } as unknown as ExecutionResult["decision"],
    final: { status: "ok", alias: "openai-codex/gpt-5.5" },
    body: null,
    stream,
    error: null,
    nativePassthrough: true,
  };
}

describe("createMessagesPipeline — openai_responses native passthrough streamIR()", () => {
  it("byte-relays the upstream Responses SSE: yields {event,data} with the VERBATIM data string", async () => {
    const pipeline = createMessagesPipeline(
      () => Promise.resolve(passthroughResponsesStreamResult()),
      "openai_responses",
    );
    const run = await pipeline.run(irOf({ stream: true }), IDENTITY, new AbortController().signal);
    const frames: Array<{ event: string; data: string }> = [];
    for await (const ev of run.streamIR()) frames.push(ev as { event: string; data: string });

    // The event names are the verbatim upstream `event:` lines (no IR `type` key).
    expect(frames.map((f) => f.event)).toEqual([
      "response.created",
      "response.output_item.added",
      "response.output_text.delta",
      "response.output_text.delta",
      "response.completed",
    ]);
    // The terminal frame's data is forwarded BYTE-FOR-BYTE — the deliberately non-
    // canonical spacing ("input_tokens":12 ,) survives, proving no JSON round-trip.
    const completed = frames.at(-1);
    expect(completed?.data).toBe(
      '{"type":"response.completed","response":{"status":"completed","usage":{ "input_tokens":12 ,"output_tokens":9,"input_tokens_details":{"cached_tokens":4}}}}',
    );
    expect((frames[0] as unknown as { type?: unknown }).type).toBeUndefined();
  });

  it("backfills the decision usage from the terminal response.completed event (cache inside input_tokens)", async () => {
    const decisionRef = passthroughResponsesStreamResult().decision;
    const pipeline = createMessagesPipeline(
      () => Promise.resolve({ ...passthroughResponsesStreamResult(), decision: decisionRef }),
      "openai_responses",
    );
    const run = await pipeline.run(irOf({ stream: true }), IDENTITY, new AbortController().signal);
    for await (const _ of run.streamIR()) {
      // drain
    }
    // Responses counts cache INSIDE input_tokens → prompt = input(12), completion =
    // output(9); the cached split (4) rides prompt_tokens_details, NOT added to prompt.
    expect(decisionRef.usage).toMatchObject({
      prompt_tokens: 12,
      completion_tokens: 9,
      cached_tokens: 4,
      measurement: "reported",
    });
    expect(decisionRef.stream_outcome).toBe("completed");
  });

  it("estimates and prices a terminal-less partial stream consistently", async () => {
    const partialFrames = [
      'event: response.created\ndata: {"type":"response.created","response":{"status":"in_progress"}}\n\n',
      'event: response.reasoning_summary_text.delta\ndata: {"type":"response.reasoning_summary_text.delta","delta":"Inspecting usage"}\n\n',
      'event: response.custom_tool_call_input.delta\ndata: {"type":"response.custom_tool_call_input.delta","delta":"{\\"path\\":\\"/tmp/report.json\\"}"}\n\n',
    ];
    const stream = (async function* (): AsyncIterable<string> {
      for (const frame of partialFrames) yield frame;
    })();
    const upstreamRequest = JSON.stringify({
      model: "gpt-5.6-sol",
      input: [{ role: "user", content: "Inspect this request." }],
      stream: true,
    });
    const decisionRef = passthroughResponsesStreamResult(stream).decision;
    Object.assign(decisionRef, {
      final: { status: "ok", model_alias: "openai-codex/gpt-5.6-sol" },
      cost_breakdown: { total_usd: null, completion_usd: null, eval_usd: null },
      provider_attempts: [
        {
          alias: "openai-codex/gpt-5.6-sol",
          skipped: false,
          skip_reason: null,
          status: "ok",
          error_class: null,
          latency_ms: 10,
          cost_usd: null,
        },
      ],
    });
    const costOf = vi.fn().mockReturnValue(0.0042);
    let now = 0;
    const budget: PipelineBudgetDeps = {
      gate: { check: async () => ({ overBudget: false }) as never },
      settle: async () => {},
      now: () => (now += 5),
      costOf,
    };
    const recordOAuthUsage = vi.fn();
    const pipeline = createMessagesPipeline(
      () =>
        Promise.resolve({
          ...passthroughResponsesStreamResult(stream),
          decision: decisionRef,
          upstreamRequest,
        }),
      "openai_responses",
      undefined,
      budget,
      recordOAuthUsage,
    );

    const run = await pipeline.run(irOf({ stream: true }), IDENTITY, new AbortController().signal);
    for await (const _ of run.streamIR()) {
      // drain the clean-but-terminal-less upstream EOF
    }

    expect(decisionRef.stream_outcome).toBe("truncated");
    expect(decisionRef.final).toMatchObject({
      status: "error",
      error_reason: "upstream_error",
    });
    expect(decisionRef.usage).toMatchObject({
      measurement: "estimated_partial",
      prompt_tokens: expect.any(Number),
      completion_tokens: expect.any(Number),
    });
    expect(decisionRef.generation_ms).toBeGreaterThan(0);
    expect(costOf).toHaveBeenCalledWith(
      "openai-codex/gpt-5.6-sol",
      expect.objectContaining({ measurement: "estimated_partial" }),
    );
    expect(decisionRef.cost_breakdown.completion_usd).toBe(0.0042);
    expect(decisionRef.provider_attempts[0]?.cost_usd).toBe(0.0042);
    expect(recordOAuthUsage).toHaveBeenCalledWith(null, "openai-codex/gpt-5.6-sol", {
      tokens: (decisionRef.usage?.prompt_tokens ?? 0) + (decisionRef.usage?.completion_tokens ?? 0),
      costUsd: 0.0042,
    });
  });

  it("settles the per-key budget using the Responses SSE tokens (input + output)", async () => {
    let settledTokens: number | null = null;
    const budget: PipelineBudgetDeps = {
      gate: { check: async () => ({ overBudget: false }) as never },
      settle: async (_keyId, _caps, usage) => {
        settledTokens = usage.tokens;
      },
      now: () => 0,
    };
    const identity: MessagesIdentity = {
      keyId: "k1",
      accountId: "acct",
      caps: { budget: { spend_usd: { day: 1 } } as never },
    };
    const pipeline = createMessagesPipeline(
      () => Promise.resolve(passthroughResponsesStreamResult()),
      "openai_responses",
      undefined,
      budget,
    );
    const run = await pipeline.run(irOf({ stream: true }), identity, new AbortController().signal);
    for await (const _ of run.streamIR()) {
      // drain
    }
    // Responses: input(12) + output(9) = 21 served tokens (cache already inside input).
    expect(settledTokens).toBe(21);
  });

  it("observe-outbound records the assistant text from response.output_text.delta", async () => {
    const { observe, persisted } = makeObserveSpy();
    const pipeline = createMessagesPipeline(
      () => Promise.resolve(passthroughResponsesStreamResult()),
      "openai_responses",
      { observe },
    );
    const run = await pipeline.run(
      irOf({
        stream: true,
        metadata: { trace_id: "t", thread_id: "th-1", memory_mode: "observe" },
      }),
      IDENTITY,
      new AbortController().signal,
    );
    for await (const _ of run.streamIR()) {
      // drain
    }
    const assistant = persisted.find((m) => m.role === "assistant");
    expect(assistant).toBeDefined();
    // The two string deltas concatenate into one assistant turn.
    expect(assistant?.content).toBe("Hello Codex");
  });

  it("Anthropic passthrough stream stays byte-identical (no Responses tee leakage)", async () => {
    // Regression guard: the protocol-aware tee must NOT change the anthropic_messages
    // passthrough behavior — same verbatim frames as before Phase 3.
    const pipeline = createMessagesPipeline(
      () => Promise.resolve(passthroughStreamResult()),
      "anthropic_messages",
    );
    const run = await pipeline.run(irOf({ stream: true }), IDENTITY, new AbortController().signal);
    const frames: Array<{ event: string; data: string }> = [];
    for await (const ev of run.streamIR()) frames.push(ev as { event: string; data: string });
    expect(frames.map((f) => f.event)).toEqual([
      "message_start",
      "content_block_start",
      "content_block_delta",
      "content_block_delta",
      "content_block_stop",
      "message_delta",
      "message_stop",
    ]);
  });
});

describe("createMessagesPipeline — openai_responses native passthrough collect()", () => {
  it("returns the native Responses body UNTOUCHED (no openAIBodyToIR projection)", async () => {
    const pipeline = createMessagesPipeline(
      () => Promise.resolve(passthroughResponsesOkResult()),
      "openai_responses",
    );
    const run = await pipeline.run(irOf(), IDENTITY, new AbortController().signal);
    const body = (await run.collect()) as Record<string, unknown>;
    expect(body).toBe(NATIVE_RESPONSES_BODY);
    expect(body.output).toEqual(NATIVE_RESPONSES_BODY.output);
    expect(body.choices).toBeUndefined();
  });

  it("settles the budget + stamps tokens from the Responses usage block", async () => {
    let settledTokens: number | null = null;
    const budget: PipelineBudgetDeps = {
      gate: { check: async () => ({ overBudget: false }) as never },
      settle: async (_keyId, _caps, usage) => {
        settledTokens = usage.tokens;
      },
      now: () => 0,
    };
    const identity: MessagesIdentity = {
      keyId: "k1",
      accountId: "acct",
      caps: { budget: { spend_usd: { day: 1 } } as never },
    };
    const decisionRef = passthroughResponsesOkResult().decision;
    const pipeline = createMessagesPipeline(
      () => Promise.resolve({ ...passthroughResponsesOkResult(), decision: decisionRef }),
      "openai_responses",
      undefined,
      budget,
    );
    const run = await pipeline.run(irOf(), identity, new AbortController().signal);
    await run.collect();
    // Responses: prompt = input(12), completion = output(9) → 21 served tokens (cache
    // already counted inside input_tokens, NOT re-added like Anthropic).
    expect(settledTokens).toBe(21);
    expect(decisionRef.usage).toMatchObject({
      prompt_tokens: 12,
      completion_tokens: 9,
      cached_tokens: 4,
    });
  });

  it("observe-outbound records the assistant text from output[].content[].output_text", async () => {
    const { observe, persisted } = makeObserveSpy();
    const pipeline = createMessagesPipeline(
      () => Promise.resolve(passthroughResponsesOkResult()),
      "openai_responses",
      { observe },
    );
    const run = await pipeline.run(
      irOf({ metadata: { trace_id: "t", thread_id: "th-1", memory_mode: "observe" } }),
      IDENTITY,
      new AbortController().signal,
    );
    await run.collect();
    const assistant = persisted.find((m) => m.role === "assistant");
    expect(assistant).toBeDefined();
    expect(assistant?.content).toBe("Hello from Codex passthrough");
  });
});

// A VERBATIM Gemini GenerateContent NON-stream body — what provider.nativePassthrough
// returns and the pipeline must hand back UNTOUCHED on the passthrough path. Carries
// the native `candidates[].content.parts[]` (NOT OpenAI choices) + a Gemini
// usageMetadata block (cache counted INSIDE promptTokenCount, like Responses).
const NATIVE_GEMINI_BODY = {
  candidates: [
    {
      content: { role: "model", parts: [{ text: "Hello from Gemini" }, { text: " passthrough" }] },
      finishReason: "STOP",
    },
  ],
  usageMetadata: {
    promptTokenCount: 12,
    candidatesTokenCount: 9,
    cachedContentTokenCount: 4,
    totalTokenCount: 21,
  },
};

function passthroughGeminiOkResult(body: unknown = NATIVE_GEMINI_BODY): ExecutionResult {
  return {
    decision: {
      lane: { selected_lane: "balanced" },
      final: { status: "ok", model_alias: "gemini/gemini-2.0-flash" },
      cost_breakdown: { total_usd: 0.02, completion_usd: 0.01, eval_usd: null },
      provider_attempts: [],
    } as unknown as ExecutionResult["decision"],
    final: { status: "ok", alias: "gemini/gemini-2.0-flash" },
    body,
    stream: null,
    error: null,
    nativePassthrough: true,
  };
}

// A canned Gemini streamGenerateContent SSE byte stream. Nameless `data:` frames carry
// CUMULATIVE usageMetadata (final frame holds the complete count) with DELIBERATELY
// non-canonical spacing so a test can prove byte-verbatim forwarding (no JSON
// round-trip). Output text rides candidates[].content.parts[].text.
const NATIVE_GEMINI_SSE_FRAMES = [
  'data: {"candidates":[{"content":{"parts":[{"text":"Hello"}]}}],"usageMetadata":{"promptTokenCount":12,"candidatesTokenCount":2}}\n\n',
  'data: {"candidates":[{"content":{"parts":[{"text":" Gemini"}]},"finishReason":"STOP"}],"usageMetadata":{ "promptTokenCount":12 ,"candidatesTokenCount":9,"cachedContentTokenCount":4}}\n\n',
];

function nativeGeminiSseTextStream(): AsyncIterable<string> {
  const joined = NATIVE_GEMINI_SSE_FRAMES.join("");
  const pieces: string[] = [];
  for (let i = 0; i < joined.length; i += 19) pieces.push(joined.slice(i, i + 19));
  return (async function* () {
    for (const p of pieces) yield p;
  })();
}

function passthroughGeminiStreamResult(
  stream: AsyncIterable<string> = nativeGeminiSseTextStream(),
): ExecutionResult {
  return {
    decision: {
      lane: { selected_lane: "balanced" },
      final: { status: "ok", model_alias: "gemini/gemini-2.0-flash" },
      cost_breakdown: { total_usd: 0, completion_usd: null, eval_usd: null },
      provider_attempts: [],
    } as unknown as ExecutionResult["decision"],
    final: { status: "ok", alias: "gemini/gemini-2.0-flash" },
    body: null,
    stream,
    error: null,
    nativePassthrough: true,
  };
}

describe("createMessagesPipeline — gemini native passthrough collect()", () => {
  it("returns the native Gemini body UNTOUCHED (no openAIBodyToIR projection)", async () => {
    const pipeline = createMessagesPipeline(
      () => Promise.resolve(passthroughGeminiOkResult()),
      "gemini",
    );
    const run = await pipeline.run(irOf(), IDENTITY, new AbortController().signal);
    const body = (await run.collect()) as Record<string, unknown>;
    expect(body).toBe(NATIVE_GEMINI_BODY);
    expect(body.candidates).toEqual(NATIVE_GEMINI_BODY.candidates);
    expect(body.choices).toBeUndefined();
  });

  it("settles the budget + stamps tokens from the Gemini usageMetadata (cache inside prompt)", async () => {
    let settledTokens: number | null = null;
    const budget: PipelineBudgetDeps = {
      gate: { check: async () => ({ overBudget: false }) as never },
      settle: async (_keyId, _caps, usage) => {
        settledTokens = usage.tokens;
      },
      now: () => 0,
    };
    const identity: MessagesIdentity = {
      keyId: "k1",
      accountId: "acct",
      caps: { budget: { spend_usd: { day: 1 } } as never },
    };
    const decisionRef = passthroughGeminiOkResult().decision;
    const pipeline = createMessagesPipeline(
      () => Promise.resolve({ ...passthroughGeminiOkResult(), decision: decisionRef }),
      "gemini",
      undefined,
      budget,
    );
    const run = await pipeline.run(irOf(), identity, new AbortController().signal);
    await run.collect();
    // Gemini: prompt = promptTokenCount(12), completion = candidates(9) → 21 served
    // tokens (cache already counted inside promptTokenCount, NOT re-added). REGRESSION
    // GUARD: before the fix this fell into the Anthropic branch → usage null → 0 tokens.
    expect(settledTokens).toBe(21);
    expect(decisionRef.usage).toMatchObject({
      prompt_tokens: 12,
      completion_tokens: 9,
      cached_tokens: 4,
    });
  });

  it("observe-outbound records the assistant text from candidates[].content.parts[].text", async () => {
    const { observe, persisted } = makeObserveSpy();
    const pipeline = createMessagesPipeline(
      () => Promise.resolve(passthroughGeminiOkResult()),
      "gemini",
      { observe },
    );
    const run = await pipeline.run(
      irOf({ metadata: { trace_id: "t", thread_id: "th-1", memory_mode: "observe" } }),
      IDENTITY,
      new AbortController().signal,
    );
    await run.collect();
    const assistant = persisted.find((m) => m.role === "assistant");
    expect(assistant).toBeDefined();
    expect(assistant?.content).toBe("Hello from Gemini passthrough");
  });
});

describe("createMessagesPipeline — gemini native passthrough streamIR()", () => {
  it("byte-relays the upstream Gemini SSE: yields the VERBATIM nameless data frames", async () => {
    const pipeline = createMessagesPipeline(
      () => Promise.resolve(passthroughGeminiStreamResult()),
      "gemini",
    );
    const run = await pipeline.run(irOf({ stream: true }), IDENTITY, new AbortController().signal);
    const frames: Array<{ event: string; data: string }> = [];
    for await (const ev of run.streamIR()) frames.push(ev as { event: string; data: string });
    // Gemini frames are nameless (no `event:` line) → event "".
    expect(frames.map((f) => f.event)).toEqual(["", ""]);
    // The terminal frame's data is forwarded BYTE-FOR-BYTE — the deliberately non-
    // canonical spacing ("promptTokenCount":12 ,) survives, proving no JSON round-trip.
    expect(frames.at(-1)?.data).toBe(
      '{"candidates":[{"content":{"parts":[{"text":" Gemini"}]},"finishReason":"STOP"}],"usageMetadata":{ "promptTokenCount":12 ,"candidatesTokenCount":9,"cachedContentTokenCount":4}}',
    );
  });

  it("settles the per-key budget using the cumulative Gemini usageMetadata", async () => {
    let settledTokens: number | null = null;
    const budget: PipelineBudgetDeps = {
      gate: { check: async () => ({ overBudget: false }) as never },
      settle: async (_keyId, _caps, usage) => {
        settledTokens = usage.tokens;
      },
      now: () => 0,
    };
    const identity: MessagesIdentity = {
      keyId: "k1",
      accountId: "acct",
      caps: { budget: { spend_usd: { day: 1 } } as never },
    };
    const pipeline = createMessagesPipeline(
      () => Promise.resolve(passthroughGeminiStreamResult()),
      "gemini",
      undefined,
      budget,
    );
    const run = await pipeline.run(irOf({ stream: true }), identity, new AbortController().signal);
    for await (const _ of run.streamIR()) {
      // drain
    }
    // Final cumulative usageMetadata: prompt(12) + candidates(9) = 21 served tokens.
    // REGRESSION GUARD: before the fix, the Anthropic carrier filter never matched a
    // Gemini frame → 0 tokens settled.
    expect(settledTokens).toBe(21);
  });

  it("observe-outbound records the assistant text from streamed parts[].text", async () => {
    const { observe, persisted } = makeObserveSpy();
    const pipeline = createMessagesPipeline(
      () => Promise.resolve(passthroughGeminiStreamResult()),
      "gemini",
      { observe },
    );
    const run = await pipeline.run(
      irOf({
        stream: true,
        metadata: { trace_id: "t", thread_id: "th-1", memory_mode: "observe" },
      }),
      IDENTITY,
      new AbortController().signal,
    );
    for await (const _ of run.streamIR()) {
      // drain
    }
    const assistant = persisted.find((m) => m.role === "assistant");
    expect(assistant).toBeDefined();
    expect(assistant?.content).toBe("Hello Gemini");
  });
});

describe("createMessagesPipeline — production IR params", () => {
  it("generates an internal request_id instead of reusing a client trace_id", async () => {
    const generatedRequestId = "11111111-1111-4111-8111-111111111111";
    const randomUUID = vi
      .spyOn(globalThis.crypto, "randomUUID")
      .mockReturnValue(generatedRequestId);
    let seen: InternalRequest | null = null;
    const route: RouteFn = async (req) => {
      seen = req;
      return okResult({ id: "x" });
    };

    try {
      const pipeline = createMessagesPipeline(route);
      await pipeline.run(
        irOf({ metadata: { trace_id: "client-controlled-trace" } }),
        IDENTITY,
        new AbortController().signal,
      );

      const captured = seen as unknown as InternalRequest;
      expect(randomUUID).toHaveBeenCalledOnce();
      expect(captured.request_id).toBe(generatedRequestId);
      expect(captured.request_id).not.toBe("client-controlled-trace");
      expect(captured.metadata?.trace_id).toBe("client-controlled-trace");
    } finally {
      randomUUID.mockRestore();
    }
  });

  it.each<Protocol>([
    "anthropic_messages",
    "openai_responses",
    "gemini",
  ])("preserves LiteLLM params into InternalRequest for %s", async (protocol) => {
    let seen: InternalRequest | null = null;
    const route: RouteFn = async (req) => {
      seen = req;
      return okResult({ id: "x" });
    };
    const pipeline = createMessagesPipeline(route, protocol);
    await pipeline.run(
      irOf({
        temperature: 0.4,
        top_p: 0.8,
        top_k: 32,
        stop: ["END"],
        n: 2,
        logprobs: true,
        top_logprobs: 3,
        tool_choice: "auto",
        parallel_tool_calls: false,
        reasoning_effort: "medium",
        user: "user-123",
        service_tier: "auto",
        web_search_options: { search_context_size: "low" },
        context_management: { edits: [{ type: "clear_tool_uses_20250919" }] },
        mcp_servers: [{ type: "url", url: "https://mcp.example.test" }],
        container: { id: "container_123" },
        speed: "fast",
        output_config: { effort: "xhigh" },
        provider_raw: { metadata: { request_id: "client-meta" } },
      }),
      { ...IDENTITY, caps: { allowFastMode: true } },
      new AbortController().signal,
    );

    expect(seen).not.toBeNull();
    const captured = seen as unknown as InternalRequest;
    expect(captured.protocol).toBe(protocol);
    expect(captured.temperature).toBe(0.4);
    expect(captured.top_p).toBe(0.8);
    expect(captured.top_k).toBe(32);
    expect(captured.stop).toEqual(["END"]);
    expect(captured.n).toBe(2);
    expect(captured.logprobs).toBe(true);
    expect(captured.top_logprobs).toBe(3);
    expect(captured.tool_choice).toBe("auto");
    expect(captured.parallel_tool_calls).toBe(false);
    expect(captured.reasoning_effort).toBe("medium");
    expect(captured.user).toBe("user-123");
    expect(captured.service_tier).toBe("auto");
    expect(captured.web_search_options).toEqual({ search_context_size: "low" });
    expect(captured.provider_raw?.metadata).toEqual({ request_id: "client-meta" });
    expect(captured.provider_raw?.context_management).toEqual({
      edits: [{ type: "clear_tool_uses_20250919" }],
    });
    expect(captured.provider_raw?.mcp_servers).toEqual([
      { type: "url", url: "https://mcp.example.test" },
    ]);
    expect(captured.provider_raw?.container).toEqual({ id: "container_123" });
    expect(captured.provider_raw?.speed).toBe("fast");
    expect(captured.provider_raw?.output_config).toEqual({ effort: "xhigh" });
  });
});

// ── Memory inject = additive TRAILING REMINDER (#217 Phase 4) ─────────────────
// The inject phase no longer full-replaces the conversation, nor edits the system
// prefix. It assembles ONE memory TEXT BLOCK and the pipeline APPENDS it as a trailing
// <system-reminder> turn: at the END of the IR messages on the TRANSLATE path, and at
// the END of native_request.messages / .input on the PASSTHROUGH path. The system-level
// field (IR system message / native system / instructions) AND every existing turn —
// i.e. the client's cached prompt prefix — are kept VERBATIM, so memory works for
// tool-using/multimodal turns AND for native passthrough WITHOUT busting the cache.

// A fake MemoryStore that returns one project reflection, so assembleInjectedContext
// produces a non-null memory block. No observations / recent messages are needed to
// exercise the splice. listMessages/listObservations return empty.
function injectStore(reflection = "PROJECT MEMORY") {
  return {
    ensureThread: vi.fn(async () => {}),
    appendMessage: vi.fn(async () => "m"),
    listMessages: vi.fn(async () => []),
    appendObservation: vi.fn(async () => "o"),
    listObservations: vi.fn(async () => []),
    getReflection: vi.fn(async (scope: { projectId?: string }) =>
      scope.projectId !== undefined
        ? {
            id: "ref",
            projectId: scope.projectId,
            resourceId: null,
            threadId: null,
            reflectionText: reflection,
            version: 1,
            tokenEstimate: 4,
            updatedAt: new Date(2026, 0, 1),
          }
        : null,
    ),
    upsertReflection: vi.fn(async () => "r"),
    updateJobStatus: vi.fn(async () => {}),
    enqueueJob: vi.fn(async () => "job-1"),
    claimPendingJobs: vi.fn(async () => []),
  };
}

function injectWiring(store: ReturnType<typeof injectStore>): InjectWiring {
  const deps: InjectDeps = {
    memoryStore: store as unknown as InjectDeps["memoryStore"],
    estimateTokens: (t: string) => Math.ceil(t.length / 4),
    enqueueObserverJob: async () => "job-x",
    costSink: vi.fn(),
    now: () => new Date("2026-01-01T00:00:00.000Z"),
    log: vi.fn(),
  };
  return { deps, tokenBudget: 4000 };
}

const INJECT_META = {
  trace_id: "trace-1",
  memory_mode: "inject",
  thread_id: "t1",
  project_id: "p1",
};

describe("createMessagesPipeline — memory inject additive trailing reminder", () => {
  it("translate path: appends memory as a trailing reminder turn, all turns verbatim", async () => {
    let seen: InternalRequest | null = null;
    const route: RouteFn = async (req) => {
      seen = JSON.parse(JSON.stringify(req)) as InternalRequest;
      return okResult({ id: "x", choices: [{ index: 0, message: { content: "ok" } }] });
    };
    const store = injectStore();
    const pipeline = createMessagesPipeline(route, "anthropic_messages", {
      observe: makeObserveSpy().observe,
      inject: injectWiring(store),
    });
    const run = await pipeline.run(
      irOf({
        metadata: INJECT_META,
        messages: [
          { role: "system", content: "be terse" },
          { role: "user", content: "hi" },
          { role: "tool", content: "tool result", tool_call_id: "c1" },
        ],
      }),
      IDENTITY,
      new AbortController().signal,
    );
    await run.collect();
    const msgs = (seen as InternalRequest | null)?.messages as Array<{
      role: string;
      content: string;
    }>;
    // The system + user + tool turns ride VERBATIM, in order (cached prefix untouched).
    expect(msgs.slice(0, 3)).toEqual([
      { role: "system", content: "be terse" },
      { role: "user", content: "hi" },
      { role: "tool", content: "tool result", tool_call_id: "c1" },
    ]);
    // Memory rides ONE trailing <system-reminder> user turn at the END.
    expect(msgs[3]?.role).toBe("user");
    expect(msgs[3]?.content).toContain("PROJECT MEMORY");
    expect(msgs[3]?.content.startsWith("<system-reminder>")).toBe(true);
  });

  it("anthropic passthrough: native system VERBATIM, reminder appended to messages, passthrough usable", async () => {
    const NATIVE = {
      model: "claude-x",
      system: "be terse",
      messages: [
        { role: "user", content: "hi" },
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "t1", name: "search", input: {} }],
        },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "done" }] },
      ],
    };
    let seen: InternalRequest | null = null;
    const route: RouteFn = async (req) => {
      // Capture by reference so the test reads the SPLICED native_request the pipeline
      // assigned (the executor would forward exactly this).
      seen = req;
      return passthroughOkResult();
    };
    const store = injectStore();
    const pipeline = createMessagesPipeline(route, "anthropic_messages", {
      observe: makeObserveSpy().observe,
      inject: injectWiring(store),
    });
    const run = await pipeline.run(
      irOf({
        metadata: { ...INJECT_META, native_request: { ...NATIVE } },
        messages: [
          { role: "system", content: "be terse" },
          { role: "user", content: "hi" },
        ],
      }),
      IDENTITY,
      new AbortController().signal,
    );
    await run.collect();
    const native = (seen as InternalRequest | null)?.native_request as
      | { system?: unknown; messages?: Array<{ role: string; content: string }> }
      | undefined;
    expect(native).toBeDefined();
    // The native top-level `system` (the cached prefix) is left BYTE-IDENTICAL.
    expect(native?.system).toBe("be terse");
    // The native messages (incl. the tool_use / tool_result turns) ride VERBATIM, in
    // order, with the memory reminder appended as ONE trailing user turn.
    expect(native?.messages?.slice(0, 3)).toEqual(NATIVE.messages);
    expect(native?.messages?.[3]?.role).toBe("user");
    expect(native?.messages?.[3]?.content).toContain("PROJECT MEMORY");
    expect(native?.messages?.[3]?.content.startsWith("<system-reminder>")).toBe(true);
    // Passthrough is still usable: the run reports the upstream native body untouched.
    expect((run as { nativePassthrough?: boolean }).nativePassthrough).toBe(true);
    const body = (await run.collect()) as Record<string, unknown>;
    expect(body).toBe(NATIVE_ANTHROPIC_BODY);
  });

  it("anthropic passthrough carrier: records memory_appended and invalidates raw_body", async () => {
    const NATIVE = {
      model: "claude-x",
      system: "be terse",
      messages: [{ role: "user", content: "hi" }],
    };
    let seen: InternalRequest | null = null;
    const route: RouteFn = async (req) => {
      seen = req;
      return passthroughOkResult();
    };
    const store = injectStore();
    const pipeline = createMessagesPipeline(route, "anthropic_messages", {
      observe: makeObserveSpy().observe,
      inject: injectWiring(store),
    });

    const run = await pipeline.run(
      irOf({
        metadata: {
          ...INJECT_META,
          native_request: {
            protocol: "anthropic_messages",
            body: NATIVE,
            raw_body: JSON.stringify(NATIVE),
            headers: { "content-type": "application/json" },
            mutations: {},
          },
        },
        messages: [
          { role: "system", content: "be terse" },
          { role: "user", content: "hi" },
        ],
      }),
      IDENTITY,
      new AbortController().signal,
    );
    await run.collect();

    const carrier = (seen as InternalRequest | null)?.native_request as
      | {
          body?: { messages?: Array<{ role: string; content: string }> };
          raw_body?: string;
          mutations?: { memory_appended?: boolean };
        }
      | undefined;
    expect(carrier?.body?.messages?.[1]?.content).toContain("PROJECT MEMORY");
    expect(carrier?.raw_body).toBeUndefined();
    expect(carrier?.mutations?.memory_appended).toBe(true);
  });

  it("anthropic passthrough: native system ARRAY kept VERBATIM, reminder appended to messages", async () => {
    const NATIVE = {
      model: "claude-x",
      system: [{ type: "text", text: "be terse" }],
      messages: [{ role: "user", content: "hi" }],
    };
    let seen: InternalRequest | null = null;
    const route: RouteFn = async (req) => {
      seen = req;
      return passthroughOkResult();
    };
    const store = injectStore();
    const pipeline = createMessagesPipeline(route, "anthropic_messages", {
      observe: makeObserveSpy().observe,
      inject: injectWiring(store),
    });
    const run = await pipeline.run(
      irOf({
        metadata: { ...INJECT_META, native_request: { ...NATIVE } },
        messages: [
          { role: "system", content: "be terse" },
          { role: "user", content: "hi" },
        ],
      }),
      IDENTITY,
      new AbortController().signal,
    );
    await run.collect();
    const native = (seen as InternalRequest | null)?.native_request as {
      system?: unknown;
      messages?: Array<{ role: string; content: string }>;
    };
    // The cached system block array is left VERBATIM — its cache_control survives.
    expect(native.system).toEqual([{ type: "text", text: "be terse" }]);
    // Memory rides a trailing <system-reminder> user turn after the verbatim message.
    expect(native.messages?.[0]).toEqual({ role: "user", content: "hi" });
    expect(native.messages?.[1]?.role).toBe("user");
    expect(native.messages?.[1]?.content).toContain("PROJECT MEMORY");
    expect(native.messages?.[1]?.content.startsWith("<system-reminder>")).toBe(true);
  });

  it("openai_responses passthrough: native instructions VERBATIM, reminder appended to input", async () => {
    const NATIVE = {
      model: "gpt-5.5",
      instructions: "be terse",
      input: [
        { role: "user", content: "hi" },
        { type: "function_call", call_id: "c1", name: "search", arguments: "{}" },
      ],
    };
    let seen: InternalRequest | null = null;
    const route: RouteFn = async (req) => {
      seen = req;
      return passthroughResponsesOkResult();
    };
    const store = injectStore();
    const pipeline = createMessagesPipeline(route, "openai_responses", {
      observe: makeObserveSpy().observe,
      inject: injectWiring(store),
    });
    const run = await pipeline.run(
      irOf({
        metadata: { ...INJECT_META, native_request: { ...NATIVE } },
        messages: [
          { role: "system", content: "be terse" },
          { role: "user", content: "hi" },
        ],
      }),
      IDENTITY,
      new AbortController().signal,
    );
    await run.collect();
    const native = (seen as InternalRequest | null)?.native_request as
      | { instructions?: unknown; input?: Array<{ role?: string; content?: string }> }
      | undefined;
    // `instructions` (the Responses system-equivalent, cached prefix) is VERBATIM.
    expect(native?.instructions).toBe("be terse");
    // input (incl. the function_call item) rides VERBATIM, reminder appended last.
    expect(native?.input?.slice(0, 2)).toEqual(NATIVE.input);
    expect(native?.input?.[2]?.role).toBe("user");
    expect(native?.input?.[2]?.content).toContain("PROJECT MEMORY");
    expect(native?.input?.[2]?.content?.startsWith("<system-reminder>")).toBe(true);
    expect((run as { nativePassthrough?: boolean }).nativePassthrough).toBe(true);
  });

  it("does NOT touch native_request when there is no memory to inject (empty block)", async () => {
    const NATIVE = { model: "claude-x", system: "be terse", messages: [] };
    let seen: InternalRequest | null = null;
    const route: RouteFn = async (req) => {
      seen = req;
      return passthroughOkResult();
    };
    // No reflection → memory block is null → native_request stays byte-identical.
    const store = injectStore();
    store.getReflection.mockResolvedValue(null);
    const pipeline = createMessagesPipeline(route, "anthropic_messages", {
      observe: makeObserveSpy().observe,
      inject: injectWiring(store),
    });
    const run = await pipeline.run(
      irOf({
        metadata: { ...INJECT_META, native_request: { ...NATIVE } },
        messages: [{ role: "user", content: "hi" }],
      }),
      IDENTITY,
      new AbortController().signal,
    );
    await run.collect();
    const native = (seen as InternalRequest | null)?.native_request as { system?: unknown };
    // No memory → system is left exactly as the client sent it.
    expect(native.system).toBe("be terse");
  });
});

// ── Additional coverage: uncovered branches / lines ────────────────────────

describe("createMessagesPipeline — toInternalRequest metadata branches", () => {
  it("forwards conversation_id when it is a non-empty string (line 172 truthy branch)", async () => {
    let seen: Record<string, unknown> | null = null;
    const route: RouteFn = async (req) => {
      seen = req as unknown as Record<string, unknown>;
      return okResult({ id: "x" });
    };
    const pipeline = createMessagesPipeline(route);
    await pipeline.run(
      irOf({
        metadata: { trace_id: "t1", conversation_id: "sess-abc" },
      }),
      IDENTITY,
      new AbortController().signal,
    );
    expect(
      (seen as { metadata?: { conversation_id?: string } } | null)?.metadata?.conversation_id,
    ).toBe("sess-abc");
  });

  it("threads client_billing_header ≤128 chars (lines 224-226 truthy branch)", async () => {
    let seen: Record<string, unknown> | null = null;
    const route: RouteFn = async (req) => {
      seen = req as unknown as Record<string, unknown>;
      return okResult({ id: "x" });
    };
    const pipeline = createMessagesPipeline(route);
    await pipeline.run(
      irOf({
        metadata: { trace_id: "t1", client_billing_header: "cch=user1" },
      }),
      IDENTITY,
      new AbortController().signal,
    );
    expect(
      (seen as { metadata?: { client_billing_header?: string } } | null)?.metadata
        ?.client_billing_header,
    ).toBe("cch=user1");
  });

  it("omits client_billing_header when it exceeds 128 chars (line 224-226 falsy branch)", async () => {
    let seen: Record<string, unknown> | null = null;
    const route: RouteFn = async (req) => {
      seen = req as unknown as Record<string, unknown>;
      return okResult({ id: "x" });
    };
    const pipeline = createMessagesPipeline(route);
    await pipeline.run(
      irOf({
        metadata: { trace_id: "t1", client_billing_header: "x".repeat(129) },
      }),
      IDENTITY,
      new AbortController().signal,
    );
    expect(
      (seen as { metadata?: Record<string, unknown> } | null)?.metadata?.client_billing_header,
    ).toBeUndefined();
  });

  it("forwards response_format as an object (line 206-208 truthy branch)", async () => {
    let seen: Record<string, unknown> | null = null;
    const route: RouteFn = async (req) => {
      seen = req as unknown as Record<string, unknown>;
      return okResult({ id: "x" });
    };
    const pipeline = createMessagesPipeline(route);
    await pipeline.run(
      irOf({ response_format: { type: "json_object" } }),
      IDENTITY,
      new AbortController().signal,
    );
    expect((seen as { response_format?: unknown } | null)?.response_format).toEqual({
      type: "json_object",
    });
  });

  it("threads userId and orgId from identity (line 200-201 truthy branches)", async () => {
    let seen: Record<string, unknown> | null = null;
    const route: RouteFn = async (req) => {
      seen = req as unknown as Record<string, unknown>;
      return okResult({ id: "x" });
    };
    const pipeline = createMessagesPipeline(route);
    const identity: MessagesIdentity = {
      keyId: "k1",
      accountId: "acct",
      userId: "u-1",
      orgId: "org-1",
    };
    await pipeline.run(irOf(), identity, new AbortController().signal);
    expect((seen as { user_id?: string; org_id?: string } | null)?.user_id).toBe("u-1");
    expect((seen as { user_id?: string; org_id?: string } | null)?.org_id).toBe("org-1");
  });

  it("stamps keyPrefix from identity when present (line 793 truthy branch)", async () => {
    let sawOpts: unknown = null;
    const route: RouteFn = async (_req, opts) => {
      sawOpts = opts;
      return okResult({ id: "x" });
    };
    const pipeline = createMessagesPipeline(route);
    const identity: MessagesIdentity = {
      keyId: "k1",
      accountId: "acct",
      keyPrefix: "helm_live_ab",
    };
    await pipeline.run(irOf(), identity, new AbortController().signal);
    expect((sawOpts as { keyPrefix?: string } | null)?.keyPrefix).toBe("helm_live_ab");
  });
});

describe("createMessagesPipeline — budget over-budget paths (lines 784-789)", () => {
  it("throws rate_limited PipelineError when budget behavior is reject (line 785-786)", async () => {
    const budget: PipelineBudgetDeps = {
      gate: {
        check: async () => ({ overBudget: true, behavior: "reject", degradeLane: null }) as never,
      },
      settle: async () => {},
      now: () => 0,
    };
    const route: RouteFn = async () => okResult({ id: "x" });
    const identity: MessagesIdentity = {
      keyId: "k1",
      accountId: "acct",
      caps: { budget: { spend_usd: { day: 1 } } as never },
    };
    const pipeline = createMessagesPipeline(route, "anthropic_messages", undefined, budget);
    await expect(
      pipeline.run(irOf(), identity, new AbortController().signal),
    ).rejects.toMatchObject({ error_class: "rate_limited" });
  });

  it("degrades lane when budget behavior is degrade (line 787-788)", async () => {
    let sawKeyCaps: { degradeLane: string | null } | null = null;
    const budget: PipelineBudgetDeps = {
      gate: {
        check: async () =>
          ({ overBudget: true, behavior: "degrade", degradeLane: "economy" }) as never,
      },
      settle: async () => {},
      now: () => 0,
    };
    const route: RouteFn = async (_req, opts) => {
      sawKeyCaps = opts.keyCaps as { degradeLane: string | null };
      return okResult({ id: "x" });
    };
    const identity: MessagesIdentity = {
      keyId: "k1",
      accountId: "acct",
      caps: { budget: { spend_usd: { day: 1 } } as never },
    };
    const pipeline = createMessagesPipeline(route, "anthropic_messages", undefined, budget);
    await pipeline.run(irOf(), identity, new AbortController().signal);
    // Cast on read: TS narrows a let assigned only inside the route closure back to
    // its `null` initializer, so the optional chain would otherwise resolve to never.
    expect((sawKeyCaps as { degradeLane: string | null } | null)?.degradeLane).toBe("economy");
  });
});

describe("createMessagesPipeline — recordOAuthUsage (lines 960-963, 917-920)", () => {
  it("calls recordOAuthUsage on non-stream collect (line 960-963)", async () => {
    const calls: Array<{ alias: string | null; tokens: number }> = [];
    const recordOAuthUsage = (
      _account: unknown,
      alias: string | null,
      usage: { tokens: number; costUsd: number | null },
    ) => {
      calls.push({ alias, tokens: usage.tokens });
    };
    const route: RouteFn = async () => {
      const r = okResult({
        id: "x",
        choices: [{ index: 0, message: { role: "assistant", content: "hi" } }],
        usage: { prompt_tokens: 5, completion_tokens: 3 },
      });
      r.decision = {
        lane: { selected_lane: "balanced" },
        final: { status: "ok", model_alias: "gpt-4o" },
        cost_breakdown: { total_usd: 0.01, completion_usd: 0.005, eval_usd: null },
      } as never;
      return r;
    };
    const pipeline = createMessagesPipeline(
      route,
      "anthropic_messages",
      undefined,
      undefined,
      recordOAuthUsage,
    );
    const run = await pipeline.run(irOf(), IDENTITY, new AbortController().signal);
    await run.collect();
    expect(calls.length).toBe(1);
    expect(calls[0]?.tokens).toBeGreaterThanOrEqual(0);
  });

  it("calls recordOAuthUsage on passthrough collect (line 917-920)", async () => {
    const calls: Array<{ alias: string | null; tokens: number }> = [];
    const recordOAuthUsage = (
      _account: unknown,
      alias: string | null,
      usage: { tokens: number; costUsd: number | null },
    ) => {
      calls.push({ alias, tokens: usage.tokens });
    };
    const pipeline = createMessagesPipeline(
      () => Promise.resolve(passthroughOkResult()),
      "anthropic_messages",
      undefined,
      undefined,
      recordOAuthUsage,
    );
    const run = await pipeline.run(irOf(), IDENTITY, new AbortController().signal);
    await run.collect();
    expect(calls.length).toBe(1);
  });
});

describe("createMessagesPipeline — writes queue (line 635-641)", () => {
  it("enqueues memory tasks onto the write queue instead of inline-awaiting", async () => {
    const tasks: Array<() => Promise<void>> = [];
    const writes = {
      enqueueTask: (task: () => Promise<void>, _opts?: { wakeOnSettle?: boolean }) => {
        tasks.push(task);
      },
      depth: 0,
    } as never;
    const { observe } = makeObserveSpy();
    const route: RouteFn = async () =>
      okResult({
        id: "x",
        choices: [{ index: 0, message: { role: "assistant", content: "hi" } }],
      });
    const pipeline = createMessagesPipeline(
      route,
      "anthropic_messages",
      { observe },
      undefined,
      undefined,
      writes,
    );
    const run = await pipeline.run(
      irOf({ metadata: { trace_id: "t", thread_id: "th-1", memory_mode: "observe" } }),
      IDENTITY,
      new AbortController().signal,
    );
    await run.collect();
    // With write queue wired, tasks are enqueued (not awaited inline)
    expect(tasks.length).toBeGreaterThan(0);
  });
});

describe("createMessagesPipeline — accumulateAssistantText via streamIR (lines 257-263)", () => {
  it("reconstructs assistant text from streamed content deltas for memory observe", async () => {
    const { observe, persisted } = makeObserveSpy();
    const route: RouteFn = async () => streamOkResult(sseTextStream());
    const pipeline = createMessagesPipeline(route, "anthropic_messages", { observe });
    const run = await pipeline.run(
      irOf({
        stream: true,
        metadata: { trace_id: "t", thread_id: "th-1", memory_mode: "observe" },
      }),
      IDENTITY,
      new AbortController().signal,
    );
    for await (const _ of run.streamIR()) {
      // drain
    }
    const assistant = persisted.find((m) => m.role === "assistant");
    expect(assistant).toBeDefined();
    expect(assistant?.content).toBe("hi");
  });

  it("openai_responses stream also accumulates assistant text via memory observe (line 1112)", async () => {
    const { observe, persisted } = makeObserveSpy();
    const route: RouteFn = async () => streamOkResult(sseTextStream());
    const pipeline = createMessagesPipeline(route, "openai_responses", { observe });
    const run = await pipeline.run(
      irOf({
        stream: true,
        metadata: { trace_id: "t", thread_id: "th-1", memory_mode: "observe" },
      }),
      IDENTITY,
      new AbortController().signal,
    );
    for await (const _ of run.streamIR()) {
      // drain
    }
    const assistant = persisted.find((m) => m.role === "assistant");
    expect(assistant).toBeDefined();
    expect(assistant?.content).toBe("hi");
  });
});

describe("createMessagesPipeline — accumulateAnthropicAssistantText edge cases (lines 499-508)", () => {
  // We test these via the native passthrough stream path — the accumulator is called per frame.
  it("passthrough stream with empty-text content_block_delta does not grow assistant text (line 499)", async () => {
    // A stream where the text_delta carries empty string → assistant text stays empty
    const frames = [
      'event: message_start\ndata: {"type":"message_start","message":{"id":"m","usage":{"input_tokens":1}}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":""}}\n\n',
      'event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":0}}\n\n',
    ];
    const stream = (async function* (): AsyncIterable<string> {
      for (const f of frames) yield f;
    })();
    const { observe, persisted } = makeObserveSpy();
    const pipeline = createMessagesPipeline(
      () => Promise.resolve({ ...passthroughStreamResult(stream) }),
      "anthropic_messages",
      { observe },
    );
    const run = await pipeline.run(
      irOf({
        stream: true,
        metadata: { trace_id: "t", thread_id: "th-1", memory_mode: "observe" },
      }),
      IDENTITY,
      new AbortController().signal,
    );
    for await (const _ of run.streamIR()) {
      // drain
    }
    // Empty text_delta → no assistant turn persisted (the accumulator returns without appending)
    const assistant = persisted.find((m) => m.role === "assistant");
    expect(assistant).toBeUndefined();
  });

  it("passthrough stream: non-text_delta content_block_delta is ignored by accumulator (line 506-507)", async () => {
    const frames = [
      'event: message_start\ndata: {"type":"message_start","message":{"id":"m","usage":{"input_tokens":1}}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{}"}}\n\n',
      'event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":1}}\n\n',
    ];
    const stream = (async function* (): AsyncIterable<string> {
      for (const f of frames) yield f;
    })();
    const { observe, persisted } = makeObserveSpy();
    const pipeline = createMessagesPipeline(
      () => Promise.resolve({ ...passthroughStreamResult(stream) }),
      "anthropic_messages",
      { observe },
    );
    const run = await pipeline.run(
      irOf({
        stream: true,
        metadata: { trace_id: "t", thread_id: "th-1", memory_mode: "observe" },
      }),
      IDENTITY,
      new AbortController().signal,
    );
    for await (const _ of run.streamIR()) {
      // drain
    }
    // Non-text-delta → tool call accumulator ignores it → no assistant turn
    const assistant = persisted.find((m) => m.role === "assistant");
    expect(assistant).toBeUndefined();
  });
});

describe("createMessagesPipeline — Anthropic stream model ID fallbacks (lines 1151-1158)", () => {
  it("uses ir.model when decision.final.status is not 'ok' (line 1156-1157 fallback)", async () => {
    // The model-id branch at line 1151 reads result.decision.final?.status (NOT result.final).
    // We keep result.final.status = "ok" (so no PipelineError is thrown) but set
    // decision.final to a non-"ok" status so the else branch (line 1156-1157) is taken.
    const streamResult = streamOkResult(sseTextStream());
    Object.assign(streamResult, {
      decision: {
        ...streamResult.decision,
        final: { status: "fallback" },
        cost_breakdown: { total_usd: 0, completion_usd: null, eval_usd: null },
        request_id: "req-1",
      },
    });
    const pipeline = createMessagesPipeline(
      () => Promise.resolve(streamResult),
      "anthropic_messages",
    );
    const run = await pipeline.run(
      irOf({ stream: true, model: "claude-3-5-sonnet" }),
      IDENTITY,
      new AbortController().signal,
    );
    // Should still yield events (model comes from ir.model fallback at line 1157)
    const types: string[] = [];
    for await (const ev of run.streamIR()) {
      types.push(String(ev.type));
    }
    expect(types.length).toBeGreaterThan(0);
  });

  it("uses provider_model when final.status is ok with provider_model defined (line 1153)", async () => {
    const streamResult = streamOkResult(sseTextStream());
    Object.assign(streamResult, {
      decision: {
        ...streamResult.decision,
        final: {
          status: "ok",
          model_alias: "anthropic/claude-3-5-sonnet",
          provider_model: "claude-3-5-sonnet-20241022",
        },
        cost_breakdown: { total_usd: 0, completion_usd: null, eval_usd: null },
        request_id: "req-1",
      },
    });
    const pipeline = createMessagesPipeline(
      () => Promise.resolve(streamResult),
      "anthropic_messages",
    );
    const run = await pipeline.run(irOf({ stream: true }), IDENTITY, new AbortController().signal);
    const types: string[] = [];
    for await (const ev of run.streamIR()) {
      types.push(String(ev.type));
    }
    expect(types.length).toBeGreaterThan(0);
  });
});

describe("createMessagesPipeline — normalizeOpenAIStreamUsageForIR via gemini stream (lines 551-593)", () => {
  it("gemini streamIR path normalizes OpenAI usage chunk (usage with prompt_tokens_details)", async () => {
    // A special SSE stream that carries an OpenAI usage block with prompt_tokens_details
    const usageChunk = JSON.stringify({
      id: "cg-1",
      model: "gemini-2.0-flash",
      choices: [{ index: 0, delta: { content: "hi" } }],
      usage: {
        prompt_tokens: 10,
        completion_tokens: 5,
        prompt_tokens_details: { cached_tokens: 3, cache_creation_input_tokens: 1 },
      },
    });
    const stream = (async function* (): AsyncIterable<string> {
      yield `data: ${usageChunk}\n\n`;
      yield `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`;
      yield "data: [DONE]\n\n";
    })();
    const decisionRef = streamOkResult(stream).decision;
    // Override the decision's final to have a valid model_alias
    Object.assign(decisionRef, {
      final: { status: "ok", model_alias: "gemini/gemini-2.0-flash" },
      cost_breakdown: { total_usd: 0, completion_usd: null, eval_usd: null },
    });
    const pipeline = createMessagesPipeline(
      () => Promise.resolve({ ...streamOkResult(stream), decision: decisionRef }),
      "gemini",
    );
    const run = await pipeline.run(irOf({ stream: true }), IDENTITY, new AbortController().signal);
    const events: Array<Record<string, unknown>> = [];
    for await (const ev of run.streamIR()) events.push(ev);
    // The stream emitted at least one chunk (gemini path)
    expect(events.length).toBeGreaterThan(0);
  });
});

describe("createMessagesPipeline — streamIR with usage tracking + costOf (lines 1196-1218)", () => {
  it("invokes costOf + backfillCompletionCost in stream finally when lastUsage is present", async () => {
    const usageFrame = JSON.stringify({
      choices: [{ index: 0, delta: { content: "hello" } }],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    });
    const stream = (async function* (): AsyncIterable<string> {
      yield `data: ${usageFrame}\n\n`;
      yield `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`;
      yield "data: [DONE]\n\n";
    })();
    const decisionRef = streamOkResult(stream).decision;
    Object.assign(decisionRef, {
      final: { status: "ok", model_alias: "gpt-4o" },
      cost_breakdown: { total_usd: 0, completion_usd: null, eval_usd: null },
    });
    const costOf = vi.fn().mockReturnValue(0.01);
    const budget: PipelineBudgetDeps = {
      gate: { check: async () => ({ overBudget: false }) as never },
      settle: async () => {},
      now: () => 0,
      costOf,
    };
    const identity: MessagesIdentity = {
      keyId: "k1",
      accountId: "acct",
      caps: { budget: { spend_usd: { day: 1 } } as never },
    };
    const pipeline = createMessagesPipeline(
      () => Promise.resolve({ ...streamOkResult(stream), decision: decisionRef }),
      "anthropic_messages",
      undefined,
      budget,
    );
    const run = await pipeline.run(irOf({ stream: true }), identity, new AbortController().signal);
    for await (const _ of run.streamIR()) {
      // drain
    }
    // costOf should have been called during the stream finally block
    expect(costOf).toHaveBeenCalledWith("gpt-4o", expect.objectContaining({ prompt_tokens: 10 }));
    // Usage should be backfilled onto the decision
    expect(decisionRef.usage).toMatchObject({ prompt_tokens: 10, completion_tokens: 5 });
  });

  it("calls recordOAuthUsage in passthrough stream finally (lines 1093-1096)", async () => {
    const oauthCalls: Array<{ alias: string | null; tokens: number }> = [];
    const recordOAuthUsage = (
      _account: unknown,
      alias: string | null,
      usage: { tokens: number; costUsd: number | null },
    ) => {
      oauthCalls.push({ alias, tokens: usage.tokens });
    };
    const decisionRef = passthroughStreamResult().decision;
    Object.assign(decisionRef, {
      final: { status: "ok", model_alias: "anthropic/claude-3-5-sonnet" },
      cost_breakdown: { total_usd: 0, completion_usd: 0.003, eval_usd: null },
    });
    const pipeline = createMessagesPipeline(
      () => Promise.resolve({ ...passthroughStreamResult(), decision: decisionRef }),
      "anthropic_messages",
      undefined,
      undefined,
      recordOAuthUsage,
    );
    const run = await pipeline.run(irOf({ stream: true }), IDENTITY, new AbortController().signal);
    for await (const _ of run.streamIR()) {
      // drain
    }
    expect(oauthCalls.length).toBe(1);
    // input(7)+cache_read(3)+cache_creation(2)+output(11) = 23 tokens
    expect(oauthCalls[0]?.tokens).toBe(23);
  });

  it("calls recordOAuthUsage in stream finally after draining (lines 1216-1218)", async () => {
    const oauthCalls: Array<{ alias: string | null; tokens: number }> = [];
    const recordOAuthUsage = (
      _account: unknown,
      alias: string | null,
      usage: { tokens: number; costUsd: number | null },
    ) => {
      oauthCalls.push({ alias, tokens: usage.tokens });
    };
    const usageFrame = JSON.stringify({
      choices: [{ index: 0, delta: { content: "yo" } }],
      usage: { prompt_tokens: 8, completion_tokens: 4 },
    });
    const stream = (async function* (): AsyncIterable<string> {
      yield `data: ${usageFrame}\n\n`;
      yield `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`;
      yield "data: [DONE]\n\n";
    })();
    const decisionRef = streamOkResult(stream).decision;
    Object.assign(decisionRef, {
      final: { status: "ok", model_alias: "gpt-4o" },
      cost_breakdown: { total_usd: 0, completion_usd: 0.002, eval_usd: null },
    });
    const pipeline = createMessagesPipeline(
      () => Promise.resolve({ ...streamOkResult(stream), decision: decisionRef }),
      "anthropic_messages",
      undefined,
      undefined,
      recordOAuthUsage,
    );
    const run = await pipeline.run(irOf({ stream: true }), IDENTITY, new AbortController().signal);
    for await (const _ of run.streamIR()) {
      // drain
    }
    expect(oauthCalls.length).toBe(1);
    expect(oauthCalls[0]?.tokens).toBe(12); // 8 + 4
  });
});
