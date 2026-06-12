import { z } from "zod";

// Query model for the admin dashboard token-accounting aggregate
// (GET /admin/api/stats). Like RequestsQuerySchema, this is a READ endpoint that
// must NEVER 5xx on a malformed querystring (a stale bookmark, a hand-typed param):
// every field is `.catch(...)` so a garbage value degrades to a safe default
// instead of throwing (principle 3 fail-open). Single source of truth via z.infer.
//
// `start`/`end` bound created_at as a half-open window [start, end) — mirroring
// RequestsQuerySchema + TelemetryStore.queryWindow. The route fills sensible
// defaults (last 24h) when they are omitted, so both are optional here. `bucket`
// chooses the time-series granularity (hour for short windows, day for long ones);
// it defaults to "day" and any junk value coerces to that default.

// Optional epoch-ms bound. Non-numeric / negative → undefined (route default).
const optionalEpochMs = z.coerce.number().int().nonnegative().optional().catch(undefined);

export const StatsQuerySchema = z.object({
  start: optionalEpochMs,
  end: optionalEpochMs,
  bucket: z.enum(["hour", "day"]).catch("day"),
});

export type StatsQuery = z.infer<typeof StatsQuerySchema>;
