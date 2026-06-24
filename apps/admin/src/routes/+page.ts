import { listRequests, type RequestListItem } from '$lib/api/requests.js';
import { type DashboardStats, EMPTY_STATS, getStats } from '$lib/api/stats.js';
import {
  pctDelta,
  resolveStatsWindow,
  resolveTodayComparisonWindow,
  trendBucketForRange,
} from '$lib/dashboard-chart.js';
import { clientTzOffsetMinutes, parseRange, resolveWindow } from '$lib/requests-filters.js';
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

export const load: PageLoad = async ({ url }) => {
  const range = parseRange(url.searchParams.get('range'), 'today');
  const now = Date.now();
  const { start, end } = resolveWindow(range, now);
  const statsWindow = resolveStatsWindow(range, now);
  const bucket = trendBucketForRange(range);
  // Send the viewer's UTC offset so the SQL series buckets break at local midnight
  // (not 00:00 UTC) — the fix for the "8am boundary" on UTC+8 dashboards.
  const tzOffsetMinutes = clientTzOffsetMinutes();

  // The aggregate (cards + charts). Fail-soft to an empty aggregate.
  let agg: DashboardStats = EMPTY_STATS;
  try {
    agg = await getStats({ ...statsWindow, bucket, tzOffsetMinutes });
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

  // "vs yesterday" deltas — only for the TODAY view, baselined against yesterday up
  // to the same time of day (resolveTodayComparisonWindow) so it's pace-vs-pace,
  // not partial-vs-full. Fail-soft: a hiccup → no deltas, cards just omit them.
  let compare: Record<string, number | null> | null = null;
  if (range === 'today') {
    try {
      const cmp = resolveTodayComparisonWindow(now);
      const y = (await getStats({ ...cmp, bucket, tzOffsetMinutes })).totals;
      compare = {
        requests: pctDelta(t.requests, y.requests),
        totalTokens: pctDelta(
          t.promptTokens + t.completionTokens,
          y.promptTokens + y.completionTokens,
        ),
        inputTokens: pctDelta(t.promptTokens, y.promptTokens),
        outputTokens: pctDelta(t.completionTokens, y.completionTokens),
        cachedTokens: pctDelta(t.cachedTokens, y.cachedTokens),
        totalCost: pctDelta(t.totalCostUsd ?? 0, y.totalCostUsd ?? 0),
      };
    } catch {
      compare = null;
    }
  }

  return {
    range,
    bucket,
    agg,
    items,
    compare,
    stats: {
      total: t.requests,
      ok: t.okCount,
      errors: t.errorCount,
      successRate,
      avgLatency: t.avgLatencyMs === null ? null : Math.round(t.avgLatencyMs),
      // True throughput across the window (aggregate Σoutput ÷ Σgeneration time, SQL-
      // computed); null = no streamed row had a measured window → the card shows '—'.
      avgTps: t.avgTps,
      totalCost: t.totalCostUsd,
      totalTokens: t.promptTokens + t.completionTokens,
      inputTokens: t.promptTokens,
      outputTokens: t.completionTokens,
      cachedTokens: t.cachedTokens,
    },
  };
};
