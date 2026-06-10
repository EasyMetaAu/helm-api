import type { CatalogEntry, Pricing } from "@helm/shared";

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
  cachedPromptTokens?: number;
  cacheCreationPromptTokens?: number;
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
  const cached = usage.cachedPromptTokens ?? 0;
  const cacheCreation = usage.cacheCreationPromptTokens ?? 0;
  const regularPrompt = Math.max(0, prompt - cached - cacheCreation);
  const cacheReadPerMTok = pricing.cacheReadPerMTokUsd ?? inputPerMTokUsd;
  const cacheWritePerMTok = pricing.cacheWritePerMTokUsd ?? inputPerMTokUsd;
  return (
    (regularPrompt * inputPerMTokUsd) / 1_000_000 +
    (cached * cacheReadPerMTok) / 1_000_000 +
    (cacheCreation * cacheWritePerMTok) / 1_000_000 +
    (completion * outputPerMTokUsd) / 1_000_000
  );
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
  const u = usage as {
    prompt_tokens?: unknown;
    completion_tokens?: unknown;
    input_tokens?: unknown;
    output_tokens?: unknown;
    cache_read_input_tokens?: unknown;
    cache_creation_input_tokens?: unknown;
    input_tokens_details?: unknown;
    prompt_tokens_details?: unknown;
  };
  const inputDetails =
    u.input_tokens_details && typeof u.input_tokens_details === "object"
      ? (u.input_tokens_details as {
          cached_tokens?: unknown;
          cache_write_tokens?: unknown;
          cache_creation_tokens?: unknown;
          cache_creation_input_tokens?: unknown;
        })
      : undefined;
  const promptDetails =
    u.prompt_tokens_details && typeof u.prompt_tokens_details === "object"
      ? (u.prompt_tokens_details as {
          cached_tokens?: unknown;
          cache_write_tokens?: unknown;
          cache_creation_tokens?: unknown;
          cache_creation_input_tokens?: unknown;
        })
      : undefined;
  const cachedPromptTokens =
    finiteNonNegative(promptDetails?.cached_tokens) ??
    finiteNonNegative(inputDetails?.cached_tokens) ??
    finiteNonNegative(u.cache_read_input_tokens);
  const cacheCreationPromptTokens =
    finiteNonNegative(promptDetails?.cache_write_tokens) ??
    finiteNonNegative(promptDetails?.cache_creation_tokens) ??
    finiteNonNegative(promptDetails?.cache_creation_input_tokens) ??
    finiteNonNegative(inputDetails?.cache_write_tokens) ??
    finiteNonNegative(inputDetails?.cache_creation_tokens) ??
    finiteNonNegative(inputDetails?.cache_creation_input_tokens) ??
    finiteNonNegative(u.cache_creation_input_tokens);
  const basePrompt = finiteNonNegative(u.prompt_tokens);
  const inputTokens = finiteNonNegative(u.input_tokens);
  const anthropicSeparateCache =
    finiteNonNegative(u.cache_read_input_tokens) !== undefined ||
    finiteNonNegative(u.cache_creation_input_tokens) !== undefined;
  const anthropicStylePrompt =
    inputTokens !== undefined && anthropicSeparateCache
      ? inputTokens +
        (finiteNonNegative(u.cache_read_input_tokens) ?? 0) +
        (finiteNonNegative(u.cache_creation_input_tokens) ?? 0)
      : undefined;
  const promptTokens = basePrompt ?? anthropicStylePrompt ?? inputTokens;
  const completionTokens =
    finiteNonNegative(u.completion_tokens) ?? finiteNonNegative(u.output_tokens);
  const out: TokenUsage = { promptTokens, completionTokens };
  if (cachedPromptTokens !== undefined) out.cachedPromptTokens = cachedPromptTokens;
  if (cacheCreationPromptTokens !== undefined)
    out.cacheCreationPromptTokens = cacheCreationPromptTokens;
  return out;
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

// The memory compaction model's auto-resolved inputs: per-MTok prices + the
// model's context window, looked up from the SAME catalog path cost telemetry
// trusts. Every field is nullable — null means "unknown", and the compaction
// policy applies its own deterministic fallbacks (NOT here, so the heuristics
// stay unit-testable in one place). Fail-open: an unknown/absent model key
// resolves to all-null, never throws (principle 3).
export interface ResolvedCompactionPricing {
  modelKey: string | null; // echo of the matched key, for provenance logging
  inputPerMtok: number | null;
  outputPerMtok: number | null;
  cacheReadPerMtok: number | null;
  cacheWritePerMtok: number | null;
  maxContextTokens: number | null;
}

export function resolveCompactionPricing(
  catalog: ReadonlyMap<string, CatalogEntry>,
  modelKey: string | null | undefined,
): ResolvedCompactionPricing {
  const entry = modelKey != null ? catalog.get(modelKey) : undefined;
  if (entry === undefined) {
    return {
      modelKey: null,
      inputPerMtok: null,
      outputPerMtok: null,
      cacheReadPerMtok: null,
      cacheWritePerMtok: null,
      maxContextTokens: null,
    };
  }
  // maxContextTokens=0 is the catalog's "unknown" placeholder for
  // override-introduced keys — surface it as null, not a real 0 window.
  const maxContext = entry.capabilities.maxContextTokens;
  return {
    modelKey: entry.modelKey,
    inputPerMtok: entry.pricing.inputPerMTokUsd ?? null,
    outputPerMtok: entry.pricing.outputPerMTokUsd ?? null,
    cacheReadPerMtok: entry.pricing.cacheReadPerMTokUsd ?? null,
    cacheWritePerMtok: entry.pricing.cacheWritePerMTokUsd ?? null,
    maxContextTokens: maxContext > 0 ? maxContext : null,
  };
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
