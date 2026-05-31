import type { SignalCollector } from "./collector.js";

// Background scheduler for the Signal Collector. A plain interval that, each
// tick, asks the collector to aggregate the JUST-ELAPSED window
// [prevTick, nowTick). Adjacent windows are half-open and non-overlapping, so a
// missed/duplicated tick is harmless (upsert is idempotent).
//
// This is the OFF-the-request-path trigger (spec's preferred model): the gateway
// starts it once at boot. The request pipeline does NOT import or call this, so
// signal collection adds ZERO latency to any served request. fail-open: a tick's
// failure is logged and swallowed — the timer keeps firing, the process is fine.
//
// Pure timer glue (no web framework) so it lives in core and is unit-testable
// with fake timers.

export interface SignalSchedulerDeps {
  collector: SignalCollector;
  intervalMs: number;
  now: () => number; // epoch ms; injectable for tests
  log?: (level: "warn" | "info", msg: string, fields?: Record<string, unknown>) => void;
}

export interface SignalSchedulerHandle {
  stop(): void;
}

export function startSignalScheduler(deps: SignalSchedulerDeps): SignalSchedulerHandle {
  const log = deps.log ?? (() => {});
  let prevTick = deps.now();

  const timer = setInterval(() => {
    const windowStart = prevTick;
    const windowEnd = deps.now();
    prevTick = windowEnd;
    // Fire-and-forget; collect() is itself fail-open, but guard the promise too
    // so a rejection can never become an unhandled rejection on the timer.
    void deps.collector.collect(windowStart, windowEnd).catch((err: unknown) => {
      log("warn", "signals.scheduler_tick_failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }, deps.intervalMs);

  // Do not keep the event loop alive solely for signal collection (Node only).
  (timer as { unref?: () => void }).unref?.();

  return {
    stop() {
      clearInterval(timer);
    },
  };
}
