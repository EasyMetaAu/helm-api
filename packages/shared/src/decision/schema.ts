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

// decided_by names the CLASSIFICATION-stage decision source (principle 5; never
// conflated with the execution-stage provider fallback). `fallback` is the
// Layer-3 balanced sink — distinct from the legacy `default` (the orchestrator's
// hard fail-open when classify itself throws); both are kept so the two paths
// stay observable.
export const DecidedBySchema = z.enum(["rules", "eval", "default", "fallback"]);
export const AttemptStatusSchema = z.enum(["ok", "error"]);

export const ClassifierDecisionSchema = z.object({
  task_type: z.string(),
  complexity: z.string(),
  confidence: z.number().min(0).max(1),
  decided_by: DecidedBySchema,
  eval_cache_hit: z.boolean().nullable(), // null when eval was not triggered
  // Present (non-null) ONLY when decided_by === "fallback": WHY we fell open to
  // balanced — `eval_disabled` (uncertain but eval off) vs `eval_<reason>` (eval
  // ran and failed). Null/absent on rules/eval/default paths. Optional so
  // pre-eval records (Phase 0 / passthrough) validate without it. Distinct from
  // the execution-stage fallback (provider_attempts), per principle 5.
  fallback_reason: z.string().nullable().optional(),
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

// Per-attempt upstream error detail (admin-debug-error-detail). Captured ONLY
// for attempts that actually failed at the upstream — it carries WHY a single
// candidate failed even when a LATER candidate served the request (so the
// failure is no longer visible in the terminal `final` error). Mirrors
// HelmError's redacted shape; principle 7: `message`/`provider_raw` are already
// key-scrubbed by the producer and pass through the telemetry `redact` gate.
//   • upstream_status — the REAL upstream HTTP status (e.g. 429/500); null for a
//     timeout / network error with no response.
//   • message         — short, redacted, human-readable (e.g. "upstream returned 429").
//   • provider_raw    — the upstream error body (key-scrubbed), or null when absent.
export const AttemptErrorDetailSchema = z.object({
  upstream_status: z.number().int().nullable(),
  message: z.string(),
  provider_raw: z.record(z.string(), z.unknown()).nullable(),
});

export const ProviderAttemptSchema = z.object({
  alias: z.string(),
  skipped: z.boolean(),
  skip_reason: z.string().nullable(),
  status: AttemptStatusSchema,
  error_class: z.string().nullable(),
  latency_ms: z.number().nonnegative(),
  cost_usd: z.number().nullable(),
  // Present (non-null) ONLY for a genuine upstream failure on THIS attempt;
  // null for ok / skipped rows and for legacy records. `.default(null)` keeps
  // stored pre-feature records round-tripping (always present, never undefined).
  error_detail: AttemptErrorDetailSchema.nullable().default(null),
});

export const FinalDecisionSchema = z.object({
  model_alias: z.string().nullable(),
  provider_model: z.string().nullable(),
  status: AttemptStatusSchema,
  error_reason: z.string().nullable(),
});

// Cost split (docs/07 "cost split (including eval's own self-cost)"). `eval_usd` isolates the
// Layer-2 small-model self-cost (non-null ONLY when eval actually ran; null when
// eval was skipped/disabled) from `completion_usd` (Σ of the served provider
// attempts' cost). `total_usd` is their sum. Each is nullable because upstream
// usage/pricing can be unknown in the MVP — null means "not measured", distinct
// from a measured 0.
export const CostBreakdownSchema = z.object({
  eval_usd: z.number().nullable(),
  completion_usd: z.number().nullable(),
  total_usd: z.number().nullable(),
});

export const DecisionRecordSchema = z.object({
  request_id: z.string().min(1),
  // Threaded end-to-end from the request context for cross-system correlation
  // (Debug UI Trace ID column, structured logs). In the current pipeline this
  // equals request_id (the orchestrator uses request_id as the trace id).
  trace_id: z.string().min(1),
  requested_model: z.string(),
  // Display-only key fingerprint for the Debug UI key column (docs/07
  // "API key / user / org"). PREFIX ONLY — the resolved auth identity's
  // ApiKeyRecord.prefix (e.g. helm_live_ab12), NEVER the plaintext key
  // (principle 7). Null when the key/prefix is unknown. `.default(null)` keeps
  // pre-existing (pre-enrichment) records valid.
  key_prefix: z.string().nullable().default(null),
  classifier: ClassifierDecisionSchema,
  policy: PolicyDecisionSchema,
  lane: LaneDecisionSchema,
  provider_attempts: z.array(ProviderAttemptSchema),
  final: FinalDecisionSchema,
  // Total served latency = Σ provider_attempts.latency_ms (docs/07 latency).
  // `.default(0)` so legacy records validate; the builder computes the real sum.
  latency_total_ms: z.number().nonnegative().default(0),
  // EXECUTION-stage fallback count (principle 5; NEVER the classification
  // fallback): non-skipped attempts minus 1, clamped ≥0. `.default(0)` for
  // legacy records; the builder computes the real value.
  fallback_count: z.number().int().nonnegative().default(0),
  // Cost split incl. eval self-cost (docs/07). `.prefault` so legacy records
  // validate as "not measured"; the builder fills the real split.
  cost_breakdown: CostBreakdownSchema.prefault({
    eval_usd: null,
    completion_usd: null,
    total_usd: null,
  }),
});

export type DecidedBy = z.infer<typeof DecidedBySchema>;
export type AttemptStatus = z.infer<typeof AttemptStatusSchema>;
export type ClassifierDecision = z.infer<typeof ClassifierDecisionSchema>;
export type PolicyDecision = z.infer<typeof PolicyDecisionSchema>;
export type LaneDecision = z.infer<typeof LaneDecisionSchema>;
export type AttemptErrorDetail = z.infer<typeof AttemptErrorDetailSchema>;
export type ProviderAttempt = z.infer<typeof ProviderAttemptSchema>;
export type FinalDecision = z.infer<typeof FinalDecisionSchema>;
export type CostBreakdown = z.infer<typeof CostBreakdownSchema>;
export type DecisionRecord = z.infer<typeof DecisionRecordSchema>;
