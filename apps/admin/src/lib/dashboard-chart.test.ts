import { describe, expect, it } from 'vitest';
import {
  formatTrendTick,
  pctDelta,
  resolveStatsWindow,
  resolveTodayComparisonWindow,
  trendAxisTicks,
  trendBucketForRange,
} from './dashboard-chart.js';

const DAY = 86_400_000;
const HOUR = 3_600_000;

const point = (ms: number) => ({ date: new Date(ms), input: 1, output: 0, cached: 0 });

describe('dashboard chart helpers', () => {
  it('uses daily aggregation for the all-time dashboard range', () => {
    expect(trendBucketForRange('all')).toBe('day');
  });

  it('sends an explicit full-history stats window for all-time instead of triggering the API default', () => {
    const now = Date.UTC(2026, 5, 17, 12);

    expect(resolveStatsWindow('all', now)).toEqual({ start: 0, end: now });
  });

  it('pins the x-axis to actual daily aggregate buckets instead of auto intra-day ticks', () => {
    const ticks = trendAxisTicks([point(Date.UTC(2026, 5, 16)), point(Date.UTC(2026, 5, 17))]);

    expect(ticks.map((d) => d.toISOString())).toEqual([
      '2026-06-16T00:00:00.000Z',
      '2026-06-17T00:00:00.000Z',
    ]);
  });

  it('thins long bucket lists while keeping the first and last bucket visible', () => {
    const ticks = trendAxisTicks(
      Array.from({ length: 31 }, (_, i) => point(Date.UTC(2026, 4, 1) + i * DAY)),
      7,
    );

    expect(ticks).toHaveLength(7);
    expect(ticks[0]?.toISOString()).toBe('2026-05-01T00:00:00.000Z');
    expect(ticks.at(-1)?.toISOString()).toBe('2026-05-31T00:00:00.000Z');
  });

  it('formats daily ticks as dates and hourly ticks as times', () => {
    const date = new Date(Date.UTC(2026, 5, 16, 13));

    expect(formatTrendTick(date, 'day', 'en-US', 'UTC')).toBe('6/16');
    expect(formatTrendTick(date, 'hour', 'en-US', 'UTC')).toBe('1:00 PM');
  });

  it('keeps hourly dashboard ranges hourly', () => {
    expect(trendBucketForRange('1h')).toBe('hour');
    expect(trendBucketForRange('6h')).toBe('hour');
    expect(trendBucketForRange('24h')).toBe('hour');
    expect(trendBucketForRange('today')).toBe('hour');
    expect(trendBucketForRange('yesterday')).toBe('hour');
    expect(trendAxisTicks([point(0), point(HOUR)]).map((d) => d.getTime())).toEqual([0, HOUR]);
  });
});

describe('today vs yesterday comparison', () => {
  it("baselines against yesterday's whole calendar day (local midnight to midnight)", () => {
    const now = new Date('2026-06-01T15:30:00').getTime();
    const yMidnight = new Date('2026-05-31T00:00:00').getTime();
    const todayMidnight = new Date('2026-06-01T00:00:00').getTime();
    // Day-over-day: the baseline is all of yesterday, regardless of time-of-day.
    expect(resolveTodayComparisonWindow(now)).toEqual({
      start: yMidnight,
      end: todayMidnight,
    });
  });

  it('pctDelta rounds the percentage change; null when there is no baseline', () => {
    expect(pctDelta(120, 100)).toBe(20);
    expect(pctDelta(80, 100)).toBe(-20);
    expect(pctDelta(5, 0)).toBeNull(); // no traffic yesterday → no honest delta
    expect(pctDelta(0, 0)).toBeNull();
  });
});
