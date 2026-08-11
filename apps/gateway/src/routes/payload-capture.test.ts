import {
  type DecisionRecord,
  type InsertPayloadInput,
  splitSessionRequestJson,
  type UpsertSessionRevisionInput,
} from "@helm/core";
import { describe, expect, it, vi } from "vitest";
import type { WriteQueue } from "../runtime/write-queue.js";
import { createWriteQueue } from "../runtime/write-queue.js";
import {
  backfillCompletionCost,
  capturedResponsesResponse,
  createResponsesDeltaAccumulator,
  createSseCapture,
  createStreamGenerationTimer,
  decisionForTimedOutRequest,
  estimateInterruptedResponsesUsage,
  type PayloadCaptureDeps,
  persistPayload,
  persistSessionRequest,
  queueOrPersistSessionRequest,
  type RecordServedDeps,
  recordServed,
  tokensFromUsage,
  usageFromAnthropicResponse,
  usageFromAnthropicSSE,
  usageFromGeminiResponse,
  usageFromGeminiSSE,
  usageFromResponsesResponse,
  usageFromResponsesSSE,
  usageFromSSE,
  withRequestContentMode,
  withSseCaptureRelease,
} from "./payload-capture.js";

describe("per-key request content mode", () => {
  const global = {
    telemetry: {} as PayloadCaptureDeps["telemetry"],
    capturePayloads: () => false,
    captureSessions: () => true,
  } satisfies PayloadCaptureDeps;

  it.each([
    [null, false, true],
    ["none", false, false],
    ["payload", true, false],
    ["session", false, true],
  ] as const)("resolves %s over the global mode", (mode, payloads, sessions) => {
    const scoped = withRequestContentMode(global, mode);
    expect(scoped.capturePayloads?.()).toBe(payloads);
    expect(scoped.captureSessions?.()).toBe(sessions);
  });

  it("lets an explicit key mode override the global toggle in both directions", () => {
    // Global fully off (metadata-only). An explicit key mode must still capture:
    // per-key `none/payload/session` is the highest priority, `null` inherits.
    const globalOff = {
      telemetry: {} as PayloadCaptureDeps["telemetry"],
      capturePayloads: () => false,
      captureSessions: () => false,
    } satisfies PayloadCaptureDeps;

    const forcedPayload = withRequestContentMode(globalOff, "payload");
    expect(forcedPayload.capturePayloads?.()).toBe(true);
    expect(forcedPayload.captureSessions?.()).toBe(false);

    const forcedSession = withRequestContentMode(globalOff, "session");
    expect(forcedSession.capturePayloads?.()).toBe(false);
    expect(forcedSession.captureSessions?.()).toBe(true);

    // Global on, key opts out: `none` forces capture off for this request only.
    const globalOn = {
      telemetry: {} as PayloadCaptureDeps["telemetry"],
      capturePayloads: () => true,
      captureSessions: () => true,
    } satisfies PayloadCaptureDeps;

    const forcedOff = withRequestContentMode(globalOn, "none");
    expect(forcedOff.capturePayloads?.()).toBe(false);
    expect(forcedOff.captureSessions?.()).toBe(false);

    // `null` inherits the live global — tracked even as it flips.
    let live = true;
    const inherit = withRequestContentMode(
      {
        telemetry: {} as PayloadCaptureDeps["telemetry"],
        capturePayloads: () => live,
        captureSessions: () => false,
      },
      null,
    );
    expect(inherit.capturePayloads?.()).toBe(true);
    live = false;
    expect(inherit.capturePayloads?.()).toBe(false);
  });
});

describe("Session queue admission", () => {
  it("does nothing when Session capture is disabled", async () => {
    const enqueueSession = vi.fn();
    const getSessionByRef = vi.fn();
    const upsertSessionRevision = vi.fn();
    const log = vi.fn();

    await queueOrPersistSessionRequest(
      {
        telemetry: {
          getSessionByRef,
          upsertSessionRevision,
        } as unknown as PayloadCaptureDeps["telemetry"],
        writes: { enqueueSession } as unknown as WriteQueue,
        captureSessions: () => false,
        captureBodyLimitBytes: 10,
      },
      {
        requestId: "request-disabled",
        accountId: "account-1",
        apiKeyId: "key-1",
        decision: {
          session: { ref: "session-disabled", label: "thread-disabled", source: "x-session-key" },
        } as unknown as DecisionRecord,
        requestJson: "x".repeat(11),
        responseId: null,
        responseJson: "x".repeat(11),
        now: 1,
      },
      log,
    );

    expect(log).not.toHaveBeenCalled();
    expect(enqueueSession).not.toHaveBeenCalled();
    expect(getSessionByRef).not.toHaveBeenCalled();
    expect(upsertSessionRevision).not.toHaveBeenCalled();
  });

  it("rejects an oversized retained body before creating the deferred closure", async () => {
    const enqueueSession = vi.fn();
    const writes = { enqueueSession } as unknown as WriteQueue;
    const sessionDecision = {
      session: { ref: "session-capacity", label: "thread-capacity", source: "x-session-key" },
    } as unknown as DecisionRecord;
    const log = vi.fn();

    await queueOrPersistSessionRequest(
      {
        telemetry: {} as PayloadCaptureDeps["telemetry"],
        writes,
        captureSessions: () => true,
        captureBodyLimitBytes: 10,
      },
      {
        requestId: "request-capacity",
        accountId: "account-1",
        apiKeyId: "key-1",
        decision: sessionDecision,
        requestJson: "x".repeat(11),
        responseId: null,
        responseJson: null,
        now: 1,
      },
      log,
    );

    expect(enqueueSession).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith("session.capture_limited");
  });

  it("drops a queued Session body after metadata-only is enabled", async () => {
    let task: (() => Promise<void>) | undefined;
    const writes = {
      enqueueSession: vi.fn(async (queued: () => Promise<void>) => {
        task = queued;
      }),
    } as unknown as WriteQueue;
    const upsertSessionRevision = vi.fn();
    let capture = true;
    let generation = 0;

    await queueOrPersistSessionRequest(
      {
        telemetry: { upsertSessionRevision } as unknown as PayloadCaptureDeps["telemetry"],
        writes,
        captureSessions: () => capture,
        captureGeneration: () => generation,
      },
      {
        requestId: "request-disabled-before-flush",
        accountId: "account-1",
        apiKeyId: "key-1",
        decision: {
          session: { ref: "session-1", label: "thread-1", source: "x-session-key" },
        } as unknown as DecisionRecord,
        requestJson: '{"input":"hello"}',
        responseId: null,
        responseJson: null,
        now: 1,
      },
      vi.fn(),
    );

    capture = false;
    generation++;
    await task?.();
    expect(upsertSessionRevision).not.toHaveBeenCalled();
  });

  it("uses the persisted head hash instead of retaining the previous request JSON", async () => {
    const first = splitSessionRequestJson('{"messages":["one"]}');
    const upsertSessionRevision = vi.fn();
    const telemetry = {
      getSessionByRef: vi.fn(async () => ({
        headRequestId: "r1",
        revisionCount: 1,
        storedBytes: 10,
        eventHead: {
          requestId: "r1",
          eventKey: first.eventKey,
          eventCount: first.eventCount,
          eventHash: first.eventHash,
        },
      })),
      upsertSessionRevision,
    } as unknown as PayloadCaptureDeps["telemetry"];

    await persistSessionRequest(
      { telemetry, captureSessions: () => true },
      {
        requestId: "r2",
        accountId: "account-1",
        apiKeyId: "key-1",
        decision: {
          session: { ref: "session-1", label: "thread-1", source: "x-session-key" },
        } as unknown as DecisionRecord,
        requestJson: '{"messages":["one","two"]}',
        responseId: null,
        responseJson: null,
        now: 2,
      },
      vi.fn(),
    );

    expect(upsertSessionRevision).toHaveBeenCalledWith(
      expect.objectContaining({ retainCount: 1, requestDeltaJson: '["two"]' }),
    );
  });

  it("keeps appending after a Session exceeds the former 64 MiB aggregate cap", async () => {
    const upsertSessionRevision = vi.fn();
    const telemetry = {
      getSessionByRef: vi.fn(async () => ({
        revisionCount: 10,
        storedBytes: 64 * 1024 * 1024,
      })),
      upsertSessionRevision,
    } as unknown as PayloadCaptureDeps["telemetry"];
    const log = vi.fn();

    await persistSessionRequest(
      { telemetry, captureSessions: () => true },
      {
        requestId: "request-over-former-cap",
        accountId: "account-1",
        apiKeyId: "key-1",
        decision: {
          session: { ref: "session-over-former-cap", label: "thread-1", source: "x-session-key" },
        } as unknown as DecisionRecord,
        requestJson: '{"input":"hello"}',
        responseId: null,
        responseJson: null,
        now: 1,
      },
      log,
    );

    expect(upsertSessionRevision).toHaveBeenCalledOnce();
    expect(log).not.toHaveBeenCalledWith("session.capture_limited");
  });
});

