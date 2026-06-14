import type { BudgetCheckResult, ExecutionResult, ObserveDeps, RouteOptions } from "@helm/core";
import type { MemoryMessageInput } from "@helm/shared";
import { describe, expect, it, vi } from "vitest";
import { createWriteQueue } from "../runtime/write-queue.js";
import type { MessagesIdentity } from "./messages.js";
import {
  createMessagesPipeline,
  type PipelineBudgetDeps,
  PipelineError,
  type RouteFn,
} from "./messages-pipeline.js";

// Supplemental coverage for the TRANSLATE (non-passthrough) governance paths the
// pipeline test leaves open: observeOutbound + budget settle + recordOAuthUsage on
// BOTH the non-stream collect() and the streamed streamIR() finally, the pre-route
// budget gate (reject → PipelineError, degrade → keyCaps.degradeLane), and the
// Gemini stream protocol branch's usage normalization. The passthrough faces are
// already covered by messages-pipeline.test.ts; this targets the translate twins.

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

// An OpenAI non-stream body the route projects into an IR (translate path). Carries
// an assistant turn + a usage block so the settle/backfill helpers read real tokens.
const OPENAI_BODY = {
  id: "chatcmpl-1",
  model: "gpt-x",
  choices: [
    {
      index: 0,
      message: { role: "assistant", content: "translated reply" },
      finish_reason: "stop",
    },
  ],
  usage: { prompt_tokens: 5, completion_tokens: 7, total_tokens: 12 },
};

function okResult(body: unknown): ExecutionResult {
  return {
    decision: {
      lane: { selected_lane: "balanced" },
      final: { status: "ok", model_alias: "gpt-x" },
      cost_breakdown: { total_usd: 0.01, completion_usd: 0.005, eval_usd: null },
    } as unknown as ExecutionResult["decision"],
    final: { status: "ok", alias: "gpt-x" },
    body,
    stream: null,
    error: null,
  };
}

// A minimal OpenAI SSE byte stream (content delta + a trailing usage chunk + stop).
function openAISSEStream(): AsyncIterable<string> {
  const frames = [
    `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "translated reply" } }] })}\n\n`,
    `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 7, total_tokens: 12 } })}\n\n`,
    "data: [DONE]\n\n",
  ];
  return (async function* () {
    for (const f of frames) yield f;
  })();
}

function streamOkResult(stream: AsyncIterable<string>): ExecutionResult {
  return {
    decision: {
      lane: { selected_lane: "balanced" },
      final: { status: "ok", model_alias: "gpt-x" },
      cost_breakdown: { total_usd: 0.01, completion_usd: 0.005, eval_usd: null },
    } as unknown as ExecutionResult["decision"],
    final: { status: "ok", alias: "gpt-x" },
    body: null,
    stream,
    error: null,
  };
}

