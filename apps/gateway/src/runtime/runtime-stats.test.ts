import { afterEach, describe, expect, it, vi } from "vitest";
import { startRuntimeStatsLogger } from "./runtime-stats.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("startRuntimeStatsLogger", () => {
  it("logs process memory, event-loop delay, and queue depth every minute", async () => {
    vi.useFakeTimers();
    const log = vi.fn();
    const histogram = {
      mean: 2_000_000,
      max: 5_000_000,
      percentile: vi.fn(() => 4_000_000),
      enable: vi.fn(),
      reset: vi.fn(),
      disable: vi.fn(),
    };
    const stats = startRuntimeStatsLogger({
      logger: { log },
      memoryUsage: () => ({
        rss: 100,
        heapUsed: 40,
        heapTotal: 60,
        external: 20,
        arrayBuffers: 10,
      }),
      eventLoopDelay: () => histogram,
      responsesPreflightPending: () => 3,
      oauthRefreshQueueDepth: () => 2,
    });

    await vi.advanceTimersByTimeAsync(60_000);

    expect(log).toHaveBeenCalledWith("info", "runtime.stats", {
      rss_bytes: 100,
      heap_used_bytes: 40,
      heap_total_bytes: 60,
      external_bytes: 20,
      array_buffers_bytes: 10,
      event_loop_delay_mean_ms: 2,
      event_loop_delay_p99_ms: 4,
      event_loop_delay_max_ms: 5,
      responses_preflight_pending: 3,
      oauth_refresh_queue_depth: 2,
    });
    expect(histogram.enable).toHaveBeenCalledOnce();
    expect(histogram.percentile).toHaveBeenCalledWith(99);
    expect(histogram.reset).toHaveBeenCalledOnce();

    stats.stop();
    expect(histogram.disable).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(log).toHaveBeenCalledOnce();
  });
});
