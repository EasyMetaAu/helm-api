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
//
// `tzOffsetMinutes` is the CLIENT's UTC offset (east-positive minutes, e.g. UTC+8 =
// 480), sent by the admin browser as `-new Date().getTimezoneOffset()`. The store
// floors day/hour buckets in the client's LOCAL time with it, so a UTC+8 user's
// "daily" series breaks at local midnight instead of 08:00 local (00:00 UTC). It
// defaults to 0 (UTC bucketing = legacy behavior) and fails open to 0 on junk /
// fractional / out-of-range input — a malformed offset must degrade, never 5xx
// (principle 3). Bounds span the real-world range UTC-12 (-720) … UTC+14 (+840).

// Optional epoch-ms bound. Non-numeric / negative → undefined (route default).
const optionalEpochMs = z.coerce.number().int().nonnegative().optional().catch(undefined);

export const StatsQuerySchema = z.object({
  start: optionalEpochMs,
  end: optionalEpochMs,
  bucket: z.enum(["hour", "day"]).catch("day"),
  tzOffsetMinutes: z.coerce.number().int().min(-720).max(840).catch(0),
});

export type StatsQuery = z.infer<typeof StatsQuerySchema>;
