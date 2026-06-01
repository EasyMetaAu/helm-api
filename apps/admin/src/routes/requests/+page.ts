import { listRequests } from '$lib/api/requests.js';
import { parseFilters, resolveWindow } from '$lib/requests-filters.js';
import type { PageLoad } from './$types.js';

// SPA load: read the filter + page state from the URL, resolve the date-range
// preset to an absolute window in client-local time (the gateway stays
// timezone-agnostic), and fetch that filtered page. Re-runs on every navigation
// (filter change / pager / back-button) since it depends on `url`. Read-only —
// the UI renders the recorded trail and recomputes nothing (docs/07).
export const load: PageLoad = async ({ url }) => {
  const filters = parseFilters(url.searchParams);
  const { start, end } = resolveWindow(filters.range, Date.now());
  const page = await listRequests({
    page: filters.page,
    status: filters.status,
    decidedBy: filters.decidedBy,
    lane: filters.lane,
    model: filters.model,
    start,
    end,
  });
  return { ...page, filters };
};
