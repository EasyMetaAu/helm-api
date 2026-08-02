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
  maxCatchupWindowMs?: number;
  now: () => number; // epoch ms; injectable for tests
  shouldRun?: () => boolean | Promise<boolean>;
  log?: (level: "warn" | "info", msg: string, fields?: Record<string, unknown>) => void;
}

export interface SignalSchedulerHandle {
  stop(): Promise<void>;
  pauseAndWait(): Promise<void>;
  resume(): void;
}

export function startSignalScheduler(deps: SignalSchedulerDeps): SignalSchedulerHandle {
  const log = deps.log ?? (() => {});
  const maxCatchupWindowMs = Math.max(
    deps.intervalMs,
    deps.maxCatchupWindowMs ?? deps.intervalMs * 5,
  );
  let prevTick = deps.now();
  let retryWindow: [number, number] | null = null;
  let inFlight = false;
  let paused = false;
  const idleWaiters: Array<() => void> = [];

  const timer = setInterval(() => {
    if (paused || inFlight) return;
    inFlight = true;
    let windowStart = prevTick;
    let windowEnd = prevTick;
    void Promise.resolve()
      .then(async () => {
        if (deps.shouldRun !== undefined && (await deps.shouldRun()) === false) return null;
        [windowStart, windowEnd] = retryWindow ?? [
          prevTick,
          Math.min(deps.now(), prevTick + maxCatchupWindowMs),
        ];
        return deps.collector.collect(windowStart, windowEnd);
      })
      .then((res) => {
        if (res === null) return;
        if (res.ok) {
          retryWindow = null;
          prevTick = windowEnd;
          return;
        }
        retryWindow = [windowStart, windowEnd];
        log("warn", "signals.scheduler_tick_failed", { windowStart, windowEnd });
      })
      .catch((err: unknown) => {
        if (windowEnd !== prevTick) retryWindow = [windowStart, windowEnd];
        log("warn", "signals.scheduler_tick_failed", {
          windowStart,
          windowEnd,
          error: err instanceof Error ? err.message : String(err),
        });
      })
      .finally(() => {
        inFlight = false;
        for (const resolve of idleWaiters.splice(0)) resolve();
      });
  }, deps.intervalMs);

  // Do not keep the event loop alive solely for signal collection (Node only).
  (timer as { unref?: () => void }).unref?.();

  return {
    async stop() {
      clearInterval(timer);
      paused = true;
      if (!inFlight) return;
      await new Promise<void>((resolve) => idleWaiters.push(resolve));
    },
    async pauseAndWait() {
      paused = true;
      if (!inFlight) return;
      await new Promise<void>((resolve) => idleWaiters.push(resolve));
    },
    resume() {
      paused = false;
    },
  };
}
