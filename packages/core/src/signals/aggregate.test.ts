import type { DecisionRecord } from "@helm/shared";
import { describe, expect, it } from "vitest";
import { aggregateSignals } from "./aggregate.js";

// Build a minimal-but-valid DecisionRecord with the dimensions the aggregator
// reads. Everything not relevant to a test is given a benign default.
function makeRecord(over: {
  taskType: string;
  lane: string;
  finalStatus: "ok" | "error";
  decidedBy?: "rules" | "eval" | "default" | "fallback";
  // each entry: a provider attempt's (skipped, latencyMs, costUsd)
  attempts: Array<{ skipped?: boolean; latencyMs: number; costUsd: number | null }>;
}): DecisionRecord {
  return {
    request_id: `r-${Math.random()}`,
    trace_id: "t",
    requested_model: "auto",
    protocol: "openai_chat",
    classifier: {
      task_type: over.taskType,
      complexity: "medium",
      confidence: 0.9,
      decided_by: over.decidedBy ?? "rules",
      rules_confidence: null,
      eval_cache_hit: null,
      eval_model: null,
      eval_latency_ms: null,
      constraints: {},
      explanation: [],
    },
    policy: { matched_policy_id: null, reason: "" },
    lane: { selected_lane: over.lane, candidate_chain: [over.lane] },
    provider_attempts: over.attempts.map((a, i) => ({
      alias: `m${i}`,
      skipped: a.skipped ?? false,
      skip_reason: a.skipped ? "capability" : null,
      status: "ok",
      error_class: null,
      latency_ms: a.latencyMs,
      cost_usd: a.costUsd,
      error_detail: null,
    })),
    final: {
      model_alias: "m0",
      provider_model: "m0",
      status: over.finalStatus,
      error_reason: over.finalStatus === "error" ? "upstream_error" : null,
    },
    key_prefix: null,
    latency_total_ms: 0,
    fallback_count: 0,
    cost_breakdown: { eval_usd: null, completion_usd: null, total_usd: null },
    memory: null,
    usage: null,
    generation_ms: null,
  };
}

