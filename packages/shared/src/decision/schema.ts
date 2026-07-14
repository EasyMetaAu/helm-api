import { z } from "zod";
import {
  NativePassthroughMutationLedgerSchema,
  ProtocolSchema,
  TargetProviderProtocolSchema,
} from "../request/schema.js";

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
  // The LAYER-1 rules confidence — the gate value that decided whether the
  // cascade escalated to eval. Persisted separately because on decided_by==="eval"
  // the eval verdict REPLACES `confidence` above (the 0.95 a user sees is the eval
  // model's self-reported confidence, NOT Layer-1's), so without this field the
  // "rules were uncertain (0.05) → escalated → eval said 0.95" causal chain is
  // unrecoverable. Null on passthrough/fail-open default records (no rules ran)
  // and on legacy pre-field records (`.default(null)`).
  rules_confidence: z.number().min(0).max(1).nullable().default(null),
  eval_cache_hit: z.boolean().nullable(), // null when eval was not triggered
  // The internal small-model id that ran Layer-2 eval (e.g. "gpt-4o-mini"), so the
  // Debug UI can show WHICH model judged the lane. Non-null whenever eval actually
  // ran — both when it decided (decided_by==="eval") and when it ran then failed
  // open (decided_by==="fallback", eval_<reason>); null when eval never ran. A
  // model id, never a key/payload (principle 7). `.default(null)` keeps pre-eval
  // (Phase 0 / passthrough / legacy) records validating without it.
  eval_model: z.string().nullable().default(null),
  // Layer-2 eval call latency (ms), surfaced alongside provider-attempt latencies
  // in the Debug UI. Non-null whenever eval ran (decided OR failed open); null when
  // eval never ran. `.default(null)` for legacy records (principle 5: this is the
  // CLASSIFICATION-stage eval timing, never the execution-stage attempt latency).
  eval_latency_ms: z.number().nonnegative().nullable().default(null),
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
  // ——— Native-protocol-passthrough telemetry (issue #217) ———
  // Per-attempt trail for the same-protocol verbatim-forward decision. All
  // OPTIONAL so legacy rows + non-passthrough attempts round-trip untouched.
  // DecisionRecord stays body-free (principle 7): these are protocol/name
  // metadata only, never request/response content.
  passthrough_considered: z.boolean().optional(),
  passthrough_used: z.boolean().optional(),
  passthrough_disable_reason: z.string().nullable().optional(),
  source_protocol: ProtocolSchema.nullable().optional(),
  target_provider_protocol: TargetProviderProtocolSchema.nullable().optional(),
  response_protocol: ProtocolSchema.nullable().optional(),
  provider_name: z.string().nullable().optional(),
  provider_model: z.string().nullable().optional(),
  passthrough_mutations: NativePassthroughMutationLedgerSchema.optional(),
  // Target-protocol request shims on translated attempts. Body-free: codes,
  // counters, and field names only; never payload values.
  request_mutations: NativePassthroughMutationLedgerSchema.optional(),
});

export const FinalDecisionSchema = z.object({
  model_alias: z.string().nullable(),
  provider_model: z.string().nullable(),
  status: AttemptStatusSchema,
  error_reason: z.string().nullable(),
});

