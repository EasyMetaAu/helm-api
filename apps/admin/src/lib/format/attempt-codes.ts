// Human-readable labels for the internal routing codes the backend records on each
// provider attempt: the attempt `outcome`, the capability-filter `skip_reason`, and
// the `error_class`. The Decision UI used to render the raw snake_case codes
// (`no_response_schema_support`, `circuit_open`, …) which are opaque to operators.
//
// Each value here is BOTH the human label AND the i18n key: the admin i18n falls back
// to the key when a locale lacks it (see lib/i18n/index.ts), so a code that is missing
// from this map — e.g. a NEW skip reason added to the gateway before this map is
// updated — still renders as its raw code rather than blank. Render sites pair the
// label with a `title={code}` tooltip so the exact code stays available for debugging.
//
// admin does not import @helm/core (CLAUDE.md principle 1), so these codes mirror the
// gateway's SkipReason union (packages/core/src/capability/filter.ts) + execution
// error classes (apps/gateway/src/routes/execute.ts). Keep in sync when codes change.
export const ATTEMPT_CODE_LABELS: Record<string, string> = {
  // ── attempt outcomes (DecisionChain badge) ──
  success: 'Success',
  error: 'Error',
  skipped: 'Skipped',

  // ── capability-filter skip reasons ──
  no_tool_support: 'No tool-calling support',
  no_json_support: 'No JSON mode support',
  no_response_schema_support: 'No strict JSON schema support',
  no_vision_support: 'No image/vision support',
  no_audio_support: 'No audio input support',
  no_video_support: 'No video input support',
  no_document_support: 'No document input support',
  context_too_small: 'Context window too small',
  no_streaming_support: 'No streaming support',
  no_nonstream_support: 'Streaming required',
  no_cached_content_support: 'No cached-content support',
  provider_unavailable: 'Provider not configured',
  capability: 'Incompatible with request',

  // ── cross-protocol guard skips (Responses-only features) ──
  responses_background_cross_protocol_blocked: 'Background mode blocked across protocols',
  responses_native_tools_cross_protocol_blocked: 'Native tools blocked across protocols',
  responses_previous_response_id_cross_protocol_blocked:
    'Conversation continuation blocked across protocols',
  responses_previous_response_id_provider_mismatch:
    'Conversation continuation pinned to its original provider',

  // ── error classes / outcomes (also used as attempt outcomes where noted) ──
  upstream_error: 'Provider error',
  all_providers_failed: 'All providers failed',
  capability_unsatisfiable: 'No compatible model',
  client_abort: 'Client disconnected',
  aborted: 'Client disconnected',
  invalid_request: 'Invalid request',
  lane_unavailable: 'Lane unavailable',
  user_message_queue_timeout: 'User message queue timed out', // skip_reason (per-account serial-queue backpressure)
  auth_error: 'Authentication failed',
  rate_limited: 'Rate limited', // outcome + error_class
  timeout: 'Timed out', // outcome + error_class
  circuit_open: 'Circuit open', // outcome + skip_reason
};

/**
 * Map an internal attempt code (outcome / skip_reason / error_class) to its English
 * human label, which is also the i18n key for `$t()`. Returns the raw code for an
 * unmapped value so a future/unknown code still renders (never blank). Empty/nullish
 * input → "".
 */
export function attemptCodeLabel(code: string | null | undefined): string {
  if (!code) return '';
  return ATTEMPT_CODE_LABELS[code] ?? code;
}
