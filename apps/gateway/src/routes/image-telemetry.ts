import type { DecisionRecord } from "@helm/shared";

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

// Minimal DecisionRecord for a model-pinned image request (no classify/lane/fallback).
export function buildImageDecision(p: {
  traceId: string;
  keyPrefix: string | null;
  requested: string;
  alias: string;
  providerModel: string;
  status: "ok" | "error";
  errorClass: string | null;
  cost: number | null;
  latency: number;
  usage: Record<string, unknown> | null;
}): DecisionRecord {
  const promptTokens = numField(p.usage, "input_tokens", "prompt_tokens");
  const completionTokens = numField(p.usage, "output_tokens", "completion_tokens");
  return {
    request_id: p.traceId,
    trace_id: p.traceId,
    requested_model: p.requested,
    protocol: null,
    key_prefix: p.keyPrefix,
    classifier: PASSTHROUGH_CLASSIFIER,
    policy: { matched_policy_id: null, reason: "image_generation" },
    lane: { selected_lane: "image", candidate_chain: [p.alias] },
    provider_attempts: [
      {
        alias: p.alias,
        skipped: false,
        skip_reason: null,
        status: p.status,
        error_class: p.errorClass,
        latency_ms: p.latency,
        cost_usd: p.status === "ok" ? p.cost : null,
        error_detail: null,
      },
    ],
    final:
      p.status === "ok"
        ? {
            model_alias: p.alias,
            provider_model: p.providerModel,
            status: "ok",
            error_reason: null,
          }
        : { model_alias: null, provider_model: null, status: "error", error_reason: p.errorClass },
    latency_total_ms: p.latency,
    fallback_count: 0,
    cost_breakdown:
      p.status === "ok"
        ? { eval_usd: null, completion_usd: p.cost, total_usd: p.cost }
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
  };
}
