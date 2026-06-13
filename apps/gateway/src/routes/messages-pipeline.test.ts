import type { ExecutionResult, RouteOptions } from "@helm/core";
import { type InternalRequest, makeHelmError, type Protocol } from "@helm/shared";
import { describe, expect, it } from "vitest";
import type { MessagesIdentity } from "./messages.js";
import { createMessagesPipeline, PipelineError, type RouteFn } from "./messages-pipeline.js";

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
