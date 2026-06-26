// Filter state for the API-key detail page, kept in the URL so the view is
// shareable, back-button friendly, and survives a reload. Two ways to pick the
// window (the issue's "by duration" + "by day"):
//   • a preset RANGE (1h/6h/24h/7d/30d/today/all) — the shared RangeFilter; OR
//   • a CUSTOM date range (startDate..endDate, inclusive calendar days).
// A valid custom range takes precedence over the preset. Pure functions only (no
// framework, no Date.now in the resolvers) so the window math + parse/serialize
// round-trip are unit-testable.

import {
  isValidDateParam,
  RANGE_KEYS,
  type RangeKey,
  resolveCustomDayWindow,
  resolveWindow,
} from './requests-filters.js';

// The preset↔custom window math now lives in requests-filters (shared with the
// dashboard + request list). Re-exported here so this module stays the one import
// for the key-detail page's filter API.
export { bucketForWindow } from './requests-filters.js';

export const KEY_DETAIL_DEFAULT_RANGE: RangeKey = 'today';

export interface KeyDetailFilters {
  range: RangeKey; // preset; ignored while a valid custom range is set
  startDate?: string; // 'YYYY-MM-DD' inclusive (custom mode)
  endDate?: string; // 'YYYY-MM-DD' inclusive (custom mode)
  page: number; // request-list page (1-based)
}

function isRange(v: string | null): v is RangeKey {
  return v !== null && (RANGE_KEYS as readonly string[]).includes(v);
}

// A custom range is active only when BOTH dates form a valid, ordered window. An
// inverted / half-filled range falls back to the preset (never throws).
export function hasCustomRange(f: KeyDetailFilters): boolean {
  return Boolean(f.startDate && f.endDate && resolveCustomDayWindow(f.startDate, f.endDate));
}

export function parseKeyDetailFilters(sp: URLSearchParams): KeyDetailFilters {
  const rangeRaw = sp.get('range');
  const startDate = sp.get('start')?.trim();
  const endDate = sp.get('end')?.trim();
  const pageRaw = Number(sp.get('page'));
  return {
    range: isRange(rangeRaw) ? rangeRaw : KEY_DETAIL_DEFAULT_RANGE,
    startDate: isValidDateParam(startDate) ? startDate : undefined,
    endDate: isValidDateParam(endDate) ? endDate : undefined,
    page: Number.isInteger(pageRaw) && pageRaw > 1 ? pageRaw : 1,
  };
}

// Serialize back to a querystring, omitting defaults so URLs stay clean. The
// custom dates win: when both are present the preset is dropped from the URL.
export function keyDetailFiltersToSearch(f: KeyDetailFilters): string {
  const qs = new URLSearchParams();
  if (hasCustomRange(f)) {
    qs.set('start', f.startDate as string);
    qs.set('end', f.endDate as string);
  } else if (f.range !== KEY_DETAIL_DEFAULT_RANGE) {
    qs.set('range', f.range);
  }
  if (f.page > 1) qs.set('page', String(f.page));
  return qs.toString();
}

// Resolve the active filters to an absolute half-open window [start, end) in epoch
// ms. Custom mode → local midnight(startDate) .. local midnight(endDate)+1 day
// (so the end day is INCLUDED). Preset mode → the rolling/today window with an
// explicit end of `now` ('all' → from 0). Always returns concrete bounds so both
// getStats (omitted start = last 24h) and listRequests get an unambiguous window.
export function resolveKeyDetailWindow(
  f: KeyDetailFilters,
  nowMs: number,
): { start: number; end: number } {
  if (f.startDate && f.endDate) {
    const custom = resolveCustomDayWindow(f.startDate, f.endDate);
    if (custom) return custom;
  }
  if (f.range === 'all') return { start: 0, end: nowMs };
  const w = resolveWindow(f.range, nowMs);
  // Honor a CLOSED preset end (yesterday) so it doesn't bleed into today; the
  // rolling/today presets leave end open → now.
  return { start: w.start ?? 0, end: w.end ?? nowMs };
}
