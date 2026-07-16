import { z } from "zod";

// Internal request structure — the normalized input contract for the whole
// pipeline. Protocol Adapters map every client protocol to THIS shape. Per
// CLAUDE.md, the Zod schema is the single source of truth; types come from
// z.infer (no hand-written interfaces). See docs/02-architecture.md.

// Matches docs/02 protocol enum one-for-one.
export const ProtocolSchema = z.enum([
  "openai_chat",
  "anthropic_messages",
  "openai_responses",
  "gemini",
]);

// Provider wire protocol selected by routing/execution. This is intentionally
// separate from the inbound source protocol and the client response protocol.
export const TargetProviderProtocolSchema = z.enum([
  "openai_chat",
  "anthropic_messages",
  "openai_responses",
  "gemini",
]);

export const MemoryModeSchema = z.enum(["off", "observe", "inject"]);

// MVP does not deep-validate message/tool internals: keep the normalized shape
// open to avoid prematurely locking per-protocol differences (narrowed later in
// the docs/05 protocol-translation tasks).
const MessageSchema = z.looseObject({ role: z.string(), content: z.unknown() });
const UnknownRecordSchema = z.record(z.string(), z.unknown());
const StreamOptionsSchema = z.object({ include_usage: z.boolean().optional() }).passthrough();
const StopSchema = z.union([z.string(), z.array(z.string())]);
const NativeHeaderValueSchema = z.union([z.string(), z.array(z.string())]);

export const NativePassthroughMutationLedgerSchema = z
  .object({
    model_rewritten: z.object({ from: z.string().nullable(), to: z.string() }).optional(),
    memory_appended: z.boolean().optional(),
    headers_dropped: z.array(z.string()).optional(),
    headers_overwritten: z.array(z.string()).optional(),
    auth_replaced: z.boolean().optional(),
    content_length_recomputed: z.boolean().optional(),
    accept_encoding_forced_identity: z.boolean().optional(),
    provider_profile_applied: z.string().nullable().optional(),
    body_shims_applied: z.array(z.string()).optional(),
    stream_reframed: z.boolean().optional(),
    // Visual context compression telemetry. Body-free by design: reason strings,
    // counts, and flags only. Never store the imaged source text or PNG bytes here.
    visual_context_compression: z
      .object({
        mode: z.enum(["observe", "enabled"]),
        applied: z.boolean(),
        would_apply: z.boolean(),
        reason: z.string(),
        detail: z.string().optional(),
        orig_chars: z.number().int().nonnegative(),
        compressed_chars: z.number().int().nonnegative(),
        image_count: z.number().int().nonnegative(),
        image_bytes: z.number().int().nonnegative(),
        image_pixels: z.number().int().nonnegative().optional(),
        estimated_image_tokens: z.number().int().nonnegative().optional(),
        kept_sharp_blocks: z.number().int().nonnegative().optional(),
        dropped_chars: z.number().int().nonnegative().optional(),
        owns_cache_control: z.boolean(),
        marker_count: z.number().int().nonnegative(),
        cache_control_markers_stripped: z.number().int().nonnegative().optional(),
      })
      .optional(),
  })
  .passthrough();

export const NativePassthroughCarrierSchema = z.object({
  protocol: z.enum(["anthropic_messages", "openai_responses", "gemini"]),
  body: UnknownRecordSchema,
  raw_body: z.string().optional(),
  headers: z.record(z.string(), NativeHeaderValueSchema),
  mutations: NativePassthroughMutationLedgerSchema,
});

const NativeRequestSchema = z.union([NativePassthroughCarrierSchema, UnknownRecordSchema]);

