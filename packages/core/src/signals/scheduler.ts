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
  let retryWindow: [number, number] | null = null;
  let inFlight = false;

  const timer = setInterval(() => {
    if (inFlight) return;
    const [windowStart, windowEnd] = retryWindow ?? [prevTick, deps.now()];
    inFlight = true;
    // Fire-and-forget; collect() is fail-open in normal operation, but the scheduler
    // still treats ok:false or a rejection as a non-advanced window so telemetry is
    // retried instead of skipped permanently.
    void deps.collector
      .collect(windowStart, windowEnd)
      .then((res) => {
        if (res.ok) {
          retryWindow = null;
          prevTick = windowEnd;
          return;
        }
        retryWindow = [windowStart, windowEnd];
        log("warn", "signals.scheduler_tick_failed", { windowStart, windowEnd });
      })
      .catch((err: unknown) => {
        retryWindow = [windowStart, windowEnd];
        log("warn", "signals.scheduler_tick_failed", {
          windowStart,
          windowEnd,
          error: err instanceof Error ? err.message : String(err),
        });
      })
      .finally(() => {
        inFlight = false;
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
