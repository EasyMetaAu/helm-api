import { describe, expect, it, vi } from 'vitest';
import {
  bucketForWindow,
  clientTzOffsetMinutes,
  DEFAULT_FILTERS,
  filtersToSearch,
  localMidnightMs,
  parseFilters,
  parseRange,
  resolveCustomDayWindow,
  resolveWindow,
} from './requests-filters.js';

describe('parseFilters', () => {
  it('returns defaults for an empty querystring', () => {
    expect(parseFilters(new URLSearchParams())).toEqual(DEFAULT_FILTERS);
  });

  it('reads a full filter set', () => {
    const sp = new URLSearchParams(
      'range=7d&status=error&decided_by=eval&lane=premium&model=gpt-4o&page=3&pageSize=100',
    );
    expect(parseFilters(sp)).toEqual({
      range: '7d',
      status: 'error',
      decidedBy: 'eval',
      lane: 'premium',
      model: 'gpt-4o',
      page: 3,
      pageSize: 100,
    });
  });

  it('drops invalid enum values and clamps page', () => {
    const sp = new URLSearchParams('range=bogus&status=nope&decided_by=nope&page=0');
    expect(parseFilters(sp)).toEqual(DEFAULT_FILTERS);
    expect(parseFilters(new URLSearchParams('page=-4')).page).toBe(1);
  });

  it('defaults the range to today (not all) for a clean URL', () => {
    expect(parseFilters(new URLSearchParams()).range).toBe('today');
    // 'all' is only reached when asked for explicitly.
    expect(parseFilters(new URLSearchParams('range=all')).range).toBe('all');
  });

  it('only accepts an offered page size, else the default', () => {
    expect(parseFilters(new URLSearchParams('pageSize=100')).pageSize).toBe(100);
    expect(parseFilters(new URLSearchParams('pageSize=70')).pageSize).toBe(
      DEFAULT_FILTERS.pageSize,
    );
    expect(parseFilters(new URLSearchParams('pageSize=junk')).pageSize).toBe(
      DEFAULT_FILTERS.pageSize,
    );
  });
});

describe('filtersToSearch', () => {
  it('omits defaults so clean URLs stay clean', () => {
    expect(filtersToSearch(DEFAULT_FILTERS)).toBe('');
    expect(filtersToSearch({ range: 'today', page: 1, pageSize: 50, lane: '   ' })).toBe('');
  });

  it('writes a non-default range explicitly since today is now the default', () => {
    expect(filtersToSearch({ range: 'all', page: 1, pageSize: 50 })).toBe('range=all');
    expect(filtersToSearch({ range: 'yesterday', page: 1, pageSize: 50 })).toBe('range=yesterday');
  });

  it('writes a non-default page size', () => {
    expect(filtersToSearch({ range: 'today', page: 1, pageSize: 100 })).toBe('pageSize=100');
  });

  it('round-trips through parseFilters', () => {
    const f = {
      range: '30d',
      status: 'ok',
      decidedBy: 'rules',
      lane: 'balanced',
      model: 'claude',
      page: 5,
      pageSize: 200,
    } as const;
    expect(parseFilters(new URLSearchParams(filtersToSearch(f)))).toEqual(f);
  });
});

describe('custom calendar-day range', () => {
  it('parses valid start/end date params', () => {
    const f = parseFilters(new URLSearchParams('start=2026-06-01&end=2026-06-03'));
    expect(f.startDate).toBe('2026-06-01');
    expect(f.endDate).toBe('2026-06-03');
  });

  it('drops malformed / non-real date params', () => {
    const f = parseFilters(new URLSearchParams('start=2026-06-31&end=nope'));
    expect(f.startDate).toBeUndefined();
    expect(f.endDate).toBeUndefined();
  });

  it('serializes a custom range and drops the preset (custom wins)', () => {
    expect(
      filtersToSearch({
        range: '7d',
        startDate: '2026-06-01',
        endDate: '2026-06-03',
        page: 1,
        pageSize: 50,
      }),
    ).toBe('start=2026-06-01&end=2026-06-03');
  });

  it('ignores a half-filled / inverted custom range (keeps the preset)', () => {
    expect(filtersToSearch({ range: '7d', startDate: '2026-06-01', page: 1, pageSize: 50 })).toBe(
      'range=7d',
    );
    expect(
      filtersToSearch({
        range: '7d',
        startDate: '2026-06-03',
        endDate: '2026-06-01',
        page: 1,
        pageSize: 50,
      }),
    ).toBe('range=7d');
  });

  it('round-trips a custom range (page preserved)', () => {
    const f = {
      range: 'today',
      startDate: '2026-06-01',
      endDate: '2026-06-03',
      page: 2,
      pageSize: 50,
    } as const;
    expect(parseFilters(new URLSearchParams(filtersToSearch(f)))).toEqual(f);
  });
});

