import { describe, expect, it } from 'vitest';
import {
  type AccountListRow,
  DEFAULT_PROVIDER_LIST_FILTERS,
  familyOf,
  filterAndSortRows,
  mostConstrainedWindow,
  parseProviderListFilters,
  providerListFiltersToSearch,
} from './account-list';

const row = (over: Partial<AccountListRow> & { id: string }): AccountListRow => ({
  family: familyOf('other', over.id),
  kind: 'subscription',
  name: over.id,
  priority: 50,
  statusGroup: 'ok',
  remainingPercent: null,
  tokens: 0,
  requests: 0,
  searchText: over.id,
  ...over,
});

describe('provider account list', () => {
  it('groups accounts by provider family by default: Claude, then OpenAI, subscriptions before keys', () => {
    const rows = [
      row({ id: 'kimi-key', kind: 'key', family: familyOf('kimi', 'Kimi') }),
      row({ id: 'openai-key', kind: 'key', family: familyOf('openai', 'OpenAI') }),
      row({
        id: 'zenmux-claude',
        kind: 'key',
        family: familyOf('zenmux-anthropic', 'zenmux-anthropic'),
      }),
      row({
        id: 'codex-a',
        kind: 'subscription',
        family: familyOf('openai-codex', 'ChatGPT Plus/Pro (Codex)'),
      }),
      row({ id: 'claude-api', kind: 'key', family: familyOf('anthropic-api', 'Claude') }),
      row({ id: 'bailian', kind: 'key', family: familyOf('bailian', 'bailian') }),
      row({
        id: 'claude-sub',
        kind: 'subscription',
        family: familyOf('anthropic', 'Anthropic (Claude Pro/Max)'),
      }),
      row({ id: 'gemini', kind: 'key', family: familyOf('zenmux-vertex', 'zenmux-vertex') }),
    ];
    expect(filterAndSortRows(rows, DEFAULT_PROVIDER_LIST_FILTERS).map((r) => r.id)).toEqual([
      'claude-sub',
      'claude-api',
      'zenmux-claude',
      'codex-a',
      'openai-key',
      'gemini',
      'kimi-key',
      'bailian',
    ]);
    expect(familyOf('anthropic', 'x').label).toBe('Claude');
    expect(familyOf('openai-responses', 'x').label).toBe('OpenAI');
  });

  it('sorts subscription and API key accounts together by priority, then name', () => {
    const rows = [
      row({ id: 'codex-b', kind: 'subscription', priority: 30 }),
      row({ id: 'openai-key', kind: 'key', priority: 20 }),
      row({ id: 'codex-a', kind: 'subscription', priority: 10 }),
      row({ id: 'local', kind: 'keyless', priority: null }),
      row({ id: 'aaa-key', kind: 'key', priority: 20 }),
    ];
    expect(
      filterAndSortRows(rows, { ...DEFAULT_PROVIDER_LIST_FILTERS, sort: 'priority' }).map(
        (r) => r.id,
      ),
    ).toEqual(['codex-a', 'aaa-key', 'openai-key', 'codex-b', 'local']);
  });

  it('filters by type, status and search text', () => {
    const rows = [
      row({ id: 'a', kind: 'subscription', statusGroup: 'attention', searchText: 'Claude max' }),
      row({ id: 'b', kind: 'key', statusGroup: 'ok', searchText: 'deepseek' }),
      row({ id: 'c', kind: 'key', statusGroup: 'paused', searchText: 'OpenAI' }),
    ];
    const base = DEFAULT_PROVIDER_LIST_FILTERS;
    expect(filterAndSortRows(rows, { ...base, type: 'key' }).map((r) => r.id)).toEqual(['b', 'c']);
    expect(filterAndSortRows(rows, { ...base, status: 'attention' }).map((r) => r.id)).toEqual([
      'a',
    ]);
    expect(filterAndSortRows(rows, { ...base, q: ' openai ' }).map((r) => r.id)).toEqual(['c']);
  });

  it('sorts by remaining quota with unknown values last in both directions', () => {
    const rows = [
      row({ id: 'none', remainingPercent: null }),
      row({ id: 'low', remainingPercent: 5 }),
      row({ id: 'high', remainingPercent: 90 }),
    ];
    const f = DEFAULT_PROVIDER_LIST_FILTERS;
    expect(filterAndSortRows(rows, { ...f, sort: 'remaining' }).map((r) => r.id)).toEqual([
      'low',
      'high',
      'none',
    ]);
    expect(
      filterAndSortRows(rows, { ...f, sort: 'remaining', dir: 'desc' }).map((r) => r.id),
    ).toEqual(['high', 'low', 'none']);
  });

  it('round-trips filters through the URL and omits defaults', () => {
    expect(providerListFiltersToSearch(DEFAULT_PROVIDER_LIST_FILTERS)).toBe('');
    const f = { q: 'codex', type: 'subscription', status: 'attention', sort: 'calls', dir: 'desc' };
    expect(DEFAULT_PROVIDER_LIST_FILTERS.sort).toBe('group');
    const qs = providerListFiltersToSearch(f as typeof DEFAULT_PROVIDER_LIST_FILTERS);
    expect(parseProviderListFilters(new URLSearchParams(qs))).toEqual(f);
  });

  it('ignores unknown URL values instead of failing', () => {
    expect(parseProviderListFilters(new URLSearchParams('type=x&status=y&sort=z&dir=up'))).toEqual(
      DEFAULT_PROVIDER_LIST_FILTERS,
    );
  });

  it('picks the quota window with the least room left', () => {
    expect(
      mostConstrainedWindow([
        { key: '5h', usedPercent: 8 },
        { key: '7d', usedPercent: 84 },
        { key: '7d-fable', usedPercent: 0 },
      ])?.key,
    ).toBe('7d');
    expect(mostConstrainedWindow([])).toBeNull();
  });
});
