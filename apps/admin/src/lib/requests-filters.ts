// Filter + pagination state for the request-debug list, kept in the URL
// querystring so views are shareable, back-button friendly, and survive a reload
// (the SPA loader re-reads them on every navigation). Pure functions only — no
// framework imports — so the date-window math and the parse/serialize round-trip
// are unit-testable.

import type { RequestListItem } from '$lib/api/requests.js';

// Date-range presets exposed in the UI. The window is resolved to absolute epoch
// ms in the loader (client-local time) so the gateway stays timezone-agnostic.
export const RANGE_KEYS = ['all', 'today', '1h', '6h', '24h', '7d', '30d'] as const;
export type RangeKey = (typeof RANGE_KEYS)[number];

// Rows-per-page choices offered by the list pager. The backend clamps to [1, 200]
// (REQUESTS_PAGE_SIZE_MAX), so 200 is the largest option; 50 is the default.
export const PAGE_SIZE_OPTIONS = [25, 50, 100, 200] as const;
export const DEFAULT_PAGE_SIZE = 50;

export interface RequestsFilters {
  range: RangeKey;
  status?: RequestListItem['status'];
  decidedBy?: RequestListItem['decided_by'];
  lane?: string;
  model?: string;
  page: number;
  pageSize: number;
}

// The list defaults to the last 24 hours (a live ops view cares about recent
// traffic) — NOT 'all'. So '24h' is the "clean URL" range (omitted from the query),
// and 'all' must be requested explicitly (?range=all).
export const DEFAULT_RANGE: RangeKey = '24h';

export const DEFAULT_FILTERS: RequestsFilters = {
  range: DEFAULT_RANGE,
  page: 1,
  pageSize: DEFAULT_PAGE_SIZE,
};

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const STATUSES = new Set<RequestListItem['status']>(['ok', 'error']);
const DECIDED_BY = new Set<RequestListItem['decided_by']>(['rules', 'eval', 'default', 'fallback']);

function isRange(v: string | null): v is RangeKey {
  return v !== null && (RANGE_KEYS as readonly string[]).includes(v);
}

// Validate a single `range` value (e.g. the homepage's date-range buttons, which
// carry only the range in the URL — no full filter set). Garbage / null degrades
// to `fallback` so a stale bookmark always renders.
export function parseRange(value: string | null, fallback: RangeKey = 'all'): RangeKey {
  return isRange(value) ? value : fallback;
}

// Read a validated filter state from the URL. Unknown/garbage values fall back to
// the default (the list must always render — never throw on a stale bookmark).
export function parseFilters(sp: URLSearchParams): RequestsFilters {
  const rangeRaw = sp.get('range');
  const status = sp.get('status');
  const decidedBy = sp.get('decided_by');
  const lane = sp.get('lane')?.trim();
  const model = sp.get('model')?.trim();
  const pageRaw = Number(sp.get('page'));
  const pageSizeRaw = Number(sp.get('pageSize'));
  return {
    range: isRange(rangeRaw) ? rangeRaw : DEFAULT_RANGE,
    status:
      status && STATUSES.has(status as RequestListItem['status'])
        ? (status as RequestListItem['status'])
        : undefined,
    decidedBy:
      decidedBy && DECIDED_BY.has(decidedBy as RequestListItem['decided_by'])
        ? (decidedBy as RequestListItem['decided_by'])
        : undefined,
    lane: lane || undefined,
    model: model || undefined,
    page: Number.isInteger(pageRaw) && pageRaw > 1 ? pageRaw : 1,
    // Only the offered sizes are accepted; anything else (junk, a hand-typed value)
    // degrades to the default so a stale bookmark always renders.
    pageSize: (PAGE_SIZE_OPTIONS as readonly number[]).includes(pageSizeRaw)
      ? pageSizeRaw
      : DEFAULT_PAGE_SIZE,
  };
}

// Serialize a filter state back to a querystring, omitting defaults so URLs stay
// clean (range=all, page=1, and empty filters are not written).
export function filtersToSearch(f: RequestsFilters): string {
  const qs = new URLSearchParams();
  if (f.range !== DEFAULT_RANGE) qs.set('range', f.range);
  if (f.status) qs.set('status', f.status);
  if (f.decidedBy) qs.set('decided_by', f.decidedBy);
  if (f.lane?.trim()) qs.set('lane', f.lane.trim());
  if (f.model?.trim()) qs.set('model', f.model.trim());
  if (f.page > 1) qs.set('page', String(f.page));
  if (f.pageSize && f.pageSize !== DEFAULT_PAGE_SIZE) qs.set('pageSize', String(f.pageSize));
  return qs.toString();
}

// Resolve a preset to an absolute half-open window [start, end) in epoch ms,
// using the client's local time. `today` is since local midnight; the rolling
// windows are now − N; `all` is unbounded. `end` is left open (undefined) so new
// requests arriving after the page loads are still included.
export function resolveWindow(range: RangeKey, nowMs: number): { start?: number; end?: number } {
  switch (range) {
    case 'all':
      return {};
    case 'today': {
      const d = new Date(nowMs);
      d.setHours(0, 0, 0, 0);
      return { start: d.getTime() };
    }
    case '1h':
      return { start: nowMs - HOUR_MS };
    case '6h':
      return { start: nowMs - 6 * HOUR_MS };
    case '24h':
      return { start: nowMs - DAY_MS };
    case '7d':
      return { start: nowMs - 7 * DAY_MS };
    case '30d':
      return { start: nowMs - 30 * DAY_MS };
  }
}