describe('localMidnightMs', () => {
  it('parses a real calendar day to local midnight', () => {
    expect(localMidnightMs('2026-06-01')).toBe(new Date('2026-06-01T00:00:00').getTime());
  });

  it('rejects malformed shapes and rollover junk (never throws)', () => {
    expect(localMidnightMs('2026-6-1')).toBeNull();
    expect(localMidnightMs('2026-06-31')).toBeNull(); // June has 30 days
    expect(localMidnightMs('2026-13-01')).toBeNull();
    expect(localMidnightMs('nope')).toBeNull();
  });
});

describe('resolveCustomDayWindow', () => {
  it('spans midnight(start) .. midnight(end)+1day so the end day is included', () => {
    const start = new Date('2026-06-01T00:00:00').getTime();
    const end = new Date('2026-06-04T00:00:00').getTime(); // 06-03 inclusive
    expect(resolveCustomDayWindow('2026-06-01', '2026-06-03')).toEqual({ start, end });
  });

  it('a single day resolves to exactly that local day', () => {
    const start = new Date('2026-06-01T00:00:00').getTime();
    const end = new Date('2026-06-02T00:00:00').getTime();
    expect(resolveCustomDayWindow('2026-06-01', '2026-06-01')).toEqual({ start, end });
  });

  it('null on an inverted or invalid range', () => {
    expect(resolveCustomDayWindow('2026-06-03', '2026-06-01')).toBeNull();
    expect(resolveCustomDayWindow('2026-06-01', 'nope')).toBeNull();
  });
});

describe('bucketForWindow', () => {
  it('is hourly for spans ≤ 2 days, daily beyond', () => {
    const day = 86_400_000;
    expect(bucketForWindow(0, 2 * day)).toBe('hour');
    expect(bucketForWindow(0, 2 * day + 1)).toBe('day');
  });
});

describe('resolveWindow', () => {
  const now = new Date('2026-06-01T15:30:00').getTime();

  it('all → unbounded', () => {
    expect(resolveWindow('all', now)).toEqual({});
  });

  it('today → since local midnight, open end', () => {
    const midnight = new Date('2026-06-01T00:00:00').getTime();
    expect(resolveWindow('today', now)).toEqual({ start: midnight });
  });

  it('yesterday → the full previous local day, closed end', () => {
    const start = new Date('2026-05-31T00:00:00').getTime();
    const end = new Date('2026-06-01T00:00:00').getTime();
    expect(resolveWindow('yesterday', now)).toEqual({ start, end });
  });

  it('rolling windows are now − N days', () => {
    expect(resolveWindow('24h', now)).toEqual({ start: now - 86_400_000 });
    expect(resolveWindow('7d', now)).toEqual({ start: now - 7 * 86_400_000 });
    expect(resolveWindow('30d', now)).toEqual({ start: now - 30 * 86_400_000 });
  });

  it('sub-day rolling windows are now − N hours', () => {
    expect(resolveWindow('1h', now)).toEqual({ start: now - 3_600_000 });
    expect(resolveWindow('6h', now)).toEqual({ start: now - 6 * 3_600_000 });
  });
});

describe('parseRange', () => {
  it('returns a valid range as-is', () => {
    expect(parseRange('6h')).toBe('6h');
    expect(parseRange('30d')).toBe('30d');
  });

  it('falls back to the default for null / garbage (never throws)', () => {
    expect(parseRange(null)).toBe('all');
    expect(parseRange('bogus')).toBe('all');
    expect(parseRange('bogus', '24h')).toBe('24h');
  });
});

describe('clientTzOffsetMinutes', () => {
  // Robust against the CI timezone: mock getTimezoneOffset so the sign convention
  // (east-positive) is asserted regardless of where the suite runs.
  it('negates getTimezoneOffset to east-positive minutes (UTC+8 → +480)', () => {
    const spy = vi.spyOn(Date.prototype, 'getTimezoneOffset').mockReturnValue(-480);
    try {
      expect(clientTzOffsetMinutes()).toBe(480);
    } finally {
      spy.mockRestore();
    }
  });

  it('handles west-of-UTC and the UTC zero case', () => {
    const west = vi.spyOn(Date.prototype, 'getTimezoneOffset').mockReturnValue(300); // UTC-5
    expect(clientTzOffsetMinutes()).toBe(-300);
    west.mockReturnValue(0); // UTC
    expect(clientTzOffsetMinutes()).toBe(0);
    west.mockRestore();
  });
});