describe("Responses session response capture", () => {
  const response = {
    id: "resp_1",
    object: "response",
    output: [
      { type: "reasoning", id: "reason_1", summary: [] },
      { type: "function_call", id: "call_1", call_id: "fc_1", name: "lookup", arguments: "{}" },
    ],
  };

  it("normalizes a JSON response while retaining reasoning and tool-call output", () => {
    expect(capturedResponsesResponse("openai_responses", JSON.stringify(response))).toEqual({
      responseId: "resp_1",
      responseJson: JSON.stringify(response),
    });
    expect(capturedResponsesResponse("openai_chat", JSON.stringify(response))).toEqual({
      responseId: null,
      responseJson: null,
    });
  });

  it("extracts the terminal response from SSE", () => {
    const raw = [
      'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"hi"}\n\n',
      `event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response })}\n\n`,
    ].join("");
    expect(capturedResponsesResponse("openai_responses", raw)).toEqual({
      responseId: "resp_1",
      responseJson: JSON.stringify(response),
    });
  });
});

describe("estimateInterruptedResponsesUsage", () => {
  it("aggregates fragmented channels once, dedupes sequence numbers, and ignores done snapshots", () => {
    const accumulator = createResponsesDeltaAccumulator();
    accumulator.observe(
      JSON.stringify({
        type: "response.function_call_arguments.delta",
        sequence_number: 7,
        item_id: "call_1",
        delta: '{"pa',
      }),
    );
    accumulator.observe(
      JSON.stringify({
        type: "response.function_call_arguments.delta",
        sequence_number: 7,
        item_id: "call_1",
        delta: '{"pa',
      }),
    );
    accumulator.observe(
      JSON.stringify({
        type: "response.function_call_arguments.delta",
        sequence_number: 8,
        item_id: "call_1",
        delta: 'th":"/tmp"}',
      }),
    );
    accumulator.observe(
      JSON.stringify({
        type: "response.function_call_arguments.delta",
        sequence_number: 6,
        item_id: "call_1",
        delta: "replayed-old-event",
      }),
    );
    accumulator.observe(
      JSON.stringify({
        type: "response.function_call_arguments.done",
        sequence_number: 9,
        item_id: "call_1",
        arguments: '{"path":"/tmp"}',
      }),
    );

    expect(accumulator.channels()).toEqual(['{"path":"/tmp"}']);
    expect(accumulator.outcome()).toBeNull();
  });

  it("bounds retained deltas and accounts for overflow without retaining it", () => {
    const accumulator = createResponsesDeltaAccumulator();
    accumulator.observe(
      JSON.stringify({
        type: "response.output_text.delta",
        sequence_number: 1,
        item_id: "msg_1",
        delta: "x".repeat(70_000),
      }),
    );

    expect(accumulator.channels().join("").length).toBe(65_536);
    expect(accumulator.overflowBytes()).toBe(4_464);
    const usage = estimateInterruptedResponsesUsage(
      null,
      accumulator.channels(),
      accumulator.overflowBytes(),
    );
    expect(usage?.completion_tokens).toBeGreaterThan(16_384);
  });

  it("estimates the semantic upstream request and observed Responses deltas", () => {
    const upstreamRequest = JSON.stringify({
      model: "gpt-5.6-sol",
      input: [{ role: "user", content: "Explain the billing gap precisely." }],
      stream: true,
    });

    const usage = estimateInterruptedResponsesUsage(upstreamRequest, [
      "I inspected the stream.",
      '{"path":"/tmp/report.json"}',
    ]);

    expect(usage).toMatchObject({
      measurement: "estimated_partial",
      cost_basis: "catalog_api_equivalent_estimate",
      prompt_tokens: expect.any(Number),
      completion_tokens: expect.any(Number),
    });
    expect(usage?.prompt_tokens).toBeGreaterThan(0);
    expect(usage?.completion_tokens).toBeGreaterThan(0);
    expect(usage?.total_tokens).toBe((usage?.prompt_tokens ?? 0) + (usage?.completion_tokens ?? 0));
  });

  it("does not tokenize embedded base64 bytes as prompt text", () => {
    const usage = estimateInterruptedResponsesUsage(
      JSON.stringify({
        model: "gpt-5.6-sol",
        input: [
          {
            role: "user",
            content: [
              { type: "input_text", text: "Describe this image." },
              { type: "input_image", image_url: `data:image/png;base64,${"A".repeat(20_000)}` },
            ],
          },
        ],
        stream: true,
      }),
      [],
    );

    expect(usage?.prompt_tokens).toBeGreaterThan(0);
    expect(usage?.prompt_tokens).toBeLessThan(100);
  });

  it("uses the bounded fallback for a very large semantic prompt", () => {
    const usage = estimateInterruptedResponsesUsage(
      JSON.stringify({ input: [{ role: "user", content: "x".repeat(100_000) }] }),
      [],
    );

    expect(usage?.prompt_tokens).toBeGreaterThan(20_000);
  });

  it("returns null when neither a request nor an observed delta exists", () => {
    expect(estimateInterruptedResponsesUsage(null, [])).toBeNull();
  });
});

describe("usageFromSSE", () => {
  it("extracts the final usage chunk emitted with include_usage", () => {
    const sse = [
      'data: {"choices":[{"delta":{"content":"hi"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":" there"}}]}\n\n',
      'data: {"choices":[],"usage":{"prompt_tokens":12,"completion_tokens":5}}\n\n',
      "data: [DONE]\n\n",
    ].join("");
    expect(usageFromSSE(sse)).toEqual({ prompt_tokens: 12, completion_tokens: 5 });
  });

  it("returns null when the stream never reported usage", () => {
    const sse = 'data: {"choices":[{"delta":{"content":"hi"}}]}\n\ndata: [DONE]\n\n';
    expect(usageFromSSE(sse)).toBeNull();
  });

  it("skips non-JSON keepalive lines without throwing", () => {
    const sse = ': keepalive\n\ndata: {"usage":{"prompt_tokens":1,"completion_tokens":2}}\n\n';
    expect(usageFromSSE(sse)).toEqual({ prompt_tokens: 1, completion_tokens: 2 });
  });

  it("preserves the provider-confirmed service tier from a streamed usage chunk", () => {
    const sse =
      'data: {"choices":[],"service_tier":"priority","usage":{"prompt_tokens":12,"completion_tokens":5}}\n\n';
    expect(usageFromSSE(sse)).toEqual({
      prompt_tokens: 12,
      completion_tokens: 5,
      service_tier: "priority",
    });
  });
});

