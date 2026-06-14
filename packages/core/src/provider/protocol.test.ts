import type { InternalRequest } from "@helm/shared";
import { describe, expect, it } from "vitest";
import { canUseNativePassthrough, type NativePassthroughDecisionInput } from "./protocol.js";

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

  it("memory inject mode is NO LONGER a blocker (#217 Phase 4 PREFIX model)", () => {
    // Inject is now ADDITIVE: the pipeline prepends the memory block into the native
    // carrier's system/instructions and leaves messages/input verbatim, so native_request
    // stays consistent and passthrough can fire WITH memory. The guard therefore makes no
    // inject-specific decision — an inject-mode same-protocol request is ok:true.
    expect(
      canUseNativePassthrough(
        input({ request: request({ metadata: { ...request().metadata, memory_mode: "inject" } }) }),
      ),
    ).toEqual({ ok: true });
  });

  it("does not inspect later fallback candidates; passthrough is per-attempt", () => {
    expect(canUseNativePassthrough(input())).toEqual({ ok: true });
  });

  it("7) disables when the provider requires a compatibility rewrite (developer-role / schema remap)", () => {
    expect(canUseNativePassthrough(input({ providerRequiresCompatibilityRewrite: true }))).toEqual({
      ok: false,
      reason: "provider_requires_compatibility_rewrite",
    });
  });

  it("8) disables when the resolved provider client has no nativePassthrough method", () => {
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
      "hasNativeRequest",
      "providerRequiresCompatibilityRewrite",
      "providerSupportsPassthrough",
      "request",
      "targetProviderProtocol",
    ]);
  });
});
