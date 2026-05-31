import type { Pricing } from "@helm/shared";

// Cost conversion: provider token usage × catalog pricing (docs/07 「成本拆分」).
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
