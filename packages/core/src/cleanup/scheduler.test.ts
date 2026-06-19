import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startCleanupScheduler } from "./scheduler.js";

describe("startCleanupScheduler", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("runs the tick body on each interval", async () => {
    const runTick = vi.fn(async () => {});
    const h = startCleanupScheduler({ intervalMs: 1000, runTick });
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(1000);
    expect(runTick).toHaveBeenCalledTimes(2);
    h.stop();
  });

  it("is fail-open: a rejecting tick is swallowed and the timer keeps firing", async () => {
    const runTick = vi.fn(async () => {
      throw new Error("boom");
    });
    const log = vi.fn();
    const h = startCleanupScheduler({ intervalMs: 1000, runTick, log });
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(1000);
    expect(runTick).toHaveBeenCalledTimes(2); // kept firing after the first throw
    expect(log).toHaveBeenCalledWith("warn", "cleanup.scheduler_tick_failed", expect.anything());
    h.stop();
  });

  it("does not overlap: a still-running sweep skips the next tick", async () => {
    let release: (() => void) | undefined;
    const runTick = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const h = startCleanupScheduler({ intervalMs: 1000, runTick });
    await vi.advanceTimersByTimeAsync(1000); // starts pass #1 (never resolves yet)
    await vi.advanceTimersByTimeAsync(1000); // would-be pass #2 → skipped
    expect(runTick).toHaveBeenCalledTimes(1);
    release?.(); // finish pass #1
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(1000); // now a new pass can run
    expect(runTick).toHaveBeenCalledTimes(2);
    h.stop();
  });

  it("stop() halts further ticks", async () => {
    const runTick = vi.fn(async () => {});
    const h = startCleanupScheduler({ intervalMs: 1000, runTick });
    h.stop();
    await vi.advanceTimersByTimeAsync(5000);
    expect(runTick).not.toHaveBeenCalled();
  });
});
