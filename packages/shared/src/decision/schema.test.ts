import { describe, expect, it } from "vitest";
import type { z } from "zod";
import { DecisionRecordSchema } from "./schema.js";

// The fixture is unparsed INPUT: key_prefix/latency_total_ms/fallback_count/
// cost_breakdown carry .default()/.prefault() in the schema, so they are optional
// on input (z.input) but required on output (z.infer/DecisionRecord). Typing the
// fixture as z.input lets these defaulted fields be omitted here — exactly what the
// "applies defaults on parse" tests below (key_prefix, latency_total_ms, …) assert.
type DecisionRecordInput = z.input<typeof DecisionRecordSchema>;

function fullRecord(): DecisionRecordInput {
  return {
    request_id: "req_1",
    trace_id: "req_1",
    requested_model: "gpt-4o",
    classifier: {
      task_type: "coding",
      complexity: "complex",
      confidence: 0.9,
      decided_by: "rules",
      eval_cache_hit: null,
      constraints: { needs_tools: true },
      explanation: ["matched: code-block dimension"],
    },
    policy: { matched_policy_id: "p1", reason: "task=coding complexity=complex" },
    lane: { selected_lane: "coding", candidate_chain: ["coding_model", "premium"] },
    provider_attempts: [
      {
        alias: "coding_model",
        skipped: true,
        skip_reason: "circuit_open",
        status: "error",
        error_class: "upstream_error",
        latency_ms: 0,
        cost_usd: null,
      },
      {
        alias: "premium",
        skipped: false,
        skip_reason: null,
        status: "ok",
        error_class: null,
        latency_ms: 1200,
        cost_usd: 0.004,
      },
    ],
    final: {
      model_alias: "premium",
      provider_model: "claude-x",
      status: "ok",
      error_reason: null,
    },
  };
}

// Phase 0 passthrough: shape complete but content degraded.
function passthroughRecord(model = "gpt-4o-mini") {
  return {
    request_id: "req_2",
    trace_id: "req_2",
    requested_model: model,
    classifier: {
      task_type: "passthrough",
      complexity: "passthrough",
      confidence: 1,
      decided_by: "default",
      eval_cache_hit: null,
      constraints: {},
      explanation: [],
    },
    policy: { matched_policy_id: null, reason: "passthrough" },
    lane: { selected_lane: "passthrough", candidate_chain: [model] },
    provider_attempts: [
      {
        alias: model,
        skipped: false,
        skip_reason: null,
        status: "ok",
        error_class: null,
        latency_ms: 800,
        cost_usd: null,
      },
    ],
    final: {
      model_alias: model,
      provider_model: model,
      status: "ok",
      error_reason: null,
    },
  };
}

describe("DecisionRecordSchema", () => {
  it("accepts a full rules-decided record", () => {
    expect(DecisionRecordSchema.safeParse(fullRecord()).success).toBe(true);
  });

  it("accepts a Phase 0 passthrough-shaped record", () => {
    const parsed = DecisionRecordSchema.parse(passthroughRecord());
    expect(parsed.classifier.decided_by).toBe("default");
    expect(parsed.lane.candidate_chain).toEqual(["gpt-4o-mini"]);
    expect(parsed.provider_attempts).toHaveLength(1);
  });

  it("enforces the decided_by enum", () => {
    for (const v of ["rules", "eval", "default"] as const) {
      const r = fullRecord();
      r.classifier.decided_by = v;
      expect(DecisionRecordSchema.safeParse(r).success).toBe(true);
    }
    const bad = fullRecord();
    (bad.classifier as Record<string, unknown>).decided_by = "manual";
    const res = DecisionRecordSchema.safeParse(bad);
    expect(res.success).toBe(false);
    if (!res.success) {
      expect(res.error.issues[0]?.path).toEqual(["classifier", "decided_by"]);
    }
  });

  it("bounds confidence to [0,1]", () => {
    for (const v of [0, 1]) {
      const r = fullRecord();
      r.classifier.confidence = v;
      expect(DecisionRecordSchema.safeParse(r).success).toBe(true);
    }
    for (const v of [1.2, -0.1]) {
      const r = fullRecord();
      r.classifier.confidence = v;
      const res = DecisionRecordSchema.safeParse(r);
      expect(res.success).toBe(false);
      if (!res.success) {
        expect(res.error.issues[0]?.path).toEqual(["classifier", "confidence"]);
      }
    }
  });

  it("requires nullable fields to be present (null ok, missing rejected)", () => {
    expect(DecisionRecordSchema.safeParse(fullRecord()).success).toBe(true);
    const missing = fullRecord() as { classifier: Record<string, unknown> };
    delete missing.classifier.eval_cache_hit;
    expect(DecisionRecordSchema.safeParse(missing).success).toBe(false);
  });

  it("accepts an empty provider_attempts array", () => {
    const r = fullRecord();
    r.provider_attempts = [];
    expect(DecisionRecordSchema.safeParse(r).success).toBe(true);
  });

  it("carries the rich telemetry fields (key_prefix, latency total, fallback_count, cost_breakdown)", () => {
    const r = fullRecord();
    const parsed = DecisionRecordSchema.parse(r);
    // key_prefix is prefix-only display metadata — present-but-nullable.
    expect(parsed).toHaveProperty("key_prefix");
    expect(parsed).toHaveProperty("latency_total_ms");
    expect(parsed).toHaveProperty("fallback_count");
    expect(parsed.cost_breakdown).toHaveProperty("eval_usd");
    expect(parsed.cost_breakdown).toHaveProperty("completion_usd");
    expect(parsed.cost_breakdown).toHaveProperty("total_usd");
  });

  it("accepts an explicit key_prefix (prefix only) and a populated cost_breakdown", () => {
    const r = {
      ...fullRecord(),
      key_prefix: "helm_live_ab12",
      latency_total_ms: 1200,
      fallback_count: 0,
      cost_breakdown: { eval_usd: 0.00002, completion_usd: 0.004, total_usd: 0.00402 },
    };
    const parsed = DecisionRecordSchema.parse(r);
    expect(parsed.key_prefix).toBe("helm_live_ab12");
    expect(parsed.cost_breakdown.eval_usd).toBeCloseTo(0.00002);
    expect(parsed.cost_breakdown.completion_usd).toBeCloseTo(0.004);
  });

  it("accepts a null key_prefix and null eval_usd (eval did not run / key unknown)", () => {
    const r = {
      ...fullRecord(),
      key_prefix: null,
      cost_breakdown: { eval_usd: null, completion_usd: 0.004, total_usd: 0.004 },
    };
    const parsed = DecisionRecordSchema.parse(r);
    expect(parsed.key_prefix).toBeNull();
    expect(parsed.cost_breakdown.eval_usd).toBeNull();
  });

  it("rejects a negative fallback_count", () => {
    const r = { ...fullRecord(), fallback_count: -1 };
    expect(DecisionRecordSchema.safeParse(r).success).toBe(false);
  });

  it("accepts an all-providers-failed terminal shape", () => {
    const r = fullRecord();
    for (const a of r.provider_attempts) {
      a.status = "error";
    }
    r.final = {
      model_alias: null,
      provider_model: null,
      status: "error",
      error_reason: "all_providers_failed",
    };
    expect(DecisionRecordSchema.safeParse(r).success).toBe(true);
  });
});