// Native-protocol-passthrough cost (#217 C-cost): the upstream Anthropic NON-stream
// response carries usage in Anthropic shape (input_tokens / output_tokens / cache_*).
// usageFromAnthropicResponse normalizes it to OpenAI-shaped StreamUsage with the SAME
// token math as core's anthropicToOpenAIResponse (prompt = input + cache_read +
// cache_creation; completion = output) so costOf/resolveCostUsd price a passthrough
// attempt identically to a translated one.
describe("usageFromAnthropicResponse", () => {
  it("maps Anthropic usage to OpenAI-shaped StreamUsage (prompt = input + cache_read + cache_creation)", () => {
    const body = {
      id: "msg_1",
      type: "message",
      role: "assistant",
      content: [{ type: "text", text: "hi" }],
      usage: {
        input_tokens: 1000,
        output_tokens: 500,
        cache_read_input_tokens: 200,
        cache_creation_input_tokens: 50,
      },
    };
    expect(usageFromAnthropicResponse(body)).toEqual({
      prompt_tokens: 1250, // 1000 + 200 + 50
      completion_tokens: 500,
      total_tokens: 1750,
      prompt_tokens_details: { cached_tokens: 200, cache_creation_tokens: 50 },
    });
  });

  it("omits prompt_tokens_details when there are no cache tokens", () => {
    const body = { usage: { input_tokens: 10, output_tokens: 7 } };
    expect(usageFromAnthropicResponse(body)).toEqual({
      prompt_tokens: 10,
      completion_tokens: 7,
      total_tokens: 17,
    });
  });

  it("tolerates missing cache_creation but present cache_read", () => {
    const body = { usage: { input_tokens: 5, output_tokens: 3, cache_read_input_tokens: 4 } };
    expect(usageFromAnthropicResponse(body)).toEqual({
      prompt_tokens: 9, // 5 + 4
      completion_tokens: 3,
      total_tokens: 12,
      prompt_tokens_details: { cached_tokens: 4 },
    });
  });

  it("preserves the Anthropic 5-minute/1-hour cache-write split for costing", () => {
    const body = {
      usage: {
        input_tokens: 10,
        output_tokens: 7,
        inference_geo: "us",
        cache_creation_input_tokens: 5,
        cache_creation: {
          ephemeral_5m_input_tokens: 3,
          ephemeral_1h_input_tokens: 2,
        },
      },
    };
    expect(usageFromAnthropicResponse(body)).toEqual({
      prompt_tokens: 15,
      completion_tokens: 7,
      total_tokens: 22,
      inference_geo: "us",
      prompt_tokens_details: {
        cached_tokens: 0,
        cache_creation_tokens: 5,
        ephemeral_5m_input_tokens: 3,
        ephemeral_1h_input_tokens: 2,
      },
    });
  });

  it("preserves Anthropic's provider-confirmed Fast speed", () => {
    expect(
      usageFromAnthropicResponse({
        usage: { input_tokens: 10, output_tokens: 7, speed: "fast" },
      }),
    ).toEqual({
      prompt_tokens: 10,
      completion_tokens: 7,
      total_tokens: 17,
      service_tier: "fast",
    });
    expect(usageFromAnthropicResponse({ usage: { speed: "fast" } })).toEqual({
      service_tier: "fast",
    });
  });

  it("returns null when the body has no usage object", () => {
    expect(usageFromAnthropicResponse({ id: "msg" })).toBeNull();
    expect(usageFromAnthropicResponse(null)).toBeNull();
    expect(usageFromAnthropicResponse(undefined)).toBeNull();
    expect(usageFromAnthropicResponse({ usage: "nope" })).toBeNull();
  });
});

// Native-protocol-passthrough STREAMING cost (#217 Phase 2 Stage 1): the upstream
// Anthropic SSE carries usage SPLIT across events — input/cache on `message_start`
// (message.usage), output on the LAST `message_delta` (usage.output_tokens). The
// byte-faithful passthrough forwards these frames VERBATIM, so cost extraction must
// scan the accumulated SSE itself. usageFromAnthropicSSE returns an Anthropic-shaped
// StreamUsage that tokensFromUsage already sums (input + output + cache_*), mirroring
// translateAnthropicSSE's accumulation (input on message_start, output on message_delta).
describe("usageFromAnthropicSSE", () => {
  it("reads input_tokens from message_start (input-only, no message_delta yet)", () => {
    const sse = [
      'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":1000}}}\n\n',
      'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
    ].join("");
    expect(usageFromAnthropicSSE(sse)).toEqual({
      input_tokens: 1000,
      output_tokens: 0,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    });
  });

  it("combines input from message_start with output from message_delta", () => {
    const sse = [
      'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":1000}}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hi"}}\n\n',
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":500}}\n\n',
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    ].join("");
    expect(usageFromAnthropicSSE(sse)).toEqual({
      input_tokens: 1000,
      output_tokens: 500,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    });
    // tokensFromUsage sums input + output + cache_* for the budget settle.
    expect(tokensFromUsage(usageFromAnthropicSSE(sse))).toBe(1500);
  });

  it("collects the cache split from message_start (cache_read + cache_creation)", () => {
    const sse = [
      'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":1000,"inference_geo":"us","cache_read_input_tokens":200,"cache_creation_input_tokens":50,"cache_creation":{"ephemeral_5m_input_tokens":30,"ephemeral_1h_input_tokens":20}}}}\n\n',
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":300}}\n\n',
    ].join("");
    const result = usageFromAnthropicSSE(sse);
    expect(result).toEqual({
      input_tokens: 1000,
      output_tokens: 300,
      cache_read_input_tokens: 200,
      cache_creation_input_tokens: 50,
      inference_geo: "us",
      prompt_tokens_details: {
        ephemeral_5m_input_tokens: 30,
        ephemeral_1h_input_tokens: 20,
      },
    });
    // input + output + cache_read + cache_creation = 1000 + 300 + 200 + 50
    expect(tokensFromUsage(result)).toBe(1550);
  });

  it("preserves Anthropic Fast speed from streamed message_start usage", () => {
    const sse = [
      'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":10,"speed":"fast"}}}\n\n',
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":5,"speed":"fast"}}\n\n',
    ].join("");
    expect(usageFromAnthropicSSE(sse)).toEqual({
      input_tokens: 10,
      output_tokens: 5,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
      service_tier: "fast",
    });
  });

  it("takes the MAX output_tokens across multiple message_delta frames", () => {
    const sse = [
      'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":10}}}\n\n',
      'event: message_delta\ndata: {"type":"message_delta","delta":{},"usage":{"output_tokens":7}}\n\n',
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":42}}\n\n',
    ].join("");
    expect(usageFromAnthropicSSE(sse)).toEqual({
      input_tokens: 10,
      output_tokens: 42,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    });
  });

  it("restates cache_* on message_delta (takes the max with message_start)", () => {
    const sse = [
      'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":10,"cache_read_input_tokens":4}}}\n\n',
      'event: message_delta\ndata: {"type":"message_delta","delta":{},"usage":{"output_tokens":5,"cache_read_input_tokens":9,"cache_creation_input_tokens":3}}\n\n',
    ].join("");
    expect(usageFromAnthropicSSE(sse)).toEqual({
      input_tokens: 10,
      output_tokens: 5,
      cache_read_input_tokens: 9,
      cache_creation_input_tokens: 3,
    });
  });

  it("skips ping / [DONE] / non-JSON frames without throwing", () => {
    const sse = [
      'event: ping\ndata: {"type":"ping"}\n\n',
      ": keepalive comment\n\n",
      'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":8}}}\n\n',
      'event: message_delta\ndata: {"type":"message_delta","delta":{},"usage":{"output_tokens":2}}\n\n',
      "data: [DONE]\n\n",
      "data: not json at all\n\n",
    ].join("");
    expect(usageFromAnthropicSSE(sse)).toEqual({
      input_tokens: 8,
      output_tokens: 2,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    });
  });

  it("returns null when no usage-bearing event is present", () => {
    const sse = [
      'event: ping\ndata: {"type":"ping"}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hi"}}\n\n',
      "data: [DONE]\n\n",
    ].join("");
    expect(usageFromAnthropicSSE(sse)).toBeNull();
    expect(usageFromAnthropicSSE("")).toBeNull();
  });
});

