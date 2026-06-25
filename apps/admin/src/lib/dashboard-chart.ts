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

// Day-level baseline for the "today" delta: yesterday's WHOLE calendar day
// (local midnight to local midnight). Today-so-far is compared against
// yesterday's full-day total — a plain day-over-day pace read, no hour-of-day
// alignment. A full-day baseline is large and stable, so early-morning deltas
// read low-and-climbing ("we're at 10% of yesterday") instead of noisy.
// DST: both midnights via local Date math.
export function resolveTodayComparisonWindow(nowMs: number): { start: number; end: number } {
  const todayMidnight = new Date(nowMs);
  todayMidnight.setHours(0, 0, 0, 0);
  const end = todayMidnight.getTime();
  const yMidnight = new Date(end);
  yMidnight.setDate(yMidnight.getDate() - 1);
  return { start: yMidnight.getTime(), end };
}

// Day-level baseline for the "yesterday" delta: the WHOLE calendar day BEFORE
// yesterday (local midnight to local midnight). Unlike the today view (today-
// so-far vs yesterday-full-day, a pace read), yesterday is already a COMPLETE
// day, so this is an honest full-day-vs-full-day comparison — the reason it's
// more meaningful than today-vs-yesterday mid-day (today isn't over yet).
// DST: both midnights via local Date math.
export function resolveYesterdayComparisonWindow(nowMs: number): { start: number; end: number } {
  const yesterdayMidnight = new Date(nowMs);
  yesterdayMidnight.setHours(0, 0, 0, 0);
  yesterdayMidnight.setDate(yesterdayMidnight.getDate() - 1); // yesterday 00:00 — window end
  const end = yesterdayMidnight.getTime();
  const dayBeforeMidnight = new Date(end);
  dayBeforeMidnight.setDate(dayBeforeMidnight.getDate() - 1); // day-before-yesterday 00:00
  return { start: dayBeforeMidnight.getTime(), end };
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
