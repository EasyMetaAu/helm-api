import type { DecisionRecord } from "./schema.js";

// The lane/result view a key holder is entitled to see for THEIR OWN request
// (spec §4.3). WHITELIST projection: only fields listed here reach the portal —
// so adding a field to DecisionRecord can never silently leak it (a blacklist
// would). Deliberately absent: provider aliases, serving_account, wire model ids,
// the classifier/eval reasoning chain, the candidate chain, upstream payload —
// all routing topology / supply-chain IP (principle 6, §8 R7).
export interface PortalDecisionView {
  /** Unique Helm-generated lookup/ownership id returned as X-Helm-Request-Id. */
  request_id: string;
  /** Caller-facing correlation metadata. It is safe to show but not to use for lookup. */
  trace_id: string;
  requested_model: string;
  /** The lane-visible served model = final.model_alias (the user already sees this
   *  in their response). NEVER final.provider_model (the internal wire id). */
  served_model: string | null;
  lane: string;
  status: DecisionRecord["final"]["status"];
  /** Terminal error CLASS only (e.g. "all_providers_failed") — an error taxonomy
   *  code, not a provider identity. Null on success. */
  error_reason: string | null;
  latency_ms: number;
  /** Total cost in USD (self-hosted cost transparency, §4.3). null = not measured. */
  cost_usd: number | null;
  usage: {
    prompt_tokens: number | null;
    completion_tokens: number | null;
    cached_tokens: number | null;
    cache_creation_tokens: number | null;
  } | null;
}

export function toPortalDecisionView(record: DecisionRecord): PortalDecisionView {
  return {
    request_id: record.request_id,
    trace_id: record.trace_id,
    requested_model: record.requested_model,
    served_model: record.final.model_alias,
    lane: record.lane.selected_lane,
    status: record.final.status,
    error_reason: record.final.error_reason,
    latency_ms: record.latency_total_ms,
    cost_usd: record.cost_breakdown.total_usd,
    usage: record.usage
      ? {
          prompt_tokens: record.usage.prompt_tokens,
          completion_tokens: record.usage.completion_tokens,
          cached_tokens: record.usage.cached_tokens,
          cache_creation_tokens: record.usage.cache_creation_tokens,
        }
      : null,
  };
}
