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
  | "responses_native_body_provider_incompatible"
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
  /** The inbound body carries Responses native items (`responses_input_items` /
   *  `unknown_items`) — Codex-private structure a non-Codex upstream can't parse. */
  sourceCarriesResponsesNativeItems: boolean;
  /** The resolved provider speaks the GENERIC OpenAI-Responses wire profile (e.g. xAI),
   *  i.e. NOT the Codex official endpoint that emits these native items. */
  targetIsGenericResponsesProfile: boolean;
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
  // Same wire protocol, but a CROSS-ORIGIN Responses body: the inbound carries Codex
  // ChatGPT-private items (custom_tool_call / additional_tools / encrypted reasoning)
  // and the target is a GENERIC Responses provider (e.g. xAI/Grok) that cannot parse
  // them — forwarding verbatim 422s. Disable passthrough so the executor translates the
  // body into a clean standard Responses request. Codex->Codex (non-generic profile)
  // and native-item-free bodies keep byte-faithful passthrough.
  if (
    input.request.protocol === "openai_responses" &&
    input.targetIsGenericResponsesProfile &&
    input.sourceCarriesResponsesNativeItems
  ) {
    return { ok: false, reason: "responses_native_body_provider_incompatible" };
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

// Anthropic historically carried `system` at the TOP LEVEL only, so an inline
// `system`/`developer` turn inside `messages[]` required the compatibility rewrite.
// Claude Opus 4.8 now accepts carefully-placed mid-conversation `system` turns, so the
// passthrough guard must be model-aware: keep older/unknown models fail-closed, but do
// not disable byte-faithful passthrough for the exact valid Opus 4.8 shape Claude Code
// emits (e.g. `[user, system]` trailing MCP instructions).
//
// Scope the CALL to anthropic_messages targets — OpenAI/Gemini accept inline
// system/developer turns, so they neither need nor want this fold. `nativeRequest` is the
// `InternalRequest.native_request` carrier (or a bare body); a non-Anthropic / message-less
// body returns false (passthrough stays eligible). Pure + framework-agnostic
// (CLAUDE.md principle 1), single-unit-testable (principle 4).
export interface AnthropicSystemFoldOptions {
  /** Resolved upstream model for this attempt. Missing/unknown stays conservative. */
  providerModel?: string | null;
}

function anthropicModelSupportsMidConversationSystem(providerModel: string | null | undefined) {
  if (providerModel === null || providerModel === undefined) return false;
  const model = providerModel.toLowerCase();
  const slash = model.lastIndexOf("/");
  const unprefixed = slash >= 0 ? model.slice(slash + 1) : model;
  return unprefixed === "claude-opus-4-8" || unprefixed.startsWith("claude-opus-4-8-");
}

function isValidOpus48MidConversationSystemPlacement(
  messages: Array<unknown>,
  index: number,
): boolean {
  if (index <= 0) return false;
  const previous = messages[index - 1];
  if (previous === null || typeof previous !== "object") return false;
  const previousRole = (previous as { role?: unknown }).role;
  // Opus 4.8 currently documents mid-conversation system insertion after a user turn.
  // Other shapes stay on the rewrite path until explicitly proven accepted.
  if (previousRole !== "user") return false;
  const next = messages[index + 1];
  if (next === undefined) return true;
  if (next === null || typeof next !== "object") return false;
  return (next as { role?: unknown }).role === "assistant";
}

function isAnthropicSystemContentTextOnly(content: unknown): boolean {
  if (typeof content === "string") return true;
  if (!Array.isArray(content)) return false;
  return content.every((block) => {
    if (block === null || typeof block !== "object") return false;
    const textBlock = block as { type?: unknown; text?: unknown };
    return textBlock.type === "text" && typeof textBlock.text === "string";
  });
}

export function anthropicNativeBodyRequiresSystemFold(
  nativeRequest: unknown,
  options: AnthropicSystemFoldOptions = {},
): boolean {
  if (nativeRequest === null || typeof nativeRequest !== "object") return false;
  const body = isNativePassthroughCarrier(nativeRequest)
    ? nativeRequest.body
    : (nativeRequest as Record<string, unknown>);
  const messages = body.messages;
  if (!Array.isArray(messages)) return false;
  const supportsMidConversationSystem = anthropicModelSupportsMidConversationSystem(
    options.providerModel,
  );
  return messages.some((m, index) => {
    if (m === null || typeof m !== "object") return false;
    const role = (m as { role?: unknown }).role;
    if (role === "developer") return true;
    if (role !== "system") return false;
    return (
      !supportsMidConversationSystem ||
      !isAnthropicSystemContentTextOnly((m as { content?: unknown }).content) ||
      !isValidOpus48MidConversationSystemPlacement(messages, index)
    );
  });
}
