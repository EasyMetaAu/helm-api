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
}

export interface DashboardSeriesBucket {
  bucketStartMs: number; // UTC hour/day bucket floor (epoch ms)
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
  },
  series: [],
  byModel: [],
};

export interface StatsParams {
  start?: number; // epoch ms (inclusive); omitted → backend default (last 24h)
  end?: number; // epoch ms (exclusive); omitted → backend default (now)
  bucket?: 'hour' | 'day';
}

const BASE = '/admin/api/stats';

// GET /admin/api/stats → TelemetryAggregate. The window + bucket are query params;
// the backend defaults to the last 24h / day when omitted and fails open on a
// malformed query, so this never needs to validate them itself.
export async function getStats(params: StatsParams = {}): Promise<DashboardStats> {
  const qs = new URLSearchParams();
  if (params.start !== undefined) qs.set('start', String(params.start));
  if (params.end !== undefined) qs.set('end', String(params.end));
  if (params.bucket) qs.set('bucket', params.bucket);
  const url = qs.toString() ? `${BASE}?${qs}` : BASE;
  const res = await fetch(url, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`stats api ${res.status}`);
  return (await res.json()) as DashboardStats;
}
