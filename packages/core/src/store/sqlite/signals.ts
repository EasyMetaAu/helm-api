import { type RoutingSignal, RoutingSignalSchema } from "@helm/shared";
import { and, eq } from "drizzle-orm";
import type { SignalStore } from "../ports.js";
import type { SqliteDb } from "./migrate.js";
import { routingSignals } from "./schema.js";

type SignalRow = typeof routingSignals.$inferSelect;

// SQLite adapter for the SignalStore port (POST-MVP Agentic Signals, docs/02).
// One row per (task_type, lane); `upsertSignals` overwrites via PRIMARY KEY so
// re-collecting a window never double-counts. Stores ONLY aggregate dimensions —
// no key/payload column (principle 7). This adapter is written off the request
// path by the background collector and (this task) read by nobody on the route.
export class SqliteSignalStore implements SignalStore {
  constructor(private readonly db: SqliteDb) {}

  async upsertSignals(signals: readonly RoutingSignal[]): Promise<void> {
    if (signals.length === 0) return;
    const rows = signals.map((s) => ({
      taskType: s.taskType,
      lane: s.lane,
      windowStart: s.windowStart,
      windowEnd: s.windowEnd,
      samples: s.samples,
      successRate: s.successRate,
      fallbackRate: s.fallbackRate,
      classifierFallbackRate: s.classifierFallbackRate,
      errorRate: s.errorRate,
      p50LatencyMs: s.p50LatencyMs,
      p95LatencyMs: s.p95LatencyMs,
      avgCostUsd: s.avgCostUsd,
      updatedAt: s.updatedAt,
    }));
    this.db.transaction((tx) => {
      for (const row of rows) {
        tx.insert(routingSignals)
          .values(row)
          .onConflictDoUpdate({
            target: [routingSignals.taskType, routingSignals.lane],
            set: {
              windowStart: row.windowStart,
              windowEnd: row.windowEnd,
              samples: row.samples,
              successRate: row.successRate,
              fallbackRate: row.fallbackRate,
              classifierFallbackRate: row.classifierFallbackRate,
              errorRate: row.errorRate,
              p50LatencyMs: row.p50LatencyMs,
              p95LatencyMs: row.p95LatencyMs,
              avgCostUsd: row.avgCostUsd,
              updatedAt: row.updatedAt,
            },
          })
          .run();
      }
    });
  }

  async getSignal(taskType: string, lane: string): Promise<RoutingSignal | null> {
    const row = this.db
      .select()
      .from(routingSignals)
      .where(and(eq(routingSignals.taskType, taskType), eq(routingSignals.lane, lane)))
      .get();
    return row ? this.toSignal(row) : null;
  }

  // Row -> RoutingSignal. Re-validates through the shared schema so a corrupted
  // row surfaces loudly rather than leaking a malformed shape.
  private toSignal(row: SignalRow): RoutingSignal {
    return RoutingSignalSchema.parse({
      taskType: row.taskType,
      lane: row.lane,
      windowStart: row.windowStart,
      windowEnd: row.windowEnd,
      samples: row.samples,
      successRate: row.successRate,
      fallbackRate: row.fallbackRate,
      classifierFallbackRate: row.classifierFallbackRate,
      errorRate: row.errorRate,
      p50LatencyMs: row.p50LatencyMs,
      p95LatencyMs: row.p95LatencyMs,
      avgCostUsd: row.avgCostUsd,
      updatedAt: row.updatedAt,
    });
  }
}
