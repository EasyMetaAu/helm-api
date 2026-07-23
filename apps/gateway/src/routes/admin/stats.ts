import { StatsQuerySchema } from "@helm/shared";
import type { Hono } from "hono";
import type { AppEnv } from "../../app.js";
import type { AdminApiDeps } from "./deps.js";
import { adminWindowCacheKey, createAdminReadCache } from "./read-cache.js";

// /admin/api/stats — dashboard token-accounting aggregate (TelemetryStore,
// READ-ONLY). Feeds the homepage token cards + the trend / by-model charts in ONE
// round-trip (TelemetryAggregate: totals + per-bucket series + per-model
// breakdown). Like the requests list, the query is parsed through the shared
// FAIL-OPEN schema: a malformed param (stale bookmark, hand-typed) coerces to a
// safe default rather than 5xx-ing a read endpoint (principle 3).

const DAY_MS = 86_400_000;

export function registerStatsRoutes(app: Hono<AppEnv>, deps: AdminApiDeps): void {
  const cache = createAdminReadCache<Awaited<ReturnType<typeof deps.telemetry.aggregate>>>({
    ...(deps.runInBackground !== undefined ? { runInBackground: deps.runInBackground } : {}),
  });
  // GET /stats?start&end&bucket&tzOffsetMinutes -> TelemetryAggregate. The window
  // defaults to the last 24h when start/end are omitted (a live dashboard cares
  // about recent traffic); bucket defaults to "day". `tzOffsetMinutes` (the admin
  // browser's UTC offset) floors buckets in the client's LOCAL day/hour — defaults
  // to 0 (UTC) when absent. The store does the SUM/GROUP BY in SQL.
  app.get("/admin/api/stats", async (c) => {
    const q = StatsQuerySchema.parse(c.req.query());
    const now = Date.now();
    const end = q.end ?? now;
    const start = q.start ?? end - DAY_MS;
    // `key_id`, when present, scopes the whole aggregate to one key (the detail
    // page); omitted = the global dashboard view.
    const key = adminWindowCacheKey({
      start,
      end,
      now,
      startWasDefault: q.start === undefined,
      endWasDefault: q.end === undefined,
      dimensions: [q.bucket, q.tzOffsetMinutes, q.key_id],
    });
    const result = await cache.get(key, () =>
      deps.telemetry.aggregate(start, end, q.bucket, q.tzOffsetMinutes, q.key_id),
    );
    c.header("X-Helm-Cache", result.status);
    return c.json(result.value);
  });
}
