import type { DecisionRecord, InsertPayloadInput } from "@helm/core";
import { describe, expect, it, vi } from "vitest";
import {
  backfillCompletionCost,
  type PayloadCaptureDeps,
  persistPayload,
  tokensFromUsage,
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
