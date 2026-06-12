import type { InternalRequest, Protocol, TargetProviderProtocol } from "@helm/shared";

export type SameProtocolSerializationFastPathDisableReason =
  | "source_protocol_not_openai_chat"
  | "response_protocol_not_openai_chat"
  | "target_provider_protocol_not_openai_chat"
  | "stream_not_supported_in_prep_pr"
  | "memory_inject_may_rewrite_request"
  | "fallback_may_change_provider_protocol"
  | "provider_requires_compatibility_rewrite";

export type SameProtocolSerializationFastPathDecision =
  | { ok: true }
  | { ok: false; reason: SameProtocolSerializationFastPathDisableReason };

export interface SameProtocolSerializationFastPathDecisionInput {
  request: InternalRequest;
  responseProtocol: Protocol;
  targetProviderProtocol: TargetProviderProtocol;
  fallbackMayUseDifferentProviderProtocol: boolean;
  providerRequiresCompatibilityRewrite: boolean;
}

// #217 first PR only defines the serialization-layer guard. It does not replace
// auth/routing/budget/telemetry/memory/fallback/breaker and is not wired into
// execute yet; later fast-path code must call it after routing selects a candidate.
export function canUseSameProtocolSerializationFastPath(
  input: SameProtocolSerializationFastPathDecisionInput,
): SameProtocolSerializationFastPathDecision {
  if (input.request.protocol !== "openai_chat") {
    return { ok: false, reason: "source_protocol_not_openai_chat" };
  }
  if (input.responseProtocol !== "openai_chat") {
    return { ok: false, reason: "response_protocol_not_openai_chat" };
  }
  if (input.targetProviderProtocol !== "openai_chat") {
    return { ok: false, reason: "target_provider_protocol_not_openai_chat" };
  }
  if (input.request.stream) {
    return { ok: false, reason: "stream_not_supported_in_prep_pr" };
  }
  if (input.request.metadata.memory_mode === "inject") {
    return { ok: false, reason: "memory_inject_may_rewrite_request" };
  }
  if (input.fallbackMayUseDifferentProviderProtocol) {
    return { ok: false, reason: "fallback_may_change_provider_protocol" };
  }
  if (input.providerRequiresCompatibilityRewrite) {
    return { ok: false, reason: "provider_requires_compatibility_rewrite" };
  }
  return { ok: true };
}