// Native-protocol-passthrough cost for openai_responses (#217 Phase 3 Stage 1): the
// upstream Codex Responses NON-stream response carries usage as
// usage:{input_tokens, output_tokens, input_tokens_details:{cached_tokens,
// cache_creation_input_tokens}}. Cache is ALREADY included in input_tokens (unlike
// Anthropic, where it is separate), so usageFromResponsesResponse maps prompt_tokens =
// input_tokens directly — the SAME math as core's aggregateResponsesStream — and
// surfaces the cache split under prompt_tokens_details for the dashboard.
describe("usageFromResponsesResponse", () => {
  it("maps Responses usage to OpenAI-shaped StreamUsage (prompt = input_tokens, cache already included)", () => {
    const body = {
      id: "resp_1",
      object: "response",
      status: "completed",
      usage: {
        input_tokens: 1000,
        output_tokens: 500,
        input_tokens_details: { cached_tokens: 200, cache_creation_input_tokens: 50 },
      },
    };
    expect(usageFromResponsesResponse(body)).toEqual({
      prompt_tokens: 1000, // cache already counted inside input_tokens
      completion_tokens: 500,
      total_tokens: 1500,
      prompt_tokens_details: { cached_tokens: 200, cache_creation_tokens: 50 },
    });
    // The summed budget tokens are prompt + completion (no separate cache add).
    expect(tokensFromUsage(usageFromResponsesResponse(body))).toBe(1500);
  });

  it("omits prompt_tokens_details when there are no cache tokens", () => {
    const body = { usage: { input_tokens: 10, output_tokens: 7 } };
    expect(usageFromResponsesResponse(body)).toEqual({
      prompt_tokens: 10,
      completion_tokens: 7,
      total_tokens: 17,
    });
  });

  it("tolerates cached_tokens without cache_creation", () => {
    const body = {
      usage: { input_tokens: 80, output_tokens: 12, input_tokens_details: { cached_tokens: 30 } },
    };
    expect(usageFromResponsesResponse(body)).toEqual({
      prompt_tokens: 80,
      completion_tokens: 12,
      total_tokens: 92,
      prompt_tokens_details: { cached_tokens: 30 },
    });
  });

  it("normalizes Codex cache_write_tokens for cache-write pricing", () => {
    expect(
      usageFromResponsesResponse({
        usage: {
          input_tokens: 63,
          output_tokens: 42,
          input_tokens_details: {
            cached_tokens: 7,
            cache_write_tokens: 11,
          },
        },
      }),
    ).toEqual({
      prompt_tokens: 63,
      completion_tokens: 42,
      total_tokens: 105,
      prompt_tokens_details: {
        cached_tokens: 7,
        cache_creation_tokens: 11,
      },
    });
  });

  it("preserves Responses repricing dimensions and authoritative billed cost", () => {
    expect(
      usageFromResponsesResponse({
        service_tier: "priority",
        usage: {
          input_tokens: 1_000,
          output_tokens: 1_220,
          cost_usd: 0.0456,
          input_tokens_details: {
            cached_tokens: 200,
            cache_creation_tokens: 50,
            ephemeral_5m_input_tokens: 30,
            ephemeral_1h_input_tokens: 20,
            audio_tokens: 300,
            cached_audio_tokens: 100,
          },
          output_tokens_details: { image_tokens: 1_120 },
        },
      }),
    ).toEqual({
      prompt_tokens: 1_000,
      completion_tokens: 1_220,
      total_tokens: 2_220,
      service_tier: "priority",
      cost_usd: 0.0456,
      prompt_tokens_details: {
        cached_tokens: 200,
        cache_creation_tokens: 50,
        ephemeral_5m_input_tokens: 30,
        ephemeral_1h_input_tokens: 20,
        audio_tokens: 300,
        cached_audio_tokens: 100,
      },
      completion_tokens_details: { image_tokens: 1_120 },
    });
  });

  it("returns null when the body has no usage object", () => {
    expect(usageFromResponsesResponse({ id: "resp" })).toBeNull();
    expect(usageFromResponsesResponse(null)).toBeNull();
    expect(usageFromResponsesResponse(undefined)).toBeNull();
    expect(usageFromResponsesResponse({ usage: "nope" })).toBeNull();
  });
});

// Native-protocol-passthrough STREAMING cost for openai_responses (#217 Phase 3
// Stage 1): the upstream Codex Responses SSE carries the totals on the terminal
// `response.completed`, `response.incomplete`, or `response.failed` event's
// `response.usage`. Byte-
// faithful passthrough forwards these frames VERBATIM, so cost extraction scans the
// accumulated SSE for that event. usageFromResponsesSSE returns the same OpenAI-shaped
// StreamUsage as the non-stream extractor, mirroring aggregateResponsesStream.
describe("usageFromResponsesSSE", () => {
  it("extracts totals from the terminal response.completed event", () => {
    const sse = [
      'event: response.created\ndata: {"type":"response.created","response":{"id":"resp_1"}}\n\n',
      'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"hi"}\n\n',
      'event: response.completed\ndata: {"type":"response.completed","response":{"status":"completed","usage":{"input_tokens":1000,"output_tokens":500,"input_tokens_details":{"cached_tokens":200,"cache_creation_input_tokens":50}}}}\n\n',
    ].join("");
    expect(usageFromResponsesSSE(sse)).toEqual({
      prompt_tokens: 1000,
      completion_tokens: 500,
      total_tokens: 1500,
      prompt_tokens_details: { cached_tokens: 200, cache_creation_tokens: 50 },
    });
    expect(tokensFromUsage(usageFromResponsesSSE(sse))).toBe(1500);
  });

  it("preserves the actual Responses service tier for streamed cost selection", () => {
    const sse =
      'event: response.completed\ndata: {"type":"response.completed","response":{"service_tier":"priority","usage":{"input_tokens":10,"output_tokens":5}}}\n\n';
    expect(usageFromResponsesSSE(sse)).toEqual({
      prompt_tokens: 10,
      completion_tokens: 5,
      total_tokens: 15,
      service_tier: "priority",
    });
  });

  it("falls back to a response.incomplete terminal event (truncation / content filter)", () => {
    const sse = [
      'event: response.created\ndata: {"type":"response.created","response":{"id":"resp_2"}}\n\n',
      'event: response.incomplete\ndata: {"type":"response.incomplete","response":{"status":"incomplete","usage":{"input_tokens":40,"output_tokens":3}}}\n\n',
    ].join("");
    expect(usageFromResponsesSSE(sse)).toEqual({
      prompt_tokens: 40,
      completion_tokens: 3,
      total_tokens: 43,
    });
  });

  it("keeps explicit zero usage from response.failed as reported evidence", () => {
    const sse =
      'event: response.failed\ndata: {"type":"response.failed","response":{"status":"failed","usage":{"input_tokens":0,"output_tokens":0}}}\n\n';
    const usage = usageFromResponsesSSE(sse);
    expect(usage).toEqual({ prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 });
    const d = decision();
    backfillCompletionCost(d, "openai/gpt", null, usage);
    expect(d.usage).toMatchObject({
      measurement: "reported",
      cost_basis: null,
      prompt_tokens: 0,
      completion_tokens: 0,
      cached_tokens: null,
      cache_creation_tokens: null,
    });
  });

  it("skips ping / [DONE] / non-JSON frames without throwing", () => {
    const sse = [
      'event: response.in_progress\ndata: {"type":"response.in_progress"}\n\n',
      ": keepalive comment\n\n",
      "data: not json at all\n\n",
      'event: response.completed\ndata: {"type":"response.completed","response":{"usage":{"input_tokens":8,"output_tokens":2}}}\n\n',
      "data: [DONE]\n\n",
    ].join("");
    expect(usageFromResponsesSSE(sse)).toEqual({
      prompt_tokens: 8,
      completion_tokens: 2,
      total_tokens: 10,
    });
  });

  it("returns null when no terminal usage event is present", () => {
    const sse = [
      'event: response.created\ndata: {"type":"response.created","response":{"id":"resp"}}\n\n',
      'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"hi"}\n\n',
      "data: [DONE]\n\n",
    ].join("");
    expect(usageFromResponsesSSE(sse)).toBeNull();
    expect(usageFromResponsesSSE("")).toBeNull();
  });
});

// Native-protocol-passthrough cost for Gemini (P2-GEM-01 governance): a VERBATIM
// Gemini GenerateContent response carries usage under `usageMetadata`. Like
// Responses (and UNLIKE Anthropic), Gemini's promptTokenCount already INCLUDES the
// cached slice, so prompt_tokens = promptTokenCount and cached rides
// prompt_tokens_details. thoughtsTokenCount (reasoning) is billed as output, so it
// folds into completion_tokens alongside candidatesTokenCount.
describe("usageFromGeminiResponse", () => {
  it("maps Gemini usageMetadata to OpenAI-shaped StreamUsage (cache inside prompt)", () => {
    const body = {
      candidates: [{ content: { role: "model", parts: [{ text: "hi" }] } }],
      usageMetadata: {
        promptTokenCount: 1000,
        candidatesTokenCount: 500,
        cachedContentTokenCount: 200,
        totalTokenCount: 1500,
        serviceTier: "priority",
      },
    };
    expect(usageFromGeminiResponse(body)).toEqual({
      prompt_tokens: 1000, // cache already counted inside promptTokenCount
      completion_tokens: 500,
      total_tokens: 1500,
      service_tier: "priority",
      prompt_tokens_details: { cached_tokens: 200 },
    });
    expect(tokensFromUsage(usageFromGeminiResponse(body))).toBe(1500);
  });

  it("folds thoughtsTokenCount (reasoning) into completion tokens", () => {
    const body = {
      usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 7, thoughtsTokenCount: 4 },
    };
    expect(usageFromGeminiResponse(body)).toEqual({
      prompt_tokens: 10,
      completion_tokens: 11, // candidates(7) + thoughts(4)
      total_tokens: 21,
    });
  });

  it("preserves Gemini audio/cache/image modality details for exact costing", () => {
    const body = {
      usageMetadata: {
        promptTokenCount: 1_000,
        cachedContentTokenCount: 200,
        candidatesTokenCount: 1_180,
        thoughtsTokenCount: 40,
        promptTokensDetails: [
          { modality: "TEXT", tokenCount: 700 },
          { modality: "AUDIO", tokenCount: 300 },
        ],
        cacheTokensDetails: [
          { modality: "TEXT", tokenCount: 100 },
          { modality: "AUDIO", tokenCount: 100 },
        ],
        candidatesTokensDetails: [
          { modality: "TEXT", tokenCount: 60 },
          { modality: "IMAGE", tokenCount: 1_120 },
        ],
      },
    };
    expect(usageFromGeminiResponse(body)).toEqual({
      prompt_tokens: 1_000,
      completion_tokens: 1_220,
      total_tokens: 2_220,
      prompt_tokens_details: {
        cached_tokens: 200,
        text_tokens: 700,
        audio_tokens: 300,
        cached_audio_tokens: 100,
      },
      completion_tokens_details: {
        text_tokens: 60,
        image_tokens: 1_120,
      },
    });
  });

  it("keeps metadata-only usage unmeasured and marks valid text-only input as zero audio", () => {
    expect(usageFromGeminiResponse({ usageMetadata: {} })).toEqual({});
    expect(
      usageFromGeminiResponse({
        usageMetadata: {
          promptTokenCount: 1_000,
          candidatesTokenCount: 10,
          promptTokensDetails: [{ modality: "TEXT", tokenCount: 1_000 }],
        },
      }),
    ).toEqual({
      prompt_tokens: 1_000,
      completion_tokens: 10,
      total_tokens: 1_010,
      prompt_tokens_details: { text_tokens: 1_000, audio_tokens: 0 },
    });
  });

  it("omits prompt_tokens_details when there are no cached tokens", () => {
    const body = { usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 3 } };
    expect(usageFromGeminiResponse(body)).toEqual({
      prompt_tokens: 12,
      completion_tokens: 3,
      total_tokens: 15,
    });
  });

  it("returns null when the body has no usageMetadata object", () => {
    expect(usageFromGeminiResponse({ candidates: [] })).toBeNull();
    expect(usageFromGeminiResponse(null)).toBeNull();
    expect(usageFromGeminiResponse(undefined)).toBeNull();
    expect(usageFromGeminiResponse({ usageMetadata: "nope" })).toBeNull();
  });
});

