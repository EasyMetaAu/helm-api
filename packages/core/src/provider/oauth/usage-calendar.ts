import type { OAuthUsageBucket, OAuthUsagePeriod } from "@helm/shared";

const DAY_MS = 86_400_000;
const MINUTE_MS = 60_000;

export type CalendarGranularity = "day" | "week";

// Floor an epoch-ms to the start of its LOCAL natural day or week. `offsetMs` is the
// admin's tz offset in ms (UTC+8 = +480min). We shift into local time, floor there,
// then shift back to a UTC instant. Week = Monday 00:00 local (the Unix epoch, a
// Thursday, is day-index 4, so we subtract 3 days to reach the Monday of its week).
function floorToCalendar(ms: number, offsetMs: number, granularity: CalendarGranularity): number {
  const local = ms + offsetMs;
  if (granularity === "day") {
    const localDayStart = local - (((local % DAY_MS) + DAY_MS) % DAY_MS);
    return localDayStart - offsetMs;
  }
  // week: index-of-week-day for the LOCAL day, Monday = 0.
  const localDay = Math.floor(local / DAY_MS);
  const weekday = (((localDay - 4) % 7) + 7) % 7; // epoch (localDay 0) is Thursday = 3 from Mon
  const localWeekStart = (localDay - weekday) * DAY_MS;
  return localWeekStart - offsetMs;
}

// Calendar period length. DST is out of scope — the offset is a fixed constant for a
// given request, so a day is always 24h and a week 7×24h.
function periodLength(granularity: CalendarGranularity): number {
  return granularity === "day" ? DAY_MS : 7 * DAY_MS;
}

// Aggregate raw hour buckets into NATURAL calendar day/week periods in the admin's
// local timezone. Unlike reset-period reconstruction, calendar boundaries are exact
// and require no resetsAtMs / approximation. Cost is null-aware (null only when every
// bucket in the period is unpriced). Result is most-recent first.
export function aggregateByCalendar(
  buckets: OAuthUsageBucket[],
  tzOffsetMinutes: number,
  granularity: CalendarGranularity,
): OAuthUsagePeriod[] {
  const offsetMs = tzOffsetMinutes * MINUTE_MS;
  const byStart = new Map<
    number,
    { requests: number; tokens: number; cost: number; anyPriced: boolean }
  >();
  for (const b of buckets) {
    const start = floorToCalendar(b.bucketMs, offsetMs, granularity);
    const agg = byStart.get(start) ?? { requests: 0, tokens: 0, cost: 0, anyPriced: false };
    agg.requests += b.requests;
    agg.tokens += b.tokens;
    if (b.costUsd !== null) {
      agg.cost += b.costUsd;
      agg.anyPriced = true;
    }
    byStart.set(start, agg);
  }
  return [...byStart.entries()]
    .sort((a, b) => b[0] - a[0]) // most recent first
    .map(([startMs, agg]) => ({
      windowKey: granularity, // "day" | "week" — a synthetic key, not a quota window
      periodStartMs: startMs,
      periodEndMs: startMs + periodLength(granularity),
      requests: agg.requests,
      tokens: agg.tokens,
      costUsd: agg.anyPriced ? agg.cost : null,
      approximate: false, // calendar boundaries are exact
      partial: false, // caller marks the oldest as partial if it precedes retained data
    }));
}