export const ServingAccountDecisionSchema = z.object({
  provider_id: z.string().min(1),
  account: z.string().min(1),
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

// Token accounting for the SERVED completion (docs/07). Mirrors cost_breakdown:
// stamped by the GATEWAY after the served usage tail is parsed
// (backfillCompletionCost), NOT by the routing core (which is headless about token
// counts, exactly as it is about streamed cost). Every leaf is an INTEGER COUNT;
// null = "not measured" (no usage reported), kept DISTINCT from a measured 0.
//
// REDACTION (principle 7, load-bearing): the telemetry redactor SUMMARIZES any
// object whose KEY matches /(api[_-]?key|authorization|password|secret|token|
// credential)/i. The container key is `usage` — it deliberately does NOT contain
// the substring "token" — so the block is recursed normally and its scalar
// `*_tokens` leaves pass through verbatim (scalars are never credentials). NEVER
// rename this block to anything containing "token" or the whole object is lost to
// {redacted:true,kind:"object"}. Pinned by redaction.test.ts.
export const TokenUsageSchema = z.object({
  prompt_tokens: z.number().int().nonnegative().nullable().default(null),
  completion_tokens: z.number().int().nonnegative().nullable().default(null),
  cached_tokens: z.number().int().nonnegative().nullable().default(null),
  cache_creation_tokens: z.number().int().nonnegative().nullable().default(null),
  // Provider-confirmed price dimensions retained for exact future repricing. Every
  // field is nullable so legacy records and providers without rich usage metadata
  // remain valid without inventing a value.
  service_tier: z.string().nullable().default(null),
  inference_geo: z.string().nullable().default(null),
  cache_creation_5m_tokens: z.number().int().nonnegative().nullable().default(null),
  cache_creation_1h_tokens: z.number().int().nonnegative().nullable().default(null),
  audio_prompt_tokens: z.number().int().nonnegative().nullable().default(null),
  cached_audio_prompt_tokens: z.number().int().nonnegative().nullable().default(null),
  image_output_tokens: z.number().int().nonnegative().nullable().default(null),
  // Authoritative relay-reported spend, distinct from the catalog estimate stamped
  // into cost_breakdown. Preserving provenance prevents later backfills replacing it.
  billed_cost_usd: z.number().nonnegative().nullable().default(null),
});

// Memory inject observability (docs/08 Phase 2 Step 10). Stamped onto the record
// by the GATEWAY after the inject phase ran (the routing core never touches
// memory — it is a middleware); null when memory inject was off / skipped /
// failed. Mirrors the inject assembler's metadata: counts + job id only — never
// memory CONTENT (the decision record stays redacted, principle 7).
export const MemoryDecisionSchema = z.object({
  memory_hydrated: z.boolean(),
  reflection_version: z.number().int().nullable(),
  observation_count: z.number().int().nonnegative(),
  // LEGACY-ROW TOLERANCE: until the redaction fix (docs/12 live-integration find),
  // the redactor mangled this numeric COUNT into {redacted:true,kind:"number"}
  // because the key matches the "token" secret pattern — and those rows are
  // PERSISTED in real deployments. Coerce that exact legacy artifact to 0 on read
  // so one old row can never 502 the whole requests list again; everything else
  // must still be a non-negative number (fail-closed).
  memory_tokens_injected: z.preprocess(
    (v) =>
      typeof v === "object" && v !== null && (v as { redacted?: unknown }).redacted === true
        ? 0
        : v,
    z.number().nonnegative(),
  ),
  observer_job_id: z.string().nullable(),
  memory_writeback_status: z.enum(["queued", "skipped", "failed"]),
  degraded: z.boolean(),
  // Which fallback-chain link produced the thread anchor (issue #97): "header",
  // "metadata_thread_id", "session_key", "prompt_cache_key", "metadata_user_id",
  // or null when no thread resolved. `.default(null)` keeps pre-#97 records valid.
  thread_source: z.string().nullable().default(null),
});

export const DecisionRecordSchema = z.object({
  request_id: z.string().min(1),
  // Threaded end-to-end from the request context for cross-system correlation
  // (Debug UI Trace ID column, structured logs). In the current pipeline this
  // equals request_id (the orchestrator uses request_id as the trace id).
  trace_id: z.string().min(1),
  requested_model: z.string(),
  // Which client protocol this request arrived on (openai_chat / anthropic_messages
  // / openai_responses / gemini). Stamped by the routing core from the
  // InternalRequest so the admin "Retry" path can re-issue a recorded request in
  // its NATIVE shape (not just OpenAI chat). `.nullable().default(null)` keeps
  // pre-existing records — and the routing core's pre-protocol builders — valid.
  protocol: ProtocolSchema.nullable().default(null),
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
  // Concrete subscription account that ultimately served the request. Null for
  // non-subscription providers, legacy rows, failed requests, or stale selections
  // that later fell back to a different provider. Body-free routing metadata only.
  serving_account: ServingAccountDecisionSchema.nullable().default(null),
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
  // Memory inject observability (docs/08) — stamped by the gateway AFTER routing
  // (see MemoryDecisionSchema). `.default(null)` keeps the routing core's
  // builders and all pre-existing records valid without knowing about memory.
  memory: MemoryDecisionSchema.nullable().default(null),
  // Served-completion token accounting (see TokenUsageSchema). Stamped by the
  // GATEWAY after the served usage tail is parsed (backfillCompletionCost), like
  // cost_breakdown; the routing core emits null (headless about token counts).
  // `.nullable().default(null)` keeps the core builders and all pre-existing
  // records valid without it.
  usage: TokenUsageSchema.nullable().default(null),
  // Wall-clock generation window of the SERVED stream (ms): the span from the
  // first to the last forwarded chunk. Stamped by the GATEWAY post-stream (same
  // place as `usage`, via backfillCompletionCost) — the routing core stays
  // headless about served-stream timing, so it emits null. Drives true TPS =
  // completion_tokens / (generation_ms / 1000). null for NON-streaming responses
  // (the body is buffered upstream, so the generation rate is unobservable) and
  // for legacy records — kept DISTINCT from a measured 0 (single-instant stream).
  // The key carries no secret-pattern substring, so it survives the telemetry
  // redactor verbatim (like latency_total_ms). `.nullable().default(null)` keeps
  // the core builders + all pre-existing records valid.
  generation_ms: z.number().nonnegative().nullable().default(null),
});

export type DecidedBy = z.infer<typeof DecidedBySchema>;
export type AttemptStatus = z.infer<typeof AttemptStatusSchema>;
export type ClassifierDecision = z.infer<typeof ClassifierDecisionSchema>;
export type PolicyDecision = z.infer<typeof PolicyDecisionSchema>;
export type LaneDecision = z.infer<typeof LaneDecisionSchema>;
export type AttemptErrorDetail = z.infer<typeof AttemptErrorDetailSchema>;
export type ProviderAttempt = z.infer<typeof ProviderAttemptSchema>;
export type FinalDecision = z.infer<typeof FinalDecisionSchema>;
export type ServingAccountDecision = z.infer<typeof ServingAccountDecisionSchema>;
export type CostBreakdown = z.infer<typeof CostBreakdownSchema>;
export type TokenUsageBreakdown = z.infer<typeof TokenUsageSchema>;
export type MemoryDecision = z.infer<typeof MemoryDecisionSchema>;
export type DecisionRecord = z.infer<typeof DecisionRecordSchema>;