// Native-protocol-passthrough STREAMING cost for Gemini: the streamGenerateContent
// SSE emits cumulative `usageMetadata` on its frames (the final frame carries the
// complete count). Byte-faithful passthrough forwards these nameless `data:` frames
// VERBATIM, so cost extraction scans the accumulated SSE and keeps the LAST seen
// usageMetadata.
describe("usageFromGeminiSSE", () => {
  it("extracts the final cumulative usageMetadata frame", () => {
    const sse = [
      'data: {"candidates":[{"content":{"parts":[{"text":"Hel"}]}}],"usageMetadata":{"promptTokenCount":1000,"candidatesTokenCount":1}}\n\n',
      'data: {"candidates":[{"content":{"parts":[{"text":"lo"}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":1000,"candidatesTokenCount":500,"cachedContentTokenCount":200,"serviceTier":"flex","promptTokensDetails":[{"modality":"TEXT","tokenCount":800},{"modality":"AUDIO","tokenCount":200}],"cacheTokensDetails":[{"modality":"AUDIO","tokenCount":100}],"candidatesTokensDetails":[{"modality":"IMAGE","tokenCount":400},{"modality":"TEXT","tokenCount":100}]}}\n\n',
    ].join("");
    expect(usageFromGeminiSSE(sse)).toEqual({
      prompt_tokens: 1000,
      completion_tokens: 500,
      total_tokens: 1500,
      service_tier: "flex",
      prompt_tokens_details: {
        cached_tokens: 200,
        text_tokens: 800,
        audio_tokens: 200,
        cached_audio_tokens: 100,
      },
      completion_tokens_details: { image_tokens: 400, text_tokens: 100 },
    });
    expect(tokensFromUsage(usageFromGeminiSSE(sse))).toBe(1500);
  });

  it("skips keepalive / [DONE] / non-JSON frames without throwing", () => {
    const sse = [
      ": keepalive comment\n\n",
      "data: not json at all\n\n",
      'data: {"candidates":[{"content":{"parts":[{"text":"x"}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":8,"candidatesTokenCount":2}}\n\n',
      "data: [DONE]\n\n",
    ].join("");
    expect(usageFromGeminiSSE(sse)).toEqual({
      prompt_tokens: 8,
      completion_tokens: 2,
      total_tokens: 10,
    });
  });

  it("returns null when no usageMetadata frame is present", () => {
    const sse = 'data: {"candidates":[{"content":{"parts":[{"text":"hi"}]}}]}\n\n';
    expect(usageFromGeminiSSE(sse)).toBeNull();
    expect(usageFromGeminiSSE("")).toBeNull();
  });
});

describe("createSseCapture", () => {
  const usageFrame =
    'data: {"choices":[],"usage":{"prompt_tokens":100,"completion_tokens":50}}\n\n';

  it("retains the FULL body when capturing (verbatim persistence)", () => {
    const cap = createSseCapture(true);
    const chunks = [
      'data: {"choices":[{"delta":{"content":"hi"}}]}\n\n',
      usageFrame,
      "data: [DONE]\n\n",
    ];
    for (const c of chunks) cap.push(c);
    expect(cap.value()).toBe(chunks.join(""));
    expect(cap.payloadValue()).toBe(chunks.join(""));
    expect(cap.limited()).toBe(false);
    cap.release();
  });

  it("drops an oversized full capture but keeps a bounded tail for accounting", () => {
    const cap = createSseCapture(true, 32, 16);
    cap.push("0123456789");
    cap.push("abcdefghijklmnop");

    expect(cap.limited()).toBe(true);
    expect(cap.payloadValue()).toBeNull();
    expect(cap.value()).toContain("abcdefghijklmnop");
    cap.release();
  });

  it("keeps only a bounded tail when NOT capturing, still enough for usageFromSSE", () => {
    const cap = createSseCapture(false, 1024);
    // A big stream: 500 content frames (well over the 1KB tail) then the usage frame.
    for (let i = 0; i < 500; i++)
      cap.push(`data: {"choices":[{"delta":{"content":"tok${i}"}}]}\n\n`);
    cap.push(usageFrame);
    cap.push("data: [DONE]\n\n");

    const tail = cap.value();
    // The retained tail is bounded — nowhere near the full body...
    expect(tail.length).toBeLessThan(4000);
    // ...yet cost backfill still finds the usage (it scans from the end).
    expect(usageFromSSE(tail)).toEqual({ prompt_tokens: 100, completion_tokens: 50 });
    expect(cap.payloadValue()).toBeNull();
    cap.release();
  });

  it("strictly truncates a single chunk to the dynamic tail budget", () => {
    const cap = createSseCapture(false, 8);
    cap.push(usageFrame); // single chunk larger than the budget
    expect(cap.value()).toBe(usageFrame.slice(-8));
    expect(cap.value().length).toBeLessThanOrEqual(8);
    cap.release();
  });

  it("copies a large sliced tail into independent storage", () => {
    const bufferFrom = vi.spyOn(Buffer, "from");
    const cap = createSseCapture(false, 8);
    const chunk = `${"x".repeat(1_000_000)}tail-end`;

    try {
      cap.push(chunk);
      expect(cap.value()).toBe("tail-end");
      expect(bufferFrom).toHaveBeenCalledWith("tail-end", "utf16le");
    } finally {
      cap.release();
      bufferFrom.mockRestore();
    }
  });

  it("reserves two UTF-8 copies for retained full parts plus their joined value", () => {
    const first = createSseCapture(true, 0, 4, 8);
    const blocked = createSseCapture(true, 0, 4, 8);
    const afterRelease = createSseCapture(true, 0, 4, 8);

    first.push("👋"); // 4 UTF-8 bytes; parts + joined value reserve 8 bytes.
    expect(first.limited()).toBe(false);

    blocked.push("x");
    expect(blocked.limited()).toBe(true);
    expect(first.payloadValue()).toBe("👋");
    first.release();

    afterRelease.push("👋");
    expect(afterRelease.limited()).toBe(false);
    expect(afterRelease.payloadValue()).toBe("👋");
    blocked.release();
    afterRelease.release();
  });

  it("drops the retained chunks after materializing a full payload", () => {
    const first = createSseCapture(true, 0, 8, 12);
    const blocked = createSseCapture(true, 0, 8, 12);

    first.push("😀"); // 4 UTF-8 bytes; parts + joined value reserve 8 bytes.
    blocked.push("😀");
    expect(blocked.limited()).toBe(true);

    expect(first.payloadValue()).toBe("😀");
    // Materializing releases the parts reservation; only the returned string
    // remains live, so another bounded capture can use the freed half.
    const second = createSseCapture(true, 0, 8, 12);
    second.push("😀");
    expect(second.limited()).toBe(false);
    first.release();
    blocked.release();
    second.release();
  });

  it("charges tail retention to the global capture budget and releases it", () => {
    const first = createSseCapture(false, 8, 1, 32);
    const second = createSseCapture(false, 8, 1, 32);

    first.push("12345678");
    second.push("abcdefgh");
    expect(first.value()).toBe("12345678");
    expect(second.value()).toBe("");

    first.release();
    second.push("abcdefgh");
    expect(second.value()).toBe("abcdefgh");
    second.release();
  });

  it("releases the capture reservation when post-stream bookkeeping throws", async () => {
    const release = vi.fn();
    const failure = new Error("bookkeeping failed");

    await expect(
      withSseCaptureRelease({ release } as never, async () => {
        throw failure;
      }),
    ).rejects.toBe(failure);

    expect(release).toHaveBeenCalledOnce();
  });
});