describe("aggregateSignals", () => {
  const WS = 1_000;
  const WE = 2_000;

  it("groups by (taskType, lane) and computes success/error rate + samples", () => {
    const records: DecisionRecord[] = [
      makeRecord({
        taskType: "chat",
        lane: "balanced",
        finalStatus: "ok",
        attempts: [{ latencyMs: 100, costUsd: 0.001 }],
      }),
      makeRecord({
        taskType: "chat",
        lane: "balanced",
        finalStatus: "ok",
        attempts: [{ latencyMs: 200, costUsd: 0.003 }],
      }),
      makeRecord({
        taskType: "chat",
        lane: "balanced",
        finalStatus: "error",
        attempts: [{ latencyMs: 300, costUsd: null }],
      }),
      // different lane → separate signal
      makeRecord({
        taskType: "chat",
        lane: "premium",
        finalStatus: "ok",
        attempts: [{ latencyMs: 50, costUsd: 0.01 }],
      }),
    ];

    const signals = aggregateSignals(records, WS, WE);

    const chatBalanced = signals.find((s) => s.taskType === "chat" && s.lane === "balanced");
    const chatPremium = signals.find((s) => s.taskType === "chat" && s.lane === "premium");
    expect(signals).toHaveLength(2);
    expect(chatBalanced).toBeDefined();
    expect(chatPremium).toBeDefined();

    // balanced: 3 samples, 2 ok / 1 error
    expect(chatBalanced?.samples).toBe(3);
    expect(chatBalanced?.successRate).toBeCloseTo(2 / 3);
    expect(chatBalanced?.errorRate).toBeCloseTo(1 / 3);
    // avgCost ignores the null-cost record → (0.001 + 0.003) / 2
    expect(chatBalanced?.avgCostUsd).toBeCloseTo(0.002);
    // window echoed
    expect(chatBalanced?.windowStart).toBe(WS);
    expect(chatBalanced?.windowEnd).toBe(WE);

    expect(chatPremium?.samples).toBe(1);
    expect(chatPremium?.successRate).toBe(1);
  });

  it("computes p50/p95 latency from total per-record latency", () => {
    // 5 records, single-attempt each: latencies 10,20,30,40,100
    const records = [10, 20, 30, 40, 100].map((ms) =>
      makeRecord({
        taskType: "code",
        lane: "balanced",
        finalStatus: "ok",
        attempts: [{ latencyMs: ms, costUsd: null }],
      }),
    );
    const [s] = aggregateSignals(records, WS, WE);
    expect(s?.p50LatencyMs).toBe(30); // median
    expect(s?.p95LatencyMs).toBe(100); // top
  });

  it("counts EXECUTION fallback (in-chain model swap) in fallbackRate, not classification fallback", () => {
    const records: DecisionRecord[] = [
      // single non-skipped attempt → NO execution fallback
      makeRecord({
        taskType: "chat",
        lane: "balanced",
        finalStatus: "ok",
        attempts: [{ latencyMs: 10, costUsd: null }],
      }),
      // two non-skipped attempts → in-chain swap → execution fallback
      makeRecord({
        taskType: "chat",
        lane: "balanced",
        finalStatus: "ok",
        attempts: [
          { latencyMs: 10, costUsd: null },
          { latencyMs: 20, costUsd: null },
        ],
      }),
      // a skipped attempt + one real one → NOT a fallback (skip != swap)
      makeRecord({
        taskType: "chat",
        lane: "balanced",
        finalStatus: "ok",
        attempts: [
          { skipped: true, latencyMs: 0, costUsd: null },
          { latencyMs: 30, costUsd: null },
        ],
      }),
    ];
    const [s] = aggregateSignals(records, WS, WE);
    // only 1 of 3 records had an in-chain swap
    expect(s?.fallbackRate).toBeCloseTo(1 / 3);
  });

  it("tracks classifierFallbackRate separately from execution fallbackRate (principle 5)", () => {
    const records: DecisionRecord[] = [
      // classification fell open to balanced, but only ONE provider attempt
      makeRecord({
        taskType: "chat",
        lane: "balanced",
        finalStatus: "ok",
        decidedBy: "fallback",
        attempts: [{ latencyMs: 10, costUsd: null }],
      }),
      makeRecord({
        taskType: "chat",
        lane: "balanced",
        finalStatus: "ok",
        decidedBy: "rules",
        attempts: [{ latencyMs: 10, costUsd: null }],
      }),
    ];
    const [s] = aggregateSignals(records, WS, WE);
    expect(s?.classifierFallbackRate).toBeCloseTo(1 / 2);
    expect(s?.fallbackRate).toBe(0); // no in-chain swap occurred
  });

  it("returns avgCostUsd=null when no record in the group carried a cost", () => {
    const records = [
      makeRecord({
        taskType: "x",
        lane: "y",
        finalStatus: "ok",
        attempts: [{ latencyMs: 1, costUsd: null }],
      }),
    ];
    const [s] = aggregateSignals(records, WS, WE);
    expect(s?.avgCostUsd).toBeNull();
  });

  it("emits no signal for an empty record set", () => {
    expect(aggregateSignals([], WS, WE)).toEqual([]);
  });

  it("uses the canonical latency_total_ms / fallback_count when the enriched record carries them", () => {
    const rec = makeRecord({
      taskType: "chat",
      lane: "balanced",
      finalStatus: "ok",
      // Two non-skipped attempts → recompute path would say execution fallback,
      // and would sum the attempt latencies to 30. The enriched canonical fields
      // disagree on purpose so we can prove the aggregator trusts them.
      attempts: [
        { latencyMs: 10, costUsd: null },
        { latencyMs: 20, costUsd: null },
      ],
    });
    rec.latency_total_ms = 999;
    rec.fallback_count = 0; // canonical says NO execution fallback
    const [s] = aggregateSignals([rec], WS, WE);
    expect(s?.p50LatencyMs).toBe(999); // trusts canonical latency, not Σattempts (30)
    expect(s?.fallbackRate).toBe(0); // trusts canonical fallback_count, not Σattempts
  });

  it("falls back to recomputation for legacy records (canonical fields default 0)", () => {
    // Pre-enrichment record: latency_total_ms/fallback_count left at their 0 default
    // even though the attempts clearly carry latency and an in-chain swap. The
    // aggregator must NOT read those zeros as truth — it recomputes from attempts.
    const rec = makeRecord({
      taskType: "chat",
      lane: "balanced",
      finalStatus: "ok",
      attempts: [
        { latencyMs: 10, costUsd: null },
        { latencyMs: 20, costUsd: null },
      ],
    });
    rec.latency_total_ms = 0;
    rec.fallback_count = 0;
    const [s] = aggregateSignals([rec], WS, WE);
    expect(s?.p50LatencyMs).toBe(30); // recomputed Σattempts
    expect(s?.fallbackRate).toBe(1); // recomputed in-chain swap
  });

  it("output carries ONLY redacted aggregate dimensions (no key/payload fields)", () => {
    const records = [
      makeRecord({
        taskType: "chat",
        lane: "balanced",
        finalStatus: "ok",
        attempts: [{ latencyMs: 10, costUsd: 0.001 }],
      }),
    ];
    const [s] = aggregateSignals(records, WS, WE);
    const keys = Object.keys(s ?? {}).sort();
    expect(keys).toEqual(
      [
        "avgCostUsd",
        "classifierFallbackRate",
        "errorRate",
        "fallbackRate",
        "lane",
        "p50LatencyMs",
        "p95LatencyMs",
        "samples",
        "successRate",
        "taskType",
        "updatedAt",
        "windowEnd",
        "windowStart",
      ].sort(),
    );
    // Defensive: serialized signal must not contain any key/secret-shaped field.
    const json = JSON.stringify(s);
    expect(json).not.toMatch(/helm_(live|test)_/);
    expect(json).not.toMatch(/api_key|apiKey|payload|message|hash/i);
  });
});
