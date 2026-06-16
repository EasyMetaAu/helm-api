import { StatsQuerySchema } from "@helm/shared";
import type { Hono } from "hono";
import type { AppEnv } from "../../app.js";
import type { AdminApiDeps } from "./deps.js";

// /admin/api/stats — dashboard token-accounting aggregate (TelemetryStore,
// READ-ONLY). Feeds the homepage token cards + the trend / by-model charts in ONE
// round-trip (TelemetryAggregate: totals + per-bucket series + per-model
// breakdown). Like the requests list, the query is parsed through the shared
// FAIL-OPEN schema: a malformed param (stale bookmark, hand-typed) coerces to a
// safe default rather than 5xx-ing a read endpoint (principle 3).

const DAY_MS = 86_400_000;

export function registerStatsRoutes(app: Hono<AppEnv>, deps: AdminApiDeps): void {
  // GET /stats?start&end&bucket&tzOffsetMinutes -> TelemetryAggregate. The window
  // defaults to the last 24h when start/end are omitted (a live dashboard cares
  // about recent traffic); bucket defaults to "day". `tzOffsetMinutes` (the admin
  // browser's UTC offset) floors buckets in the client's LOCAL day/hour — defaults
  // to 0 (UTC) when absent. The store does the SUM/GROUP BY in SQL.
  app.get("/admin/api/stats", async (c) => {
    const q = StatsQuerySchema.parse(c.req.query());
    const end = q.end ?? Date.now();
    const start = q.start ?? end - DAY_MS;
    const agg = await deps.telemetry.aggregate(start, end, q.bucket, q.tzOffsetMinutes);
    return c.json(agg);
  });
}