describe("tokensFromUsage", () => {
  it("counts Responses-style input/output usage", () => {
    expect(tokensFromUsage({ input_tokens: 100, output_tokens: 20 })).toBe(120);
  });

  it("counts Anthropic separate cache tokens with input/output usage", () => {
    expect(
      tokensFromUsage({
        input_tokens: 60,
        output_tokens: 20,
        cache_read_input_tokens: 30,
        cache_creation_input_tokens: 10,
      }),
    ).toBe(120);
  });
});

// Minimal decision record with the cost-relevant fields the backfill touches.
function decision(): DecisionRecord {
  return {
    provider_attempts: [
      { alias: "openai/gpt", status: "ok", cost_usd: null },
      { alias: "openai/other", status: "error", cost_usd: null },
    ],
    cost_breakdown: { eval_usd: null, completion_usd: null, total_usd: null },
    usage: null,
    generation_ms: null,
    serving_account: null,
    final: { status: "ok", model_alias: "openai/gpt" },
  } as unknown as DecisionRecord;
}

describe("createStreamGenerationTimer", () => {
  // A clock that hands out the supplied ticks in order (then sticks on the last).
  function clockOf(ticks: number[]): () => number {
    let i = 0;
    return () => ticks[Math.min(i++, ticks.length - 1)] ?? 0;
  }

  it("returns null before any chunk is marked (no stream)", () => {
    const t = createStreamGenerationTimer(clockOf([1000]));
    expect(t.generationMs()).toBeNull();
  });

  it("returns null after a single mark (a single instant has no span)", () => {
    const t = createStreamGenerationTimer(clockOf([1000]));
    t.mark();
    expect(t.generationMs()).toBeNull();
  });

  it("measures the span from the first to the last marked chunk", () => {
    const t = createStreamGenerationTimer(clockOf([1000, 1200, 1850, 4200]));
    t.mark(); // first chunk @1000
    t.mark(); // @1200
    t.mark(); // @1850
    t.mark(); // last chunk @4200
    expect(t.generationMs()).toBe(3200); // 4200 − 1000
  });

  it("is null when the span is zero (all marks at the same instant)", () => {
    const t = createStreamGenerationTimer(clockOf([1000, 1000]));
    t.mark();
    t.mark();
    expect(t.generationMs()).toBeNull();
  });
});

describe("backfillCompletionCost", () => {
  it("sets the matching ok attempt + completion/total cost", () => {
    const d = decision();
    backfillCompletionCost(d, "openai/gpt", 0.0123);
    expect(d.provider_attempts[0]?.cost_usd).toBe(0.0123);
    expect(d.provider_attempts[1]?.cost_usd).toBeNull(); // error attempt untouched
    expect(d.cost_breakdown.completion_usd).toBe(0.0123);
    expect(d.cost_breakdown.total_usd).toBe(0.0123);
  });

  it("adds eval self-cost into the total when present", () => {
    const d = decision();
    d.cost_breakdown.eval_usd = 0.001;
    backfillCompletionCost(d, "openai/gpt", 0.01);
    expect(d.cost_breakdown.total_usd).toBeCloseTo(0.011);
  });

  it("is a no-op when cost is null (keeps the honest 'not measured' null)", () => {
    const d = decision();
    backfillCompletionCost(d, "openai/gpt", null);
    expect(d.provider_attempts[0]?.cost_usd).toBeNull();
    expect(d.cost_breakdown.completion_usd).toBeNull();
  });

  // Dashboard token accounting: the 4th arg stamps decision.usage from the served
  // usage tail, reusing core's OpenAI/Anthropic parser. Decoupled from cost.
  it("stamps the token breakdown from an OpenAI usage tail (cost + usage together)", () => {
    const d = decision();
    backfillCompletionCost(d, "openai/gpt", 0.01, {
      prompt_tokens: 120,
      completion_tokens: 34,
      prompt_tokens_details: { cached_tokens: 80 },
    });
    expect(d.usage).toEqual({
      measurement: "reported",
      cost_basis: null,
      prompt_tokens: 120,
      completion_tokens: 34,
      cached_tokens: 80,
      cache_creation_tokens: null,
      service_tier: null,
      inference_geo: null,
      cache_creation_5m_tokens: null,
      cache_creation_1h_tokens: null,
      audio_prompt_tokens: null,
      cached_audio_prompt_tokens: null,
      image_output_tokens: null,
      billed_cost_usd: null,
    });
    expect(d.cost_breakdown.completion_usd).toBe(0.01); // cost still stamped
  });

  it("stamps Anthropic-shaped usage (input/output + separate cache tokens)", () => {
    const d = decision();
    backfillCompletionCost(d, "anthropic/claude", null, {
      input_tokens: 50,
      output_tokens: 20,
      cache_read_input_tokens: 30,
      cache_creation_input_tokens: 10,
    });
    // prompt = input + cache_read + cache_creation (core's Anthropic normalization).
    expect(d.usage).toEqual({
      measurement: "reported",
      cost_basis: null,
      prompt_tokens: 90,
      completion_tokens: 20,
      cached_tokens: 30,
      cache_creation_tokens: 10,
      service_tier: null,
      inference_geo: null,
      cache_creation_5m_tokens: null,
      cache_creation_1h_tokens: null,
      audio_prompt_tokens: null,
      cached_audio_prompt_tokens: null,
      image_output_tokens: null,
      billed_cost_usd: null,
    });
  });

  it("stamps every future-repricing dimension and authoritative billed cost", () => {
    const d = decision();
    backfillCompletionCost(d, "google/gemini", null, {
      prompt_tokens: 1_000,
      completion_tokens: 1_220,
      service_tier: "flex",
      inference_geo: "us",
      cost: 0.0456,
      prompt_tokens_details: {
        cached_tokens: 200,
        cache_creation_tokens: 50,
        ephemeral_5m_input_tokens: 30,
        ephemeral_1h_input_tokens: 20,
        audio_tokens: 300,
        cached_audio_tokens: 100,
      },
      completion_tokens_details: { image_tokens: 1_120 },
    });

    expect(d.usage).toEqual({
      measurement: "reported",
      cost_basis: null,
      prompt_tokens: 1_000,
      completion_tokens: 1_220,
      cached_tokens: 200,
      cache_creation_tokens: 50,
      service_tier: "flex",
      inference_geo: "us",
      cache_creation_5m_tokens: 30,
      cache_creation_1h_tokens: 20,
      audio_prompt_tokens: 300,
      cached_audio_prompt_tokens: 100,
      image_output_tokens: 1_120,
      billed_cost_usd: 0.0456,
    });
  });

  it("stamps usage even when cost is null (token accounting is decoupled from pricing)", () => {
    const d = decision();
    backfillCompletionCost(d, "openai/gpt", null, { prompt_tokens: 5, completion_tokens: 7 });
    expect(d.usage?.prompt_tokens).toBe(5);
    expect(d.usage?.completion_tokens).toBe(7);
    expect(d.cost_breakdown.completion_usd).toBeNull(); // cost left untouched
  });

  it("leaves usage null when no usage tail is provided", () => {
    const d = decision();
    backfillCompletionCost(d, "openai/gpt", 0.01);
    expect(d.usage).toBeNull();
  });

  // True-TPS denominator: the 5th arg stamps the served-stream generation window
  // (gateway-timed). Decoupled from cost + usage, like the other stamps.
  it("stamps generation_ms from the 5th arg (streaming path)", () => {
    const d = decision();
    backfillCompletionCost(d, "openai/gpt", 0.01, { completion_tokens: 340 }, 4200);
    expect(d.generation_ms).toBe(4200);
  });

  it("leaves generation_ms null when omitted (non-streaming path)", () => {
    const d = decision();
    backfillCompletionCost(d, null, null, { completion_tokens: 340 });
    expect(d.generation_ms).toBeNull();
  });

  it("does not stamp generation_ms when the timer yielded null (no measurable span)", () => {
    const d = decision();
    backfillCompletionCost(d, "openai/gpt", 0.01, { completion_tokens: 1 }, null);
    expect(d.generation_ms).toBeNull();
  });
});