export const RequestMetadataSchema = z.object({
  // Client-facing correlation id (X-Request-Id / X-Trace-Id). It is deliberately
  // separate from the server-generated top-level request_id and must never be
  // used as a telemetry/payload ownership key.
  trace_id: z.string().min(1).optional(),
  conversation_id: z.string().nullable(),
  // Memory fields below are reserved-only in the MVP, not consumed (docs/08).
  thread_id: z.string().nullable(),
  resource_id: z.string().nullable(),
  project_id: z.string().nullable(),
  memory_mode: MemoryModeSchema,
  // The inbound client's Claude-Code billing-attribution prefix —
  // "cc_version=<v>.<3hex>; cc_entrypoint=<entry>" with the per-request `cch` dropped
  // — captured at the Anthropic route from the real CLI's system[0] block before it
  // is stripped. Gateway-only metadata (never forwarded to providers as a body field):
  // the native-Anthropic subscription executor reads it to re-emit the client's OWN
  // version/entrypoint (anti-ban) with a cache-stable cch, instead of a pinned spoof.
  // Null/absent for non-CLI traffic (e.g. an OpenAI-shaped request routed to a Claude
  // subscription lane) → the executor falls back to its baked default version.
  client_billing_header: z.string().nullish(),
});

export const InternalRequestSchema = z.object({
  request_id: z.string().min(1),
  protocol: ProtocolSchema,
  account_id: z.string().min(1),
  api_key_id: z.string().min(1),
  user_id: z.string().nullable(),
  org_id: z.string().nullable(),
  requested_model: z.string().min(1),
  messages: z.array(MessageSchema).min(1),
  tools: z.array(z.unknown()).nullable(),
  response_format: z.record(z.string(), z.unknown()).nullable(),
  attachments: z.array(z.unknown()).nullable(),
  max_tokens: z.number().int().positive().nullable(),
  // LiteLLM/OpenAI-compatible optional request controls. They must survive the
  // production route -> routing -> provider path; unsupported target protocols
  // record data-loss warnings in the protocol layer instead of silently dropping.
  max_completion_tokens: z.number().int().positive().optional(),
  temperature: z.number().optional(),
  top_p: z.number().optional(),
  top_k: z.number().int().optional(),
  frequency_penalty: z.number().optional(),
  presence_penalty: z.number().optional(),
  seed: z.number().int().optional(),
  stop: StopSchema.optional(),
  n: z.number().int().positive().optional(),
  logprobs: z.boolean().optional(),
  top_logprobs: z.number().int().nonnegative().optional(),
  parallel_tool_calls: z.boolean().optional(),
  stream_options: StreamOptionsSchema.optional(),
  modalities: z.array(z.string()).optional(),
  reasoning_effort: z.string().optional(),
  // Internal signal (NOT a client wire field): set by the router when a lane FORCES
  // reasoning_effort. It tells the native-passthrough path to rewrite the verbatim
  // body's reasoning field (the translated path already forwards reasoning_effort).
  // Absent => passthrough stays byte-verbatim, as today.
  reasoning_effort_forced: z.boolean().optional(),
  // Internal signal (NOT a client wire field): a per-CANDIDATE timeout (ms) for the
  // execution-fallback loop. When set, each candidate's attempt is bounded to this
  // many ms to first output; exceeding it is treated as a provider `timeout` fault
  // (breaker failure + advance to the next candidate), NOT a client abort. Set only
  // by trusted internal callers (the classifier eval loopback, gated to the internal
  // key in the chat route). Absent => only the global connect/idle timeouts apply, as
  // today.
  attempt_timeout_ms: z.number().int().positive().optional(),
  user: z.string().optional(),
  service_tier: z.string().optional(),
  tool_choice: z.unknown().optional(),
  cache_control: z.unknown().optional(),
  prompt_cache_key: z.string().optional(),
  prompt_cache_retention: z.string().optional(),
  cached_content: z.string().optional(),
  thinking: z.unknown().optional(),
  functions: z.array(z.unknown()).optional(),
  function_call: z.unknown().optional(),
  prediction: z.unknown().optional(),
  audio: z.unknown().optional(),
  logit_bias: z.record(z.string(), z.number()).optional(),
  web_search_options: z.unknown().optional(),
  include_server_side_tool_invocations: z.boolean().optional(),
  verbosity: z.string().optional(),
  safety_identifier: z.string().optional(),
  provider_raw: UnknownRecordSchema.optional(),
  // Verbatim native request body in InternalRequest.protocol, captured at the
  // route boundary; used ONLY by execute's native-passthrough branch after
  // governance gates prove same-protocol non-stream safe.
  native_request: NativeRequestSchema.optional(),
  stream: z.boolean(),
  metadata: RequestMetadataSchema,
});

