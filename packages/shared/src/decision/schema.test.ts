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

  it("defaults eval_model / eval_latency_ms to null when omitted (legacy / non-eval records)", () => {
    // The legacy fixture omits both → must parse as null (present, never undefined),
    // so every stored classifier record carries the field even pre-eval.
    const parsed = DecisionRecordSchema.parse(fullRecord());
    expect(parsed.classifier.eval_model).toBeNull();
    expect(parsed.classifier.eval_latency_ms).toBeNull();
  });

  it("round-trips an eval-decided classifier (model + latency present)", () => {
    const r = fullRecord();
    r.classifier.decided_by = "eval";
    r.classifier.eval_cache_hit = false;
    (r.classifier as Record<string, unknown>).eval_model = "gpt-4o-mini";
    (r.classifier as Record<string, unknown>).eval_latency_ms = 1234;
    const parsed = DecisionRecordSchema.parse(r);
    expect(parsed.classifier.eval_model).toBe("gpt-4o-mini");
    expect(parsed.classifier.eval_latency_ms).toBe(1234);
  });

  it("defaults rules_confidence to null when omitted; round-trips when present; bounds to [0,1]", () => {
    // Legacy record (no field) → null, present (never undefined).
    expect(DecisionRecordSchema.parse(fullRecord()).classifier.rules_confidence).toBeNull();
    // An eval-decided record keeps the LOW Layer-1 gate value alongside the
    // eval verdict's high `confidence` — the causal chain stays reconstructible.
    const r = fullRecord();
    r.classifier.decided_by = "eval";
    r.classifier.confidence = 0.95;
    (r.classifier as Record<string, unknown>).rules_confidence = 0.05;
    const parsed = DecisionRecordSchema.parse(r);
    expect(parsed.classifier.rules_confidence).toBeCloseTo(0.05);
    expect(parsed.classifier.confidence).toBeCloseTo(0.95);
    // Out-of-range rejected.
    (r.classifier as Record<string, unknown>).rules_confidence = 1.2;
    expect(DecisionRecordSchema.safeParse(r).success).toBe(false);
  });

  it("rejects a negative eval_latency_ms", () => {
    const r = fullRecord();
    (r.classifier as Record<string, unknown>).eval_latency_ms = -1;
    expect(DecisionRecordSchema.safeParse(r).success).toBe(false);
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

  it("accepts a per-attempt error_detail (upstream status + message + raw body)", () => {
    const r = fullRecord();
    r.provider_attempts[0] = {
      alias: "coding_model",
      skipped: false,
      skip_reason: null,
      status: "error",
      error_class: "upstream_error",
      latency_ms: 306,
      cost_usd: null,
      error_detail: {
        upstream_status: 429,
        message: "upstream returned 429",
        provider_raw: { error: { message: "rate limit exceeded", type: "rate_limit_error" } },
      },
    };
    const parsed = DecisionRecordSchema.parse(r);
    expect(parsed.provider_attempts[0]?.error_detail?.upstream_status).toBe(429);
    expect(parsed.provider_attempts[0]?.error_detail?.message).toBe("upstream returned 429");
    expect(parsed.provider_attempts[0]?.error_detail?.provider_raw).toEqual({
      error: { message: "rate limit exceeded", type: "rate_limit_error" },
    });
  });

  it("defaults error_detail to null when omitted (legacy records round-trip)", () => {
    const parsed = DecisionRecordSchema.parse(fullRecord());
    // The legacy fixture omits error_detail entirely → must parse as null,
    // never undefined, so the field is always present in stored records.
    expect(parsed.provider_attempts[0]?.error_detail).toBeNull();
  });

  it("accepts a null upstream_status / null provider_raw (timeout, no body)", () => {
    const r = fullRecord();
    r.provider_attempts[0] = {
      ...r.provider_attempts[0],
      error_class: "timeout",
      error_detail: {
        upstream_status: null,
        message: "upstream request timed out",
        provider_raw: null,
      },
    } as (typeof r.provider_attempts)[number];
    const parsed = DecisionRecordSchema.parse(r);
    expect(parsed.provider_attempts[0]?.error_detail?.upstream_status).toBeNull();
    expect(parsed.provider_attempts[0]?.error_detail?.provider_raw).toBeNull();
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

  // Regression (docs/12 live-integration find): the redactor used to mangle the
  // numeric `memory_tokens_injected` (key matches the "token" secret pattern) into
  // {redacted:true,kind:"number"} — and those rows are PERSISTED in real DBs. The
  // schema coerces that exact legacy artifact to 0 on read so a single old row can
  // never 502 the whole /admin/api/requests list; anything else stays fail-closed.
  it("tolerates the legacy redaction-mangled memory_tokens_injected (coerced to 0)", () => {
    const r = {
      ...fullRecord(),
      memory: {
        memory_hydrated: true,
        reflection_version: 2,
        observation_count: 1,
        memory_tokens_injected: { redacted: true, kind: "number" }, // the legacy artifact
        observer_job_id: "job-1",
        memory_writeback_status: "queued",
        degraded: false,
        thread_source: "header",
      },
    } as unknown as DecisionRecordInput;
    const parsed = DecisionRecordSchema.parse(r);
    expect(parsed.memory?.memory_tokens_injected).toBe(0);
    // A healthy numeric value round-trips untouched…
    const healthy = DecisionRecordSchema.parse({
      ...r,
      memory: { ...(r as { memory: object }).memory, memory_tokens_injected: 191 },
    } as unknown as DecisionRecordInput);
    expect(healthy.memory?.memory_tokens_injected).toBe(191);
    // …and a non-legacy junk object is still rejected (fail-closed).
    const junk = DecisionRecordSchema.safeParse({
      ...r,
      memory: { ...(r as { memory: object }).memory, memory_tokens_injected: { nope: 1 } },
    } as unknown as DecisionRecordInput);
    expect(junk.success).toBe(false);
  });

  it("defaults usage to null when omitted (legacy records round-trip)", () => {
    // Dashboard token accounting: the routing core emits null and pre-feature
    // records have no `usage`, so an absent block must parse as null (present,
    // never undefined) — the gateway stamps the real counts post-served.
    const parsed = DecisionRecordSchema.parse(fullRecord());
    expect(parsed.usage).toBeNull();
  });

  it("round-trips a stamped usage token-count block", () => {
    const parsed = DecisionRecordSchema.parse({
      ...fullRecord(),
      usage: {
        prompt_tokens: 1200,
        completion_tokens: 340,
        cached_tokens: 800,
        cache_creation_tokens: 64,
      },
    });
    expect(parsed.usage?.prompt_tokens).toBe(1200);
    expect(parsed.usage?.completion_tokens).toBe(340);
    expect(parsed.usage?.cached_tokens).toBe(800);
    expect(parsed.usage?.cache_creation_tokens).toBe(64);
  });

  it("defaults absent usage leaves to null and rejects a negative count", () => {
    // A partially-known block validates (each leaf .nullable().default(null))…
    const parsed = DecisionRecordSchema.parse({
      ...fullRecord(),
      usage: { prompt_tokens: 10 },
    });
    expect(parsed.usage?.prompt_tokens).toBe(10);
    expect(parsed.usage?.completion_tokens).toBeNull();
    // …but a negative token count is fail-closed.
    const bad = DecisionRecordSchema.safeParse({
      ...fullRecord(),
      usage: { prompt_tokens: -1 },
    });
    expect(bad.success).toBe(false);
  });

  it("defaults protocol to null when omitted (legacy records round-trip)", () => {
    const parsed = DecisionRecordSchema.parse(fullRecord());
    expect(parsed.protocol).toBeNull();
  });

  it("round-trips each client protocol (Retry re-issues in the native shape)", () => {
    for (const protocol of [
      "openai_chat",
      "anthropic_messages",
      "openai_responses",
      "gemini",
    ] as const) {
      const parsed = DecisionRecordSchema.parse({ ...fullRecord(), protocol });
      expect(parsed.protocol).toBe(protocol);
    }
  });

  it("rejects an unknown protocol (fail-closed)", () => {
    const bad = DecisionRecordSchema.safeParse({
      ...fullRecord(),
      protocol: "cohere",
    } as unknown as DecisionRecordInput);
    expect(bad.success).toBe(false);
  });
});
