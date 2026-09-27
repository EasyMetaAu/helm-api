// Type-only shim so the reused admin detail viewer (TokenUsage) compiles in the
// portal. That component imports its prop type from `$lib/api/requests.js`; the
// portal doesn't reuse the admin requests parser, so we re-declare ONLY that view
// type. Kept structurally identical to the admin original
// (apps/admin/src/lib/api/requests.ts) so the component needs no edits.

export interface TokenUsageView {
  input: number | null;
  output: number | null;
  cached: number | null;
  cacheCreation: number | null;
  nonCached: number | null;
  total: number | null;
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
