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
// day so the x-axis answers "which date did this aggregate come from?"
export function trendBucketForRange(range: RangeKey): TrendBucket {
  return range === '1h' || range === '6h' || range === '24h' || range === 'today'
    ? 'hour'
    : 'day';
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
