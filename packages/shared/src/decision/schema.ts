import { z } from "zod";

// Decision record — the full routing trail for one request: classification,
// matched policy, selected lane + candidate chain, every provider attempt, and
// the final landing. Persisted by telemetry; rebuilt by the Debug UI. Single
// source of truth via z.infer. See docs/02, 03, 04, 07.
//
// Phase 0 (passthrough): real routing is not wired yet, so degraded-but-complete
// values must validate (decided_by:"default", single attempt, single-model chain).
// CLAUDE.md principle 5: classification fallback (classifier.decided_by) and
// execution fallback (provider_attempts) are SEPARATE fields, never conflated.

export const DecidedBySchema = z.enum(["rules", "eval", "default"]);
export const AttemptStatusSchema = z.enum(["ok", "error"]);

export const ClassifierDecisionSchema = z.object({
  task_type: z.string(),
  complexity: z.string(),
  confidence: z.number().min(0).max(1),
  decided_by: DecidedBySchema,
  eval_cache_hit: z.boolean().nullable(), // null when eval was not triggered
  constraints: z.record(z.string(), z.unknown()), // docs/03 constraint bitmap; not deep-validated in MVP
  explanation: z.array(z.unknown()), // matched dimensions / signals
});

export const PolicyDecisionSchema = z.object({
  matched_policy_id: z.string().nullable(),
  reason: z.string(),
});

export const LaneDecisionSchema = z.object({
  selected_lane: z.string(),
  candidate_chain: z.array(z.string()), // ordered primary + fallback aliases
});

export const ProviderAttemptSchema = z.object({
  alias: z.string(),
  skipped: z.boolean(),
  skip_reason: z.string().nullable(),
  status: AttemptStatusSchema,
  error_class: z.string().nullable(),
  latency_ms: z.number().nonnegative(),
  cost_usd: z.number().nullable(),
});

export const FinalDecisionSchema = z.object({
  model_alias: z.string().nullable(),
  provider_model: z.string().nullable(),
  status: AttemptStatusSchema,
  error_reason: z.string().nullable(),
});

export const DecisionRecordSchema = z.object({
  request_id: z.string().min(1),
  // Threaded end-to-end from the request context for cross-system correlation
  // (Debug UI Trace ID column, structured logs). In the current pipeline this
  // equals request_id (the orchestrator uses request_id as the trace id).
  trace_id: z.string().min(1),
  requested_model: z.string(),
  classifier: ClassifierDecisionSchema,
  policy: PolicyDecisionSchema,
  lane: LaneDecisionSchema,
  provider_attempts: z.array(ProviderAttemptSchema),
  final: FinalDecisionSchema,
});

export type DecidedBy = z.infer<typeof DecidedBySchema>;
export type AttemptStatus = z.infer<typeof AttemptStatusSchema>;
export type ClassifierDecision = z.infer<typeof ClassifierDecisionSchema>;
export type PolicyDecision = z.infer<typeof PolicyDecisionSchema>;
export type LaneDecision = z.infer<typeof LaneDecisionSchema>;
export type ProviderAttempt = z.infer<typeof ProviderAttemptSchema>;
export type FinalDecision = z.infer<typeof FinalDecisionSchema>;
export type DecisionRecord = z.infer<typeof DecisionRecordSchema>;
