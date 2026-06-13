import type { InternalRequest, TargetProviderProtocol } from "@helm/shared";

// Native protocol passthrough guard (issue #217, Phase 1). Decides whether the
// executor may forward the client's VERBATIM native request body to the upstream
// and return the upstream's native response untranslated — skipping the 4 lossy
// translations (`Anthropic-native → IR → OpenAI-Chat → Anthropic wire` and back)
// that only exist to normalize a heterogeneous chain. When the inbound protocol
// already equals the upstream's native protocol, those translations are pure
// waste and pure risk, so passthrough sends the body as-is.
//
// This generalizes the #218 same-protocol-serialization guard: the previous guard
// hard-coded `openai_chat` (which was a no-op — openai_chat IS the lingua franca,
// nothing to save). The native-passthrough guard instead REQUIRES a non-lingua
// source that matches the target native protocol.
//
// The disable-reason ORDER is contractual: the FIRST failing check wins, so the
// recorded `disable_reason` is stable and deterministic.
export type NativePassthroughDisableReason =
  | "feature_flag_disabled"
  | "missing_native_request"
  | "source_protocol_is_lingua_franca"
  | "protocol_mismatch"
  | "memory_inject_may_rewrite_request"
  | "fallback_may_change_provider_protocol"
  | "provider_requires_compatibility_rewrite"
  | "provider_lacks_passthrough";

export type NativePassthroughDecision =
  | { ok: true }
  | { ok: false; reason: NativePassthroughDisableReason };

export interface NativePassthroughDecisionInput {
  /** Runtime flag `native_protocol_passthrough` (default OFF). */
  enabled: boolean;
  /** Whether `request.native_request` carries the verbatim inbound body. */
  hasNativeRequest: boolean;
  request: InternalRequest;
  /** The resolved candidate's upstream wire protocol. */
  targetProviderProtocol: TargetProviderProtocol;
  /** True when a LATER candidate in the fallback chain resolves to a different
   *  provider protocol (a heterogeneous chain) — passthrough must stay off so the
   *  response can be normalized to IR for any fallback translator. */
  fallbackMayUseDifferentProviderProtocol: boolean;
  /** The provider needs a compatibility rewrite (e.g. developer-role / tool /
   *  schema remap) — the body cannot be forwarded byte-for-byte. */
  providerRequiresCompatibilityRewrite: boolean;
  /** The resolved provider client actually implements `nativePassthrough`. */
  providerSupportsPassthrough: boolean;
}

// Pure decision. Governance (auth/routing/budget/telemetry/memory/fallback/
// breaker) is NOT this helper's concern — it must already have run before execute
// asks. This only answers "is the verbatim native forward safe for THIS attempt?".
export function canUseNativePassthrough(
  input: NativePassthroughDecisionInput,
): NativePassthroughDecision {
  if (!input.enabled) {
    return { ok: false, reason: "feature_flag_disabled" };
  }
  if (!input.hasNativeRequest) {
    return { ok: false, reason: "missing_native_request" };
  }
  // openai_chat is the internal lingua franca: an openai_chat inbound has no
  // translation to save, so passthrough is meaningless (the #218 no-op case).
  if (input.request.protocol === "openai_chat") {
    return { ok: false, reason: "source_protocol_is_lingua_franca" };
  }
  // The generalized same-protocol check: only forward verbatim when the inbound
  // protocol equals the upstream wire protocol. This implicitly guarantees
  // response == request shape (the client gets a native response it understands).
  if (input.request.protocol !== input.targetProviderProtocol) {
    return { ok: false, reason: "protocol_mismatch" };
  }
  // Phase 2: streaming passthrough is supported. The guard stays protocol-neutral —
  // whether the provider can stream the verbatim native body is conveyed by
  // `providerSupportsPassthrough` (execute feature-detects nativePassthroughStream for
  // stream requests, nativePassthrough for non-stream), so a stream is no longer a
  // blocker here. The byte-faithful SSE forward ELIMINATES the SSE re-mapping state
  // machine (principle 8) rather than replacing it.
  if (input.request.metadata.memory_mode === "inject") {
    return { ok: false, reason: "memory_inject_may_rewrite_request" };
  }
  if (input.fallbackMayUseDifferentProviderProtocol) {
    return { ok: false, reason: "fallback_may_change_provider_protocol" };
  }
  if (input.providerRequiresCompatibilityRewrite) {
    return { ok: false, reason: "provider_requires_compatibility_rewrite" };
  }
  if (!input.providerSupportsPassthrough) {
    return { ok: false, reason: "provider_lacks_passthrough" };
  }
  return { ok: true };
}
