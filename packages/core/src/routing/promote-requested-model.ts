// When a request is classified into a lane (NOT explicit passthrough) and the
// client's requested model already appears in that lane's expanded candidate
// chain, serve the model the client actually asked for — promote it to the
// front, leaving the rest of the chain as the fallback.
//
// INVARIANT: reorder-only. This never introduces a new candidate, so cost stays
// bounded by the operator-declared lane set and the per-candidate capability
// filter + circuit breaker in the executor still gate every attempt — a promoted
// head that cannot serve (context_too_small, breaker open) is simply skipped and
// the chain falls through. Promotion is never worse than the un-promoted order.
//
// Pure, deterministic, zero-network, zero-dependency (principle 4). Applied only
// at the routing call sites (route-request); expandLaneChain stays untouched
// because the public model listing (GET /v1/models) reuses it and must not reorder.

// Alias entries are `provider/model`; the segment after the first slash is the
// client-addressable model id (and, for OAuth-synthesized aliases, the literal
// wire model forwarded upstream). A bare alias with no slash is its own id.
function modelIdOf(alias: string): string {
  const slash = alias.indexOf("/");
  return slash > 0 ? alias.slice(slash + 1) : alias;
}

// Canonicalize to the official form (lowercase, dashed version separators) so
// `claude-sonnet-4.6` and `claude-sonnet-4-6` are treated as the same model.
// Applied to BOTH sides → symmetric, so dotted ids like `gpt-5.5` both become
// `gpt-5-5` and still self-match (no false matches introduced).
function normalizeModelId(s: string): string {
  return s.trim().toLowerCase().replace(/\./g, "-");
}

export function promoteRequestedModel(chain: string[], requestedModel: string): string[] {
  const want = normalizeModelId(requestedModel);
  // `auto` is the "let the router decide" sentinel, never a model to pin; the
  // guard sits after normalization so "AUTO"/" auto " and empty are caught too.
  if (want.length === 0 || want === "auto") return chain;
  const idx = chain.findIndex((alias) => normalizeModelId(modelIdOf(alias)) === want);
  if (idx <= 0) return chain; // -1 = no match; 0 = already leading → same reference
  const promoted = chain[idx];
  if (promoted === undefined) return chain; // unreachable (0 < idx < len); narrows for the checker
  return [promoted, ...chain.slice(0, idx), ...chain.slice(idx + 1)];
}
