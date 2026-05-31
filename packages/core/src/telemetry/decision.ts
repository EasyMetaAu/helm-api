import type { DecisionRecord, InternalRequest } from "@helm/shared";
import type { AttemptRecord } from "../executor/fallback.js";
import type { InsertTelemetryInput, TelemetryStore } from "../store/ports.js";
import { redact } from "./redaction.js";

// telemetry.decision — assemble the scattered intermediate results of the
// routing pipeline (classification, policy, lane, provider attempt chain, final
// landing) into the ONE complete DecisionRecord of docs/02, then persist it.
//
// The decision record is an OBSERVABILITY artifact, not the success/failure
// judge of the request path:
//   • fail-open (CLAUDE.md principle 3): a telemetry write failure must NEVER
//     turn a served request into a 5xx — the worst case is one lost record plus
//     a structured warning.
//   • redaction (principle 7): a plaintext key / private payload must never
//     reach the store — the record is run through `redact` as the last gate.
//
// Two fallbacks stay separate (principle 5): `classifier.decided_by` records the
// CLASSIFICATION fallback (rules | eval | default); `provider_attempts` records
// the EXECUTION fallback (the in-chain model swaps). They are never conflated.

// Classification segment the assembler consumes. Mirrors @helm/shared
// ClassifierDecision; `decided_by`/`eval_cache_hit`/`constraints`/`explanation`
// are produced by the classifier cascade (classifier.engine + eval), already
// fail-open internally.
export interface ClassifierOutput {
  task_type: string;
  complexity: string;
  confidence: number;
  decided_by: "rules" | "eval" | "default";
  /** boolean only when eval was triggered; null otherwise (NOT false). */
  eval_cache_hit: boolean | null;
  constraints: Record<string, unknown>;
  explanation: unknown[];
}

// Policy segment — the matched policy id (null when none matched) + reason.
export interface PolicyOutcome {
  matched_policy_id: string | null;
  reason: string;
}

// Lane segment — the selected lane and its ordered (primary -> fallback)
// candidate alias chain, as produced by the Lane Resolver + chain expansion.
export interface LaneSelection {
  selected_lane: string;
  candidate_chain: string[];
}

// Final landing — exactly one of an ok terminal (selected alias + provider
// model) or a structured error terminal (error_reason is a docs/07 error_class,
// e.g. all_providers_failed). The aliases/models are null on the error branch.
export type FinalOutcome =
  | {
      status: "ok";
      model_alias: string;
      provider_model: string;
      error_reason: null;
    }
  | {
      status: "error";
      model_alias: null;
      provider_model: null;
      error_reason: string;
    };

// All the intermediate results needed to assemble one record.
export interface DecisionParts {
  request: InternalRequest;
  classification: ClassifierOutput;
  policy: PolicyOutcome;
  lane: LaneSelection;
  /** Straight from executor.fallback — includes skipped candidates, in order. */
  attempts: AttemptRecord[];
  final: FinalOutcome;
  /** Display prefix of the resolved auth key (e.g. helm_live_ab12). PREFIX ONLY
   *  — never the plaintext key (principle 7). Null/undefined when unknown. */
  keyPrefix?: string | null;
  /** Layer-2 eval self-cost in USD, known ONLY when eval actually ran (the eval
   *  client surfaces it from the small-model usage). Null/undefined when eval was
   *  skipped/disabled — kept SEPARATE from completion cost (docs/07; principle 5). */
  evalUsd?: number | null;
}

// completion_usd = Σ of the served attempts' cost. Null (not a measured 0) when
// no attempt carried a cost — so "unknown" stays distinct from "free".
function sumCompletionCost(attempts: AttemptRecord[]): number | null {
  return attempts.reduce<number | null>((acc, a) => {
    if (a.cost_usd === null) return acc;
    return (acc ?? 0) + a.cost_usd;
  }, null);
}

// EXECUTION-stage fallback count (principle 5; NOT the classification fallback):
// number of real (non-skipped) attempts beyond the first, clamped ≥0. Skipped
// candidates (capability filter / circuit-open) are not swaps.
function executionFallbackCount(attempts: AttemptRecord[]): number {
  const served = attempts.filter((a) => !a.skipped).length;
  return Math.max(0, served - 1);
}

