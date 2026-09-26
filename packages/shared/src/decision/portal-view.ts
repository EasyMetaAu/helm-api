import type { DecisionRecord } from "./schema.js";

// The lane/result view a key holder is entitled to see for THEIR OWN request
// (spec §4.3). WHITELIST projection: only fields listed here reach the portal —
// so adding a field to DecisionRecord can never silently leak it (a blacklist
// would). Deliberately absent: provider aliases, serving_account, wire model ids,
// the classifier/eval reasoning chain, the candidate chain, upstream payload —
// all routing topology / supply-chain IP (principle 6, §8 R7). `attempts` shows
// that a fallback happened (outcome + latency per try) WITHOUT naming which
// alias/provider/model was tried — that stays supply-chain internal.
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
  /** Client-requested reasoning level, before any policy/lane override. */
  requested_reasoning_effort: string | null;
  /** Effective reasoning level actually routed. */
  reasoning_effort: string | null;
  /** Wall-clock generation window (ms) of the served stream. null for
   *  non-streaming/legacy — kept distinct from a measured 0. */
  generation_ms: number | null;
  /** Derived throughput = completion_tokens / (generation_ms / 1000). null when
   *  either input isn't measured (mirrors admin's computeTps — never re-derives
   *  from anything the backend didn't already record). */
  tps: number | null;
  /** Time-to-first-token (ms): only meaningful when a generation window was
   *  measured (streaming), in which case latency_total_ms IS the wait for the
   *  first token (attempts run sequentially). Mirrors admin's computeTtfbMs. */
  ttfb_ms: number | null;
  /** Fallback attempts actually made for THIS request — outcome + latency ONLY.
   *  Deliberately excludes alias/provider_name/provider_model (routing topology
   *  / supply chain, principle 6 §8 R7): a key holder may see "attempt 1 timed
   *  out, attempt 2 succeeded" but never WHICH provider/model was tried. */
  attempts: Array<{
    outcome: "success" | "error" | "timeout" | "rate_limited" | "circuit_open" | "skipped";
    latency_ms: number;
  }>;
}

function attemptOutcome(
  a: DecisionRecord["provider_attempts"][number],
): PortalDecisionView["attempts"][number]["outcome"] {
  if (a.skipped) return "skipped";
  if (a.status === "ok") return "success";
  const ec = a.error_class ?? "";
  if (ec === "timeout" || ec === "rate_limited" || ec === "circuit_open") return ec;
  return "error";
}

export function toPortalDecisionView(record: DecisionRecord): PortalDecisionView {
  const completionTokens = record.usage?.completion_tokens ?? null;
  const generationMs = record.generation_ms;
  const tps =
    completionTokens !== null && generationMs !== null && generationMs > 0
      ? completionTokens / (generationMs / 1000)
      : null;
  const ttfbMs = generationMs !== null ? record.latency_total_ms : null;
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
    requested_reasoning_effort: record.requested_reasoning_effort ?? null,
    reasoning_effort: record.reasoning_effort ?? null,
    generation_ms: generationMs,
    tps,
    ttfb_ms: ttfbMs,
    attempts: record.provider_attempts.map((a) => ({
      outcome: attemptOutcome(a),
      latency_ms: a.latency_ms,
    })),
  };
}
