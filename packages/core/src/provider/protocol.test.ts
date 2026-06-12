import type { InternalRequest } from "@helm/shared";
import { describe, expect, it } from "vitest";
import {
  canUseSameProtocolSerializationFastPath,
  type SameProtocolSerializationFastPathDecisionInput,
} from "./protocol.js";

function request(overrides: Partial<InternalRequest> = {}): InternalRequest {
  return {
    request_id: "req-1",
    protocol: "openai_chat",
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
  overrides: Partial<SameProtocolSerializationFastPathDecisionInput> = {},
): SameProtocolSerializationFastPathDecisionInput {
  return {
    request: request(),
    responseProtocol: "openai_chat",
    targetProviderProtocol: "openai_chat",
    fallbackMayUseDifferentProviderProtocol: false,
    providerRequiresCompatibilityRewrite: false,
    ...overrides,
  };
}

describe("canUseSameProtocolSerializationFastPath", () => {
  it("enables only openai_chat -> OpenAI-compatible chat non-stream serialization", () => {
    expect(canUseSameProtocolSerializationFastPath(input())).toEqual({ ok: true });
  });

  it("disables stream requests in the prep PR until stream fast path is implemented", () => {
    expect(
      canUseSameProtocolSerializationFastPath(input({ request: request({ stream: true }) })),
    ).toEqual({ ok: false, reason: "stream_not_supported_in_prep_pr" });
  });

  it("disables memory inject because it can rewrite messages before execute serialization", () => {
    expect(
      canUseSameProtocolSerializationFastPath(
        input({ request: request({ metadata: { ...request().metadata, memory_mode: "inject" } }) }),
      ),
    ).toEqual({ ok: false, reason: "memory_inject_may_rewrite_request" });
  });

  it("disables when fallback or retry may select a non OpenAI-compatible provider wire", () => {
    expect(
      canUseSameProtocolSerializationFastPath(
        input({ fallbackMayUseDifferentProviderProtocol: true }),
      ),
    ).toEqual({ ok: false, reason: "fallback_may_change_provider_protocol" });
  });

  it.each([
    "anthropic_messages",
    "gemini",
    "openai_responses",
  ] as const)("disables cross-protocol source %s", (protocol) => {
    expect(
      canUseSameProtocolSerializationFastPath(input({ request: request({ protocol }) })),
    ).toEqual({ ok: false, reason: "source_protocol_not_openai_chat" });
  });

  it.each([
    "anthropic_messages",
    "gemini",
    "openai_responses",
  ] as const)("disables non-chat target provider protocol %s", (targetProviderProtocol) => {
    expect(canUseSameProtocolSerializationFastPath(input({ targetProviderProtocol }))).toEqual({
      ok: false,
      reason: "target_provider_protocol_not_openai_chat",
    });
  });

  it("disables provider compatibility rewrites such as developer-role or tool/schema remaps", () => {
    expect(
      canUseSameProtocolSerializationFastPath(
        input({ providerRequiresCompatibilityRewrite: true }),
      ),
    ).toEqual({ ok: false, reason: "provider_requires_compatibility_rewrite" });
  });

  it("is only a serialization-layer decision and does not replace governance", () => {
    const decision = canUseSameProtocolSerializationFastPath(input());

    expect(decision).toEqual({ ok: true });
    // Governance remains outside this helper: auth, routing, budget, telemetry,
    // memory, fallback and breaker must already have run before execute asks this.
    expect(Object.keys(input()).sort()).toEqual([
      "fallbackMayUseDifferentProviderProtocol",
      "providerRequiresCompatibilityRewrite",
      "request",
      "responseProtocol",
      "targetProviderProtocol",
    ]);
  });
});
