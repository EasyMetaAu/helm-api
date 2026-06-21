import { describe, expect, it, vi } from "vitest";
import type { SignalCollector } from "./collector.js";
import { startSignalScheduler } from "./scheduler.js";

function fakeCollector(): SignalCollector & { calls: Array<[number, number]> } {
  const calls: Array<[number, number]> = [];
  return {
    calls,
    async collect(ws, we) {
      calls.push([ws, we]);
      return { written: 0, ok: true };
    },
  };
}

describe("startSignalScheduler", () => {
  it("runs collect once per interval over the just-elapsed window, and stop() halts it", async () => {
    vi.useFakeTimers();
    try {
      const collector = fakeCollector();
      let t = 100_000;
      const handle = startSignalScheduler({
        collector,
        intervalMs: 1_000,
        now: () => t,
      });

      // advance one interval → one collect over [t-1000, t)
      t = 101_000;
      await vi.advanceTimersByTimeAsync(1_000);
      expect(collector.calls).toEqual([[100_000, 101_000]]);

      // second interval → next adjacent (non-overlapping) window
      t = 102_000;
      await vi.advanceTimersByTimeAsync(1_000);
      expect(collector.calls).toEqual([
        [100_000, 101_000],
        [101_000, 102_000],
      ]);

      handle.stop();
      t = 103_000;
      await vi.advanceTimersByTimeAsync(5_000);
      // no further collects after stop()
      expect(collector.calls).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("retries the same window after a swallowed collector failure", async () => {
    vi.useFakeTimers();
    try {
      const calls: Array<[number, number]> = [];
      const results = [
        { written: 0, ok: false },
        { written: 0, ok: true },
        { written: 0, ok: true },
      ];
      let t = 100_000;
      const handle = startSignalScheduler({
        collector: {
          async collect(ws, we) {
            calls.push([ws, we]);
            return results.shift() ?? { written: 0, ok: true };
          },
        },
        intervalMs: 1_000,
        now: () => t,
      });

      t = 101_000;
      await vi.advanceTimersByTimeAsync(1_000);
      t = 102_000;
      await vi.advanceTimersByTimeAsync(1_000);
      t = 103_000;
      await vi.advanceTimersByTimeAsync(1_000);

      expect(calls).toEqual([
        [100_000, 101_000],
        [100_000, 101_000],
        [101_000, 103_000],
      ]);
      handle.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("a collect rejection never escapes the scheduler tick (fail-open)", async () => {
    vi.useFakeTimers();
    try {
      const log = vi.fn();
      let t = 0;
      const handle = startSignalScheduler({
        collector: {
          async collect() {
            throw new Error("boom");
          },
        },
        intervalMs: 1_000,
        now: () => {
          t += 1_000;
          return t;
        },
        log,
      });
      // must not throw out of the timer callback
      await vi.advanceTimersByTimeAsync(1_000);
      expect(log).toHaveBeenCalled();
      handle.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});
