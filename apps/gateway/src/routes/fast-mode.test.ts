import type { InternalRequest, NativePassthroughCarrier } from "@helm/shared";
import { describe, expect, it } from "vitest";
import { downgradeClientFastModeIfDisallowed } from "./fast-mode.js";

function request(overrides: Partial<InternalRequest> = {}): InternalRequest {
  return {
    request_id: "req_1",
    protocol: "anthropic_messages",
    account_id: "acct",
    api_key_id: "k1",
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
      memory_mode: "off",
    },
    ...overrides,
  };
}

describe("downgradeClientFastModeIfDisallowed", () => {
  it("preserves client-requested Fast mode when the API key allows passthrough", () => {
    const req = request({
      service_tier: "priority",
      provider_raw: { speed: "fast" },
      native_request: { speed: "fast" },
    });

    const out = downgradeClientFastModeIfDisallowed(req, true);

    expect(out).toBe(req);
    expect(out.service_tier).toBe("priority");
    expect(out.provider_raw?.speed).toBe("fast");
    expect((out.native_request as Record<string, unknown>).speed).toBe("fast");
  });

  it("downgrades OpenAI and Anthropic Fast fields when the API key disallows passthrough", () => {
    const native: NativePassthroughCarrier = {
      protocol: "anthropic_messages",
      body: { model: "claude-opus-4-8", speed: "fast", service_tier: "priority" },
      raw_body: '{"speed":"fast","service_tier":"priority"}',
      headers: {},
      mutations: {},
    };
    const req = request({
      service_tier: "Priority",
      provider_raw: { speed: "fast", kept: true },
      native_request: native,
    });

    const out = downgradeClientFastModeIfDisallowed(req, false);

    expect(out).not.toBe(req);
    expect(out.service_tier).toBe("default");
    expect(out.provider_raw).toEqual({ speed: "standard", kept: true });
    const outNative = out.native_request as NativePassthroughCarrier;
    expect(outNative.body).toEqual({
      model: "claude-opus-4-8",
      speed: "standard",
      service_tier: "default",
    });
    expect(outNative.raw_body).toBeUndefined();
    expect(outNative.mutations.body_shims_applied).toEqual([
      "client_fast_service_tier_downgraded",
      "client_fast_speed_downgraded",
    ]);
    expect(native.body.speed).toBe("fast");
    expect(native.mutations.body_shims_applied).toBeUndefined();
  });

  it("downgrades a plain native passthrough body without requiring a carrier", () => {
    const req = request({
      protocol: "openai_responses",
      native_request: { model: "gpt-5.5", service_tier: "fast" },
    });

    const out = downgradeClientFastModeIfDisallowed(req, undefined);

    expect(out.native_request).toEqual({ model: "gpt-5.5", service_tier: "default" });
  });

  it("removes only the Anthropic Fast beta token from native passthrough headers", () => {
    const native: NativePassthroughCarrier = {
      protocol: "anthropic_messages",
      body: { model: "claude-opus-4-8", speed: "standard" },
      raw_body: '{"speed":"standard"}',
      headers: {
        "anthropic-beta": "client-beta-2026-01-01, fast-mode-2026-02-01",
      },
      mutations: {},
    };
    const req = request({ native_request: native });

    const out = downgradeClientFastModeIfDisallowed(req, false);

    const carrier = out.native_request as NativePassthroughCarrier;
    expect(carrier.body.speed).toBe("standard");
    expect(carrier.raw_body).toBe('{"speed":"standard"}');
    expect(carrier.headers["anthropic-beta"]).toBe("client-beta-2026-01-01");
    expect(carrier.mutations.body_shims_applied).toEqual(["client_fast_beta_header_downgraded"]);
    expect(carrier.mutations.headers_overwritten).toEqual(["anthropic-beta"]);
    expect(native.headers["anthropic-beta"]).toBe("client-beta-2026-01-01, fast-mode-2026-02-01");
  });

  it("drops the Anthropic beta header when it only requested Fast mode", () => {
    const native: NativePassthroughCarrier = {
      protocol: "anthropic_messages",
      body: { model: "claude-opus-4-8", speed: "standard" },
      headers: {
        "Anthropic-Beta": ["fast-mode-2026-02-01"],
      },
      mutations: {},
    };
    const req = request({ native_request: native });

    const out = downgradeClientFastModeIfDisallowed(req, false);

    const carrier = out.native_request as NativePassthroughCarrier;
    expect(carrier.headers["Anthropic-Beta"]).toBeUndefined();
    expect(carrier.mutations.headers_dropped).toEqual(["anthropic-beta"]);
  });
});
