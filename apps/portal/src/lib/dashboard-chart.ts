// Trend-chart axis helpers (portal subset of the admin dashboard-chart). Only the
// two functions the Overview chart needs — self-contained, no requests-filters dep.
export type TrendBucket = "hour" | "day";
export type TrendPointLike = { date: Date };

export function resolveTodayWindow(nowMs: number): {
  start: number;
  end: number;
} {
  const start = new Date(nowMs);
  start.setHours(0, 0, 0, 0);
  return { start: start.getTime(), end: nowMs };
}

export function resolveYesterdayWindow(nowMs: number): {
  start: number;
  end: number;
} {
  const today = new Date(nowMs);
  today.setHours(0, 0, 0, 0);
  const end = today.getTime();
  today.setDate(today.getDate() - 1);
  return { start: today.getTime(), end };
}

export function pctDelta(current: number, baseline: number): number | null {
  if (!(baseline > 0)) return null;
  return Math.round(((current - baseline) / baseline) * 100);
}

// Thin a bucket series down to at most `maxTicks` axis ticks, always keeping the
// last point so the axis ends on "now".
export function trendAxisTicks<T extends TrendPointLike>(
  points: readonly T[],
  maxTicks = 7,
): Date[] {
  const ticks = points
    .map((p) => p.date)
    .filter((d) => !Number.isNaN(d.getTime()));
  if (ticks.length <= maxTicks) return ticks;

  const last = ticks.length - 1;
  const step = Math.ceil(last / (maxTicks - 1));
  const thinned = ticks.filter((_, i) => i % step === 0);
  const tail = ticks[last];
  if (tail && thinned.at(-1)?.getTime() !== tail.getTime()) thinned.push(tail);
  return thinned;
}

export function formatTrendTick(
  date: Date,
  bucket: TrendBucket,
  locale?: string | string[],
  timeZone?: string,
): string {
  const options: Intl.DateTimeFormatOptions =
    bucket === "day"
      ? { month: "numeric", day: "numeric" }
      : { hour: "numeric", minute: "2-digit" };
  if (timeZone) options.timeZone = timeZone;
  return bucket === "day"
    ? date.toLocaleDateString(locale, options)
    : date.toLocaleTimeString(locale, options);
}
