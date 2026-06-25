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
  // Cache hit rate: the share of input (prompt) tokens served from cache. Cached
  // tokens are a subset of prompt tokens, so this is cached ÷ prompt; null when the
  // window has no input tokens (→ the card hides the line rather than dividing by 0).
  const cacheHitRate =
    t.promptTokens === 0 ? null : Math.round((t.cachedTokens / t.promptTokens) * 100);

  // "vs yesterday" deltas — only for the TODAY view, baselined against yesterday's
  // WHOLE calendar day (resolveTodayComparisonWindow): a plain day-over-day read of
  // today-so-far against yesterday's full-day total. Each entry carries {pct, base}:
  // base is the yesterday value, surfaced in the card tooltip so the comparison is
  // transparent. Suppressed entirely when yesterday had too little traffic to
  // compare against. Fail-soft: a hiccup → no deltas, cards just omit them.
  const MIN_COMPARISON_BASELINE_REQUESTS = 10;
  let compare: Record<string, { pct: number | null; base: number }> | null = null;
  if (range === 'today') {
    try {
      const cmp = resolveTodayComparisonWindow(now);
      const y = (await getStats({ ...cmp, bucket, tzOffsetMinutes })).totals;
      if (y.requests >= MIN_COMPARISON_BASELINE_REQUESTS) {
        const yTotalTokens = y.promptTokens + y.completionTokens;
        compare = {
          requests: { pct: pctDelta(t.requests, y.requests), base: y.requests },
          totalTokens: {
            pct: pctDelta(t.promptTokens + t.completionTokens, yTotalTokens),
            base: yTotalTokens,
          },
          inputTokens: { pct: pctDelta(t.promptTokens, y.promptTokens), base: y.promptTokens },
          outputTokens: {
            pct: pctDelta(t.completionTokens, y.completionTokens),
            base: y.completionTokens,
          },
          cachedTokens: { pct: pctDelta(t.cachedTokens, y.cachedTokens), base: y.cachedTokens },
          totalCost: {
            pct: pctDelta(t.totalCostUsd ?? 0, y.totalCostUsd ?? 0),
            base: y.totalCostUsd ?? 0,
          },
        };
      }
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
      cacheHitRate,
    },
  };
};
