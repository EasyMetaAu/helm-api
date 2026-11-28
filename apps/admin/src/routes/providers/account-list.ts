// One list for every upstream account on the Providers page: subscription logins,
// API key accounts and key-free connections share the same row shape, so filtering,
// sorting and the URL state are decided here once, as pure functions.

export type AccountKind = 'subscription' | 'key' | 'keyless';
export type StatusGroup = 'ok' | 'attention' | 'paused';
export type SortKey = 'priority' | 'name' | 'remaining' | 'used' | 'calls';
export type SortDir = 'asc' | 'desc';

export interface AccountListRow {
  id: string;
  kind: AccountKind;
  name: string;
  /** Lower is preferred. `null` for rows that take no part in scheduling. */
  priority: number | null;
  statusGroup: StatusGroup;
  /** Remaining share of the tightest quota window, 0–100; `null` when unknown. */
  remainingPercent: number | null;
  tokens: number;
  requests: number;
  searchText: string;
}

export interface ProviderListFilters {
  q: string;
  type: 'all' | AccountKind;
  status: 'all' | StatusGroup;
  sort: SortKey;
  dir: SortDir;
}

export const DEFAULT_PROVIDER_LIST_FILTERS: ProviderListFilters = {
  q: '',
  type: 'all',
  status: 'all',
  sort: 'priority',
  dir: 'asc',
};

const KINDS: readonly AccountKind[] = ['subscription', 'key', 'keyless'];
const GROUPS: readonly StatusGroup[] = ['ok', 'attention', 'paused'];
const SORTS: readonly SortKey[] = ['priority', 'name', 'remaining', 'used', 'calls'];

const oneOf = <T extends string>(values: readonly T[], raw: string | null): T | undefined =>
  values.find((value) => value === raw);

export function parseProviderListFilters(sp: URLSearchParams): ProviderListFilters {
  const d = DEFAULT_PROVIDER_LIST_FILTERS;
  return {
    q: sp.get('q')?.trim() ?? d.q,
    type: oneOf(KINDS, sp.get('type')) ?? d.type,
    status: oneOf(GROUPS, sp.get('status')) ?? d.status,
    sort: oneOf(SORTS, sp.get('sort')) ?? d.sort,
    dir: sp.get('dir') === 'desc' ? 'desc' : d.dir,
  };
}

export function providerListFiltersToSearch(f: ProviderListFilters): string {
  const qs = new URLSearchParams();
  const d = DEFAULT_PROVIDER_LIST_FILTERS;
  if (f.q.trim()) qs.set('q', f.q.trim());
  if (f.type !== d.type) qs.set('type', f.type);
  if (f.status !== d.status) qs.set('status', f.status);
  if (f.sort !== d.sort) qs.set('sort', f.sort);
  if (f.dir !== d.dir) qs.set('dir', f.dir);
  return qs.toString();
}

function sortValue(row: AccountListRow, key: SortKey): number | string | null {
  switch (key) {
    case 'priority':
      return row.priority;
    case 'name':
      return row.name.toLocaleLowerCase();
    case 'remaining':
      return row.remainingPercent;
    case 'used':
      return row.tokens;
    case 'calls':
      return row.requests;
  }
}

export function filterAndSortRows<T extends AccountListRow>(
  rows: T[],
  f: ProviderListFilters,
): T[] {
  const needle = f.q.trim().toLocaleLowerCase();
  const sign = f.dir === 'desc' ? -1 : 1;
  return rows
    .filter(
      (row) =>
        (f.type === 'all' || row.kind === f.type) &&
        (f.status === 'all' || row.statusGroup === f.status) &&
        (!needle || row.searchText.toLocaleLowerCase().includes(needle)),
    )
    .sort((a, b) => {
      const av = sortValue(a, f.sort);
      const bv = sortValue(b, f.sort);
      // Unknown values (no quota, no scheduling) always sink to the bottom.
      if (av !== bv) {
        if (av === null) return 1;
        if (bv === null) return -1;
        return (av < bv ? -1 : 1) * sign;
      }
      return a.name.localeCompare(b.name) || a.id.localeCompare(b.id);
    });
}

/** The quota window with the least room left — the one that limits the account first. */
export function mostConstrainedWindow<W extends { usedPercent: number }>(windows: W[]): W | null {
  let worst: W | null = null;
  for (const w of windows) {
    if (!Number.isFinite(w.usedPercent)) continue;
    if (worst === null || w.usedPercent > worst.usedPercent) worst = w;
  }
  return worst;
}
