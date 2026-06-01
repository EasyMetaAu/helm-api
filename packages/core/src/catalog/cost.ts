import type { Pricing } from "@helm/shared";

// Cost conversion: provider token usage × catalog pricing (docs/07 "cost breakdown").
// Framework-/network-free (principle 1). Pricing is quoted per MILLION tokens
// (LiteLLM-derived generated catalog + manual overrides), so we divide by 1e6.
//
// MISSING pricing → null (NOT a crash, principle 3 fail-open): an unknown model
// or a half-filled pricing entry means "cost not measured", which the decision
// record keeps DISTINCT from a measured 0. Callers log the miss; they never throw.

export interface TokenUsage {
  promptTokens?: number;
  completionTokens?: number;
}

// Compute the USD cost of one attempt/eval from its token usage and the model's
// pricing. Returns null when pricing is unavailable (entry absent, or either
// per-MTok rate is null). Absent token counts are treated as 0 (a measured
// number), so a priced model with no reported usage costs 0, not null.
export function computeCostUsd(pricing: Pricing | undefined, usage: TokenUsage): number | null {
  if (!pricing) return null;
  const { inputPerMTokUsd, outputPerMTokUsd } = pricing;
  if (inputPerMTokUsd === null || outputPerMTokUsd === null) return null;
  const prompt = usage.promptTokens ?? 0;
  const completion = usage.completionTokens ?? 0;
  return (prompt * inputPerMTokUsd) / 1_000_000 + (completion * outputPerMTokUsd) / 1_000_000;
}

// Extract OpenAI-shaped token usage from a raw upstream response body. Defensive:
// any missing/non-numeric/NaN/negative field collapses to undefined (→ treated as
// 0 by computeCostUsd). A NaN or negative count would otherwise propagate to a NaN
// cost that serializes to null — masquerading as "not measured" without the
// pricing_missing log, and corrupting aggregation. Never throws, never touches
// message content (principle 7).
function finiteNonNegative(x: unknown): number | undefined {
  return typeof x === "number" && Number.isFinite(x) && x >= 0 ? x : undefined;
}

export function usageFromBody(body: unknown): TokenUsage {
  const usage = (body as { usage?: unknown } | null | undefined)?.usage;
  if (!usage || typeof usage !== "object") return {};
  const u = usage as { prompt_tokens?: unknown; completion_tokens?: unknown };
  return {
    promptTokens: finiteNonNegative(u.prompt_tokens),
    completionTokens: finiteNonNegative(u.completion_tokens),
  };
}

// An upstream-BILLED cost the provider returned alongside the response — the
// relay's OWN computed price, in USD. Different relays surface it differently, so
// we probe, in precedence order: `usage.cost_usd` → `usage.cost` (OpenRouter) →
// top-level `cost_usd`. When present this is AUTHORITATIVE (real money charged)
// and must OVERRIDE our catalog estimate (CLAUDE.md cost convention: if the upstream
// returns cost use it to override; otherwise fall back to the prepared pricing).
// Defensive (principle 3/7): only a finite, non-negative
// number counts — anything else → null so the caller falls back to the estimate.
// Never throws, never reads message content.
export function billedCostFromBody(body: unknown): number | null {
  if (!body || typeof body !== "object") return null;
  const b = body as { cost_usd?: unknown; usage?: unknown };
  const usage =
    b.usage && typeof b.usage === "object"
      ? (b.usage as { cost_usd?: unknown; cost?: unknown })
      : undefined;
  for (const candidate of [usage?.cost_usd, usage?.cost, b.cost_usd]) {
    const v = finiteNonNegative(candidate);
    if (v !== undefined) return v;
  }
  return null;
}

// Resolve one served attempt's USD cost from a raw upstream response body: prefer
// the upstream-billed cost when present (authoritative — overrides the estimate,
// and works even with no catalog entry), otherwise estimate from token usage ×
// catalog pricing. Returns null ONLY when BOTH are unavailable (no billed cost
// AND pricing missing) — the honest "not measured" sentinel, kept DISTINCT from a
// measured 0 (principle 3). This is the single source of the override-or-preset
// rule; eval (classify) and execution (execute/stream) both route through it.
export function resolveCostUsd(pricing: Pricing | undefined, body: unknown): number | null {
  const billed = billedCostFromBody(body);
  if (billed !== null) return billed;
  return computeCostUsd(pricing, usageFromBody(body));
}
