// Dashboard token-accounting API client. Like the requests client, the admin UI
// is a PURE consumer of /admin/api/* — it imports NO core/gateway code and
// re-declares just the shape it reads (CLAUDE.md Principle 1). The backend does the
// SUM/GROUP BY in SQL (GET /admin/api/stats → TelemetryAggregate); this only
// fetches + types the result.

// ── UI-facing contract (mirrors core's TelemetryAggregate) ───────────────────

export interface DashboardTotals {
  requests: number;
  okCount: number;
  errorCount: number;
  totalCostUsd: number | null;
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;
  cacheCreationTokens: number;
  avgLatencyMs: number | null;
  // True throughput across the window: Σ output ÷ Σ generation time × 1000, over
  // streaming rows with a measured window. null = no such row → the card renders '—'.
  avgTps: number | null;
}

export interface DashboardSeriesBucket {
  bucketStartMs: number; // bucket floor in epoch ms (client-local day/hour when a tz offset was sent; UTC otherwise) — rendered back to local in the chart
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;
  cacheCreationTokens: number;
  requests: number;
}

export interface DashboardModelUsage {
  servedModel: string | null; // null = pre-feature / unstamped row → shown as "unknown"
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  requests: number;
}

export interface DashboardStats {
  totals: DashboardTotals;
  series: DashboardSeriesBucket[];
  byModel: DashboardModelUsage[];
}

// An empty aggregate — the loader's fail-soft fallback so a fresh gateway (or an
// admin API hiccup) renders zeroed cards + empty charts instead of an error page.
export const EMPTY_STATS: DashboardStats = {
  totals: {
    requests: 0,
    okCount: 0,
    errorCount: 0,
    totalCostUsd: null,
    promptTokens: 0,
    completionTokens: 0,
    cachedTokens: 0,
    cacheCreationTokens: 0,
    avgLatencyMs: null,
    avgTps: null,
  },
  series: [],
  byModel: [],
};

export interface StatsParams {
  start?: number; // epoch ms (inclusive); omitted → backend default (last 24h)
  end?: number; // epoch ms (exclusive); omitted → backend default (now)
  bucket?: 'hour' | 'day';
  tzOffsetMinutes?: number; // east-positive UTC offset; buckets in client-local day
}

const BASE = '/admin/api/stats';

// GET /admin/api/stats → TelemetryAggregate. The window + bucket + tzOffsetMinutes
// are query params; the backend defaults to the last 24h / day / UTC when omitted
// and fails open on a malformed query, so this never needs to validate them itself.
export async function getStats(params: StatsParams = {}): Promise<DashboardStats> {
  const qs = new URLSearchParams();
  if (params.start !== undefined) qs.set('start', String(params.start));
  if (params.end !== undefined) qs.set('end', String(params.end));
  if (params.bucket) qs.set('bucket', params.bucket);
  if (params.tzOffsetMinutes !== undefined)
    qs.set('tzOffsetMinutes', String(params.tzOffsetMinutes));
  const url = qs.toString() ? `${BASE}?${qs}` : BASE;
  const res = await fetch(url, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`stats api ${res.status}`);
  return (await res.json()) as DashboardStats;
}
