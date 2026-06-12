import type { TelemetryAggregate } from "./ports.js";

// Shared shaping for TelemetryStore.aggregate (dashboard token accounting). Both
// adapters run dialect-specific SQL but funnel the raw rows through HERE so the
// returned shape — and the numeric coercion — can never drift between sqlite and
// postgres (the store-contract test pins the parity, this keeps it honest).
//
// Why coerce: postgres returns SUM()/COUNT() over bigint and the raw bucket
// expression as STRINGS (the pg driver marshals bigint as string to avoid 2^53
// loss); sqlite returns numbers. Number() normalizes both. Token sums are already
// COALESCE'd to 0 in SQL, so a missing value is a real 0; cost/latency stay
// nullable (null = "not measured", distinct from a measured 0 — principle 3).
const num = (v: unknown): number => (v == null ? 0 : Number(v));
const numOrNull = (v: unknown): number | null => (v == null ? null : Number(v));

export function shapeTelemetryAggregate(
  totals: Record<string, unknown> | undefined,
  series: ReadonlyArray<Record<string, unknown>>,
  byModel: ReadonlyArray<Record<string, unknown>>,
): TelemetryAggregate {
  return {
    totals: {
      requests: num(totals?.requests),
      okCount: num(totals?.okCount),
      errorCount: num(totals?.errorCount),
      totalCostUsd: numOrNull(totals?.totalCostUsd),
      promptTokens: num(totals?.promptTokens),
      completionTokens: num(totals?.completionTokens),
      cachedTokens: num(totals?.cachedTokens),
      cacheCreationTokens: num(totals?.cacheCreationTokens),
      avgLatencyMs: numOrNull(totals?.avgLatencyMs),
    },
    // Sort in JS (not SQL) so the ordering is IDENTICAL across dialects regardless
    // of GROUP BY emission order — series chronological, byModel by volume desc.
    series: series
      .map((r) => ({
        bucketStartMs: num(r.bucketStartMs),
        promptTokens: num(r.promptTokens),
        completionTokens: num(r.completionTokens),
        cachedTokens: num(r.cachedTokens),
        cacheCreationTokens: num(r.cacheCreationTokens),
        requests: num(r.requests),
      }))
      .sort((a, b) => a.bucketStartMs - b.bucketStartMs),
    byModel: byModel
      .map((r) => ({
        servedModel: (r.servedModel as string | null) ?? null,
        promptTokens: num(r.promptTokens),
        completionTokens: num(r.completionTokens),
        totalTokens: num(r.totalTokens),
        requests: num(r.requests),
      }))
      .sort((a, b) => b.totalTokens - a.totalTokens),
  };
}
