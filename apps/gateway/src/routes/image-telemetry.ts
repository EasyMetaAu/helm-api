import type { DecisionRecord, ProviderAttempt } from "@helm/shared";

// Shared telemetry helpers for the model-pinned image-generation routes
// (POST /v1/images/generations and POST /v1beta/interactions). Both bypass the
// classify→lane→fallback pipeline (image gen has none of that), so they build a
// minimal DecisionRecord with a fixed passthrough classifier and the `image` lane —
// one source of truth so the two routes never drift.

// Image generation has no classification — a fixed passthrough classifier, mirroring
// route-request.ts's explicit-passthrough records.
export const PASSTHROUGH_CLASSIFIER: DecisionRecord["classifier"] = {
  task_type: "passthrough",
  complexity: "passthrough",
  confidence: 1,
  decided_by: "default",
  rules_confidence: null,
  eval_cache_hit: null,
  eval_model: null,
  eval_latency_ms: null,
  fallback_reason: null,
  constraints: {},
  explanation: [],
};

export function numField(o: Record<string, unknown> | null, ...keys: string[]): number | null {
  if (o === null) return null;
  for (const k of keys) {
    const v = o[k];
    if (typeof v === "number" && Number.isFinite(v) && v >= 0) return v;
  }
  return null;
}

// DecisionRecord for a model-pinned image request, chain-aware: a single bare-model
// request produces a one-row chain; an image LANE produces one row per attempted /
// skipped provider, with `final` bound to the alias that actually SERVED (cost
// attribution in /admin/requests keys on the served leaf, not the requested lane).
// All derived fields (latency total, fallback count, cost) are computed FROM the
// attempts array, mirroring how the chat executor's attempts become a DecisionRecord.
export function buildImageDecision(p: {
  traceId: string;
  keyPrefix: string | null;
  requested: string; // the client-sent id (lane name OR bare model)
  selectedLane: string; // the lane name, or "image" for a bare model
  candidateChain: string[]; // the full expanded chain (alias order)
  attempts: ProviderAttempt[]; // ALL rows: skipped / failed / served
  served: { alias: string; providerModel: string } | null; // null on terminal error
  finalErrorClass: string | null; // the terminal error class (error case)
  usage: Record<string, unknown> | null; // the SERVED upstream body's usage
}): DecisionRecord {
  const promptTokens = numField(p.usage, "input_tokens", "prompt_tokens");
  const completionTokens = numField(p.usage, "output_tokens", "completion_tokens");
  const attempted = p.attempts.filter((a) => !a.skipped);
  const costed = p.attempts.filter((a) => a.cost_usd !== null);
  const completionUsd =
    costed.length > 0 ? costed.reduce((sum, a) => sum + (a.cost_usd ?? 0), 0) : null;
  return {
    request_id: p.traceId,
    trace_id: p.traceId,
    requested_model: p.requested,
    protocol: null,
    key_prefix: p.keyPrefix,
    classifier: PASSTHROUGH_CLASSIFIER,
    policy: { matched_policy_id: null, reason: "image_generation" },
    lane: { selected_lane: p.selectedLane, candidate_chain: p.candidateChain },
    provider_attempts: p.attempts,
    final:
      p.served !== null
        ? {
            model_alias: p.served.alias,
            provider_model: p.served.providerModel,
            status: "ok",
            error_reason: null,
          }
        : {
            model_alias: null,
            provider_model: null,
            status: "error",
            error_reason: p.finalErrorClass,
          },
    latency_total_ms: p.attempts.reduce((sum, a) => sum + a.latency_ms, 0),
    fallback_count: Math.max(0, attempted.length - 1),
    cost_breakdown:
      p.served !== null
        ? { eval_usd: null, completion_usd: completionUsd, total_usd: completionUsd }
        : { eval_usd: null, completion_usd: null, total_usd: null },
    memory: null,
    usage:
      promptTokens === null && completionTokens === null
        ? null
        : {
            prompt_tokens: promptTokens,
            completion_tokens: completionTokens,
            cached_tokens: null,
            cache_creation_tokens: null,
          },
    generation_ms: null,
    serving_account: null,
  };
}
