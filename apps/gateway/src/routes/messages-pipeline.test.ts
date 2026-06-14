import type { ExecutionResult, InjectDeps, ObserveDeps, RouteOptions } from "@helm/core";
import {
  type InternalRequest,
  type MemoryMessageInput,
  makeHelmError,
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
      IDENTITY,
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
    });
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
  'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_x","usage":{ "input_tokens":7 ,"cache_read_input_tokens":3,"cache_creation_input_tokens":2}}}\n\n',
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
      '{"type":"message_start","message":{"id":"msg_x","usage":{ "input_tokens":7 ,"cache_read_input_tokens":3,"cache_creation_input_tokens":2}}}',
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
    });
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

describe("createMessagesPipeline — production IR params", () => {
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
      IDENTITY,
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
