import { describe, expect, it } from 'vitest';
import {
  DEFAULT_FILTERS,
  filtersToSearch,
  parseFilters,
  parseRange,
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

  it('defaults the range to 24h (not all) for a clean URL', () => {
    expect(parseFilters(new URLSearchParams()).range).toBe('24h');
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
    expect(filtersToSearch({ range: '24h', page: 1, pageSize: 50, lane: '   ' })).toBe('');
  });

  it('writes range=all explicitly since 24h is now the default', () => {
    expect(filtersToSearch({ range: 'all', page: 1, pageSize: 50 })).toBe('range=all');
  });

  it('writes a non-default page size', () => {
    expect(filtersToSearch({ range: '24h', page: 1, pageSize: 100 })).toBe('pageSize=100');
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

describe('resolveWindow', () => {
  const now = new Date('2026-06-01T15:30:00').getTime();

  it('all → unbounded', () => {
    expect(resolveWindow('all', now)).toEqual({});
  });

  it('today → since local midnight, open end', () => {
    const midnight = new Date('2026-06-01T00:00:00').getTime();
    expect(resolveWindow('today', now)).toEqual({ start: midnight });
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
