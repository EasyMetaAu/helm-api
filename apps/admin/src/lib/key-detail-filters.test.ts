import { describe, expect, it } from 'vitest';
import {
  bucketForWindow,
  hasCustomRange,
  KEY_DETAIL_DEFAULT_RANGE,
  keyDetailFiltersToSearch,
  parseKeyDetailFilters,
  resolveKeyDetailWindow,
} from './key-detail-filters.js';

const sp = (q: string) => new URLSearchParams(q);

describe('key-detail-filters', () => {
  it('defaults to the today preset, page 1, no custom dates', () => {
    const f = parseKeyDetailFilters(sp(''));
    expect(f.range).toBe(KEY_DETAIL_DEFAULT_RANGE);
    expect(f.page).toBe(1);
    expect(f.startDate).toBeUndefined();
    expect(f.endDate).toBeUndefined();
    expect(hasCustomRange(f)).toBe(false);
  });

  it('parses a valid preset, page, and custom dates; drops malformed dates', () => {
    const f = parseKeyDetailFilters(sp('range=7d&page=3'));
    expect(f.range).toBe('7d');
    expect(f.page).toBe(3);

    const c = parseKeyDetailFilters(sp('start=2026-06-01&end=2026-06-10'));
    expect(hasCustomRange(c)).toBe(true);

    const bad = parseKeyDetailFilters(sp('start=nope&end=2026-13-99'));
    expect(bad.startDate).toBeUndefined();
    expect(bad.endDate).toBeUndefined();
  });

  it('treats an inverted / half-filled custom range as not-custom', () => {
    expect(hasCustomRange(parseKeyDetailFilters(sp('start=2026-06-10&end=2026-06-01')))).toBe(
      false,
    );
    expect(hasCustomRange(parseKeyDetailFilters(sp('start=2026-06-01')))).toBe(false);
  });

  it('serializes clean URLs: custom dates win over the preset; defaults omitted', () => {
    expect(keyDetailFiltersToSearch({ range: 'today', page: 1 })).toBe('');
    expect(keyDetailFiltersToSearch({ range: '7d', page: 2 })).toBe('range=7d&page=2');
    // Custom range present → preset dropped, dates serialized.
    expect(
      keyDetailFiltersToSearch({
        range: '7d',
        startDate: '2026-06-01',
        endDate: '2026-06-10',
        page: 1,
      }),
    ).toBe('start=2026-06-01&end=2026-06-10');
  });

  it('resolves a custom window as [midnight(start), midnight(end)+1day)', () => {
    const w = resolveKeyDetailWindow(
      { range: '24h', startDate: '2026-06-01', endDate: '2026-06-01', page: 1 },
      0,
    );
    // A single-day custom range spans exactly that local day (24h, the end day included).
    const start = new Date('2026-06-01T00:00:00').getTime();
    const end = new Date('2026-06-02T00:00:00').getTime();
    expect(w).toEqual({ start, end });
  });

  it('resolves preset windows with an explicit end of now (all → from 0)', () => {
    const now = 10 * 86_400_000;
    expect(resolveKeyDetailWindow({ range: '24h', page: 1 }, now)).toEqual({
      start: now - 86_400_000,
      end: now,
    });
    expect(resolveKeyDetailWindow({ range: 'all', page: 1 }, now)).toEqual({ start: 0, end: now });
  });

  it('honors a closed preset end so yesterday does not bleed into today', () => {
    const now = new Date('2026-06-01T15:30:00').getTime();
    const start = new Date('2026-05-31T00:00:00').getTime();
    const end = new Date('2026-06-01T00:00:00').getTime();
    expect(resolveKeyDetailWindow({ range: 'yesterday', page: 1 }, now)).toEqual({ start, end });
  });

  it('buckets short windows hourly, long windows daily', () => {
    const base = 100 * 86_400_000;
    expect(bucketForWindow(base, base + 86_400_000)).toBe('hour'); // 1 day
    expect(bucketForWindow(base, base + 7 * 86_400_000)).toBe('day'); // 7 days
  });
});
