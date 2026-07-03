import type { TelemetryStore } from "@helm/core";
import { StatsQuerySchema } from "@helm/shared";
import type { Hono } from "hono";
import type { AppEnv } from "../app.js";

export interface UsageStatsRouteDeps {
  telemetry: Pick<TelemetryStore, "aggregate">;
  now?: () => number;
}

export function registerUsageStatsRoute(app: Hono<AppEnv>, deps: UsageStatsRouteDeps): void {
  app.get("/v1/usage/stats", async (c) => {
    const q = StatsQuerySchema.parse(c.req.query());
    const identity = c.get("identity");
    const end = q.end ?? deps.now?.() ?? Date.now();
    const start = q.start ?? 0;
    const agg = await deps.telemetry.aggregate(
      start,
      end,
      q.bucket,
      q.tzOffsetMinutes,
      identity.keyId,
    );
    const totals = agg.totals;
    const promptTokens = totals.promptTokens;
    const completionTokens = totals.completionTokens;

    return c.json(
      {
        object: "usage_stats",
        api_key_id: identity.keyId,
        range: {
          start_ms: start,
          end_ms: end,
          bucket: q.bucket,
          tz_offset_minutes: q.tzOffsetMinutes,
        },
        totals: {
          requests: totals.requests,
          ok_count: totals.okCount,
          error_count: totals.errorCount,
          prompt_tokens: promptTokens,
          completion_tokens: completionTokens,
          total_tokens: promptTokens + completionTokens,
          cached_tokens: totals.cachedTokens,
          cache_creation_tokens: totals.cacheCreationTokens,
          cost_usd: totals.totalCostUsd ?? 0,
        },
      },
      200,
    );
  });
}