// Assemble the complete DecisionRecord, every field filled (explicit null where
// the spec requires null — never omitted). The request is the source of the
// trace id (the pipeline uses request_id as the trace id). The whole record is
// passed through `redact` so no plaintext key / private payload survives even if
// an upstream segment accidentally carried one (principle 7, last gate).
export function buildDecisionRecord(parts: DecisionParts): DecisionRecord {
  const { request, classification, policy, lane, attempts, final } = parts;

  const keyPrefix = parts.keyPrefix ?? null;
  const completionUsd = sumCompletionCost(attempts);
  const evalUsd = parts.evalUsd ?? null;
  // total = eval + completion, but null when BOTH are unknown (preserve "not
  // measured"); a measured side still contributes when the other is unknown.
  const totalUsd =
    evalUsd === null && completionUsd === null ? null : (evalUsd ?? 0) + (completionUsd ?? 0);

  const record: DecisionRecord = {
    request_id: request.request_id,
    trace_id: request.request_id,
    requested_model: request.requested_model,
    key_prefix: keyPrefix,
    classifier: {
      task_type: classification.task_type,
      complexity: classification.complexity,
      confidence: classification.confidence,
      decided_by: classification.decided_by,
      eval_cache_hit: classification.eval_cache_hit,
      constraints: classification.constraints,
      explanation: classification.explanation,
    },
    policy: {
      matched_policy_id: policy.matched_policy_id,
      reason: policy.reason,
    },
    lane: {
      selected_lane: lane.selected_lane,
      candidate_chain: lane.candidate_chain,
    },
    // Field-for-field identical to ProviderAttemptSchema — copy verbatim, in
    // chain order (skipped candidates included with their skip_reason).
    provider_attempts: attempts.map((a) => ({
      alias: a.alias,
      skipped: a.skipped,
      skip_reason: a.skip_reason,
      status: a.status,
      error_class: a.error_class,
      latency_ms: a.latency_ms,
      cost_usd: a.cost_usd,
    })),
    final: {
      model_alias: final.model_alias,
      provider_model: final.provider_model,
      status: final.status,
      error_reason: final.error_reason,
    },
    latency_total_ms: attempts.reduce((acc, a) => acc + a.latency_ms, 0),
    fallback_count: executionFallbackCount(attempts),
    cost_breakdown: {
      eval_usd: evalUsd,
      completion_usd: completionUsd,
      total_usd: totalUsd,
    },
  };

  // Last gate before the record leaves core: irreversibly fingerprint any
  // plaintext key and summarize any private payload that slipped into a field.
  // `key_prefix` does NOT match the secret pattern (api[_-]?key | … — there is no
  // standalone `key` alternative), so the prefix-only display value survives the
  // pass verbatim (principle 7: prefix only, no plaintext — and no useless
  // double-fingerprinting that would blank the Debug UI key column). The
  // redaction test pins this.
  return redact(record);
}

// Options for persistence. The DecisionRecord intentionally carries NO api key
// (principle 7), but the request-log identity column needs the key_id reference,
// so the caller threads it here (key_id only — never plaintext/hash). `apiKeyId`
// defaults to the request_id correlation id when the caller has nothing better.
export interface PersistDecisionOptions {
  apiKeyId?: string;
  now?: () => Date;
}

// Persist the record through the TelemetryStore (fail-open, principle 3): any
// store error is swallowed with a structured warning — it is NEVER rethrown, so
// the request result is unaffected. The store layer keeps only the redacted
// record + the key_id reference (never plaintext/hash; see ports.ts).
export async function persistDecision(
  store: TelemetryStore,
  record: DecisionRecord,
  opts: PersistDecisionOptions = {},
): Promise<void> {
  const now = opts.now ?? (() => new Date());
  const input: InsertTelemetryInput = {
    decision: record,
    apiKeyId: opts.apiKeyId ?? record.request_id,
    createdAt: now(),
  };
  try {
    await store.insert(input);
  } catch (err) {
    // Structured warning only — fail-open. trace_id correlates the dropped
    // record in the logs.
    console.warn(
      JSON.stringify({
        level: "warn",
        event: "telemetry.persist_failed",
        trace_id: record.trace_id,
        request_id: record.request_id,
        error: err instanceof Error ? err.message : String(err),
      }),
    );
  }
}
