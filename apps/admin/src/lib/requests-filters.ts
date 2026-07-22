// Filter + pagination state for the request-debug list, kept in the URL
// querystring so views are shareable, back-button friendly, and survive a reload
// (the SPA loader re-reads them on every navigation). Pure functions only — no
// framework imports — so the date-window math and the parse/serialize round-trip
// are unit-testable.

import type { RequestListItem } from '$lib/api/requests.js';

// Date-range presets. The window is resolved to absolute epoch ms in the loader
// (client-local time) so the gateway stays timezone-agnostic. The UI offers only
// the calendar-day presets (today/yesterday/7d/30d/all — see RangeFilter.svelte);
// the rolling 1h/6h/24h keys are retained so old bookmarks still resolve.
export const RANGE_KEYS = ['all', 'today', 'yesterday', '7d', '30d', '1h', '6h', '24h'] as const;
export type RangeKey = (typeof RANGE_KEYS)[number];

// Rows-per-page choices offered by the list pager. The backend clamps to [1, 200]
// (REQUESTS_PAGE_SIZE_MAX), so 200 is the largest option; 50 is the default.
export const PAGE_SIZE_OPTIONS = [25, 50, 100, 200] as const;
export const DEFAULT_PAGE_SIZE = 50;

export interface RequestsFilters {
  range: RangeKey;
  // Custom calendar-day window (YYYY-MM-DD, inclusive). When BOTH are set and form
  // a valid range they OVERRIDE `range` — the same "custom wins" model the key-detail
  // page uses. Half-filled / inverted / invalid falls back to the preset.
  startDate?: string;
  endDate?: string;
  status?: RequestListItem['status'];
  decidedBy?: RequestListItem['decided_by'];
  lane?: string;
  model?: string;
  // Exact api_key_id scope. Not a typed control — it's set by clicking a row's key
  // (or arriving via the key detail page's "view more" link) and shown as a
  // removable chip. Serialized as `key_id` to match the backend schema.
  keyId?: string;
  // Exact session scope, carried as `session_ref` in the URL/API.
  sessionRef?: string;
  page: number;
  pageSize: number;
}

// The list defaults to TODAY (since local midnight) — the calendar-day view the
// dashboard is built around, NOT 'all'. So 'today' is the "clean URL" range
// (omitted from the query), and anything else (incl. 'all') is written explicitly.
export const DEFAULT_RANGE: RangeKey = 'today';

