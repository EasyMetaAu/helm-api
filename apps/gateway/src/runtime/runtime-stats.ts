import { monitorEventLoopDelay } from "node:perf_hooks";
import type { Logger } from "../logging.js";

interface MemoryUsage {
  rss: number;
  heapUsed: number;
  heapTotal: number;
  external: number;
  arrayBuffers: number;
}

interface EventLoopDelay {
  readonly mean: number;
  readonly max: number;
  percentile(value: number): number;
  enable(): void;
  reset(): void;
  disable(): void;
}

export function startRuntimeStatsLogger(args: {
  logger: Logger;
  responsesPreflightPending: () => number;
  oauthRefreshQueueDepth: () => number;
  memoryUsage?: () => MemoryUsage;
  eventLoopDelay?: () => EventLoopDelay;
}) {
  const delay = (args.eventLoopDelay ?? (() => monitorEventLoopDelay({ resolution: 20 })))();
  const toMilliseconds = (nanoseconds: number) =>
    Number.isFinite(nanoseconds) ? nanoseconds / 1_000_000 : 0;
  delay.enable();
  const timer = setInterval(() => {
    const memory = (args.memoryUsage ?? process.memoryUsage)();
    args.logger.log("info", "runtime.stats", {
      rss_bytes: memory.rss,
      heap_used_bytes: memory.heapUsed,
      heap_total_bytes: memory.heapTotal,
      external_bytes: memory.external,
      array_buffers_bytes: memory.arrayBuffers,
      event_loop_delay_mean_ms: toMilliseconds(delay.mean),
      event_loop_delay_p99_ms: toMilliseconds(delay.percentile(99)),
      event_loop_delay_max_ms: toMilliseconds(delay.max),
      responses_preflight_pending: args.responsesPreflightPending(),
      oauth_refresh_queue_depth: args.oauthRefreshQueueDepth(),
    });
    delay.reset();
  }, 60_000);
  timer.unref();

  return {
    stop() {
      clearInterval(timer);
      delay.disable();
    },
  };
}
