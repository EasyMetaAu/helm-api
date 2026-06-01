import type { DecisionRecord } from "@helm/shared";
import { describe, expect, it } from "vitest";
import { createSqliteDb } from "./migrate.js";
import { SqliteTelemetryStore } from "./telemetry.js";

function decision(requestId: string, overrides: Partial<DecisionRecord> = {}): DecisionRecord {
  return {
    request_id: requestId,
    trace_id: requestId,
    requested_model: "gpt-4o",
    classifier: {
      task_type: "coding",
      complexity: "complex",
      confidence: 0.87,
      decided_by: "rules",
      eval_cache_hit: null,
      constraints: { needs_tools: true },
      explanation: ["code-block"],
    },
    policy: { matched_policy_id: "p1", reason: "coding" },
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
        error_detail: null,
      },
      {
        alias: "premium",
        skipped: false,
        skip_reason: null,
        status: "ok",
        error_class: null,
        latency_ms: 1200,
        cost_usd: 0.004,
        error_detail: null,
      },
    ],
    final: { model_alias: "premium", provider_model: "claude-x", status: "ok", error_reason: null },
    key_prefix: "helm_live_ab12",
    latency_total_ms: 1200,
    fallback_count: 0,
    cost_breakdown: { eval_usd: null, completion_usd: 0.004, total_usd: 0.004 },
    ...overrides,
  };
}

function freshStore() {
  return new SqliteTelemetryStore(createSqliteDb(":memory:"));
}

describe("SqliteTelemetryStore", () => {
  it("round-trips insert -> queryRecent without losing nested structure", async () => {
    const store = freshStore();
    const at = new Date(1717155600000);
    await store.insert({ decision: decision("req_1"), apiKeyId: "k1", createdAt: at });
    const recent = await store.queryRecent(10);
    expect(recent).toHaveLength(1);
    expect(recent[0]?.record).toEqual(decision("req_1"));
    expect(recent[0]?.record.provider_attempts).toHaveLength(2);
    // queryRecent surfaces the recorded timestamp alongside the record so the
    // Debug UI can render the 「时间」 column without fabricating it.
    expect(recent[0]?.createdAt.getTime()).toBe(at.getTime());
  });

  it("getByRequestId returns the record, null on a miss", async () => {
    const store = freshStore();
    await store.insert({ decision: decision("req_1"), apiKeyId: "k1", createdAt: new Date() });
    expect((await store.getByRequestId("req_1"))?.request_id).toBe("req_1");
    expect(await store.getByRequestId("nope")).toBeNull();
  });

  it("stores no plaintext key and no raw message payload", async () => {
    const store = freshStore();
    await store.insert({ decision: decision("req_1"), apiKeyId: "k1", createdAt: new Date() });
    // The persisted record (read back via the public path) must not contain a
    // plaintext api key or a raw user message payload.
    const got = await store.getByRequestId("req_1");
    const serialized = JSON.stringify(got);
    expect(serialized).not.toContain("sk-");
    expect(serialized).not.toContain("password");
    // the decision record carries no `messages` field by design
    expect(got && "messages" in got).toBe(false);
  });

  it("orders by created_at desc and respects limit", async () => {
    const store = freshStore();
    await store.insert({
      decision: decision("old"),
      apiKeyId: "k1",
      createdAt: new Date(1000),
    });
    await store.insert({
      decision: decision("mid"),
      apiKeyId: "k1",
      createdAt: new Date(2000),
    });
    await store.insert({
      decision: decision("new"),
      apiKeyId: "k1",
      createdAt: new Date(3000),
    });
    const recent = await store.queryRecent(2);
    expect(recent.map((r) => r.record.request_id)).toEqual(["new", "mid"]);
  });

  it("rejects a duplicate request_id (unique constraint)", async () => {
    const store = freshStore();
    await store.insert({ decision: decision("req_1"), apiKeyId: "k1", createdAt: new Date() });
    await expect(
      store.insert({ decision: decision("req_1"), apiKeyId: "k2", createdAt: new Date() }),
    ).rejects.toThrow();
  });

  it("preserves number/boolean|null/array types through JSON round-trip", async () => {
    const store = freshStore();
    const d = decision("req_1", {
      classifier: {
        task_type: "chat",
        complexity: "simple",
        confidence: 0.5,
        decided_by: "eval",
        eval_cache_hit: true,
        constraints: {},
        explanation: [],
      },
    });
    await store.insert({ decision: d, apiKeyId: "k1", createdAt: new Date() });
    const got = await store.getByRequestId("req_1");
    expect(got?.classifier.confidence).toBe(0.5);
    expect(got?.classifier.eval_cache_hit).toBe(true);
    expect(Array.isArray(got?.provider_attempts)).toBe(true);
  });
});
