// Type-only shim so the reused admin detail viewers (TokenUsage/CostBreakdown)
// compile in the portal. These components import their prop types from
// `$lib/api/requests.js`; the portal doesn't reuse the admin requests parser, so
// we re-declare ONLY the two view types they read. Kept structurally identical to
// the admin originals (apps/admin/src/lib/api/requests.ts) so the components need
// no edits.

export interface TokenUsageView {
  input: number | null;
  output: number | null;
  cached: number | null;
  cacheCreation: number | null;
  nonCached: number | null;
  total: number | null;
}

// CostBreakdown reads `RequestDetail['cost_breakdown']`; only that member is used.
// The portal never exposes eval/routing self-cost (§4.3) so those read null — but
// the shape must match the component's field access.
export interface RequestDetail {
  cost_breakdown: {
    routing_usd: number | null;
    eval_usd: number | null;
    completion_usd: number | null;
    total_usd: number | null;
  };
}

// Map the portal's flat usage counts to the viewer's TokenUsageView (derives the
// nonCached/total the component displays).
export function toTokenUsageView(
  u: {
    prompt_tokens: number | null;
    completion_tokens: number | null;
    cached_tokens: number | null;
    cache_creation_tokens: number | null;
  } | null,
): TokenUsageView {
  const input = u?.prompt_tokens ?? null;
  const output = u?.completion_tokens ?? null;
  const cached = u?.cached_tokens ?? null;
  const nonCached =
    input !== null && cached !== null ? Math.max(0, input - cached) : null;
  const total =
    input !== null || output !== null ? (input ?? 0) + (output ?? 0) : null;
  return {
    input,
    output,
    cached,
    cacheCreation: u?.cache_creation_tokens ?? null,
    nonCached,
    total,
  };
}
