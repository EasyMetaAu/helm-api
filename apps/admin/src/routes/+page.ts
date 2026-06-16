import { listRequests, type RequestListItem } from '$lib/api/requests.js';
import { type DashboardStats, EMPTY_STATS, getStats } from '$lib/api/stats.js';
import {
  clientTzOffsetMinutes,
  parseRange,
  type RangeKey,
  resolveWindow,
} from '$lib/requests-filters.js';
import type { PageLoad } from './$types.js';

// Dashboard load (SPA, client-side): read the date-range preset from the URL
// (?range=…, default 24h — a live dashboard cares about recent traffic), resolve
// it to an absolute window in client-local time (the gateway stays
// timezone-agnostic), and pull TWO things for that window:
//   1. the token-accounting aggregate (getStats) — a real SQL SUM/GROUP BY over
//      the whole window, NOT a client-side reduce of a sample. This feeds the
//      headline cards + the trend / by-model charts.
//   2. a small recent-requests page (listRequests) — still needed for the table
//      preview; only its first 10 rows are shown, so a modest page is plenty.
// Both fail SOFT independently — a fresh gateway with no telemetry (or an admin
// API hiccup) shows a zeroed dashboard rather than an error page. Re-runs on every
// navigation (range change / back-button) since it depends on `url`.

// Short windows want an hourly trend (you can see the shape of a day); long
// windows want a daily trend (a month of hourly points is noise). The boundary is
// the sub-day presets.
function bucketFor(range: RangeKey): 'hour' | 'day' {
  return range === '1h' || range === '6h' || range === '24h' || range === 'today'
    ? 'hour'
    : 'day';
}

export const load: PageLoad = async ({ url }) => {
  const range = parseRange(url.searchParams.get('range'), '24h');
  const { start, end } = resolveWindow(range, Date.now());
  const bucket = bucketFor(range);
  // Send the viewer's UTC offset so the SQL series buckets break at local midnight
  // (not 00:00 UTC) — the fix for the "8am boundary" on UTC+8 dashboards.
  const tzOffsetMinutes = clientTzOffsetMinutes();

  // The aggregate (cards + charts). Fail-soft to an empty aggregate.
  let agg: DashboardStats = EMPTY_STATS;
  try {
    agg = await getStats({ start, end, bucket, tzOffsetMinutes });
  } catch {
    agg = EMPTY_STATS;
  }

  // The recent-requests table preview (first 10 rows shown). Fail-soft to [].
  let items: RequestListItem[] = [];
  try {
    const res = await listRequests({ start, end, pageSize: 10 });
    items = res.items;
  } catch {
    items = [];
  }

  // Derive the headline card numbers from the SQL aggregate (the real totals over
  // the whole window, not a sample). Token totals: Input = prompt, Output =
  // completion, Total = the two summed, Cached = cached prompt tokens.
  const t = agg.totals;
  const successRate = t.requests === 0 ? null : Math.round((t.okCount / t.requests) * 100);

  return {
    range,
    agg,
    items,
    stats: {
      total: t.requests,
      ok: t.okCount,
      errors: t.errorCount,
      successRate,
      avgLatency: t.avgLatencyMs === null ? null : Math.round(t.avgLatencyMs),
      totalCost: t.totalCostUsd,
      totalTokens: t.promptTokens + t.completionTokens,
      inputTokens: t.promptTokens,
      outputTokens: t.completionTokens,
      cachedTokens: t.cachedTokens,
    },
  };
};
