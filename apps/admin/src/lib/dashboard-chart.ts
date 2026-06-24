import { resolveWindow, type RangeKey } from './requests-filters.js';

export type TrendBucket = 'hour' | 'day';
export type TrendPointLike = { date: Date };

// Stats endpoint semantics differ from the request list: omitted bounds mean
// "last 24h" there, so the all-time dashboard must send an explicit lower bound.
export function resolveStatsWindow(
  range: RangeKey,
  nowMs: number,
): { start?: number; end?: number } {
  return range === 'all' ? { start: 0, end: nowMs } : resolveWindow(range, nowMs);
}

// Short windows want hourly shape; longer/all-time windows should be summarized by
// day so the x-axis answers "which date did this aggregate come from?" A single
// calendar day (today/yesterday) reads best hour-bucketed.
export function trendBucketForRange(range: RangeKey): TrendBucket {
  return range === '1h' ||
    range === '6h' ||
    range === '24h' ||
    range === 'today' ||
    range === 'yesterday'
    ? 'hour'
    : 'day';
}

// Same-time-yesterday baseline for the "today" delta: yesterday from local
// midnight up to the SAME elapsed offset as today-so-far. Comparing a partial day
// against a full one would always read as a drop, so we cut yesterday at the same
// point in the day. DST: yesterday midnight via setDate; the elapsed offset is
// added as flat ms (a DST jump shifts the cutoff by ≤1h — fine for a glance).
export function resolveTodayComparisonWindow(nowMs: number): { start: number; end: number } {
  const d = new Date(nowMs);
  d.setHours(0, 0, 0, 0);
  const elapsed = nowMs - d.getTime();
  d.setDate(d.getDate() - 1);
  const start = d.getTime();
  return { start, end: start + elapsed };
}

// Percentage change current-vs-baseline, rounded. null when there is no baseline
// (yesterday had zero) — an honest "no comparison" instead of a fake +∞/+100%.
export function pctDelta(current: number, baseline: number): number | null {
  if (!(baseline > 0)) return null;
  return Math.round(((current - baseline) / baseline) * 100);
}

export function trendAxisTicks<T extends TrendPointLike>(
  points: readonly T[],
  maxTicks = 7,
): Date[] {
  const ticks = points.map((p) => p.date).filter((d) => !Number.isNaN(d.getTime()));
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
    bucket === 'day'
      ? { month: 'numeric', day: 'numeric' }
      : { hour: 'numeric', minute: '2-digit' };
  if (timeZone) options.timeZone = timeZone;
  return bucket === 'day'
    ? date.toLocaleDateString(locale, options)
    : date.toLocaleTimeString(locale, options);
}
