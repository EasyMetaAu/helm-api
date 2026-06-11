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
      rules_confidence: null,
      eval_cache_hit: null,
      eval_model: null,
      eval_latency_ms: null,
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
    memory: null,
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
    // Debug UI can render the "Time" column without fabricating it.
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

  // ── queryPage: filtered + paginated Debug list (createdAt DESC) ──────────────
  // Seed helper: insert a record at a given time with the fields queryPage filters on.
  async function seed(
    store: SqliteTelemetryStore,
    id: string,
    atMs: number,
    fields: {
      status?: "ok" | "error";
      decidedBy?: DecisionRecord["classifier"]["decided_by"];
      lane?: string;
      requestedModel?: string;
      servedModel?: string;
    } = {},
  ): Promise<void> {
    const base = decision(id);
    const d: DecisionRecord = {
      ...base,
      requested_model: fields.requestedModel ?? base.requested_model,
      classifier: {
        ...base.classifier,
        decided_by: fields.decidedBy ?? base.classifier.decided_by,
      },
      lane: { ...base.lane, selected_lane: fields.lane ?? base.lane.selected_lane },
      final: {
        ...base.final,
        status: fields.status ?? base.final.status,
        model_alias: fields.servedModel ?? base.final.model_alias,
        error_reason: (fields.status ?? base.final.status) === "error" ? "upstream_error" : null,
      },
    };
    await store.insert({ decision: d, apiKeyId: "k1", createdAt: new Date(atMs) });
  }

  it("paginates createdAt DESC with offset/limit and reports the full total", async () => {
    const store = freshStore();
    for (let i = 0; i < 5; i++) await seed(store, `r${i}`, 1000 + i * 1000);
    const page1 = await store.queryPage({ limit: 2, offset: 0 });
    expect(page1.total).toBe(5);
    expect(page1.rows.map((r) => r.record.request_id)).toEqual(["r4", "r3"]);
    const page2 = await store.queryPage({ limit: 2, offset: 2 });
    expect(page2.rows.map((r) => r.record.request_id)).toEqual(["r2", "r1"]);
    const page3 = await store.queryPage({ limit: 2, offset: 4 });
    expect(page3.rows.map((r) => r.record.request_id)).toEqual(["r0"]);
  });

  it("filters by status using the denormalized final_status column", async () => {
    const store = freshStore();
    await seed(store, "ok1", 1000, { status: "ok" });
    await seed(store, "err1", 2000, { status: "error" });
    await seed(store, "ok2", 3000, { status: "ok" });
    const page = await store.queryPage({ limit: 50, offset: 0, status: "error" });
    expect(page.total).toBe(1);
    expect(page.rows.map((r) => r.record.request_id)).toEqual(["err1"]);
  });

  it("filters by decided_by (classification stage, from JSON)", async () => {
    const store = freshStore();
    await seed(store, "rules1", 1000, { decidedBy: "rules" });
    await seed(store, "eval1", 2000, { decidedBy: "eval" });
    await seed(store, "fb1", 3000, { decidedBy: "fallback" });
    const page = await store.queryPage({ limit: 50, offset: 0, decidedBy: "eval" });
    expect(page.rows.map((r) => r.record.request_id)).toEqual(["eval1"]);
    expect(page.total).toBe(1);
  });

  it("filters by lane (selected_lane, from JSON)", async () => {
    const store = freshStore();
    await seed(store, "a", 1000, { lane: "premium" });
    await seed(store, "b", 2000, { lane: "balanced" });
    const page = await store.queryPage({ limit: 50, offset: 0, lane: "premium" });
    expect(page.rows.map((r) => r.record.request_id)).toEqual(["a"]);
  });

  it("filters by model substring across requested OR served, case-insensitive", async () => {
    const store = freshStore();
    await seed(store, "req", 1000, { requestedModel: "gpt-4o-mini", servedModel: "claude-x" });
    await seed(store, "srv", 2000, { requestedModel: "auto", servedModel: "GPT-4o" });
    await seed(store, "none", 3000, { requestedModel: "auto", servedModel: "claude-x" });
    const page = await store.queryPage({ limit: 50, offset: 0, model: "gpt-4o" });
    expect(page.rows.map((r) => r.record.request_id).sort()).toEqual(["req", "srv"]);
    expect(page.total).toBe(2);
  });

  it("filters by half-open date window [startMs, endMs)", async () => {
    const store = freshStore();
    await seed(store, "before", 1000);
    await seed(store, "in", 2000);
    await seed(store, "edge", 3000); // == endMs → excluded (half-open)
    const page = await store.queryPage({ limit: 50, offset: 0, startMs: 2000, endMs: 3000 });
    expect(page.rows.map((r) => r.record.request_id)).toEqual(["in"]);
    expect(page.total).toBe(1);
  });

  it("combines filters and counts the full filtered total (not just the page)", async () => {
    const store = freshStore();
    for (let i = 0; i < 4; i++) await seed(store, `e${i}`, 1000 + i * 1000, { status: "error" });
    await seed(store, "ok", 9000, { status: "ok" });
    const page = await store.queryPage({ limit: 2, offset: 0, status: "error" });
    expect(page.total).toBe(4);
    expect(page.rows).toHaveLength(2);
    expect(page.rows.map((r) => r.record.request_id)).toEqual(["e3", "e2"]);
  });

  it("preserves number/boolean|null/array types through JSON round-trip", async () => {
    const store = freshStore();
    const d = decision("req_1", {
      classifier: {
        task_type: "chat",
        complexity: "simple",
        confidence: 0.5,
        decided_by: "eval",
        rules_confidence: null,
        eval_cache_hit: true,
        eval_model: null,
        eval_latency_ms: null,
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

  // Batch variants (perf): the deferred write queue collapses N inserts into ONE
  // commit. The result must be indistinguishable from N single inserts.
  it("insertMany persists every decision (batch == N singles)", async () => {
    const store = freshStore();
    const at = new Date(1717155600000);
    await store.insertMany([
      { decision: decision("req_a"), apiKeyId: "k1", createdAt: at },
      { decision: decision("req_b"), apiKeyId: "k1", createdAt: at },
      { decision: decision("req_c"), apiKeyId: "k2", createdAt: at },
    ]);
    const recent = await store.queryRecent(10);
    expect(recent.map((r) => r.record.request_id).sort()).toEqual(["req_a", "req_b", "req_c"]);
    expect(await store.getApiKeyId("req_c")).toBe("k2");
    expect(await store.getByRequestId("req_a")).toEqual(decision("req_a"));
  });

  it("insertMany([]) is a no-op", async () => {
    const store = freshStore();
    await expect(store.insertMany([])).resolves.toBeUndefined();
    expect(await store.queryRecent(10)).toHaveLength(0);
  });

  it("insertPayloads persists every payload and upserts by request_id", async () => {
    const store = freshStore();
    const at = new Date(1717155600000);
    await store.insertPayloads([
      { requestId: "req_a", requestJson: '{"a":1}', responseJson: '{"r":1}', createdAt: at },
      { requestId: "req_b", requestJson: '{"b":2}', responseJson: null, createdAt: at },
    ]);
    expect((await store.getPayload("req_a"))?.responseJson).toBe('{"r":1}');
    expect((await store.getPayload("req_b"))?.responseJson).toBeNull();

    // Re-batch the same request_id with a backfilled response → upsert, not dup.
    await store.insertPayloads([
      { requestId: "req_b", requestJson: '{"b":2}', responseJson: '{"r":2}', createdAt: at },
    ]);
    expect((await store.getPayload("req_b"))?.responseJson).toBe('{"r":2}');
  });

  it("insertPayloads([]) is a no-op", async () => {
    const store = freshStore();
    await expect(store.insertPayloads([])).resolves.toBeUndefined();
    expect(await store.getPayload("nope")).toBeNull();
  });
});
