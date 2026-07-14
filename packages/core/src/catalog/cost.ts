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
  cacheCreation5mPromptTokens?: number;
  cacheCreation1hPromptTokens?: number;
  imageOutputTokens?: number;
  audioPromptTokens?: number;
  cachedAudioPromptTokens?: number;
  serviceTier?: string;
  inferenceGeo?: string;
}

// Compute the USD cost of one attempt/eval from its token usage and the model's
// pricing. Returns null when pricing is unavailable (entry absent, or either
// per-MTok rate is null). Absent token counts are treated as 0 (a measured
// number), so a priced model with no reported usage costs 0, not null.
export function computeCostUsd(pricing: Pricing | undefined, usage: TokenUsage): number | null {
  if (!pricing) return null;
  const prompt = usage.promptTokens ?? 0;
  const normalizedServiceTier = usage.serviceTier?.trim().toLowerCase();
  const namedServiceTier =
    normalizedServiceTier !== undefined &&
    !["auto", "default", "standard", "unspecified"].includes(normalizedServiceTier)
      ? normalizedServiceTier
      : undefined;
  const servicePricing =
    namedServiceTier !== undefined ? pricing.serviceTiers?.[namedServiceTier] : undefined;
  // A provider says it used a non-standard tier but the catalog has no official
  // card for it, or the request exceeds that card's published range: unknown is
  // more accurate than silently applying standard/short-context prices.
  if (namedServiceTier !== undefined && servicePricing === undefined) return null;
  if (servicePricing?.maxPromptTokens !== undefined && prompt > servicePricing.maxPromptTokens) {
    return null;
  }
  // Context tiers are full-request bands: select the highest crossed threshold,
  // then price every token in this request with that rate card.
  const contextTier = (
    servicePricing?.contextTiers ??
    (servicePricing === undefined ? pricing.contextTiers : undefined)
  )
    ?.filter((tier) => prompt >= tier.minPromptTokens)
    .at(-1);
  const inputPerMTokUsd =
    contextTier?.inputPerMTokUsd ?? servicePricing?.inputPerMTokUsd ?? pricing.inputPerMTokUsd;
  const outputPerMTokUsd =
    contextTier?.outputPerMTokUsd ?? servicePricing?.outputPerMTokUsd ?? pricing.outputPerMTokUsd;
  if (inputPerMTokUsd === null || outputPerMTokUsd === null) return null;
  const completion = usage.completionTokens ?? 0;
  const cached = usage.cachedPromptTokens ?? 0;
  const cacheCreation = usage.cacheCreationPromptTokens ?? 0;
  if (
    (usage.promptTokens === undefined &&
      (usage.cachedPromptTokens !== undefined ||
        usage.cacheCreationPromptTokens !== undefined ||
        usage.audioPromptTokens !== undefined ||
        usage.cachedAudioPromptTokens !== undefined)) ||
    (usage.completionTokens === undefined && usage.imageOutputTokens !== undefined) ||
    cached + cacheCreation > prompt ||
    (usage.audioPromptTokens !== undefined && usage.audioPromptTokens > prompt) ||
    (usage.cachedAudioPromptTokens !== undefined &&
      (usage.cachedAudioPromptTokens > cached ||
        usage.cachedAudioPromptTokens > (usage.audioPromptTokens ?? 0)))
  ) {
    return null;
  }
  const regularPrompt = Math.max(0, prompt - cached - cacheCreation);
  const cacheReadPerMTok =
    contextTier?.cacheReadPerMTokUsd ??
    servicePricing?.cacheReadPerMTokUsd ??
    pricing.cacheReadPerMTokUsd ??
    inputPerMTokUsd;
  const cacheWritePerMTok =
    contextTier?.cacheWritePerMTokUsd ??
    servicePricing?.cacheWritePerMTokUsd ??
    pricing.cacheWritePerMTokUsd ??
    inputPerMTokUsd;
  const cacheWrite1hPerMTok =
    contextTier?.cacheWrite1hPerMTokUsd ??
    servicePricing?.cacheWrite1hPerMTokUsd ??
    pricing.cacheWrite1hPerMTokUsd ??
    cacheWritePerMTok;
  // Defensive partition: malformed provider details must never make the priced
  // sub-buckets exceed the aggregate cache-creation count.
  const cacheWrite5m = Math.min(cacheCreation, usage.cacheCreation5mPromptTokens ?? 0);
  const cacheWrite1h = Math.min(
    Math.max(0, cacheCreation - cacheWrite5m),
    usage.cacheCreation1hPromptTokens ?? 0,
  );
  const cacheWriteUnclassified = Math.max(0, cacheCreation - cacheWrite5m - cacheWrite1h);
  const audioPrompt = Math.min(prompt, usage.audioPromptTokens ?? 0);
  const cachedAudio = Math.min(cached, audioPrompt, usage.cachedAudioPromptTokens ?? 0);
  const freshAudio = Math.min(regularPrompt, Math.max(0, audioPrompt - cachedAudio));
  const regularNonAudio = Math.max(0, regularPrompt - freshAudio);
  const cachedNonAudio = Math.max(0, cached - cachedAudio);
  const audioInputPerMTok =
    contextTier?.audioInputPerMTokUsd ??
    servicePricing?.audioInputPerMTokUsd ??
    pricing.audioInputPerMTokUsd ??
    inputPerMTokUsd;
  const audioCacheReadPerMTok =
    contextTier?.audioCacheReadPerMTokUsd ??
    servicePricing?.audioCacheReadPerMTokUsd ??
    pricing.audioCacheReadPerMTokUsd ??
    cacheReadPerMTok;
  // A split-rate model without a provider-reported modality partition cannot be
  // priced exactly. Preserve the honest unknown sentinel instead of silently
  // treating image/audio tokens as ordinary text tokens.
  if (
    prompt > 0 &&
    audioInputPerMTok !== inputPerMTokUsd &&
    usage.audioPromptTokens === undefined
  ) {
    return null;
  }
  if (
    cached > 0 &&
    audioPrompt > 0 &&
    audioCacheReadPerMTok !== cacheReadPerMTok &&
    usage.cachedAudioPromptTokens === undefined
  ) {
    return null;
  }
  const imageOutput = Math.min(completion, usage.imageOutputTokens ?? 0);
  const regularOutput = Math.max(0, completion - imageOutput);
  const imageOutputPerMTok =
    contextTier?.imageOutputPerMTokUsd ??
    servicePricing?.imageOutputPerMTokUsd ??
    pricing.imageOutputPerMTokUsd ??
    outputPerMTokUsd;
  if (
    completion > 0 &&
    imageOutputPerMTok !== outputPerMTokUsd &&
    usage.imageOutputTokens === undefined
  ) {
    return null;
  }
  const baseCost =
    (regularNonAudio * inputPerMTokUsd) / 1_000_000 +
    (freshAudio * audioInputPerMTok) / 1_000_000 +
    (cachedNonAudio * cacheReadPerMTok) / 1_000_000 +
    (cachedAudio * audioCacheReadPerMTok) / 1_000_000 +
    (cacheWrite5m * cacheWritePerMTok) / 1_000_000 +
    (cacheWrite1h * cacheWrite1hPerMTok) / 1_000_000 +
    (cacheWriteUnclassified * cacheWritePerMTok) / 1_000_000 +
    (regularOutput * outputPerMTokUsd) / 1_000_000 +
    (imageOutput * imageOutputPerMTok) / 1_000_000;
  const inferenceGeo = usage.inferenceGeo?.trim().toLowerCase();
  if (inferenceGeo === undefined) return baseCost;
  const geoMultiplier = pricing.inferenceGeoMultipliers?.[inferenceGeo];
  // A response-confirmed geo without a configured official multiplier is an
  // unknown price dimension, not permission to silently apply the global card.
  return geoMultiplier === undefined ? null : baseCost * geoMultiplier;
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
  const root = body as { usage?: unknown; service_tier?: unknown } | null | undefined;
  const usage = root?.usage;
  if (!usage || typeof usage !== "object") return {};
  const u = usage as {
    prompt_tokens?: unknown;
    completion_tokens?: unknown;
    input_tokens?: unknown;
    output_tokens?: unknown;
    cache_read_input_tokens?: unknown;
    cache_creation_input_tokens?: unknown;
    cache_creation?: unknown;
    prompt_cache_hit_tokens?: unknown;
    input_tokens_details?: unknown;
    prompt_tokens_details?: unknown;
    output_tokens_details?: unknown;
    completion_tokens_details?: unknown;
    service_tier?: unknown;
    speed?: unknown;
    inference_geo?: unknown;
  };
  const inputDetails =
    u.input_tokens_details && typeof u.input_tokens_details === "object"
      ? (u.input_tokens_details as {
          cached_tokens?: unknown;
          cache_write_tokens?: unknown;
          cache_creation_tokens?: unknown;
          cache_creation_input_tokens?: unknown;
          ephemeral_5m_input_tokens?: unknown;
          ephemeral_1h_input_tokens?: unknown;
          audio_tokens?: unknown;
          cached_audio_tokens?: unknown;
        })
      : undefined;
  const promptDetails =
    u.prompt_tokens_details && typeof u.prompt_tokens_details === "object"
      ? (u.prompt_tokens_details as {
          cached_tokens?: unknown;
          cache_write_tokens?: unknown;
          cache_creation_tokens?: unknown;
          cache_creation_input_tokens?: unknown;
          ephemeral_5m_input_tokens?: unknown;
          ephemeral_1h_input_tokens?: unknown;
          audio_tokens?: unknown;
          cached_audio_tokens?: unknown;
        })
      : undefined;
  const cacheCreationDetails =
    u.cache_creation && typeof u.cache_creation === "object"
      ? (u.cache_creation as {
          ephemeral_5m_input_tokens?: unknown;
          ephemeral_1h_input_tokens?: unknown;
        })
      : undefined;
  const outputTokenDetails =
    u.output_tokens_details && typeof u.output_tokens_details === "object"
      ? u.output_tokens_details
      : undefined;
  const completionTokenDetails =
    u.completion_tokens_details && typeof u.completion_tokens_details === "object"
      ? u.completion_tokens_details
      : undefined;
  const outputDetails =
    outputTokenDetails !== undefined || completionTokenDetails !== undefined
      ? ({
          ...(completionTokenDetails ?? {}),
          ...(outputTokenDetails ?? {}),
        } as {
          text_tokens?: unknown;
          image_tokens?: unknown;
          audio_tokens?: unknown;
          video_tokens?: unknown;
        })
      : undefined;
  const cachedPromptTokens =
    finiteNonNegative(promptDetails?.cached_tokens) ??
    finiteNonNegative(inputDetails?.cached_tokens) ??
    finiteNonNegative(u.cache_read_input_tokens) ??
    finiteNonNegative(u.prompt_cache_hit_tokens);
  const cacheCreation5mPromptTokens =
    finiteNonNegative(cacheCreationDetails?.ephemeral_5m_input_tokens) ??
    finiteNonNegative(promptDetails?.ephemeral_5m_input_tokens) ??
    finiteNonNegative(inputDetails?.ephemeral_5m_input_tokens);
  const cacheCreation1hPromptTokens =
    finiteNonNegative(cacheCreationDetails?.ephemeral_1h_input_tokens) ??
    finiteNonNegative(promptDetails?.ephemeral_1h_input_tokens) ??
    finiteNonNegative(inputDetails?.ephemeral_1h_input_tokens);
  const explicitCacheCreationPromptTokens =
    finiteNonNegative(promptDetails?.cache_write_tokens) ??
    finiteNonNegative(promptDetails?.cache_creation_tokens) ??
    finiteNonNegative(promptDetails?.cache_creation_input_tokens) ??
    finiteNonNegative(inputDetails?.cache_write_tokens) ??
    finiteNonNegative(inputDetails?.cache_creation_tokens) ??
    finiteNonNegative(inputDetails?.cache_creation_input_tokens) ??
    finiteNonNegative(u.cache_creation_input_tokens);
  const cacheCreationPromptTokens =
    explicitCacheCreationPromptTokens ??
    (cacheCreation5mPromptTokens !== undefined || cacheCreation1hPromptTokens !== undefined
      ? (cacheCreation5mPromptTokens ?? 0) + (cacheCreation1hPromptTokens ?? 0)
      : undefined);
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
  const serviceTier =
    typeof root?.service_tier === "string"
      ? root.service_tier
      : typeof u.service_tier === "string"
        ? u.service_tier
        : typeof u.speed === "string"
          ? u.speed
          : undefined;
  if (serviceTier !== undefined) out.serviceTier = serviceTier;
  if (typeof u.inference_geo === "string") out.inferenceGeo = u.inference_geo;
  if (cachedPromptTokens !== undefined) out.cachedPromptTokens = cachedPromptTokens;
  if (cacheCreationPromptTokens !== undefined)
    out.cacheCreationPromptTokens = cacheCreationPromptTokens;
  if (cacheCreation5mPromptTokens !== undefined)
    out.cacheCreation5mPromptTokens = cacheCreation5mPromptTokens;
  if (cacheCreation1hPromptTokens !== undefined)
    out.cacheCreation1hPromptTokens = cacheCreation1hPromptTokens;
  const hasOutputModalityPartition =
    finiteNonNegative(outputDetails?.text_tokens) !== undefined ||
    finiteNonNegative(outputDetails?.image_tokens) !== undefined ||
    finiteNonNegative(outputDetails?.audio_tokens) !== undefined ||
    finiteNonNegative(outputDetails?.video_tokens) !== undefined;
  const imageOutputTokens =
    finiteNonNegative(outputDetails?.image_tokens) ?? (hasOutputModalityPartition ? 0 : undefined);
  if (imageOutputTokens !== undefined) out.imageOutputTokens = imageOutputTokens;
  const audioPromptTokens =
    finiteNonNegative(inputDetails?.audio_tokens) ?? finiteNonNegative(promptDetails?.audio_tokens);
  if (audioPromptTokens !== undefined) out.audioPromptTokens = audioPromptTokens;
  const cachedAudioPromptTokens =
    finiteNonNegative(inputDetails?.cached_audio_tokens) ??
    finiteNonNegative(promptDetails?.cached_audio_tokens);
  if (cachedAudioPromptTokens !== undefined) out.cachedAudioPromptTokens = cachedAudioPromptTokens;
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
  contextTiers?: Pricing["contextTiers"];
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
    ...(entry.pricing.contextTiers !== undefined
      ? { contextTiers: entry.pricing.contextTiers }
      : {}),
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
  const usage = usageFromBody(body);
  // A successful body with no usage is not a measured free request. Preserve the
  // honest null sentinel; explicit zero token fields still survive as real zeroes.
  const { serviceTier: _serviceTier, inferenceGeo: _inferenceGeo, ...tokenUsage } = usage;
  if (Object.values(tokenUsage).every((value) => value === undefined)) return null;
  return computeCostUsd(pricing, usage);
}
