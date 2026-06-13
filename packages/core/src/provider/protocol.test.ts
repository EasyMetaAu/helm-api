import type { InternalRequest } from "@helm/shared";
import { describe, expect, it } from "vitest";
import {
  canUseNativePassthrough,
  canUseSameProtocolSerializationFastPath,
  type NativePassthroughDecisionInput,
  type SameProtocolSerializationFastPathDecisionInput,
} from "./protocol.js";

// canUseNativePassthrough — the framework-agnostic guard for native protocol
// passthrough (issue #217, Phase 1). It decides whether execute may forward the
// client's verbatim native body to the upstream and return the native response
// untranslated. Pure + deterministic + single-unit-testable (CLAUDE.md
// principle 4). The disable-reason ORDER is contractual (first failure wins);
// each branch below pins one reason in that order.

function request(overrides: Partial<InternalRequest> = {}): InternalRequest {
  return {
    request_id: "req-1",
    // Default source is a NON-lingua-franca native protocol that MATCHES the
    // default target, so the bare input() is the ok path.
    protocol: "anthropic_messages",
    account_id: "acct-1",
    api_key_id: "key-1",
    user_id: null,
    org_id: null,
    requested_model: "auto",
    messages: [{ role: "user", content: "hi" }],
    tools: null,
    response_format: null,
    attachments: null,
    max_tokens: null,
    stream: false,
    metadata: {
      conversation_id: null,
      thread_id: null,
      resource_id: null,
      project_id: null,
      memory_mode: "observe",
    },
    ...overrides,
  };
}

function input(
  overrides: Partial<NativePassthroughDecisionInput> = {},
): NativePassthroughDecisionInput {
  return {
    enabled: true,
    hasNativeRequest: true,
    request: request(),
    targetProviderProtocol: "anthropic_messages",
    fallbackMayUseDifferentProviderProtocol: false,
    providerRequiresCompatibilityRewrite: false,
    providerSupportsPassthrough: true,
    ...overrides,
  };
}

describe("canUseNativePassthrough", () => {
  it("enables native passthrough when source == target native protocol, flag on, native body present", () => {
    expect(canUseNativePassthrough(input())).toEqual({ ok: true });
  });

  // ——— disable reasons IN ORDER (first failure wins) ———

  it("1) disables when the runtime feature flag is off", () => {
    expect(canUseNativePassthrough(input({ enabled: false }))).toEqual({
      ok: false,
      reason: "feature_flag_disabled",
    });
  });

  it("2) disables when no native carrier body was captured", () => {
    expect(canUseNativePassthrough(input({ hasNativeRequest: false }))).toEqual({
      ok: false,
      reason: "missing_native_request",
    });
  });

  it("3) disables an openai_chat source because it is the lingua franca (no translation to save)", () => {
    expect(
      canUseNativePassthrough(
        input({
          request: request({ protocol: "openai_chat" }),
          targetProviderProtocol: "openai_chat",
        }),
      ),
    ).toEqual({ ok: false, reason: "source_protocol_is_lingua_franca" });
  });

  it("4) disables when source protocol != target provider protocol (anthropic_messages -> openai_chat)", () => {
    expect(
      canUseNativePassthrough(
        input({
          request: request({ protocol: "anthropic_messages" }),
          targetProviderProtocol: "openai_chat",
        }),
      ),
    ).toEqual({ ok: false, reason: "protocol_mismatch" });
  });

  it("a STREAM request is no longer a blocker (Phase 2 byte-level SSE passthrough)", () => {
    // Phase 2: streaming passthrough is supported. The guard stays protocol-neutral —
    // whether the provider can stream verbatim is conveyed by providerSupportsPassthrough,
    // which execute computes per stream/non-stream. With everything else ok, a stream
    // request returns ok:true.
    expect(canUseNativePassthrough(input({ request: request({ stream: true }) }))).toEqual({
      ok: true,
    });
  });

  it("6) disables when memory inject may rewrite the request before execute", () => {
    expect(
      canUseNativePassthrough(
        input({ request: request({ metadata: { ...request().metadata, memory_mode: "inject" } }) }),
      ),
    ).toEqual({ ok: false, reason: "memory_inject_may_rewrite_request" });
  });

  it("7) disables when a heterogeneous fallback chain may pick a different provider protocol", () => {
    expect(
      canUseNativePassthrough(input({ fallbackMayUseDifferentProviderProtocol: true })),
    ).toEqual({ ok: false, reason: "fallback_may_change_provider_protocol" });
  });

  it("8) disables when the provider requires a compatibility rewrite (developer-role / schema remap)", () => {
    expect(canUseNativePassthrough(input({ providerRequiresCompatibilityRewrite: true }))).toEqual({
      ok: false,
      reason: "provider_requires_compatibility_rewrite",
    });
  });

  it("9) disables when the resolved provider client has no nativePassthrough method", () => {
    expect(canUseNativePassthrough(input({ providerSupportsPassthrough: false }))).toEqual({
      ok: false,
      reason: "provider_lacks_passthrough",
    });
  });

  it("honors the disable-reason ORDER: flag-off wins over every later failure", () => {
    // Every later guard is ALSO violated; the first (feature_flag_disabled) must win.
    expect(
      canUseNativePassthrough(
        input({
          enabled: false,
          hasNativeRequest: false,
          request: request({ protocol: "openai_chat", stream: true }),
          targetProviderProtocol: "anthropic_messages",
          fallbackMayUseDifferentProviderProtocol: true,
          providerRequiresCompatibilityRewrite: true,
          providerSupportsPassthrough: false,
        }),
      ),
    ).toEqual({ ok: false, reason: "feature_flag_disabled" });
  });

  it("is only a serialization-layer decision and does not replace governance", () => {
    const decision = canUseNativePassthrough(input());

    expect(decision).toEqual({ ok: true });
    // Governance remains outside this helper: auth, routing, budget, telemetry,
    // memory, fallback and breaker must already have run before execute asks this.
    expect(Object.keys(input()).sort()).toEqual([
      "enabled",
      "fallbackMayUseDifferentProviderProtocol",
      "hasNativeRequest",
      "providerRequiresCompatibilityRewrite",
      "providerSupportsPassthrough",
      "request",
      "targetProviderProtocol",
    ]);
  });
});


