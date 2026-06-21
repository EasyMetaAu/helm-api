// Background scheduler for the data-cleanup sweep. A plain interval that, each
// tick, runs ONE cleanup pass (`runTick`). Mirrors the signal scheduler exactly:
// off the request path, fail-open (a tick's rejection is logged + swallowed so the
// timer keeps firing), and unref'd so it never keeps the process alive on its own.
//
// It is deliberately SEPARATE from the 60s memory worker tick: cleanup is a heavier,
// hour/day-cadence sweep (archive reads + deletes), and coupling it to the memory
// cadence would either over-run cleanup or let a slow archive delay memory drain.
//
// Pure timer glue (no web framework) so it lives in core and is unit-testable with
// fake timers. The tick body itself (build plan from live settings → runCleanup) is
// injected by the composition root, which owns the settings closure + stores.

export interface CleanupSchedulerDeps {
  intervalMs: number;
  // The tick body. Resolves when one cleanup pass finishes; may reject (it is
  // guarded here). The composition root closes over the live settings + stores.
  runTick: () => Promise<void>;
  log?: (level: "warn" | "info", msg: string, fields?: Record<string, unknown>) => void;
}

export interface CleanupSchedulerHandle {
  reschedule(intervalMs: number): void;
  stop(): void;
}

export function startCleanupScheduler(deps: CleanupSchedulerDeps): CleanupSchedulerHandle {
  const log = deps.log ?? (() => {});
  let running = false;
  let timer: ReturnType<typeof setInterval> | null = null;

  const tick = () => {
    // Skip if a previous (slow) sweep is still running — never overlap passes.
    if (running) {
      log("info", "cleanup.scheduler_tick_skipped_overlap", {});
      return;
    }
    running = true;
    void deps
      .runTick()
      .catch((err: unknown) => {
        log("warn", "cleanup.scheduler_tick_failed", {
          error: err instanceof Error ? err.message : String(err),
        });
      })
      .finally(() => {
        running = false;
      });
  };

  const schedule = (intervalMs: number): void => {
    if (timer !== null) clearInterval(timer);
    timer = setInterval(tick, intervalMs);
    (timer as { unref?: () => void }).unref?.();
  };

  schedule(deps.intervalMs);

  return {
    reschedule(intervalMs: number) {
      schedule(intervalMs);
    },
    stop() {
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
    },
  };
}
