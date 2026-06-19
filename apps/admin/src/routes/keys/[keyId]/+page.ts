import { error } from '@sveltejs/kit';
import { getKey } from '$lib/api/keys.js';
import { listRequests, type RequestListItem } from '$lib/api/requests.js';
import { type DashboardStats, EMPTY_STATS, getStats } from '$lib/api/stats.js';
import {
  bucketForWindow,
  parseKeyDetailFilters,
  resolveKeyDetailWindow,
} from '$lib/key-detail-filters.js';
import { clientTzOffsetMinutes } from '$lib/requests-filters.js';
import type { PageLoad } from './$types.js';

// Key detail load (SPA): the page is ABOUT one key, so the key record is a HARD
// dependency — an unknown id throws 404 (the SvelteKit error page). Everything
// else is SUPPLEMENTARY observability and fails SOFT independently (a zeroed
// stats panel / empty request list rather than an error page), exactly like the
// dashboard. The window (preset OR custom date range) + page live in the URL, so
// this re-runs on every filter change / back-button.

const DETAIL_PAGE_SIZE = 25;

export const load: PageLoad = async ({ params, url }) => {
  const keyId = params.keyId;

  // getKey returns null ONLY for a genuine 404; every other failure (500/503,
  // network) throws and propagates as a real load error — we must not mask an
  // admin-API outage as "key not found".
  const key = await getKey(keyId);
  if (!key) throw error(404, 'API key not found');

  const filters = parseKeyDetailFilters(url.searchParams);
  const now = Date.now();
  const { start, end } = resolveKeyDetailWindow(filters, now);
  const bucket = bucketForWindow(start, end);
  const tzOffsetMinutes = clientTzOffsetMinutes();

  // Stats scoped to THIS key (cards + charts). Fail-soft to an empty aggregate.
  let agg: DashboardStats = EMPTY_STATS;
  try {
    agg = await getStats({ key_id: keyId, start, end, bucket, tzOffsetMinutes });
  } catch {
    agg = EMPTY_STATS;
  }

  // The key's own request list (scoped + paginated). Fail-soft to an empty page.
  let requests = {
    items: [] as RequestListItem[],
    total: 0,
    page: filters.page,
    pageSize: DETAIL_PAGE_SIZE,
  };
  try {
    requests = await listRequests({
      keyId,
      start,
      end,
      page: filters.page,
      pageSize: DETAIL_PAGE_SIZE,
    });
  } catch {
    // keep the empty page
  }

  // Headline cards from the SQL aggregate (real totals over the window, not a
  // sample) — same derivation as the dashboard so the numbers read identically.
  const t = agg.totals;
  const successRate = t.requests === 0 ? null : Math.round((t.okCount / t.requests) * 100);

  return {
    key,
    keyId,
    filters,
    bucket,
    agg,
    requests,
    stats: {
      total: t.requests,
      ok: t.okCount,
      errors: t.errorCount,
      successRate,
      avgLatency: t.avgLatencyMs === null ? null : Math.round(t.avgLatencyMs),
      avgTps: t.avgTps,
      totalCost: t.totalCostUsd,
      totalTokens: t.promptTokens + t.completionTokens,
      inputTokens: t.promptTokens,
      outputTokens: t.completionTokens,
      cachedTokens: t.cachedTokens,
    },
  };
};