function fastPathRequest(overrides: Partial<InternalRequest> = {}): InternalRequest {
  return request({ protocol: "openai_chat", ...overrides });
}

function fastPathInput(
  overrides: Partial<SameProtocolSerializationFastPathDecisionInput> = {},
): SameProtocolSerializationFastPathDecisionInput {
  return {
    enabled: true,
    hasGovernedNativePayload: true,
    request: fastPathRequest(),
    responseProtocol: "openai_chat",
    targetProviderProtocol: "openai_chat",
    fallbackMayUseDifferentProviderProtocol: false,
    providerRequiresCompatibilityRewrite: false,
    ...overrides,
  };
}

describe("canUseSameProtocolSerializationFastPath", () => {
  it("enables the OpenAI Chat same-protocol non-stream serialization fast path", () => {
    expect(canUseSameProtocolSerializationFastPath(fastPathInput())).toEqual({ ok: true });
  });

  it("pins disable-reason order", () => {
    expect(
      canUseSameProtocolSerializationFastPath(
        fastPathInput({
          enabled: false,
          hasGovernedNativePayload: false,
          request: fastPathRequest({ protocol: "anthropic_messages", stream: true }),
          responseProtocol: "anthropic_messages",
          targetProviderProtocol: "anthropic_messages",
          fallbackMayUseDifferentProviderProtocol: true,
          providerRequiresCompatibilityRewrite: true,
        }),
      ),
    ).toEqual({ ok: false, reason: "feature_flag_disabled" });
  });

  it("disables unsafe OpenAI fast-path cases", () => {
    expect(
      canUseSameProtocolSerializationFastPath(
        fastPathInput({ hasGovernedNativePayload: false }),
      ),
    ).toEqual({ ok: false, reason: "missing_governed_native_payload" });
    expect(
      canUseSameProtocolSerializationFastPath(
        fastPathInput({ request: fastPathRequest({ protocol: "anthropic_messages" }) }),
      ),
    ).toEqual({ ok: false, reason: "source_protocol_not_openai_chat" });
    expect(
      canUseSameProtocolSerializationFastPath(
        fastPathInput({ responseProtocol: "anthropic_messages" }),
      ),
    ).toEqual({ ok: false, reason: "response_protocol_not_openai_chat" });
    expect(
      canUseSameProtocolSerializationFastPath(
        fastPathInput({ targetProviderProtocol: "anthropic_messages" }),
      ),
    ).toEqual({ ok: false, reason: "target_provider_protocol_not_openai_chat" });
    expect(
      canUseSameProtocolSerializationFastPath(
        fastPathInput({ request: fastPathRequest({ stream: true }) }),
      ),
    ).toEqual({ ok: false, reason: "stream_not_supported" });
    expect(
      canUseSameProtocolSerializationFastPath(
        fastPathInput({
          request: fastPathRequest({
            metadata: { ...fastPathRequest().metadata, memory_mode: "inject" },
          }),
        }),
      ),
    ).toEqual({ ok: false, reason: "memory_inject_may_rewrite_request" });
    expect(
      canUseSameProtocolSerializationFastPath(
        fastPathInput({ fallbackMayUseDifferentProviderProtocol: true }),
      ),
    ).toEqual({ ok: false, reason: "fallback_may_change_provider_protocol" });
    expect(
      canUseSameProtocolSerializationFastPath(
        fastPathInput({ providerRequiresCompatibilityRewrite: true }),
      ),
    ).toEqual({ ok: false, reason: "provider_requires_compatibility_rewrite" });
  });
});
