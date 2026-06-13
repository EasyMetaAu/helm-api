import type { ExecutionPlan, ProviderClient } from "@helm/core";
import { createCircuitBreaker } from "@helm/core";
import type { InternalRequest } from "@helm/shared";
import { RuntimeSettingsSchema } from "@helm/shared";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { createExecute } from "./routes/execute.js";
import { buildRegistry, estimateRequestTokens } from "./server.js";

// A minimal Hono context whose request carries the given content-length header.
// We never read the body here — the estimator must derive its estimate WITHOUT
// consuming the stream, so the downstream route can still parse the body.
async function ctxWithContentLength(
  len: string | null,
): Promise<Parameters<Parameters<Hono["use"]>[1]>[0]> {
  const app = new Hono();
  let captured: unknown;
  app.use("*", async (c, next) => {
    captured = c;
    await next();
  });
  app.get("/", (c) => c.text("ok"));
  const headers: Record<string, string> = {};
  if (len !== null) headers["content-length"] = len;
  await app.request("/", { headers });
  // biome-ignore lint/suspicious/noExplicitAny: test narrows the captured context
  return captured as any;
}

describe("estimateRequestTokens", () => {
  it("derives a deterministic estimate of ceil(content-length / 4)", async () => {
    const c = await ctxWithContentLength("400");
    expect(estimateRequestTokens(c)).toBe(100);
  });

  it("rounds up partial tokens (ceil, not floor)", async () => {
    const c = await ctxWithContentLength("401");
    expect(estimateRequestTokens(c)).toBe(101);
  });

  it("estimates 0 when no content-length is present (cannot size the body)", async () => {
    const c = await ctxWithContentLength(null);
    expect(estimateRequestTokens(c)).toBe(0);
  });

  it("estimates 0 for a non-numeric / malformed content-length (never NaN)", async () => {
    const c = await ctxWithContentLength("not-a-number");
    expect(estimateRequestTokens(c)).toBe(0);
  });

  it("estimates 0 for a negative content-length (clamped, never negative)", async () => {
    const c = await ctxWithContentLength("-100");
    expect(estimateRequestTokens(c)).toBe(0);
  });
});

describe("native_protocol_passthrough runtime flag", () => {
  it("defaults OFF (merging the feature must not enable it)", () => {
    // The whole-object default — the SAME schema the gateway loads runtime
    // settings through. An empty blob must parse to passthrough OFF.
    const parsed = RuntimeSettingsSchema.parse({});
    expect(parsed.native_protocol_passthrough).toBe(false);
  });
});

// A gateway-shaped InternalRequest. `protocol` defaults to anthropic_messages
// here because these tests exercise the SAME-protocol passthrough decision (an
// openai_chat source would short-circuit at `source_protocol_is_lingua_franca`
// before the backfilled target protocol is ever consulted).
function gatewayReq(over: Partial<InternalRequest> = {}): InternalRequest {
  return {
    request_id: "req-1",
    protocol: "anthropic_messages",
    account_id: "acct",
    api_key_id: "k1",
    user_id: null,
    org_id: null,
    requested_model: "balanced",
    messages: [{ role: "user", content: "hello" }],
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
    ...over,
  };
}

// A verbatim native Anthropic body carried on the request (the messages route
// stamps this onto ir.metadata.native_request → toInternalRequest copies it).
function nativeAnthropicRequest(): Record<string, unknown> {
  return { model: "claude-x", messages: [{ role: "user", content: "hello" }], max_tokens: 16 };
}

function gatewayPlan(alias: string): ExecutionPlan {
  return { selected_lane: "balanced", candidate_chain: [alias], explicit_model: null };
}

// A provider with NO nativePassthrough method (the common case — only the
// Anthropic native client implements it). The guard must reach
// `provider_lacks_passthrough`, NOT a fake protocol mismatch.
function okProvider(): ProviderClient {
  return {
    chatCompletion: vi.fn().mockResolvedValue({ id: "ok" }),
    chatCompletionStream: vi.fn(),
  } as unknown as ProviderClient;
}