describe("persistPayload", () => {
  function deps(over: Partial<PayloadCaptureDeps> = {}): {
    deps: PayloadCaptureDeps;
    inserts: InsertPayloadInput[];
    prunes: number[];
  } {
    const inserts: InsertPayloadInput[] = [];
    const prunes: number[] = [];
    return {
      inserts,
      prunes,
      deps: {
        telemetry: {
          insertPayload: vi.fn(async (i: InsertPayloadInput) => {
            inserts.push(i);
          }),
          prunePayloads: vi.fn(async (ms: number) => {
            prunes.push(ms);
          }),
        } as unknown as PayloadCaptureDeps["telemetry"],
        capturePayloads: () => true,
        ...over,
      },
    };
  }

  it("writes the payload and NEVER prunes (retention is the scheduled cleanup runner's job)", async () => {
    const { deps: d, inserts, prunes } = deps();
    await persistPayload(
      d,
      { requestId: "req_1", requestJson: "{}", responseJson: "{}", now: 5000 },
      () => {},
    );
    expect(inserts).toHaveLength(1);
    expect(inserts[0]?.requestId).toBe("req_1");
    expect(prunes).toEqual([]); // capture path must not delete bodies (P1 regression guard)
  });

  it("does nothing when capture is disabled", async () => {
    const { deps: d, inserts } = deps({ capturePayloads: () => false });
    await persistPayload(
      d,
      { requestId: "req_1", requestJson: "{}", responseJson: null, now: 5000 },
      () => {},
    );
    expect(inserts).toHaveLength(0);
  });

  it("fails open and logs when the store throws", async () => {
    const log = vi.fn();
    const d: PayloadCaptureDeps = {
      telemetry: {
        insertPayload: vi.fn(async () => {
          throw new Error("db down");
        }),
        prunePayloads: vi.fn(async () => {}),
      } as unknown as PayloadCaptureDeps["telemetry"],
      capturePayloads: () => true,
    };
    await expect(
      persistPayload(d, { requestId: "req_1", requestJson: "{}", responseJson: null, now: 1 }, log),
    ).resolves.toBeUndefined();
    expect(log).toHaveBeenCalledWith("payload.capture_failed");
  });
});

describe("timeout-after-lease-loss persistence classification", () => {
  it("decisionForTimedOutRequest preserves an authoritative truncated concurrency lease loss", () => {
    const leaseLostDecision = decision();
    leaseLostDecision.stream_outcome = "truncated";
    leaseLostDecision.final = {
      ...leaseLostDecision.final,
      status: "error",
      error_reason: "concurrency_lease_lost",
    };

    expect(decisionForTimedOutRequest(leaseLostDecision)).toMatchObject({
      stream_outcome: "truncated",
      final: {
        status: "error",
        error_reason: "concurrency_lease_lost",
      },
    });
  });
});

