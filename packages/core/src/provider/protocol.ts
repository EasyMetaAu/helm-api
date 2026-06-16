import {
  type InternalRequest,
  isNativePassthroughCarrier,
  type TargetProviderProtocol,
} from "@helm/shared";

// Native protocol passthrough guard (issue #217, Phase 1). Decides whether the
// executor may forward the client's VERBATIM native request body to the upstream
// and return the upstream's native response untranslated — skipping the 4 lossy
// translations (`Anthropic-native → IR → OpenAI-Chat → Anthropic wire` and back).
// When the inbound protocol already equals THIS attempt's upstream native protocol,
// those translations are pure waste and pure risk, so passthrough sends the body as-is.
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
  | "provider_requires_compatibility_rewrite"
  | "provider_lacks_passthrough";

export type NativePassthroughDecision =
  | { ok: true }
  | { ok: false; reason: NativePassthroughDisableReason };

export interface NativePassthroughDecisionInput {
  /** Runtime flag `native_protocol_passthrough` (default ON since #232; see the
   *  runtime-settings schema). */
  enabled: boolean;
  /** Whether `request.native_request` carries the verbatim inbound body. */
  hasNativeRequest: boolean;
  request: InternalRequest;
  /** The resolved candidate's upstream wire protocol. */
  targetProviderProtocol: TargetProviderProtocol;
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
  // Memory inject is NO LONGER a blocker (#217 Phase 4 TRAILING-REMINDER model). Inject
  // is purely ADDITIVE: the pipeline appends the assembled memory block as ONE trailing
  // `<system-reminder>` turn on the native carrier's `messages`/`input` and keeps the
  // `system`/`instructions` field and every existing turn VERBATIM, so the upstream
  // cached prefix (tools → system → history) survives and the native_request stays
  // self-consistent. Passthrough can therefore fire WITH memory — there is no longer a
  // request rewrite for the guard to defend against.
  if (input.providerRequiresCompatibilityRewrite) {
    return { ok: false, reason: "provider_requires_compatibility_rewrite" };
  }
  if (!input.providerSupportsPassthrough) {
    return { ok: false, reason: "provider_lacks_passthrough" };
  }
  return { ok: true };
}

// Anthropic's Messages API carries `system` at the TOP LEVEL only. A `system`- or
// `developer`-role entry INSIDE `messages[]` is the "mid-conversation system" shape
// modern Claude Code emits (role-folded transcripts — e.g. MCP-server instructions as a
// trailing system turn, CC ≥2.1.x). Anthropic's subscription endpoint REJECTS such a body
// — `messages.N: role 'system' must precede an 'assistant' message or end the array` — so
// it cannot be forwarded VERBATIM. It needs the compatibility rewrite that folds
// system/developer turns into the top-level `system` param (provider/anthropic
// openaiToAnthropicRequest / protocol/anthropic transformRequestIn), so passthrough must
// be disabled for the attempt and the request routed through the translating path.
//
// Scope the CALL to anthropic_messages targets — OpenAI/Gemini accept inline
// system/developer turns, so they neither need nor want this fold. `nativeRequest` is the
// `InternalRequest.native_request` carrier (or a bare body); a non-Anthropic / message-less
// body returns false (passthrough stays eligible). Pure + framework-agnostic
// (CLAUDE.md principle 1), single-unit-testable (principle 4).
export function anthropicNativeBodyRequiresSystemFold(nativeRequest: unknown): boolean {
  if (nativeRequest === null || typeof nativeRequest !== "object") return false;
  const body = isNativePassthroughCarrier(nativeRequest)
    ? nativeRequest.body
    : (nativeRequest as Record<string, unknown>);
  const messages = body.messages;
  if (!Array.isArray(messages)) return false;
  return messages.some((m) => {
    if (m === null || typeof m !== "object") return false;
    const role = (m as { role?: unknown }).role;
    return role === "system" || role === "developer";
  });
}
