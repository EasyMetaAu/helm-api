import { describe, expect, it } from 'vitest';
import {
  DEFAULT_FILTERS,
  filtersToSearch,
  parseFilters,
  resolveWindow,
} from './requests-filters.js';

describe('parseFilters', () => {
  it('returns defaults for an empty querystring', () => {
    expect(parseFilters(new URLSearchParams())).toEqual(DEFAULT_FILTERS);
  });

  it('reads a full filter set', () => {
    const sp = new URLSearchParams(
      'range=7d&status=error&decided_by=eval&lane=premium&model=gpt-4o&page=3',
    );
    expect(parseFilters(sp)).toEqual({
      range: '7d',
      status: 'error',
      decidedBy: 'eval',
      lane: 'premium',
      model: 'gpt-4o',
      page: 3,
    });
  });

  it('drops invalid enum values and clamps page', () => {
    const sp = new URLSearchParams('range=bogus&status=nope&decided_by=nope&page=0');
    expect(parseFilters(sp)).toEqual(DEFAULT_FILTERS);
    expect(parseFilters(new URLSearchParams('page=-4')).page).toBe(1);
  });
});

describe('filtersToSearch', () => {
  it('omits defaults so clean URLs stay clean', () => {
    expect(filtersToSearch(DEFAULT_FILTERS)).toBe('');
    expect(filtersToSearch({ range: 'all', page: 1, lane: '   ' })).toBe('');
  });

  it('round-trips through parseFilters', () => {
    const f = {
      range: '30d',
      status: 'ok',
      decidedBy: 'rules',
      lane: 'balanced',
      model: 'claude',
      page: 5,
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
});