// ── Inbound OpenAI Chat Completions request validation (boundary guard) ─────────
// The gateway must reject a malformed/invalid OpenAI request with 400
// invalid_request BEFORE normalization + routing (docs/07, principle 2: fail-
// closed). This validates only what makes a request well-formed enough to route:
// `messages` must be a non-empty array of role-bearing objects. Everything else
// (model, tools, response_format, temperature, …) is passed through loosely — we
// do NOT prematurely lock per-provider fields here. `model` is optional (absent →
// "auto"). Loose objects so unknown OpenAI fields never break parsing.
const OpenAIChatMessageSchema = z.looseObject({ role: z.string().min(1), content: z.unknown() });

export const OpenAIChatRequestSchema = z.looseObject({
  model: z.string().optional(),
  messages: z.array(OpenAIChatMessageSchema).min(1),
  stream: z.boolean().optional(),
  max_tokens: z.number().int().positive().optional(),
  max_completion_tokens: z.number().int().positive().optional(),
  tools: z.array(z.unknown()).optional(),
  tool_choice: z.unknown().optional(),
  response_format: UnknownRecordSchema.optional(),
  temperature: z.number().optional(),
  top_p: z.number().optional(),
  top_k: z.number().int().optional(),
  frequency_penalty: z.number().optional(),
  presence_penalty: z.number().optional(),
  seed: z.number().int().optional(),
  stop: StopSchema.optional(),
  n: z.number().int().positive().optional(),
  logprobs: z.boolean().optional(),
  top_logprobs: z.number().int().nonnegative().optional(),
  parallel_tool_calls: z.boolean().optional(),
  stream_options: StreamOptionsSchema.optional(),
  modalities: z.array(z.string()).optional(),
  reasoning_effort: z.string().optional(),
  user: z.string().optional(),
  service_tier: z.string().optional(),
  metadata: UnknownRecordSchema.optional(),
  store: z.boolean().optional(),
  cache_control: z.unknown().optional(),
  prompt_cache_key: z.string().optional(),
  prompt_cache_retention: z.string().optional(),
  cached_content: z.string().optional(),
  thinking: z.unknown().optional(),
  functions: z.array(z.unknown()).optional(),
  function_call: z.unknown().optional(),
  prediction: z.unknown().optional(),
  audio: z.unknown().optional(),
  logit_bias: z.record(z.string(), z.number()).optional(),
  web_search_options: z.unknown().optional(),
  include_server_side_tool_invocations: z.boolean().optional(),
  verbosity: z.string().optional(),
  safety_identifier: z.string().optional(),
});

export type OpenAIChatRequest = z.infer<typeof OpenAIChatRequestSchema>;

// Single source of truth: types via z.infer — no duplicate interfaces.
export type Protocol = z.infer<typeof ProtocolSchema>;
export type TargetProviderProtocol = z.infer<typeof TargetProviderProtocolSchema>;
export type MemoryMode = z.infer<typeof MemoryModeSchema>;
export type RequestMetadata = z.infer<typeof RequestMetadataSchema>;
export type InternalRequest = z.infer<typeof InternalRequestSchema>;
export type NativePassthroughCarrier = z.infer<typeof NativePassthroughCarrierSchema>;
export type NativePassthroughMutationLedger = z.infer<typeof NativePassthroughMutationLedgerSchema>;