export const DEFAULT_FILTERS: RequestsFilters = {
  range: DEFAULT_RANGE,
  page: 1,
  pageSize: DEFAULT_PAGE_SIZE,
};

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
// A 2-day window or shorter reads better hour-bucketed; longer → day buckets.
const HOURLY_MAX_SPAN_MS = 2 * DAY_MS;
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
  const startDate = sp.get('start')?.trim();
  const endDate = sp.get('end')?.trim();
  const status = sp.get('status');
  const decidedBy = sp.get('decided_by');
  const lane = sp.get('lane')?.trim();
  const model = sp.get('model')?.trim();
  const keyId = sp.get('key_id')?.trim();
  const sessionRef = sp.get('session_ref')?.trim();
  const pageRaw = Number(sp.get('page'));
  const pageSizeRaw = Number(sp.get('pageSize'));
  return {
    range: isRange(rangeRaw) ? rangeRaw : DEFAULT_RANGE,
    // Kept only if they are REAL calendar days; the "both valid + ordered" check
    // that makes them WIN over the preset happens in resolveCustomDayWindow.
    startDate: isValidDateParam(startDate) ? startDate : undefined,
    endDate: isValidDateParam(endDate) ? endDate : undefined,
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
    keyId: keyId || undefined,
    sessionRef: sessionRef || undefined,
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
  // A valid custom range wins: write start/end and drop the preset. A half-filled
  // or inverted range is ignored, so the preset is written instead.
  const custom = f.startDate && f.endDate ? resolveCustomDayWindow(f.startDate, f.endDate) : null;
  if (custom) {
    qs.set('start', f.startDate as string);
    qs.set('end', f.endDate as string);
  } else if (f.range !== DEFAULT_RANGE) {
    qs.set('range', f.range);
  }
  if (f.status) qs.set('status', f.status);
  if (f.decidedBy) qs.set('decided_by', f.decidedBy);
  if (f.lane?.trim()) qs.set('lane', f.lane.trim());
  if (f.model?.trim()) qs.set('model', f.model.trim());
  if (f.keyId?.trim()) qs.set('key_id', f.keyId.trim());
  if (f.sessionRef?.trim()) qs.set('session_ref', f.sessionRef.trim());
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
    case 'yesterday': {
      // The full previous local day: [yesterday midnight, today midnight). The
      // only preset with a CLOSED end — it must not bleed into today. setDate
      // steps the day (DST-correct), not a flat −DAY_MS.
      const d = new Date(nowMs);
      d.setHours(0, 0, 0, 0);
      const end = d.getTime();
      d.setDate(d.getDate() - 1);
      return { start: d.getTime(), end };
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

// Local-midnight epoch ms for a 'YYYY-MM-DD' (parsed in the viewer's zone, like the
// rest of the admin). null when the shape is wrong OR the value is not a real
// calendar day — rollover junk like 2026-06-31 / 2026-13-99 is rejected (the parsed
// Y-M-D must match the input), never silently rolled into the next month.
export function localMidnightMs(date: string): number | null {
  if (!DATE_RE.test(date)) return null;
  const d = new Date(`${date}T00:00:00`);
  if (Number.isNaN(d.getTime())) return null;
  const [y, m, day] = date.split('-').map(Number);
  if (d.getFullYear() !== y || d.getMonth() + 1 !== m || d.getDate() !== day) return null;
  return d.getTime();
}

// A querystring date param is kept only if it is a REAL calendar day (not just digits).
export function isValidDateParam(date: string | undefined): date is string {
  return date !== undefined && localMidnightMs(date) !== null;
}

// The viewer's local calendar 'today' as 'YYYY-MM-DD' — the latest day a custom range
// may select, since future days have no data yet (used as the date inputs' `max`).
// Built from local Y/M/D, NOT toISOString() (which is UTC and would jump a day near
// midnight for non-UTC viewers).
export function todayLocalDate(nowMs: number = Date.now()): string {
  const d = new Date(nowMs);
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

// Resolve a custom calendar-day range to a half-open window [start, end) in epoch ms
// (viewer-local). `end` is midnight of the day AFTER endDate so the end day is
// INCLUDED. null when either date isn't a real day or start > end — the caller then
// falls back to its preset (never throws).
export function resolveCustomDayWindow(
  startDate: string,
  endDate: string,
): { start: number; end: number } | null {
  const start = localMidnightMs(startDate);
  const endMidnight = localMidnightMs(endDate);
  if (start === null || endMidnight === null || start > endMidnight) return null;
  // End-of-day exclusive: midnight of the day AFTER endDate (DST-correct via setDate,
  // not a flat +DAY_MS).
  const endDay = new Date(endMidnight);
  endDay.setDate(endDay.getDate() + 1);
  return { start, end: endDay.getTime() };
}

// Trend bucket granularity for a resolved window: hourly for short spans, daily for
// longer ones — so the x-axis stays legible at every range.
export function bucketForWindow(start: number, end: number): 'hour' | 'day' {
  return end - start <= HOURLY_MAX_SPAN_MS ? 'hour' : 'day';
}

// The viewer's UTC offset in EAST-POSITIVE minutes (UTC+8 → +480), the form the
// stats/usage endpoints expect for local-day bucketing. `Date.getTimezoneOffset()`
// is the OPPOSITE sign (minutes to ADD to local to reach UTC, so UTC+8 → −480), so
// we negate it. Passed to the aggregate endpoints so SQL buckets break at the
// client's local midnight instead of 00:00 UTC (the "8am boundary" for UTC+8).
export function clientTzOffsetMinutes(nowMs: number = Date.now()): number {
  // `|| 0` normalizes negative zero: `-getTimezoneOffset()` is -0 at UTC, which is
  // surprising to compare against and to serialize.
  return -new Date(nowMs).getTimezoneOffset() || 0;
}