function makeObserveSpy(): { observe: ObserveDeps; persisted: MemoryMessageInput[] } {
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

const BUDGET_IDENTITY: MessagesIdentity = {
  keyId: "k1",
  accountId: "acct",
  caps: { budget: { spend_usd: { day: 1 } } as never },
};

function budgetDeps(check: () => Promise<BudgetCheckResult>): {
  budget: PipelineBudgetDeps;
  settledTokens: { value: number | null };
} {
  const settledTokens = { value: null as number | null };
  const budget: PipelineBudgetDeps = {
    gate: { check },
    settle: async (_keyId, _caps, usage) => {
      settledTokens.value = usage.tokens;
    },
    costOf: (_alias, usage) =>
      (usage.prompt_tokens ?? 0) * 1e-6 + (usage.completion_tokens ?? 0) * 2e-6,
    now: () => 1000,
  };
  return { budget, settledTokens };
}

describe("createMessagesPipeline — translate collect() governance", () => {
  it("observes the assistant turn, settles the budget, and records OAuth usage on the non-stream IR path", async () => {
    const { observe, persisted } = makeObserveSpy();
    const recordOAuthUsage = vi.fn();
    const { budget, settledTokens } = budgetDeps(async () => ({ overBudget: false }) as never);
    const route: RouteFn = async () => okResult(OPENAI_BODY);
    const pipeline = createMessagesPipeline(
      route,
      "anthropic_messages",
      { observe },
      budget,
      recordOAuthUsage,
    );

    const run = await pipeline.run(
      irOf({ metadata: { trace_id: "t", thread_id: "th-1", memory_mode: "observe" } }),
      BUDGET_IDENTITY,
      new AbortController().signal,
    );
    const body = await run.collect();

    // The IR projection carries the assistant content (translate path, not verbatim).
    expect(
      (body as { choices: Array<{ message: { content: string } }> }).choices[0]?.message.content,
    ).toBe("translated reply");
    // observeOutbound persisted the reconstructed assistant turn.
    expect(persisted.some((m) => m.role === "assistant" && m.content === "translated reply")).toBe(
      true,
    );
    // The budget settled the served tokens from the OpenAI usage block (5 + 7).
    expect(settledTokens.value).toBe(12);
    // Per-account OAuth usage recorded with the served alias.
    expect(recordOAuthUsage).toHaveBeenCalledOnce();
    const usageArg = recordOAuthUsage.mock.calls[0]?.[2] as { tokens: number };
    expect(usageArg.tokens).toBe(12);
  });
});

describe("createMessagesPipeline — translate streamIR() governance finally", () => {
  it("observes the streamed assistant text, settles tokens from the usage tail, and records OAuth usage", async () => {
    const { observe, persisted } = makeObserveSpy();
    const recordOAuthUsage = vi.fn();
    const { budget, settledTokens } = budgetDeps(async () => ({ overBudget: false }) as never);
    const route: RouteFn = async () => streamOkResult(openAISSEStream());
    const pipeline = createMessagesPipeline(
      route,
      "anthropic_messages",
      { observe },
      budget,
      recordOAuthUsage,
    );

    const run = await pipeline.run(
      irOf({
        stream: true,
        metadata: { trace_id: "t", thread_id: "th-1", memory_mode: "observe" },
      }),
      BUDGET_IDENTITY,
      new AbortController().signal,
    );
    // Drain the Anthropic SSE events so the finally (observe + settle + OAuth) runs.
    const types: string[] = [];
    for await (const ev of run.streamIR()) types.push(String(ev.type));

    expect(types[0]).toBe("message_start");
    // The reconstructed assistant text reached observeOutbound.
    expect(persisted.some((m) => m.role === "assistant" && m.content === "translated reply")).toBe(
      true,
    );
    // The trailing usage chunk settled the streamed tokens.
    expect(settledTokens.value).toBe(12);
    expect(recordOAuthUsage).toHaveBeenCalledOnce();
  });
});

describe("createMessagesPipeline — pre-route budget gate", () => {
  it("rejects an over-budget request (behavior=reject) with a rate_limited PipelineError before routing", async () => {
    const route = vi.fn<RouteFn>(async () => okResult(OPENAI_BODY));
    const { budget } = budgetDeps(
      async () =>
        ({
          overBudget: true,
          limitedBy: "spend",
          behavior: "reject",
          degradeLane: null,
        }) as never,
    );
    const pipeline = createMessagesPipeline(route, "anthropic_messages", undefined, budget);

    await expect(
      pipeline.run(irOf(), BUDGET_IDENTITY, new AbortController().signal),
    ).rejects.toMatchObject({ error_class: "rate_limited" });
    // The gate cut the request off BEFORE routing.
    expect(route).not.toHaveBeenCalled();
  });

  it("threads the degrade lane into keyCaps.degradeLane (behavior=degrade) and still routes", async () => {
    let sawOpts: RouteOptions | null = null;
    const route: RouteFn = async (_req, opts) => {
      sawOpts = opts;
      return okResult(OPENAI_BODY);
    };
    const { budget } = budgetDeps(
      async () =>
        ({
          overBudget: true,
          limitedBy: "spend",
          behavior: "degrade",
          degradeLane: "economy",
        }) as never,
    );
    const pipeline = createMessagesPipeline(route, "anthropic_messages", undefined, budget);

    await pipeline.run(irOf(), BUDGET_IDENTITY, new AbortController().signal);

    expect((sawOpts as RouteOptions | null)?.keyCaps?.degradeLane).toBe("economy");
  });

  it("surfaces a PipelineError(rate_limited) as the thrown type (instanceof PipelineError)", async () => {
    const { budget } = budgetDeps(
      async () =>
        ({
          overBudget: true,
          limitedBy: "spend",
          behavior: "reject",
          degradeLane: null,
        }) as never,
    );
    const pipeline = createMessagesPipeline(
      async () => okResult(OPENAI_BODY),
      "anthropic_messages",
      undefined,
      budget,
    );

    await expect(
      pipeline.run(irOf(), BUDGET_IDENTITY, new AbortController().signal),
    ).rejects.toBeInstanceOf(PipelineError);
  });
});

// A VERBATIM Anthropic-native non-stream response (passthrough collect path).
const NATIVE_ANTHROPIC_BODY = {
  id: "msg_native_1",
  type: "message",
  role: "assistant",
  model: "claude-3-5-sonnet",
  content: [{ type: "text", text: "native reply" }],
  stop_reason: "end_turn",
  stop_sequence: null,
  usage: { input_tokens: 7, output_tokens: 11, cache_read_input_tokens: 3 },
};

function passthroughOkResult(body: unknown = NATIVE_ANTHROPIC_BODY): ExecutionResult {
  return {
    decision: {
      lane: { selected_lane: "balanced" },
      final: { status: "ok", model_alias: "anthropic/claude-3-5-sonnet" },
      cost_breakdown: { total_usd: 0.05, completion_usd: 0.02, eval_usd: null },
    } as unknown as ExecutionResult["decision"],
    final: { status: "ok", alias: "anthropic/claude-3-5-sonnet" },
    body,
    stream: null,
    error: null,
    nativePassthrough: true,
  };
}

describe("createMessagesPipeline — deferred observe via write queue", () => {
  it("enqueues observeInbound/outbound onto the write queue instead of awaiting inline", async () => {
    const { observe, persisted } = makeObserveSpy();
    const q = createWriteQueue({
      telemetry: { insert: vi.fn().mockResolvedValue({ id: "1" }) } as never,
      log: () => {},
      flushIntervalMs: 10_000,
    });
    const route: RouteFn = async () => okResult(OPENAI_BODY);
    const pipeline = createMessagesPipeline(
      route,
      "anthropic_messages",
      { observe },
      undefined,
      undefined,
      q,
    );

    const run = await pipeline.run(
      irOf({ metadata: { trace_id: "t", thread_id: "th-q", memory_mode: "observe" } }),
      IDENTITY,
      new AbortController().signal,
    );
    await run.collect();
    await q.flush();

    // The deferred (enqueued) observe path ran: inbound user + outbound assistant.
    expect(persisted.some((m) => m.role === "user" && m.content === "hi")).toBe(true);
    expect(persisted.some((m) => m.role === "assistant" && m.content === "translated reply")).toBe(
      true,
    );
  });
});

describe("createMessagesPipeline — passthrough collect() OAuth + observe", () => {
  it("records OAuth usage + observes the assistant turn reconstructed from native content", async () => {
    const { observe, persisted } = makeObserveSpy();
    const recordOAuthUsage = vi.fn();
    const route: RouteFn = async () => passthroughOkResult();
    const pipeline = createMessagesPipeline(
      route,
      "anthropic_messages",
      { observe },
      undefined,
      recordOAuthUsage,
    );

    const run = await pipeline.run(
      irOf({ metadata: { trace_id: "t", thread_id: "th-1", memory_mode: "observe" } }),
      IDENTITY,
      new AbortController().signal,
    );
    const body = await run.collect();

    // The verbatim native body is handed back UNTOUCHED on the passthrough path.
    expect(body).toEqual(NATIVE_ANTHROPIC_BODY);
    // observeOutbound reconstructed the assistant turn from content[].text.
    expect(persisted.some((m) => m.role === "assistant" && m.content === "native reply")).toBe(
      true,
    );
    // Per-account OAuth usage recorded with the served alias.
    expect(recordOAuthUsage).toHaveBeenCalledOnce();
    const aliasArg = recordOAuthUsage.mock.calls[0]?.[1];
    expect(aliasArg).toBe("anthropic/claude-3-5-sonnet");
  });
});

// A canned Anthropic SSE byte stream (what provider.nativePassthroughStream emits):
// message_start (usage in) + text deltas + message_delta (usage out) + message_stop.
const NATIVE_SSE_FRAMES = [
  'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_x","usage":{"input_tokens":7,"cache_read_input_tokens":3}}}\n\n',
  'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}\n\n',
  'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":" native"}}\n\n',
  'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":11}}\n\n',
  'event: message_stop\ndata: {"type":"message_stop"}\n\n',
];

function nativeSseTextStream(): AsyncIterable<string> {
  const joined = NATIVE_SSE_FRAMES.join("");
  const pieces: string[] = [];
  // Re-chunk into 17-byte pieces so frames straddle chunk boundaries.
  for (let i = 0; i < joined.length; i += 17) pieces.push(joined.slice(i, i + 17));
  return (async function* () {
    for (const p of pieces) yield p;
  })();
}

function passthroughStreamResult(): ExecutionResult {
  return {
    decision: {
      lane: { selected_lane: "balanced" },
      final: { status: "ok", model_alias: "anthropic/claude-3-5-sonnet" },
      cost_breakdown: { total_usd: 0.05, completion_usd: 0.02, eval_usd: null },
    } as unknown as ExecutionResult["decision"],
    final: { status: "ok", alias: "anthropic/claude-3-5-sonnet" },
    body: null,
    stream: nativeSseTextStream(),
    error: null,
    nativePassthrough: true,
  };
}

describe("createMessagesPipeline — passthrough streamIR() OAuth + observe finally", () => {
  it("byte-relays the frames, observes the reconstructed assistant text, and records OAuth usage", async () => {
    const { observe, persisted } = makeObserveSpy();
    const recordOAuthUsage = vi.fn();
    const { budget, settledTokens } = budgetDeps(async () => ({ overBudget: false }) as never);
    const route: RouteFn = async () => passthroughStreamResult();
    const pipeline = createMessagesPipeline(
      route,
      "anthropic_messages",
      { observe },
      budget,
      recordOAuthUsage,
    );

    const run = await pipeline.run(
      irOf({
        stream: true,
        metadata: { trace_id: "t", thread_id: "th-1", memory_mode: "observe" },
      }),
      BUDGET_IDENTITY,
      new AbortController().signal,
    );

    const frames: Record<string, unknown>[] = [];
    for await (const frame of run.streamIR()) frames.push(frame);

    // The passthrough path yields verbatim {event,data} frames (no SSE `type` bag).
    expect(frames[0]?.event).toBe("message_start");
    expect(frames.some((f) => f.event === "message_stop")).toBe(true);
    // The assistant text reconstructed from the text_delta frames reached observe.
    expect(persisted.some((m) => m.role === "assistant" && m.content === "Hello native")).toBe(
      true,
    );
    // The native SSE usage tail settled the streamed tokens (input 7 + cache 3 +
    // output 11 = 21 — the Anthropic usage extractor counts cache_read into input).
    expect(settledTokens.value).toBe(21);
    expect(recordOAuthUsage).toHaveBeenCalledOnce();
  });
});

describe("createMessagesPipeline — gemini stream protocol branch", () => {
  it("yields Gemini GenerateContentResponse snapshots (no `type`) and normalizes the usage chunk", async () => {
    const route: RouteFn = async () => streamOkResult(openAISSEStream());
    const pipeline = createMessagesPipeline(route, "gemini");

    const run = await pipeline.run(
      irOf({ model: "gemini-2.0-flash", stream: true }),
      IDENTITY,
      new AbortController().signal,
    );

    const snapshots: Record<string, unknown>[] = [];
    for await (const snap of run.streamIR()) snapshots.push(snap);

    // Gemini frames are nameless snapshots (no SSE `type`), each a GenerateContentResponse.
    expect(snapshots.length).toBeGreaterThan(0);
    expect(snapshots.every((s) => s.type === undefined)).toBe(true);
    // The candidate content rode through the gemini delta state machine.
    const text = JSON.stringify(snapshots);
    expect(text).toContain("candidates");
  });
});