describe("recordServed — deferred write queue (the three pipeline faces)", () => {
  function sink() {
    const inserted: DecisionRecord[] = [];
    const payloads: InsertPayloadInput[] = [];
    const telemetry = {
      insert: vi.fn(async (i: { decision: DecisionRecord }) => {
        inserted.push(i.decision);
        return { id: "1" };
      }),
      insertPayload: vi.fn(async (p: InsertPayloadInput) => {
        payloads.push(p);
      }),
      prunePayloads: vi.fn(async () => {}),
    } as unknown as RecordServedDeps["telemetry"];
    return { telemetry, inserted, payloads };
  }
  const args = {
    requestId: "req_1",
    apiKeyId: "k1",
    decision: decision(),
    requestJson: "{}",
    responseJson: "{}",
  };

  it("defers telemetry + payload off the response, written only on flush", async () => {
    const s = sink();
    const q = createWriteQueue({ telemetry: s.telemetry, log: () => {}, flushIntervalMs: 10_000 });
    const d: RecordServedDeps = {
      telemetry: s.telemetry,
      writes: q,
      redact: (x) => x,
      now: () => 5000,
      capturePayloads: () => true,
    };
    await recordServed(d, args, () => {});
    expect(s.inserted).toHaveLength(0);
    expect(s.payloads).toHaveLength(0);

    await q.flush();
    expect(s.inserted).toHaveLength(1);
    expect(s.payloads).toHaveLength(1);
    expect(s.payloads[0]?.requestId).toBe("req_1");
  });

  it("drops queued body capture after a live hard-off while retaining telemetry", async () => {
    const s = sink();
    const q = createWriteQueue({ telemetry: s.telemetry, log: () => {}, flushIntervalMs: 10_000 });
    let capture = true;
    let generation = 0;
    const d = {
      telemetry: s.telemetry,
      writes: q,
      redact: (x: unknown) => x,
      now: () => 5000,
      capturePayloads: () => capture,
      captureSessions: () => false,
      captureGeneration: () => generation,
    } as RecordServedDeps & { captureGeneration: () => number };

    await recordServed(d, args, () => {});
    capture = false;
    generation++;
    await q.flush();

    expect(s.inserted).toHaveLength(1);
    expect(s.payloads).toHaveLength(0);
  });

  it("writes inline (today's behavior) when no queue is wired", async () => {
    const s = sink();
    const d: RecordServedDeps = {
      telemetry: s.telemetry,
      redact: (x) => x,
      now: () => 5000,
      capturePayloads: () => true,
    };
    await recordServed(
      d,
      { ...args, requestId: "req_2", requestJson: '{"text":"你好"}' },
      () => {},
    );
    expect(s.inserted).toHaveLength(1);
    expect(s.inserted[0]?.request_body_bytes).toBe(17);
    expect(s.payloads).toHaveLength(1);
  });

  it("records a timed-out request as an error even if the provider later completed", async () => {
    const s = sink();
    const d: RecordServedDeps = {
      telemetry: s.telemetry,
      redact: (x) => x,
      now: () => 5000,
      capturePayloads: () => true,
    };
    await recordServed(d, { ...args, requestId: "req_timeout", timedOut: true }, () => {});
    expect(s.inserted[0]?.final).toMatchObject({
      status: "error",
      error_reason: "timeout",
      model_alias: "openai/gpt",
    });
    expect(s.inserted[0]?.serving_account).toBeNull();
    expect(s.payloads[0]?.responseJson).toBeNull();
    expect(args.decision.final.status).toBe("ok");
  });

  it("preserves an authoritative truncated concurrency lease loss when timeout follows lease loss before persistence", async () => {
    const s = sink();
    const leaseLostDecision = decision();
    leaseLostDecision.stream_outcome = "truncated";
    leaseLostDecision.final = {
      ...leaseLostDecision.final,
      status: "error",
      error_reason: "concurrency_lease_lost",
    };
    const d: RecordServedDeps = {
      telemetry: s.telemetry,
      redact: (x) => x,
      now: () => 5000,
      capturePayloads: () => false,
    };

    await recordServed(
      d,
      {
        ...args,
        requestId: "req_lease_loss_then_timeout",
        decision: leaseLostDecision,
        timedOut: true,
      },
      () => {},
    );

    expect(s.inserted[0]).toMatchObject({
      stream_outcome: "truncated",
      final: {
        status: "error",
        error_reason: "concurrency_lease_lost",
      },
    });
  });

  it("stores an incremental session revision when full payload capture is off", async () => {
    const s = sink();
    const revisions: unknown[] = [];
    const telemetry = {
      ...s.telemetry,
      getSessionByRef: vi.fn(async () => null),
      listSessionRevisions: vi.fn(async () => []),
      upsertSessionRevision: vi.fn(async (input: UpsertSessionRevisionInput) => {
        revisions.push(input);
      }),
    } as unknown as RecordServedDeps["telemetry"];
    const sessionDecision = decision();
    sessionDecision.session = {
      ref: "session-ref",
      label: "thread-1",
      source: "x-thread-id",
    };
    await recordServed(
      {
        telemetry,
        redact: (x) => x,
        now: () => 5000,
        capturePayloads: () => false,
        captureSessions: () => true,
      },
      {
        ...args,
        accountId: "account-1",
        decision: sessionDecision,
        requestJson: '{"model":"auto","messages":[{"role":"user","content":"hi"}]}',
      },
      () => {},
    );
    expect(s.payloads).toHaveLength(0);
    expect(revisions).toHaveLength(1);
    expect(revisions[0]).toMatchObject({
      sessionRef: "session-ref",
      accountId: "account-1",
      requestDeltaJson: '[{"role":"user","content":"hi"}]',
      retainCount: 0,
      responseJson: "{}",
      fidelity: "semantic",
    });
  });

  it("keeps the request revision but omits a Session response beyond the runtime limit", async () => {
    const s = sink();
    const revisions: UpsertSessionRevisionInput[] = [];
    const telemetry = {
      ...s.telemetry,
      getSessionByRef: vi.fn(async () => null),
      listSessionRevisions: vi.fn(async () => []),
      upsertSessionRevision: vi.fn(async (input: UpsertSessionRevisionInput) => {
        revisions.push(input);
      }),
    } as unknown as RecordServedDeps["telemetry"];
    const sessionDecision = decision();
    sessionDecision.session = {
      ref: "session-ref-large-response",
      label: "thread-large-response",
      source: "x-thread-id",
    };
    const log = vi.fn();
    await recordServed(
      {
        telemetry,
        redact: (value) => value,
        now: () => 5000,
        capturePayloads: () => false,
        captureSessions: () => true,
        captureBodyLimitBytes: 1024,
      },
      {
        ...args,
        requestId: "large-response",
        decision: sessionDecision,
        requestJson: '{"model":"auto","messages":[{"role":"user","content":"hi"}]}',
        responseJson: "x".repeat(1025),
      },
      log,
    );
    expect(revisions).toHaveLength(1);
    expect(revisions[0]?.responseJson).toBeNull();
    expect(log).toHaveBeenCalledWith("session.response_limited");
  });

  it("builds Responses continuation branches from response ids instead of the latest head", async () => {
    const s = sink();
    const revisions: UpsertSessionRevisionInput[] = [];
    const telemetry = {
      ...s.telemetry,
      getSessionByRef: vi.fn(async () => {
        const last = revisions.at(-1);
        return last
          ? {
              sessionRef: "session-ref",
              accountId: "account-1",
              apiKeyId: "k1",
              source: "x-thread-id",
              externalSessionId: "thread-1",
              createdAt: new Date(1),
              lastSeenAt: new Date(1),
              headRequestId: last.requestId,
              revisionCount: revisions.length,
              storedBytes: 1,
            }
          : null;
      }),
      listSessionRevisions: vi.fn(async () =>
        revisions.map((revision, sequence) => ({
          ...revision,
          responseId: revision.responseId ?? null,
          sequence: sequence + 1,
        })),
      ),
      findSessionRequestIdByResponseId: vi.fn(async (_sessionRef: string, responseId: string) => {
        const revision = revisions.find((item) => item.responseId === responseId);
        if (!revision) return null;
        return {
          requestId: revision.requestId,
          responseBodyStored: revision.responseJson !== null,
        };
      }),
      upsertSessionRevision: vi.fn(async (input: UpsertSessionRevisionInput) => {
        revisions.push(input);
      }),
    } as unknown as RecordServedDeps["telemetry"];
    const sessionDecision = (): DecisionRecord => {
      const value = decision();
      value.protocol = "openai_responses";
      value.session = { ref: "session-ref", label: "thread-1", source: "x-thread-id" };
      return value;
    };
    const deps: RecordServedDeps = {
      telemetry,
      redact: (value) => value,
      now: () => 5000,
      capturePayloads: () => false,
      captureSessions: () => true,
    };
    const rootResponse = {
      id: "resp_root",
      output: [{ type: "reasoning", id: "reason_root", summary: [] }],
    };
    await recordServed(
      deps,
      {
        ...args,
        requestId: "root",
        accountId: "account-1",
        decision: sessionDecision(),
        requestJson: '{"model":"gpt","input":[{"role":"user","content":"root"}]}',
        responseJson: JSON.stringify(rootResponse),
      },
      () => {},
    );
    await recordServed(
      deps,
      {
        ...args,
        requestId: "child",
        accountId: "account-1",
        decision: sessionDecision(),
        requestJson:
          '{"model":"gpt","previous_response_id":"resp_root","input":[{"role":"user","content":"child"}]}',
        responseJson: JSON.stringify({ id: "resp_child", output: [] }),
      },
      () => {},
    );
    await recordServed(
      deps,
      {
        ...args,
        requestId: "branch",
        accountId: "account-1",
        decision: sessionDecision(),
        requestJson:
          '{"model":"gpt","previous_response_id":"resp_root","input":[{"role":"user","content":"branch"}]}',
        responseJson: JSON.stringify({ id: "resp_branch", output: [] }),
      },
      () => {},
    );

    expect(revisions).toHaveLength(3);
    expect(revisions[0]).toMatchObject({
      requestId: "root",
      parentRequestId: null,
      responseId: "resp_root",
      responseJson: JSON.stringify(rootResponse),
    });
    expect(revisions[1]).toMatchObject({ requestId: "child", parentRequestId: "root" });
    expect(revisions[2]).toMatchObject({ requestId: "branch", parentRequestId: "root" });
  });

  it("marks an unknown Responses continuation as partial instead of linking it to the head", async () => {
    const s = sink();
    const revisions: UpsertSessionRevisionInput[] = [];
    const telemetry = {
      ...s.telemetry,
      getSessionByRef: vi.fn(async () => ({
        sessionRef: "session-ref",
        accountId: "account-1",
        apiKeyId: "k1",
        source: "x-thread-id",
        externalSessionId: "thread-1",
        createdAt: new Date(1),
        lastSeenAt: new Date(1),
        headRequestId: "unrelated-head",
        revisionCount: 1,
        storedBytes: 1,
      })),
      listSessionRevisions: vi.fn(async () => []),
      findSessionRequestIdByResponseId: vi.fn(async () => null),
      upsertSessionRevision: vi.fn(async (input: UpsertSessionRevisionInput) => {
        revisions.push(input);
      }),
    } as unknown as RecordServedDeps["telemetry"];
    const sessionDecision = decision();
    sessionDecision.protocol = "openai_responses";
    sessionDecision.session = {
      ref: "session-ref",
      label: "thread-1",
      source: "x-thread-id",
    };
    await recordServed(
      {
        telemetry,
        redact: (value) => value,
        now: () => 5000,
        capturePayloads: () => false,
        captureSessions: () => true,
      },
      {
        ...args,
        requestId: "unknown-child",
        accountId: "account-1",
        decision: sessionDecision,
        requestJson:
          '{"previous_response_id":"resp_missing","input":[{"role":"user","content":"child"}]}',
        responseJson: JSON.stringify({ id: "resp_child", output: [] }),
      },
      () => {},
    );
    expect(revisions[0]).toMatchObject({
      parentRequestId: null,
      responseId: "resp_child",
      fidelity: "partial",
    });
  });

  it("backpressures an oversized retained Responses output instead of dropping the Session", async () => {
    const upsertSessionRevision = vi.fn(async (_input: UpsertSessionRevisionInput) => {});
    const insert = vi.fn(async () => ({ id: "1" }));
    const telemetry = {
      insert,
      getSessionByRef: vi.fn(async () => null),
      listSessionRevisions: vi.fn(async () => []),
      findSessionRequestIdByResponseId: vi.fn(async () => null),
      upsertSessionRevision,
    } as unknown as RecordServedDeps["telemetry"];
    const writes = createWriteQueue({
      telemetry,
      log: () => {},
      flushIntervalMs: 10_000,
      maxBytes: 1_000,
    });
    const sessionDecision = decision();
    sessionDecision.protocol = "openai_responses";
    sessionDecision.session = {
      ref: "session-ref-budget",
      label: "thread-budget",
      source: "x-thread-id",
    };
    await recordServed(
      {
        telemetry,
        writes,
        redact: (value) => value,
        now: () => 5000,
        capturePayloads: () => false,
        captureSessions: () => true,
      },
      {
        ...args,
        requestId: "budgeted",
        decision: sessionDecision,
        requestJson: '{"input":"small"}',
        responseJson: JSON.stringify({ id: "resp_budget", output: ["x".repeat(2_000)] }),
      },
      () => {},
    );
    await writes.flush();
    expect(insert).toHaveBeenCalledOnce();
    expect(upsertSessionRevision).toHaveBeenCalledOnce();
  });
});
