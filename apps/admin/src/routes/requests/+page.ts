import { listRequests } from '$lib/api/requests.js';
import { parseFilters, resolveCustomDayWindow, resolveWindow } from '$lib/requests-filters.js';
import type { PageLoad } from './$types.js';

// SPA load: read the filter + page state from the URL, resolve the date-range
// preset to an absolute window in client-local time (the gateway stays
// timezone-agnostic), and fetch that filtered page. Re-runs on every navigation
// (filter change / pager / back-button) since it depends on `url`. Read-only —
// the UI renders the recorded trail and recomputes nothing (docs/07).
export const load: PageLoad = async ({ url }) => {
  const filters = parseFilters(url.searchParams);
  const now = Date.now();
  // A valid custom day range (start/end) OVERRIDES the preset for the fetch window;
  // a half-filled / inverted range falls back to it.
  const custom =
    filters.startDate && filters.endDate
      ? resolveCustomDayWindow(filters.startDate, filters.endDate)
      : null;
  const { start, end } = custom ?? resolveWindow(filters.range, now);
  const page = await listRequests({
    page: filters.page,
    pageSize: filters.pageSize,
    status: filters.status,
    decidedBy: filters.decidedBy,
    lane: filters.lane,
    model: filters.model,
    start,
    end,
  });
  return { ...page, filters };
};
