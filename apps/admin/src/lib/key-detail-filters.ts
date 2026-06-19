// Filter state for the API-key detail page, kept in the URL so the view is
// shareable, back-button friendly, and survives a reload. Two ways to pick the
// window (the issue's "by duration" + "by day"):
//   • a preset RANGE (1h/6h/24h/7d/30d/today/all) — the shared RangeFilter; OR
//   • a CUSTOM date range (startDate..endDate, inclusive calendar days).
// A valid custom range takes precedence over the preset. Pure functions only (no
// framework, no Date.now in the resolvers) so the window math + parse/serialize
// round-trip are unit-testable.

import { RANGE_KEYS, type RangeKey, resolveWindow } from './requests-filters.js';

export const KEY_DETAIL_DEFAULT_RANGE: RangeKey = '24h';

const DAY_MS = 86_400_000;
// A 2-day window or shorter reads better hour-bucketed; longer → day buckets.
const HOURLY_MAX_SPAN_MS = 2 * DAY_MS;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export interface KeyDetailFilters {
  range: RangeKey; // preset; ignored while a valid custom range is set
  startDate?: string; // 'YYYY-MM-DD' inclusive (custom mode)
  endDate?: string; // 'YYYY-MM-DD' inclusive (custom mode)
  page: number; // request-list page (1-based)
}

function isRange(v: string | null): v is RangeKey {
  return v !== null && (RANGE_KEYS as readonly string[]).includes(v);
}

// Local-midnight epoch ms for a 'YYYY-MM-DD' (parsed in the viewer's zone, like
// the rest of the admin). Returns null when the shape is wrong OR the value is not
// a real calendar day — including rollover junk like 2026-06-31 / 2026-13-99 (the
// parsed Y-M-D must match the input, so an out-of-range component is rejected, not
// silently rolled into the next month).
function localMidnightMs(date: string): number | null {
  if (!DATE_RE.test(date)) return null;
  const d = new Date(`${date}T00:00:00`);
  if (Number.isNaN(d.getTime())) return null;
  const [y, m, day] = date.split('-').map(Number);
  if (d.getFullYear() !== y || d.getMonth() + 1 !== m || d.getDate() !== day) return null;
  return d.getTime();
}

// A querystring date is kept only if it is a REAL calendar day (not just digits).
function validDate(date: string | undefined): date is string {
  return date !== undefined && localMidnightMs(date) !== null;
}

// A custom range is active only when BOTH dates are valid AND start ≤ end. An
// inverted / half-filled range falls back to the preset (never throws).
export function hasCustomRange(f: KeyDetailFilters): boolean {
  if (!f.startDate || !f.endDate) return false;
  const s = localMidnightMs(f.startDate);
  const e = localMidnightMs(f.endDate);
  return s !== null && e !== null && s <= e;
}

export function parseKeyDetailFilters(sp: URLSearchParams): KeyDetailFilters {
  const rangeRaw = sp.get('range');
  const startDate = sp.get('start')?.trim();
  const endDate = sp.get('end')?.trim();
  const pageRaw = Number(sp.get('page'));
  return {
    range: isRange(rangeRaw) ? rangeRaw : KEY_DETAIL_DEFAULT_RANGE,
    startDate: validDate(startDate) ? startDate : undefined,
    endDate: validDate(endDate) ? endDate : undefined,
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
  if (hasCustomRange(f)) {
    const start = localMidnightMs(f.startDate as string) as number;
    // End-of-day exclusive: midnight of the day AFTER endDate (DST-correct via
    // setDate, not a flat +DAY_MS).
    const endDay = new Date(`${f.endDate}T00:00:00`);
    endDay.setDate(endDay.getDate() + 1);
    return { start, end: endDay.getTime() };
  }
  if (f.range === 'all') return { start: 0, end: nowMs };
  const w = resolveWindow(f.range, nowMs);
  return { start: w.start ?? 0, end: nowMs };
}

// Trend bucket granularity for a resolved window: hourly for short spans, daily
// for longer ones — so the x-axis stays legible at every range.
export function bucketForWindow(start: number, end: number): 'hour' | 'day' {
  return end - start <= HOURLY_MAX_SPAN_MS ? 'hour' : 'day';
}
