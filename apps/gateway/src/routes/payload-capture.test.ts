import type { DecisionRecord, InsertPayloadInput } from "@helm/core";
import { describe, expect, it, vi } from "vitest";
import { createWriteQueue } from "../runtime/write-queue.js";
import {
  backfillCompletionCost,
  createSseCapture,
  type PayloadCaptureDeps,
  persistPayload,
  type RecordServedDeps,
  recordServed,
  tokensFromUsage,
  usageFromAnthropicResponse,
  usageFromAnthropicSSE,
  usageFromSSE,
} from "./payload-capture.js";

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
      'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":1000,"cache_read_input_tokens":200,"cache_creation_input_tokens":50}}}\n\n',
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":300}}\n\n',
    ].join("");
    const result = usageFromAnthropicSSE(sse);
    expect(result).toEqual({
      input_tokens: 1000,
      output_tokens: 300,
      cache_read_input_tokens: 200,
      cache_creation_input_tokens: 50,
    });
    // input + output + cache_read + cache_creation = 1000 + 300 + 200 + 50
    expect(tokensFromUsage(result)).toBe(1550);
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
  });

  it("never drops the only/last chunk even if it exceeds the tail budget", () => {
    const cap = createSseCapture(false, 8);
    cap.push(usageFrame); // single chunk larger than the budget
    expect(usageFromSSE(cap.value())).toEqual({ prompt_tokens: 100, completion_tokens: 50 });
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
    final: { status: "ok", model_alias: "openai/gpt" },
  } as unknown as DecisionRecord;
}

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
      prompt_tokens: 120,
      completion_tokens: 34,
      cached_tokens: 80,
      cache_creation_tokens: null,
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
      prompt_tokens: 90,
      completion_tokens: 20,
      cached_tokens: 30,
      cache_creation_tokens: 10,
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
        payloadRetentionMs: () => 1000,
        ...over,
      },
    };
  }

  it("writes the payload and prunes by the retention cutoff when enabled", async () => {
    const { deps: d, inserts, prunes } = deps();
    await persistPayload(
      d,
      { requestId: "req_1", requestJson: "{}", responseJson: "{}", now: 5000 },
      () => {},
    );
    expect(inserts).toHaveLength(1);
    expect(inserts[0]?.requestId).toBe("req_1");
    expect(prunes).toEqual([4000]); // now - retentionMs
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
      payloadRetentionMs: () => 1000,
    };
    await expect(
      persistPayload(d, { requestId: "req_1", requestJson: "{}", responseJson: null, now: 1 }, log),
    ).resolves.toBeUndefined();
    expect(log).toHaveBeenCalledWith("payload.capture_failed");
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
      payloadRetentionMs: () => 1000,
    };
    await recordServed(d, args, () => {});
    expect(s.inserted).toHaveLength(0);
    expect(s.payloads).toHaveLength(0);

    await q.flush();
    expect(s.inserted).toHaveLength(1);
    expect(s.payloads).toHaveLength(1);
    expect(s.payloads[0]?.requestId).toBe("req_1");
  });

  it("writes inline (today's behavior) when no queue is wired", async () => {
    const s = sink();
    const d: RecordServedDeps = {
      telemetry: s.telemetry,
      redact: (x) => x,
      now: () => 5000,
      capturePayloads: () => true,
      payloadRetentionMs: () => 1000,
    };
    await recordServed(d, { ...args, requestId: "req_2" }, () => {});
    expect(s.inserted).toHaveLength(1);
    expect(s.payloads).toHaveLength(1);
  });
});
