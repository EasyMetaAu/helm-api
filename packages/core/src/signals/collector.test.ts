import type { DecisionRecord, RoutingSignal } from "@helm/shared";
import { describe, expect, it, vi } from "vitest";
import type { SignalStore, TelemetryStore } from "../store/ports.js";
import { createSignalCollector } from "./collector.js";

function makeRecord(taskType: string, lane: string): DecisionRecord {
  return {
    request_id: `r-${Math.random()}`,
    trace_id: "t",
    requested_model: "auto",
    protocol: "openai_chat",
    classifier: {
      task_type: taskType,
      complexity: "medium",
      confidence: 0.9,
      decided_by: "rules",
      rules_confidence: null,
      eval_cache_hit: null,
      eval_model: null,
      eval_latency_ms: null,
      constraints: {},
      explanation: [],
    },
    policy: { matched_policy_id: null, reason: "" },
    lane: { selected_lane: lane, candidate_chain: [lane] },
    provider_attempts: [
      {
        alias: "m0",
        skipped: false,
        skip_reason: null,
        status: "ok",
        error_class: null,
        latency_ms: 100,
        cost_usd: 0.001,
        error_detail: null,
      },
    ],
    final: { model_alias: "m0", provider_model: "m0", status: "ok", error_reason: null },
    key_prefix: null,
    latency_total_ms: 100,
    fallback_count: 0,
    cost_breakdown: { eval_usd: null, completion_usd: 0.001, total_usd: 0.001 },
    memory: null,
    usage: null,
    stream_outcome: null,
    generation_ms: null,
    serving_account: null,
  };
}

// A TelemetryStore that only implements the window query the collector needs.
function fakeTelemetry(window: DecisionRecord[]): TelemetryStore {
  return {
    insert: vi.fn(),
    queryRecent: vi.fn(),
    getByRequestId: vi.fn(),
    queryWindow: vi.fn(async () => window),
  } as unknown as TelemetryStore;
}

class RecordingSignalStore implements SignalStore {
  public readonly upserted: RoutingSignal[][] = [];
  private readonly byKey = new Map<string, RoutingSignal>();
  async upsertSignals(signals: readonly RoutingSignal[]): Promise<void> {
    this.upserted.push([...signals]);
    for (const s of signals) this.byKey.set(`${s.taskType}\u0000${s.lane}`, s);
  }
  async getSignal(taskType: string, lane: string): Promise<RoutingSignal | null> {
    return this.byKey.get(`${taskType}\u0000${lane}`) ?? null;
  }
}

describe("createSignalCollector", () => {
  it("pulls the window, aggregates, and upserts; returns written count", async () => {
    const telemetry = fakeTelemetry([
      makeRecord("chat", "balanced"),
      makeRecord("chat", "premium"),
    ]);
    const signals = new RecordingSignalStore();
    const collector = createSignalCollector({ telemetry, signals, now: () => 5_000 });

    const res = await collector.collect(1_000, 2_000);

    expect(res).toEqual({ written: 2, ok: true });
    const got = await signals.getSignal("chat", "balanced");
    expect(got?.samples).toBe(1);
    expect(got?.updatedAt).toBe(5_000);
    // the collector must read records by WINDOW, never the whole table
    expect(telemetry.queryWindow).toHaveBeenCalledWith(1_000, 2_000);
  });

  it("empty window → written:0, no throw, no upsert", async () => {
    const telemetry = fakeTelemetry([]);
    const signals = new RecordingSignalStore();
    const upsertSpy = vi.spyOn(signals, "upsertSignals");
    const collector = createSignalCollector({ telemetry, signals, now: () => 0 });

    const res = await collector.collect(1_000, 2_000);

    expect(res).toEqual({ written: 0, ok: true });
    expect(upsertSpy).not.toHaveBeenCalled();
  });

  it("is fail-open: an upsert throw is swallowed (no rethrow) → no 5xx / no main-path impact", async () => {
    const telemetry = fakeTelemetry([makeRecord("chat", "balanced")]);
    const log = vi.fn();
    const failingSignals: SignalStore = {
      upsertSignals: vi.fn(async () => {
        throw new Error("db down");
      }),
      getSignal: vi.fn(async () => null),
    };
    const collector = createSignalCollector({
      telemetry,
      signals: failingSignals,
      now: () => 0,
      log,
    });

    // MUST NOT reject — the background job records the error and moves on.
    const res = await collector.collect(1_000, 2_000);
    expect(res).toEqual({ written: 0, ok: false });
    expect(log).toHaveBeenCalled();
  });

  it("is fail-open: a telemetry read throw is swallowed too", async () => {
    const telemetry = {
      insert: vi.fn(),
      queryRecent: vi.fn(),
      getByRequestId: vi.fn(),
      queryWindow: vi.fn(async () => {
        throw new Error("read failed");
      }),
    } as unknown as TelemetryStore;
    const signals = new RecordingSignalStore();
    const collector = createSignalCollector({ telemetry, signals, now: () => 0, log: vi.fn() });

    await expect(collector.collect(1_000, 2_000)).resolves.toEqual({ written: 0, ok: false });
  });

  it("idempotent re-collect of the same window upserts (overwrites), never double-counts", async () => {
    const window = [makeRecord("chat", "balanced"), makeRecord("chat", "balanced")];
    const telemetry = fakeTelemetry(window);
    const signals = new RecordingSignalStore();
    const collector = createSignalCollector({ telemetry, signals, now: () => 0 });

    await collector.collect(1_000, 2_000);
    await collector.collect(1_000, 2_000);

    const got = await signals.getSignal("chat", "balanced");
    // still 2 samples — re-running the same window does not accumulate to 4
    expect(got?.samples).toBe(2);
  });
});
