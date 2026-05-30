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
}

// Assemble the complete DecisionRecord, every field filled (explicit null where
// the spec requires null — never omitted). The request is the source of the
// trace id (the pipeline uses request_id as the trace id). The whole record is
// passed through `redact` so no plaintext key / private payload survives even if
// an upstream segment accidentally carried one (principle 7, last gate).
export function buildDecisionRecord(parts: DecisionParts): DecisionRecord {
  const { request, classification, policy, lane, attempts, final } = parts;

  const record: DecisionRecord = {
    request_id: request.request_id,
    trace_id: request.request_id,
    requested_model: request.requested_model,
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
  };

  // Last gate before the record leaves core: irreversibly fingerprint any
  // plaintext key and summarize any private payload that slipped into a field.
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
