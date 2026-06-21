import type { SignalStore, TelemetryStore } from "../store/ports.js";
import { aggregateSignals } from "./aggregate.js";

// Signal Collector — the BACKGROUND half of the Agentic Signals loop
// (collect → aggregate → write). It consumes telemetry that is ALREADY
// persisted: it pulls a finished time window, folds it with the pure
// `aggregateSignals`, and upserts the result into the SignalStore.
//
// HARD CONSTRAINT (head of the spec): this NEVER runs on the request path. It is
// triggered by a background scheduler (gateway interval) and the request
// pipeline does not import or await it — zero added main-path latency.
//
// fail-open (principle 3): aggregation/read/write failures only LOG; `collect`
// never rejects, so a flaky signal store can never 5xx a served request or stall
// the next request. The scheduler can retry ok:false windows without treating a
// successful empty window as a failure.

export interface SignalCollectorDeps {
  telemetry: TelemetryStore; // read already-persisted decision records (windowed)
  signals: SignalStore; // write aggregated signals
  now: () => number; // epoch ms, for the signal's updatedAt
  // Optional structured logger; defaults to a no-op so core stays framework-free.
  log?: (level: "warn" | "info", msg: string, fields?: Record<string, unknown>) => void;
}

export interface SignalCollector {
  // Aggregate [windowStart, windowEnd) and upsert. Returns how many signals were
  // written. ok=false distinguishes a swallowed failure from a successful empty
  // window so the scheduler can retry the same range instead of skipping telemetry.
  collect(windowStart: number, windowEnd: number): Promise<{ written: number; ok: boolean }>;
}

export function createSignalCollector(deps: SignalCollectorDeps): SignalCollector {
  const log = deps.log ?? (() => {});

  return {
    async collect(windowStart, windowEnd) {
      try {
        const records = await deps.telemetry.queryWindow(windowStart, windowEnd);
        if (records.length === 0) return { written: 0, ok: true };

        const signals = aggregateSignals(records, windowStart, windowEnd);
        // Stamp updatedAt with the collector's clock (aggregate uses windowEnd as
        // a deterministic default; the collector owns the real wall-clock).
        const stamped = signals.map((s) => ({ ...s, updatedAt: deps.now() }));
        if (stamped.length === 0) return { written: 0, ok: true };

        await deps.signals.upsertSignals(stamped);
        return { written: stamped.length, ok: true };
      } catch (err) {
        // fail-open: a background signal failure must never propagate to the main
        // path. Return ok:false so the scheduler can retry this window.
        log("warn", "signals.collect_failed", {
          windowStart,
          windowEnd,
          error: err instanceof Error ? err.message : String(err),
        });
        return { written: 0, ok: false };
      }
    },
  };
}