// A provider that DOES implement nativePassthrough — used to prove the
// compatibility-rewrite flag (not the missing method) is what disables passthrough.
function passthroughProvider(): ProviderClient {
  return {
    chatCompletion: vi.fn().mockResolvedValue({ id: "translated" }),
    chatCompletionStream: vi.fn(),
    nativePassthrough: vi.fn().mockResolvedValue({ id: "native" }),
  } as unknown as ProviderClient;
}

describe("buildRegistry backfill metadata through execute", () => {
  it("preserves a non-OpenAI primary protocol for a bare lane alias (not mislabeled openai_chat)", async () => {
    const provider = okProvider();
    const registry = buildRegistry(
      [
        {
          name: "anthropic",
          alias: "anthropic",
          type: "anthropic",
          base_url: "https://api.anthropic.com",
          api_key_env: "ANTHROPIC_API_KEY",
          models: [],
          targetProviderProtocol: "anthropic_messages",
          map_developer_role_to_system: false,
        },
      ],
      "anthropic",
      "https://api.anthropic.com",
      "ANTHROPIC_API_KEY",
      {
        balanced: {
          primary: "claude-bare",
          fallback: [],
          constraints: { require_tools: false, require_json: false, require_vision: false },
        },
      },
      "https://fallback.invalid",
    );
    const execute = createExecute({
      defaultProvider: provider,
      providers: new Map([["anthropic", provider]]),
      registry,
      breaker: createCircuitBreaker({
        config: { failureThreshold: 5, cooldownMs: 1000 },
        now: () => 0,
      }),
      catalog: new Map(),
      now: () => 0,
      signal: new AbortController().signal,
      nativeProtocolPassthroughEnabled: () => true,
    });

    const out = await execute(
      gatewayPlan("claude-bare"),
      gatewayReq({ native_request: nativeAnthropicRequest() }),
    );

    expect(out.final.status).toBe("ok");
    // The backfilled bare alias carried the PRIMARY's anthropic_messages protocol
    // (not the default openai_chat). The source protocol matched the target, so the
    // guard advanced past protocol_mismatch and disabled on the only remaining
    // gate (the default provider has no nativePassthrough method).
    expect(out.attempts[0]).toMatchObject({
      provider_name: "anthropic",
      provider_model: "claude-bare",
      target_provider_protocol: "anthropic_messages",
      passthrough_used: false,
      passthrough_disable_reason: "provider_lacks_passthrough",
    });
  });

  it("preserves compatibility-rewrite metadata for a bare lane alias", async () => {
    const provider = passthroughProvider();
    const registry = buildRegistry(
      [
        {
          name: "anthropic",
          alias: "anthropic",
          type: "anthropic",
          base_url: "https://api.anthropic.com",
          api_key_env: "ANTHROPIC_API_KEY",
          models: [],
          targetProviderProtocol: "anthropic_messages",
          // The compatibility shim disables verbatim passthrough — even though the
          // provider implements nativePassthrough and the protocols match.
          map_developer_role_to_system: true,
        },
      ],
      "anthropic",
      "https://api.anthropic.com",
      "ANTHROPIC_API_KEY",
      {
        balanced: {
          primary: "claude-bare",
          fallback: [],
          constraints: { require_tools: false, require_json: false, require_vision: false },
        },
      },
      "https://fallback.invalid",
    );
    const execute = createExecute({
      defaultProvider: provider,
      providers: new Map([["anthropic", provider]]),
      registry,
      breaker: createCircuitBreaker({
        config: { failureThreshold: 5, cooldownMs: 1000 },
        now: () => 0,
      }),
      catalog: new Map(),
      now: () => 0,
      signal: new AbortController().signal,
      nativeProtocolPassthroughEnabled: () => true,
    });

    const out = await execute(
      gatewayPlan("claude-bare"),
      gatewayReq({ native_request: nativeAnthropicRequest() }),
    );

    expect(out.final.status).toBe("ok");
    expect(out.attempts[0]).toMatchObject({
      provider_name: "anthropic",
      provider_model: "claude-bare",
      target_provider_protocol: "anthropic_messages",
      passthrough_used: false,
      passthrough_disable_reason: "provider_requires_compatibility_rewrite",
    });
  });
});
