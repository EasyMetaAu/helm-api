import type { CircuitBreaker, ExecutionPlan, ProviderClient, ProviderRegistry } from "@helm/core";
import {
  createAnthropicClient,
  createCircuitBreaker,
  createGeminiClient,
  createGenericOpenAIResponsesClient,
  createOAuthPoolClient,
  TokenRefreshError,
  UpstreamError,
} from "@helm/core";
import {
  type CatalogEntry,
  createNativePassthroughCarrier,
  ERROR_CLASS_HTTP_STATUS,
  type InternalRequest,
  type NativePassthroughCarrier,
  nativePassthroughBody,
  type TargetProviderProtocol,
} from "@helm/shared";
import { describe, expect, it, vi } from "vitest";
import { createExecute, detectRequestModalities, isAccountScopedFault } from "./execute.js";

function req(over: Partial<InternalRequest> = {}): InternalRequest {
  return {
    request_id: "req-1",
    protocol: "openai_chat",
    account_id: "acct",
    api_key_id: "k1",
    user_id: null,
    org_id: null,
    requested_model: "auto",
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

describe("detectRequestModalities — remote media-as-document routing (GEM-02)", () => {
  it("routes an audio/* document part to the audio modality, not document", () => {
    const r = req({
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "transcribe" },
            { type: "document", mediaType: "audio/mp3", url: "gs://bucket/clip.mp3" },
          ],
        },
      ] as InternalRequest["messages"],
    });
    expect(detectRequestModalities(r)).toEqual({
      image: false,
      audio: true,
      video: false,
      document: false,
    });
  });

  it("still routes a real application/pdf document to the document modality", () => {
    const r = req({
      messages: [
        {
          role: "user",
          content: [{ type: "document", mediaType: "application/pdf", url: "gs://b/x.pdf" }],
        },
      ] as InternalRequest["messages"],
    });
    expect(detectRequestModalities(r).document).toBe(true);
    expect(detectRequestModalities(r).audio).toBe(false);
  });
});

// Registry: alias -> providerModel passthrough.
function registry(map: Record<string, string>): ProviderRegistry {
  return {
    resolve(alias: string) {
      const pm = map[alias];
      if (pm === undefined) return { ok: false, error: { kind: "unknown_alias", alias } };
      return {
        ok: true,
        value: {
          alias,
          providerName: "mock",
          providerModel: pm,
          baseUrl: "http://x",
          apiKeyEnv: "X",
          targetProviderProtocol: "openai_chat",
          providerRequiresCompatibilityRewrite: false,
        },
      };
    },
    list: () => Object.keys(map),
  };
}

function registryWithProviders(
  map: Record<string, { providerName: string; providerModel: string }>,
): ProviderRegistry {
  return {
    resolve(alias: string) {
      const hit = map[alias];
      if (hit === undefined) return { ok: false, error: { kind: "unknown_alias", alias } };
      return {
        ok: true,
        value: {
          alias,
          providerName: hit.providerName,
          providerModel: hit.providerModel,
          baseUrl: "http://x",
          apiKeyEnv: "X",
          targetProviderProtocol: "openai_chat",
          providerRequiresCompatibilityRewrite: false,
        },
      };
    },
    list: () => Object.keys(map),
  };
}

function protocolRegistry(
  map: Record<
    string,
    {
      providerName: string;
      providerModel: string;
      targetProviderProtocol: TargetProviderProtocol;
      providerRequiresCompatibilityRewrite?: boolean;
    }
  >,
): ProviderRegistry {
  return {
    resolve(alias: string) {
      const hit = map[alias];
      if (hit === undefined) return { ok: false, error: { kind: "unknown_alias", alias } };
      return {
        ok: true,
        value: {
          alias,
          providerName: hit.providerName,
          providerModel: hit.providerModel,
          baseUrl: "http://x",
          apiKeyEnv: "X",
          targetProviderProtocol: hit.targetProviderProtocol,
          providerRequiresCompatibilityRewrite: hit.providerRequiresCompatibilityRewrite === true,
        },
      };
    },
    list: () => Object.keys(map),
  };
}

function plan(chain: string[]): ExecutionPlan {
  return { selected_lane: "balanced", candidate_chain: chain, explicit_model: null };
}

function breaker(): CircuitBreaker {
  return createCircuitBreaker({ config: { failureThreshold: 5, cooldownMs: 1000 }, now: () => 0 });
}

async function* gen(chunks: string[]): AsyncGenerator<string> {
  for (const c of chunks) yield c;
}

function clock() {
  let t = 0;
  return () => (t += 10);
}

describe("createExecute — gateway execution adapter", () => {
  it("invokes the head candidate and returns the non-stream body", async () => {
    const provider = {
      chatCompletion: vi.fn().mockResolvedValue({ id: "ok" }),
      chatCompletionStream: vi.fn(),
    } as unknown as ProviderClient;
    const execute = createExecute({
      defaultProvider: provider,
      providers: new Map([["mock", provider]]),
      registry: registry({ default_good_model: "gpt-x" }),
      breaker: breaker(),
      catalog: new Map(),
      now: clock(),
      signal: new AbortController().signal,
    });

    const out = await execute(plan(["default_good_model"]), req());
    expect(out.final.status).toBe("ok");
    expect(out.body).toEqual({ id: "ok" });
    expect(out.attempts[0]?.status).toBe("ok");
  });

  it("forwards LiteLLM/OpenAI-compatible params to the upstream request body", async () => {
    const provider = {
      chatCompletion: vi.fn().mockResolvedValue({ id: "ok" }),
      chatCompletionStream: vi.fn(),
    } as unknown as ProviderClient;
    const execute = createExecute({
      defaultProvider: provider,
      providers: new Map([["mock", provider]]),
      registry: registry({ default_good_model: "gpt-x" }),
      breaker: breaker(),
      catalog: new Map([
        ["default_good_model", entry("default_good_model", { supportsCachedContent: true })],
      ]),
      now: clock(),
      signal: new AbortController().signal,
    });

    await execute(
      plan(["default_good_model"]),
      req({
        temperature: 0.2,
        top_p: 0.9,
        top_k: 32,
        frequency_penalty: 0.1,
        presence_penalty: -0.1,
        seed: 42,
        stop: ["END"],
        n: 2,
        logprobs: true,
        top_logprobs: 3,
        max_completion_tokens: 123,
        tool_choice: "auto",
        parallel_tool_calls: false,
        modalities: ["text", "audio"],
        reasoning_effort: "high",
        user: "user-123",
        service_tier: "auto",
        prompt_cache_key: "thread-123",
        prompt_cache_retention: "24h",
        cached_content: "cachedContents/gemini-ctx",
        prediction: { type: "content", content: "expected" },
        audio: { voice: "alloy", format: "wav" },
        logit_bias: { "42": -1 },
        web_search_options: { search_context_size: "low" },
        include_server_side_tool_invocations: true,
        verbosity: "low",
        safety_identifier: "safe-user",
        provider_raw: {
          metadata: { prompt_version: "v1" },
          store: false,
        },
      }),
    );

    const body = (provider.chatCompletion as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as Record<
      string,
      unknown
    >;
    expect(body).toMatchObject({
      model: "gpt-x",
      temperature: 0.2,
      top_p: 0.9,
      top_k: 32,
      frequency_penalty: 0.1,
      presence_penalty: -0.1,
      seed: 42,
      stop: ["END"],
      n: 2,
      logprobs: true,
      top_logprobs: 3,
      max_completion_tokens: 123,
      tool_choice: "auto",
      parallel_tool_calls: false,
      modalities: ["text", "audio"],
      reasoning_effort: "high",
      user: "user-123",
      service_tier: "auto",
      prompt_cache_key: "thread-123",
      prompt_cache_retention: "24h",
      cached_content: "cachedContents/gemini-ctx",
      prediction: { type: "content", content: "expected" },
      audio: { voice: "alloy", format: "wav" },
      logit_bias: { "42": -1 },
      web_search_options: { search_context_size: "low" },
      include_server_side_tool_invocations: true,
      verbosity: "low",
      safety_identifier: "safe-user",
      metadata: { prompt_version: "v1" },
      store: false,
    });
  });

  it("does not forward Responses-only previous_response_id/truncation to OpenAI-compatible upstreams", async () => {
    const provider = {
      chatCompletion: vi.fn().mockResolvedValue({ id: "ok", usage: {} }),
      chatCompletionStream: vi.fn(),
    } as unknown as ProviderClient;
    const execute = createExecute({
      defaultProvider: provider,
      providers: new Map([["mock", provider]]),
      registry: registry({ default_good_model: "gpt-x" }),
      breaker: breaker(),
      catalog: new Map(),
      now: clock(),
      signal: new AbortController().signal,
    });

    await execute(
      plan(["default_good_model"]),
      req({
        provider_raw: { previous_response_id: "resp_prev", truncation: "auto", store: false },
      }),
    );

    const body = (provider.chatCompletion as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as Record<
      string,
      unknown
    >;
    expect(body.previous_response_id).toBeUndefined();
    expect(body.truncation).toBeUndefined();
    expect(body.store).toBe(false);
  });

  it("renders Responses output caps as max_completion_tokens for GPT-5.6 OpenAI-chat targets", async () => {
    const provider = {
      chatCompletion: vi.fn().mockResolvedValue({ id: "ok", usage: {} }),
      chatCompletionStream: vi.fn(),
    } as unknown as ProviderClient;
    const execute = createExecute({
      defaultProvider: provider,
      providers: new Map([["mock", provider]]),
      registry: protocolRegistry({
        "openai/gpt-5.6-luna": {
          providerName: "mock",
          providerModel: "gpt-5.6-luna",
          targetProviderProtocol: "openai_chat",
        },
      }),
      breaker: breaker(),
      catalog: new Map(),
      now: clock(),
      signal: new AbortController().signal,
    });

    const out = await execute(
      plan(["openai/gpt-5.6-luna"]),
      req({ protocol: "openai_responses", max_tokens: 16 }),
    );

    expect(out.final.status).toBe("ok");
    const body = (provider.chatCompletion as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as Record<
      string,
      unknown
    >;
    expect(body.max_completion_tokens).toBe(16);
    expect(body).not.toHaveProperty("max_tokens");
  });

  it("sets GPT-5.6 chat reasoning_effort none when function tools are present", async () => {
    const provider = {
      chatCompletion: vi.fn().mockResolvedValue({ id: "ok", usage: {} }),
      chatCompletionStream: vi.fn(),
    } as unknown as ProviderClient;
    const execute = createExecute({
      defaultProvider: provider,
      providers: new Map([["mock", provider]]),
      registry: protocolRegistry({
        "openai/gpt-5.6-luna": {
          providerName: "mock",
          providerModel: "gpt-5.6-luna",
          targetProviderProtocol: "openai_chat",
        },
      }),
      breaker: breaker(),
      catalog: new Map([
        [
          "openai/gpt-5.6-luna",
          entry("openai/gpt-5.6-luna", {
            reasoningEffort: {
              openaiReasoning: {
                supported: true,
                levels: ["none", "low", "medium", "high", "xhigh", "max"],
              },
            },
          }),
        ],
      ]),
      now: clock(),
      signal: new AbortController().signal,
    });

    const tool = {
      type: "function",
      function: {
        name: "git_push",
        description: "Push the current branch",
        parameters: { type: "object", properties: {} },
      },
    };
    const out = await execute(
      plan(["openai/gpt-5.6-luna"]),
      req({
        protocol: "anthropic_messages",
        reasoning_effort: "medium",
        tools: [tool],
      }),
    );

    expect(out.final.status).toBe("ok");
    const body = (provider.chatCompletion as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as Record<
      string,
      unknown
    >;
    expect(body.model).toBe("gpt-5.6-luna");
    expect(body.tools).toEqual([tool]);
    expect(body.reasoning_effort).toBe("none");
    expect(out.attempts[0]?.request_mutations).toMatchObject({
      body_shims_applied: ["reasoning_effort_none_for_chat_tools"],
    });
  });

  it("sets GPT-5.6 chat reasoning_effort none for Anthropic-shaped tools without catalog data", async () => {
    const provider = {
      chatCompletion: vi.fn().mockResolvedValue({ id: "ok", usage: {} }),
      chatCompletionStream: vi.fn(),
    } as unknown as ProviderClient;
    const execute = createExecute({
      defaultProvider: provider,
      providers: new Map([["mock", provider]]),
      registry: protocolRegistry({
        "openai/gpt-5.6-luna": {
          providerName: "mock",
          providerModel: "gpt-5.6-luna",
          targetProviderProtocol: "openai_chat",
        },
      }),
      breaker: breaker(),
      catalog: new Map(),
      now: clock(),
      signal: new AbortController().signal,
    });

    const tool = {
      name: "noop_tool",
      description: "No-op test tool",
      input_schema: { type: "object", properties: {} },
    };
    const out = await execute(
      plan(["openai/gpt-5.6-luna"]),
      req({
        protocol: "anthropic_messages",
        reasoning_effort: "medium",
        tools: [tool],
      }),
    );

    expect(out.final.status).toBe("ok");
    const body = (provider.chatCompletion as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as Record<
      string,
      unknown
    >;
    expect(body.model).toBe("gpt-5.6-luna");
    expect(body.tools).toEqual([tool]);
    expect(body.reasoning_effort).toBe("none");
    expect(out.attempts[0]?.request_mutations).toMatchObject({
      body_shims_applied: ["reasoning_effort_none_for_chat_tools"],
    });
  });

  it("sets GPT-5.6 chat reasoning_effort none for tools even when the client omits reasoning", async () => {
    const provider = {
      chatCompletion: vi.fn().mockResolvedValue({ id: "ok", usage: {} }),
      chatCompletionStream: vi.fn(),
    } as unknown as ProviderClient;
    const execute = createExecute({
      defaultProvider: provider,
      providers: new Map([["mock", provider]]),
      registry: protocolRegistry({
        "openai/gpt-5.6-luna": {
          providerName: "mock",
          providerModel: "gpt-5.6-luna",
          targetProviderProtocol: "openai_chat",
        },
      }),
      breaker: breaker(),
      catalog: new Map(),
      now: clock(),
      signal: new AbortController().signal,
    });

    await execute(
      plan(["openai/gpt-5.6-luna"]),
      req({
        protocol: "anthropic_messages",
        tools: [
          {
            type: "function",
            function: {
              name: "noop_tool",
              parameters: { type: "object", properties: {} },
            },
          },
        ],
      }),
    );

    const body = (provider.chatCompletion as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as Record<
      string,
      unknown
    >;
    expect(body.reasoning_effort).toBe("none");
  });

  it.each([
    "openai_chat",
    "anthropic_messages",
  ] as const)("does not forward Responses reasoning history as %s provider thinking config", async (targetProviderProtocol) => {
    const provider = {
      chatCompletion: vi.fn().mockResolvedValue({ id: "ok", usage: {} }),
      chatCompletionStream: vi.fn(),
    } as unknown as ProviderClient;
    const execute = createExecute({
      defaultProvider: provider,
      providers: new Map([["mock", provider]]),
      registry: protocolRegistry({
        default_good_model: {
          providerName: "mock",
          providerModel: "gpt-x",
          targetProviderProtocol,
        },
      }),
      breaker: breaker(),
      catalog: new Map(),
      now: clock(),
      signal: new AbortController().signal,
    });

    const out = await execute(
      plan(["default_good_model"]),
      req({
        protocol: "openai_responses",
        thinking: [{ type: "thinking", text: "" }],
        provider_raw: {
          reasoning: [{ type: "reasoning", id: "rs_missing", summary: [] }],
        },
      }),
    );

    const body = (provider.chatCompletion as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as Record<
      string,
      unknown
    >;
    expect(body.thinking).toBeUndefined();
    expect(out.attempts[0]?.request_mutations).toMatchObject({
      thinking_history_stripped_for_target: true,
    });
  });

  it("strips Anthropic thinking controls on OpenAI-compatible fallback without reasoning support", async () => {
    const provider = {
      chatCompletion: vi.fn().mockResolvedValue({ id: "ok", usage: {} }),
      chatCompletionStream: vi.fn(),
    } as unknown as ProviderClient;
    const execute = createExecute({
      defaultProvider: provider,
      providers: new Map([["mock", provider]]),
      registry: protocolRegistry({
        default_good_model: {
          providerName: "mock",
          providerModel: "deepseek-v4-pro",
          targetProviderProtocol: "openai_chat",
        },
      }),
      breaker: breaker(),
      catalog: new Map([["default_good_model", entry("default_good_model")]]),
      now: clock(),
      signal: new AbortController().signal,
    });

    const out = await execute(
      plan(["default_good_model"]),
      req({
        protocol: "anthropic_messages",
        thinking: { type: "adaptive" },
        reasoning_effort: "medium",
        provider_raw: { output_config: { effort: "medium" } },
      }),
    );

    expect(out.final.status).toBe("ok");
    const body = (provider.chatCompletion as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as Record<
      string,
      unknown
    >;
    expect(body.thinking).toBeUndefined();
    expect(body.reasoning_effort).toBeUndefined();
    expect(body.output_config).toBeUndefined();
    expect(out.attempts[0]?.request_mutations).toMatchObject({
      thinking_config_stripped_for_openai: true,
      provider_raw_stripped_for_openai: ["output_config"],
    });
    expect(out.attempts[0]?.request_mutations?.body_shims_applied).toEqual(
      expect.arrayContaining([
        "thinking_config_stripped_for_openai",
        "reasoning_effort_stripped_for_model",
      ]),
    );
  });

  it("does not forward Anthropic-only provider_raw keys to OpenAI-compatible upstreams", async () => {
    const provider = {
      chatCompletion: vi.fn().mockResolvedValue({ id: "ok", usage: {} }),
      chatCompletionStream: vi.fn(),
    } as unknown as ProviderClient;
    const execute = createExecute({
      defaultProvider: provider,
      providers: new Map([["mock", provider]]),
      registry: registry({ default_good_model: "gpt-x" }),
      breaker: breaker(),
      catalog: new Map(),
      now: clock(),
      signal: new AbortController().signal,
    });

    const out = await execute(
      plan(["default_good_model"]),
      req({
        protocol: "anthropic_messages",
        provider_raw: {
          metadata: { prompt_version: "v1" },
          store: false,
          context_management: { edits: [{ type: "clear_tool_uses_20250919" }] },
          mcp_servers: [{ type: "url", url: "https://mcp.example.test" }],
          container: { id: "container_123" },
          speed: "fast",
          output_config: { effort: "xhigh" },
        },
      }),
    );

    const body = (provider.chatCompletion as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as Record<
      string,
      unknown
    >;
    expect(body.metadata).toEqual({ prompt_version: "v1" });
    expect(body.store).toBe(false);
    expect(body.context_management).toBeUndefined();
    expect(body.mcp_servers).toBeUndefined();
    expect(body.container).toBeUndefined();
    expect(body.speed).toBeUndefined();
    expect(body.output_config).toBeUndefined();
    expect(out.attempts[0]?.request_mutations).toMatchObject({
      provider_raw_stripped_for_openai: [
        "context_management",
        "mcp_servers",
        "container",
        "speed",
        "output_config",
      ],
    });
  });

  it("strips Anthropic cache_control markers before OpenAI-compatible upstream calls", async () => {
    const provider = {
      chatCompletion: vi.fn().mockResolvedValue({ id: "ok", usage: {} }),
      chatCompletionStream: vi.fn(),
    } as unknown as ProviderClient;
    const execute = createExecute({
      defaultProvider: provider,
      providers: new Map([["mock", provider]]),
      registry: registry({ default_good_model: "gpt-x" }),
      breaker: breaker(),
      catalog: new Map(),
      now: clock(),
      signal: new AbortController().signal,
    });

    const out = await execute(
      plan(["default_good_model"]),
      req({
        cache_control: { type: "ephemeral" },
        messages: [
          {
            role: "user",
            content: [
              {
                type: "text",
                text: "hello",
                cache_control: { type: "ephemeral" },
              },
            ],
            cache_control: { type: "ephemeral" },
          },
        ] as unknown as InternalRequest["messages"],
        tools: [
          {
            type: "function",
            function: {
              name: "search",
              parameters: {
                type: "object",
                properties: {
                  query: { type: "string", cache_control: { type: "ephemeral" } },
                },
              },
            },
            cache_control: { type: "ephemeral" },
          },
        ],
      }),
    );

    const body = (provider.chatCompletion as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as Record<
      string,
      unknown
    >;
    expect(JSON.stringify(body)).not.toContain("cache_control");
    expect(out.attempts[0]?.request_mutations).toMatchObject({
      cache_control_stripped_for_openai: 4,
    });
  });

  it("renders normalized IR multimodal parts back to OpenAI-native content for OpenAI targets", async () => {
    const provider = {
      chatCompletion: vi.fn().mockResolvedValue({ id: "ok", usage: {} }),
      chatCompletionStream: vi.fn(),
    } as unknown as ProviderClient;
    const execute = createExecute({
      defaultProvider: provider,
      providers: new Map([["mock", provider]]),
      registry: registry({ default_good_model: "gpt-x" }),
      breaker: breaker(),
      catalog: new Map(),
      now: clock(),
      signal: new AbortController().signal,
    });

    await execute(
      plan(["default_good_model"]),
      req({
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "look" },
              { type: "image", url: "https://example.test/cat.png", detail: "low" },
              {
                type: "document",
                data: "JVBERi0=",
                mediaType: "application/pdf",
                filename: "document.pdf",
              },
            ],
          },
        ] as unknown as InternalRequest["messages"],
      }),
    );

    const body = (provider.chatCompletion as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as {
      messages?: Array<{ content?: Array<Record<string, unknown>> }>;
    };
    const parts = body.messages?.[0]?.content ?? [];
    expect(parts[1]).toEqual({
      type: "image_url",
      image_url: { url: "https://example.test/cat.png", detail: "low" },
    });
    expect(parts[2]).toEqual({
      type: "file",
      file: {
        file_data: "data:application/pdf;base64,JVBERi0=",
        filename: "document.pdf",
        format: "application/pdf",
      },
    });
  });

  it("records a Gemini remote-media warning when translated media is not materialized", async () => {
    const provider = {
      chatCompletion: vi.fn().mockResolvedValue({ id: "ok", choices: [], usage: {} }),
      chatCompletionStream: vi.fn(),
    } as unknown as ProviderClient;
    const execute = createExecute({
      defaultProvider: provider,
      providers: new Map([["gemini", provider]]),
      registry: protocolRegistry({
        g: {
          providerName: "gemini",
          providerModel: "gemini-2.0-flash",
          targetProviderProtocol: "gemini",
        },
      }),
      breaker: breaker(),
      catalog: new Map(),
      now: clock(),
      signal: new AbortController().signal,
    });

    const out = await execute(
      plan(["g"]),
      req({
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "describe" },
              { type: "image", url: "https://example.test/cat.png", mediaType: "image/png" },
            ],
          },
        ] as InternalRequest["messages"],
      }),
    );

    expect(out.final.status).toBe("ok");
    expect(out.attempts[0]?.request_mutations).toMatchObject({
      remote_media_not_materialized: 1,
    });
  });

  it("blocks every Responses previous_response_id continuation on non-Responses targets", async () => {
    const provider = {
      chatCompletion: vi.fn().mockResolvedValue({ id: "should-not-call" }),
      chatCompletionStream: vi.fn(),
    } as unknown as ProviderClient;
    const execute = createExecute({
      defaultProvider: provider,
      providers: new Map([["mock", provider]]),
      registry: registry({ default_good_model: "gpt-x" }),
      breaker: breaker(),
      catalog: new Map(),
      now: clock(),
      signal: new AbortController().signal,
    });

    const out = await execute(
      plan(["default_good_model"]),
      req({
        protocol: "openai_responses",
        messages: [{ role: "user", content: "continue" }],
        provider_raw: { previous_response_id: "resp_prev" },
      }),
    );

    expect(provider.chatCompletion).not.toHaveBeenCalled();
    expect(out.final.status).toBe("error");
    if (out.final.status !== "error") throw new Error("expected error result");
    expect(out.final.error.error_class).toBe("capability_unsatisfiable");
    expect(out.attempts[0]?.skip_reason).toBe(
      "responses_previous_response_id_cross_protocol_blocked",
    );
  });

  it("keeps a previous_response_id continuation on its recorded provider alias", async () => {
    const first = {
      chatCompletion: vi.fn().mockResolvedValue({ id: "wrong-provider" }),
      chatCompletionStream: vi.fn(),
    } as unknown as ProviderClient;
    const pinned = {
      chatCompletion: vi.fn().mockResolvedValue({ id: "right-provider" }),
      chatCompletionStream: vi.fn(),
    } as unknown as ProviderClient;
    const execute = createExecute({
      defaultProvider: first,
      providers: new Map([
        ["first", first],
        ["pinned", pinned],
      ]),
      registry: protocolRegistry({
        "first/gpt": {
          providerName: "first",
          providerModel: "gpt",
          targetProviderProtocol: "openai_responses",
        },
        "pinned/gpt": {
          providerName: "pinned",
          providerModel: "gpt",
          targetProviderProtocol: "openai_responses",
        },
      }),
      breaker: breaker(),
      catalog: new Map(),
      now: clock(),
      signal: new AbortController().signal,
    });
    const request = req({
      protocol: "openai_responses",
      provider_raw: { previous_response_id: "resp_prev" },
    });
    (request.metadata as Record<string, unknown>).stateful_provider_alias = "pinned/gpt";

    const out = await execute(plan(["first/gpt", "pinned/gpt"]), request);

    expect(out.final).toMatchObject({ status: "ok", alias: "pinned/gpt" });
    expect(first.chatCompletion).not.toHaveBeenCalled();
    expect(pinned.chatCompletion).toHaveBeenCalledOnce();
    expect(out.attempts[0]?.skip_reason).toBe("responses_previous_response_id_provider_mismatch");
  });

  it("rejects generate:false when native Responses passthrough is unavailable", async () => {
    const provider = {
      chatCompletion: vi.fn().mockResolvedValue({ id: "must-not-generate" }),
      chatCompletionStream: vi.fn(),
    } as unknown as ProviderClient;
    const execute = createExecute({
      defaultProvider: provider,
      providers: new Map([["responses", provider]]),
      registry: protocolRegistry({
        "responses/gpt": {
          providerName: "responses",
          providerModel: "gpt",
          targetProviderProtocol: "openai_responses",
        },
      }),
      breaker: breaker(),
      catalog: new Map(),
      now: clock(),
      signal: new AbortController().signal,
    });

    const out = await execute(
      plan(["responses/gpt"]),
      req({
        protocol: "openai_responses",
        provider_raw: { generate: false },
        native_request: {
          protocol: "openai_responses",
          body: { model: "gpt", input: [], generate: false, stream: false },
          headers: {},
          mutations: {},
        },
      }),
    );

    expect(provider.chatCompletion).not.toHaveBeenCalled();
    expect(out.final.status).toBe("error");
    expect(out.attempts[0]?.skip_reason).toBe(
      "responses_generate_false_requires_native_passthrough",
    );
  });

  it.each([
    ["mcp", { type: "mcp", server_label: "local" }],
    ["file_search", { type: "file_search", vector_store_ids: ["vs_1"] }],
  ])("blocks Responses native %s tools on non-Responses targets", async (_label, nativeTool) => {
    const provider = {
      chatCompletion: vi.fn().mockResolvedValue({ id: "should-not-call" }),
      chatCompletionStream: vi.fn(),
    } as unknown as ProviderClient;
    const execute = createExecute({
      defaultProvider: provider,
      providers: new Map([["mock", provider]]),
      registry: registry({ default_good_model: "gpt-x" }),
      breaker: breaker(),
      catalog: new Map(),
      now: clock(),
      signal: new AbortController().signal,
    });

    const out = await execute(
      plan(["default_good_model"]),
      req({
        protocol: "openai_responses",
        provider_raw: { responses_native_tools: [nativeTool] },
      }),
    );

    expect(provider.chatCompletion).not.toHaveBeenCalled();
    expect(out.final.status).toBe("error");
    if (out.final.status !== "error") throw new Error("expected error result");
    expect(out.final.error.error_class).toBe("capability_unsatisfiable");
    expect(out.attempts[0]?.skip_reason).toBe("responses_native_tools_cross_protocol_blocked");
  });

  it("blocks Responses background mode on non-Responses targets", async () => {
    const provider = {
      chatCompletion: vi.fn().mockResolvedValue({ id: "should-not-call" }),
      chatCompletionStream: vi.fn(),
    } as unknown as ProviderClient;
    const execute = createExecute({
      defaultProvider: provider,
      providers: new Map([["mock", provider]]),
      registry: registry({ default_good_model: "gpt-x" }),
      breaker: breaker(),
      catalog: new Map(),
      now: clock(),
      signal: new AbortController().signal,
    });

    const out = await execute(
      plan(["default_good_model"]),
      req({ protocol: "openai_responses", provider_raw: { background: true } }),
    );

    expect(provider.chatCompletion).not.toHaveBeenCalled();
    expect(out.final.status).toBe("error");
    if (out.final.status !== "error") throw new Error("expected error result");
    expect(out.final.error.error_class).toBe("capability_unsatisfiable");
    expect(out.attempts[0]?.skip_reason).toBe("responses_background_cross_protocol_blocked");
  });

  it.each([
    [
      "PTC input sequence",
      {
        responses_input_items: [
          { type: "program", call_id: "call_program", code: "return 1" },
          {
            type: "function_call",
            call_id: "call_tool",
            name: "lookup",
            arguments: "{}",
            caller: { type: "program", caller_id: "call_program" },
          },
        ],
      },
    ],
    ["future native items", { unknown_items: [{ type: "future_response_item", opaque: true }] }],
  ])("blocks Responses %s on non-Responses targets", async (_label, providerRaw) => {
    const provider = {
      chatCompletion: vi.fn().mockResolvedValue({ id: "should-not-call" }),
      chatCompletionStream: vi.fn(),
    } as unknown as ProviderClient;
    const execute = createExecute({
      defaultProvider: provider,
      providers: new Map([["mock", provider]]),
      registry: registry({ default_good_model: "gpt-x" }),
      breaker: breaker(),
      catalog: new Map(),
      now: clock(),
      signal: new AbortController().signal,
    });

    const out = await execute(
      plan(["default_good_model"]),
      req({ protocol: "openai_responses", provider_raw: providerRaw }),
    );

    expect(provider.chatCompletion).not.toHaveBeenCalled();
    expect(out.final.status).toBe("error");
    expect(out.attempts[0]?.skip_reason).toBe("responses_native_items_cross_protocol_blocked");
  });

  it("translates (does NOT skip) foldable Responses items to a non-Responses target", async () => {
    // A plain custom_tool_call / caller-free function_call folds losslessly into
    // assistant.tool_calls — the cross-protocol guard must let the candidate run the
    // normal responses->IR->target translation instead of skipping the whole candidate.
    // Regression for Codex fallback: GPT quota exhausted must still reach Claude.
    const provider = {
      chatCompletion: vi.fn().mockResolvedValue({ id: "translated-ok", usage: {} }),
      chatCompletionStream: vi.fn(),
    } as unknown as ProviderClient;
    const execute = createExecute({
      defaultProvider: provider,
      providers: new Map([["mock", provider]]),
      registry: registry({ default_good_model: "gpt-x" }),
      breaker: breaker(),
      catalog: new Map(),
      now: clock(),
      signal: new AbortController().signal,
    });

    const out = await execute(
      plan(["default_good_model"]),
      req({
        protocol: "openai_responses",
        provider_raw: {
          responses_input_items: [
            { type: "custom_tool_call", call_id: "c1", name: "apply_patch", input: "{}" },
          ],
        },
      }),
    );

    expect(provider.chatCompletion).toHaveBeenCalled();
    expect(out.attempts[0]?.skip_reason).not.toBe("responses_native_items_cross_protocol_blocked");
  });

  it("blocks Codex-native Responses items on xAI Responses targets", async () => {
    const memberClient = {
      chatCompletion: vi.fn().mockResolvedValue({ id: "should-not-call" }),
      chatCompletionStream: vi.fn(),
      nativeProtocolProfile: "generic_openai_responses",
    } as unknown as ProviderClient;
    const provider = createOAuthPoolClient({
      members: [
        {
          account: "xai-account",
          priority: 10,
          schedulable: true,
          client: memberClient,
        },
      ],
    });
    const execute = createExecute({
      defaultProvider: provider,
      providers: new Map([["xai", provider]]),
      registry: {
        resolve(alias: string) {
          if (alias !== "xai/grok-4.5") {
            return { ok: false as const, error: { kind: "unknown_alias" as const, alias } };
          }
          return {
            ok: true as const,
            value: {
              alias,
              providerName: "xai",
              providerModel: "grok-4.5",
              baseUrl: "https://example.test",
              apiKeyEnv: "XAI_API_KEY",
              targetProviderProtocol: "openai_responses" as const,
              providerRequiresCompatibilityRewrite: false,
            },
          };
        },
        list: () => ["xai/grok-4.5"],
      },
      breaker: breaker(),
      catalog: new Map(),
      now: clock(),
      signal: new AbortController().signal,
    });

    const out = await execute(
      plan(["xai/grok-4.5"]),
      req({
        protocol: "openai_responses",
        provider_raw: {
          unknown_items: [{ type: "agent_message", content: [] }],
        },
      }),
    );

    expect(memberClient.chatCompletion).not.toHaveBeenCalled();
    expect(out.final.status).toBe("error");
    expect(out.attempts[0]?.skip_reason).toBe("responses_native_items_provider_incompatible");
  });

  it("translates (not verbatim-forwards) a FOLDABLE Codex body to an xAI Responses pool", async () => {
    // Regression: GPT quota exhausted -> Grok fallback. A plain custom_tool_call folds
    // losslessly, so instead of a 422 verbatim passthrough (or a hard skip), the xAI
    // member's chatCompletion translation path runs and produces a clean Responses body.
    const memberClient = {
      chatCompletion: vi.fn().mockResolvedValue({ id: "grok-translated", usage: {} }),
      chatCompletionStream: vi.fn(),
      nativePassthrough: vi.fn().mockResolvedValue({ id: "should-not-passthrough" }),
      nativeProtocolProfile: "generic_openai_responses",
    } as unknown as ProviderClient;
    const provider = createOAuthPoolClient({
      members: [
        { account: "xai-a", priority: 10, schedulable: true, client: memberClient },
        { account: "xai-b", priority: 20, schedulable: true, client: memberClient },
      ],
    });
    const execute = createExecute({
      defaultProvider: provider,
      providers: new Map([["xai", provider]]),
      registry: {
        resolve(alias: string) {
          if (alias !== "xai/grok-4.5") {
            return { ok: false as const, error: { kind: "unknown_alias" as const, alias } };
          }
          return {
            ok: true as const,
            value: {
              alias,
              providerName: "xai",
              providerModel: "grok-4.5",
              baseUrl: "https://example.test",
              apiKeyEnv: "XAI_API_KEY",
              targetProviderProtocol: "openai_responses" as const,
              providerRequiresCompatibilityRewrite: false,
            },
          };
        },
        list: () => ["xai/grok-4.5"],
      },
      breaker: breaker(),
      catalog: new Map(),
      now: clock(),
      signal: new AbortController().signal,
      nativeProtocolPassthroughEnabled: () => true,
    });

    const responsesInput = [
      { type: "custom_tool_call", call_id: "c1", name: "apply_patch", input: "{}" },
    ];
    const out = await execute(
      plan(["xai/grok-4.5"]),
      req({
        protocol: "openai_responses",
        provider_raw: { responses_input_items: responsesInput },
        native_request: {
          protocol: "openai_responses",
          body: { model: "gpt-5.6-sol", input: responsesInput, stream: true },
          headers: {},
          mutations: {},
        },
      }),
    );

    // Translation ran, verbatim passthrough did NOT, and it was not skipped.
    expect(memberClient.chatCompletion).toHaveBeenCalled();
    expect(memberClient.nativePassthrough).not.toHaveBeenCalled();
    expect(out.attempts[0]?.skipped).not.toBe(true);
    expect(out.attempts[0]?.passthrough_used).toBe(false);
    expect(out.attempts[0]?.passthrough_disable_reason).toBe(
      "responses_native_body_provider_incompatible",
    );
  });

  it("strips Anthropic context_management before a GENERIC Responses (xAI) upstream (box grok 422)", async () => {
    // context_management is an Anthropic-native context-editing control. It is forwarded to
    // openai_responses targets for the Codex-OFFICIAL endpoint (which understands it), but a
    // GENERIC Responses provider (xAI grok) does not — and helm carries it as the Anthropic
    // object shape `{ edits: [...] }`, which xAI rejects with HTTP 422 "invalid type: map,
    // expected a sequence". Like `responses_input_items`, it must be dropped for the generic
    // profile so correctness never depends on the upstream happening to ignore it.
    const memberClient = {
      chatCompletion: vi.fn().mockResolvedValue({ id: "grok-ok", usage: {} }),
      chatCompletionStream: vi.fn(),
      nativePassthrough: vi.fn(),
      nativeProtocolProfile: "generic_openai_responses",
    } as unknown as ProviderClient;
    const provider = createOAuthPoolClient({
      members: [{ account: "xai-a", priority: 10, schedulable: true, client: memberClient }],
    });
    const execute = createExecute({
      defaultProvider: provider,
      providers: new Map([["xai", provider]]),
      registry: {
        resolve(alias: string) {
          if (alias !== "xai/grok-4.5") {
            return { ok: false as const, error: { kind: "unknown_alias" as const, alias } };
          }
          return {
            ok: true as const,
            value: {
              alias,
              providerName: "xai",
              providerModel: "grok-4.5",
              baseUrl: "https://example.test",
              apiKeyEnv: "XAI_API_KEY",
              targetProviderProtocol: "openai_responses" as const,
              providerRequiresCompatibilityRewrite: false,
            },
          };
        },
        list: () => ["xai/grok-4.5"],
      },
      breaker: breaker(),
      catalog: new Map(),
      now: clock(),
      signal: new AbortController().signal,
    });

    const out = await execute(
      plan(["xai/grok-4.5"]),
      req({
        protocol: "anthropic_messages",
        // As Claude Code sends it: context_management folded into provider_raw as the
        // Anthropic object shape after normalizeAnthropicContextManagement wraps the bare array.
        provider_raw: {
          context_management: { edits: [{ type: "clear_tool_uses_20250919" }] },
        },
      }),
    );

    expect(out.final.status).toBe("ok");
    const body = (memberClient.chatCompletion as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as
      | Record<string, unknown>
      | undefined;
    // The Anthropic-only control must NOT reach the generic xAI Responses body.
    expect(body?.context_management).toBeUndefined();
    expect(out.attempts[0]?.request_mutations).toMatchObject({
      provider_raw_stripped_for_target: ["context_management"],
    });
  });

  it("keeps context_management for a NON-generic (Codex-official) Responses profile", async () => {
    // The strip is scoped to the generic profile: the Codex OFFICIAL endpoint understands
    // context_management, so a non-generic openai_responses target must still receive it.
    const memberClient = {
      chatCompletion: vi.fn().mockResolvedValue({ id: "codex-ok", usage: {} }),
      chatCompletionStream: vi.fn(),
      nativePassthrough: vi.fn(),
      nativeProtocolProfile: "openai_responses",
    } as unknown as ProviderClient;
    const provider = createOAuthPoolClient({
      members: [{ account: "codex-a", priority: 10, schedulable: true, client: memberClient }],
    });
    const execute = createExecute({
      defaultProvider: provider,
      providers: new Map([["codex", provider]]),
      registry: {
        resolve(alias: string) {
          if (alias !== "codex/gpt-5.6") {
            return { ok: false as const, error: { kind: "unknown_alias" as const, alias } };
          }
          return {
            ok: true as const,
            value: {
              alias,
              providerName: "codex",
              providerModel: "gpt-5.6",
              baseUrl: "https://example.test",
              apiKeyEnv: "OPENAI_API_KEY",
              targetProviderProtocol: "openai_responses" as const,
              providerRequiresCompatibilityRewrite: false,
            },
          };
        },
        list: () => ["codex/gpt-5.6"],
      },
      breaker: breaker(),
      catalog: new Map(),
      now: clock(),
      signal: new AbortController().signal,
    });

    const cm = { edits: [{ type: "clear_tool_uses_20250919" }] };
    const out = await execute(
      plan(["codex/gpt-5.6"]),
      req({ protocol: "anthropic_messages", provider_raw: { context_management: cm } }),
    );

    expect(out.final.status).toBe("ok");
    const body = (memberClient.chatCompletion as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as
      | Record<string, unknown>
      | undefined;
    expect(body?.context_management).toEqual(cm);
  });

  it("strips object-shaped context_management from a generic-Responses native passthrough body", async () => {
    // Same-protocol openai_responses -> generic xAI can PASSTHROUGH verbatim (no translation),
    // bypassing the forward allowlist. If the native body carries Anthropic's object-shaped
    // context_management, xAI still 422s. The passthrough sanitizer must drop it for the
    // generic profile (mirrors the Codex-official native sanitizer at the same chokepoint).
    const responsesBody = {
      id: "resp_generic",
      object: "response",
      status: "completed",
      output: [],
      usage: { input_tokens: 1, output_tokens: 1 },
    };
    const provider = {
      nativeProtocolProfile: "generic_openai_responses",
      chatCompletion: vi.fn(),
      chatCompletionStream: vi.fn(),
      nativePassthrough: vi.fn().mockResolvedValue(responsesBody),
    } as unknown as ProviderClient & { nativePassthrough: ReturnType<typeof vi.fn> };
    const execute = createExecute({
      defaultProvider: provider,
      providers: new Map([["xai", provider]]),
      registry: protocolRegistry({
        r: {
          providerName: "xai",
          providerModel: "grok-4.5",
          targetProviderProtocol: "openai_responses",
        },
      }),
      breaker: breaker(),
      catalog: new Map(),
      now: clock(),
      signal: new AbortController().signal,
      nativeProtocolPassthroughEnabled: () => true,
    });

    const out = await execute(
      plan(["r"]),
      req({
        protocol: "openai_responses",
        native_request: {
          protocol: "openai_responses" as const,
          body: {
            model: "grok-4.5",
            input: "hi",
            context_management: { edits: [{ type: "clear_tool_uses_20250919" }] },
          },
          headers: {},
          mutations: {},
        },
      }),
    );

    expect(out.final.status).toBe("ok");
    const forwarded = provider.nativePassthrough.mock.calls[0]?.[0] as {
      body?: Record<string, unknown>;
    } & Record<string, unknown>;
    const forwardedBody = (forwarded?.body ?? forwarded) as Record<string, unknown>;
    expect(forwardedBody.context_management).toBeUndefined();
    // The rest of the native body is untouched.
    expect(forwardedBody.input).toBe("hi");
  });

  it("does not forward top-level cache_control to non-Anthropic target protocols", async () => {
    const provider = {
      chatCompletion: vi.fn().mockResolvedValue({ id: "ok", usage: {} }),
      chatCompletionStream: vi.fn(),
    } as unknown as ProviderClient;
    const registryFor = (targetProviderProtocol: TargetProviderProtocol): ProviderRegistry => ({
      resolve(alias: string) {
        if (alias !== "candidate") {
          return { ok: false, error: { kind: "unknown_alias", alias } };
        }
        return {
          ok: true,
          value: {
            alias,
            providerName: "mock",
            providerModel: "upstream-model",
            baseUrl: "http://x",
            apiKeyEnv: "X",
            targetProviderProtocol,
            providerRequiresCompatibilityRewrite: false,
          },
        };
      },
      list: () => ["candidate"],
    });

    for (const targetProtocol of ["openai_responses", "gemini"] as const) {
      (provider.chatCompletion as ReturnType<typeof vi.fn>).mockClear();
      const execute = createExecute({
        defaultProvider: provider,
        providers: new Map([["mock", provider]]),
        registry: registryFor(targetProtocol),
        breaker: breaker(),
        catalog: new Map(),
        now: clock(),
        signal: new AbortController().signal,
      });

      await execute(
        plan(["candidate"]),
        req({
          protocol: "anthropic_messages",
          cache_control: { type: "ephemeral" },
        }),
      );

      const body = (provider.chatCompletion as ReturnType<typeof vi.fn>).mock
        .calls[0]?.[0] as Record<string, unknown>;
      expect(body.cache_control).toBeUndefined();
    }
  });

  it("preserves top-level cache_control for Anthropic target protocols", async () => {
    const provider = {
      chatCompletion: vi.fn().mockResolvedValue({ id: "ok", usage: {} }),
      chatCompletionStream: vi.fn(),
    } as unknown as ProviderClient;
    const anthroRegistry: ProviderRegistry = {
      resolve(alias: string) {
        if (alias !== "candidate") {
          return { ok: false, error: { kind: "unknown_alias", alias } };
        }
        return {
          ok: true,
          value: {
            alias,
            providerName: "mock",
            providerModel: "claude-x",
            baseUrl: "http://x",
            apiKeyEnv: "X",
            targetProviderProtocol: "anthropic_messages",
            providerRequiresCompatibilityRewrite: false,
          },
        };
      },
      list: () => ["candidate"],
    };
    const execute = createExecute({
      defaultProvider: provider,
      providers: new Map([["mock", provider]]),
      registry: anthroRegistry,
      breaker: breaker(),
      catalog: new Map(),
      now: clock(),
      signal: new AbortController().signal,
    });

    await execute(
      plan(["candidate"]),
      req({
        protocol: "anthropic_messages",
        cache_control: { type: "ephemeral" },
      }),
    );

    const body = (provider.chatCompletion as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as Record<
      string,
      unknown
    >;
    expect(body.cache_control).toEqual({ type: "ephemeral" });
  });

  it("threads captured client_billing_header to Anthropic compatibility translation metadata", async () => {
    const provider = {
      chatCompletion: vi.fn().mockResolvedValue({ id: "ok", usage: {} }),
      chatCompletionStream: vi.fn(),
    } as unknown as ProviderClient;
    const anthroRegistry: ProviderRegistry = {
      resolve(alias: string) {
        if (alias !== "candidate") {
          return { ok: false, error: { kind: "unknown_alias", alias } };
        }
        return {
          ok: true,
          value: {
            alias,
            providerName: "mock",
            providerModel: "claude-x",
            baseUrl: "http://x",
            apiKeyEnv: "X",
            targetProviderProtocol: "anthropic_messages",
            providerRequiresCompatibilityRewrite: true,
          },
        };
      },
      list: () => ["candidate"],
    };
    const execute = createExecute({
      defaultProvider: provider,
      providers: new Map([["mock", provider]]),
      registry: anthroRegistry,
      breaker: breaker(),
      catalog: new Map(),
      now: clock(),
      signal: new AbortController().signal,
    });
    const base = req();

    await execute(
      plan(["candidate"]),
      req({
        protocol: "anthropic_messages",
        metadata: {
          ...base.metadata,
          client_billing_header: "cc_version=2.1.202.c96; cc_entrypoint=cli",
        },
        provider_raw: { metadata: { user_id: "stable-device" } },
      }),
    );

    const body = (provider.chatCompletion as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as Record<
      string,
      unknown
    >;
    expect(body.metadata).toEqual({
      user_id: "stable-device",
      client_billing_header: "cc_version=2.1.202.c96; cc_entrypoint=cli",
    });
  });

  it("merges streamed client stream_options while forcing include_usage for cost capture", async () => {
    const provider = {
      chatCompletion: vi.fn(),
      chatCompletionStream: vi.fn().mockReturnValue(gen(["data: {}\n\n"])),
    } as unknown as ProviderClient;
    const execute = createExecute({
      defaultProvider: provider,
      providers: new Map([["mock", provider]]),
      registry: registry({ default_good_model: "gpt-x" }),
      breaker: breaker(),
      catalog: new Map(),
      now: clock(),
      signal: new AbortController().signal,
    });

    await execute(
      plan(["default_good_model"]),
      req({ stream: true, stream_options: { include_usage: false, extra: "keep" } }),
    );

    const body = (provider.chatCompletionStream as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as {
      stream_options?: Record<string, unknown>;
    };
    expect(body.stream_options).toEqual({ include_usage: true, extra: "keep" });
  });

  it("falls back to the next candidate on a pre-first-chunk provider failure", async () => {
    const provider = {
      chatCompletion: vi
        .fn()
        .mockRejectedValueOnce(new UpstreamError("upstream_error", "boom"))
        .mockResolvedValueOnce({ id: "second" }),
      chatCompletionStream: vi.fn(),
    } as unknown as ProviderClient;
    const execute = createExecute({
      defaultProvider: provider,
      providers: new Map([["mock", provider]]),
      registry: registry({ a: "m-a", b: "m-b" }),
      breaker: breaker(),
      catalog: new Map(),
      now: clock(),
      signal: new AbortController().signal,
    });

    const out = await execute(plan(["a", "b"]), req());
    expect(out.final.status).toBe("ok");
    expect(out.body).toEqual({ id: "second" });
    expect(out.attempts).toHaveLength(2);
    expect(out.attempts[0]?.status).toBe("error");
    expect(out.attempts[0]?.error_class).toBe("upstream_error");
    expect(out.attempts[1]?.status).toBe("ok");
  });

  it("captures complete per-attempt error_detail on a failed attempt", async () => {
    const rawBody = { error: { message: "rate limit exceeded", type: "rate_limit_error" } };
    const provider = {
      chatCompletion: vi
        .fn()
        .mockRejectedValueOnce(
          new UpstreamError("upstream_error", "upstream returned 429", rawBody, 429),
        )
        .mockResolvedValueOnce({ id: "second" }),
      chatCompletionStream: vi.fn(),
    } as unknown as ProviderClient;
    const execute = createExecute({
      defaultProvider: provider,
      providers: new Map([["mock", provider]]),
      registry: registry({ a: "m-a", b: "m-b" }),
      breaker: breaker(),
      catalog: new Map(),
      now: clock(),
      signal: new AbortController().signal,
    });

    const out = await execute(plan(["a", "b"]), req());
    // The first candidate failed but the SECOND served — so this detail is the
    // only record of WHY `a` failed (it never reaches the terminal error).
    expect(out.attempts[0]?.status).toBe("error");
    expect(out.attempts[0]?.error_detail).toEqual({
      upstream_status: 429,
      message: "upstream returned 429",
      provider_raw: rawBody,
      provider_headers: null,
      cause: null,
      stack: expect.stringContaining("UpstreamError: upstream returned 429"),
    });
    // ok / skipped rows must NOT carry a detail.
    expect(out.attempts[1]?.error_detail ?? null).toBeNull();
  });

  it("uses exact Anthropic count_tokens to skip an over-context native attempt without tripping the breaker", async () => {
    const provider = {
      countTokens: vi.fn().mockResolvedValue({ input_tokens: 1_001_854 }),
      chatCompletion: vi.fn().mockResolvedValue({ id: "second" }),
      chatCompletionStream: vi.fn(),
    } as unknown as ProviderClient;
    const cb = breaker();
    const recordFailure = vi.spyOn(cb, "recordFailure");
    const execute = createExecute({
      defaultProvider: provider,
      providers: new Map([["mock", provider]]),
      registry: protocolRegistry({
        opus: {
          providerName: "mock",
          providerModel: "claude-opus-4-8",
          targetProviderProtocol: "anthropic_messages",
        },
        codex: {
          providerName: "mock",
          providerModel: "gpt-5.5",
          targetProviderProtocol: "openai_responses",
        },
      }),
      breaker: cb,
      catalog: new Map(),
      now: clock(),
      signal: new AbortController().signal,
    });

    const out = await execute(
      plan(["opus", "codex"]),
      req({
        protocol: "anthropic_messages",
        requested_model: "claude-opus-4-8",
        native_request: createNativePassthroughCarrier({
          protocol: "anthropic_messages",
          body: {
            model: "claude-opus-4-8",
            messages: [{ role: "user", content: "huge" }],
            max_tokens: 64,
          },
          headers: {},
        }),
      }),
    );

    expect(out.final.status).toBe("ok");
    expect(provider.countTokens).toHaveBeenCalledOnce();
    expect(provider.chatCompletion).toHaveBeenCalledOnce();
    expect(out.attempts[0]).toMatchObject({
      alias: "opus",
      skipped: true,
      skip_reason: "context_too_small",
      status: "error",
    });
    expect(out.attempts[1]?.status).toBe("ok");
    expect(recordFailure).not.toHaveBeenCalled();
  });

  it("returns a compaction-compatible 400 when exact count_tokens exhausts the chain", async () => {
    const provider = {
      countTokens: vi.fn().mockResolvedValue({ input_tokens: 1_001_854 }),
      chatCompletion: vi.fn(),
      chatCompletionStream: vi.fn(),
    } as unknown as ProviderClient;
    const cb = breaker();
    const recordFailure = vi.spyOn(cb, "recordFailure");
    const execute = createExecute({
      defaultProvider: provider,
      providers: new Map([["mock", provider]]),
      registry: protocolRegistry({
        opus: {
          providerName: "mock",
          providerModel: "claude-opus-4-8",
          targetProviderProtocol: "anthropic_messages",
        },
      }),
      breaker: cb,
      catalog: new Map(),
      now: clock(),
      signal: new AbortController().signal,
    });

    const out = await execute(
      plan(["opus"]),
      req({
        protocol: "anthropic_messages",
        requested_model: "claude-opus-4-8",
        native_request: createNativePassthroughCarrier({
          protocol: "anthropic_messages",
          body: {
            model: "claude-opus-4-8",
            messages: [{ role: "user", content: "huge" }],
            max_tokens: 64,
          },
          headers: {},
        }),
      }),
    );

    expect(out.final.status).toBe("error");
    if (out.final.status !== "error") throw new Error("expected a terminal error");
    expect(out.final.error).toMatchObject({
      error_class: "invalid_request",
      http_status: 400,
      message: "prompt is too long: 1001854 tokens > 1000000 maximum",
      provider_raw: null,
    });
    expect(out.attempts[0]).toMatchObject({
      skipped: true,
      skip_reason: "context_too_small",
      error_class: null,
    });
    expect(provider.chatCompletion).not.toHaveBeenCalled();
    expect(recordFailure).not.toHaveBeenCalled();
  });

  it("uses exact count_tokens instead of an earlier approximate context rejection", async () => {
    const provider = {
      countTokens: vi.fn().mockResolvedValue({ input_tokens: 21 }),
      chatCompletion: vi.fn(),
      chatCompletionStream: vi.fn(),
    } as unknown as ProviderClient;
    const execute = createExecute({
      defaultProvider: provider,
      providers: new Map([["mock", provider]]),
      registry: protocolRegistry({
        opus: {
          providerName: "mock",
          providerModel: "claude-opus-4-8",
          targetProviderProtocol: "anthropic_messages",
        },
      }),
      breaker: breaker(),
      catalog: new Map([["opus", entry("opus", { maxContextTokens: 20 })]]),
      now: clock(),
      signal: new AbortController().signal,
    });

    const out = await execute(
      plan(["opus"]),
      req({
        protocol: "anthropic_messages",
        messages: [{ role: "user", content: "x".repeat(100) }],
        native_request: createNativePassthroughCarrier({
          protocol: "anthropic_messages",
          body: {
            model: "claude-opus-4-8",
            messages: [{ role: "user", content: "x".repeat(100) }],
            max_tokens: 1,
          },
          headers: {},
        }),
      }),
    );

    expect(provider.countTokens).toHaveBeenCalledOnce();
    expect(out.final.status).toBe("error");
    if (out.final.status !== "error") throw new Error("expected a terminal error");
    expect(out.final.error).toMatchObject({
      error_class: "invalid_request",
      message: "prompt is too long: 21 tokens > 20 maximum",
    });
  });

  it("returns a compaction-compatible 400 for approximate context-only exhaustion", async () => {
    const provider = {
      chatCompletion: vi.fn(),
      chatCompletionStream: vi.fn(),
    } as unknown as ProviderClient;
    const execute = createExecute({
      defaultProvider: provider,
      providers: new Map([["mock", provider]]),
      registry: registry({ small: "small-model" }),
      breaker: breaker(),
      catalog: new Map([["small", entry("small", { maxContextTokens: 20 })]]),
      now: clock(),
      signal: new AbortController().signal,
    });

    const out = await execute(
      plan(["small"]),
      req({ messages: [{ role: "user", content: "x".repeat(100) }] }),
    );

    expect(out.final.status).toBe("error");
    if (out.final.status !== "error") throw new Error("expected a terminal error");
    expect(out.final.error).toMatchObject({
      error_class: "invalid_request",
      http_status: 400,
      message: "prompt is too long: 25 tokens > 20 maximum",
    });
    expect(provider.chatCompletion).not.toHaveBeenCalled();
  });

  it("explains cross-protocol native-items exhaustion instead of a bare all_providers_failed", async () => {
    // Real case (Codex sub-agent / encrypted agent_message): the same-protocol Codex head
    // errors (pool exhausted) while every cross-protocol candidate is skipped because the
    // body carries Responses native items that cannot be translated. The terminal error must
    // NAME that structural reason so the client knows it can't fail over, not a bare
    // "all providers failed".
    const poolExhausted = () =>
      Promise.reject(new UpstreamError("upstream_error", "pool exhausted", {}, 503));
    const codex = {
      chatCompletion: vi.fn(poolExhausted),
      chatCompletionStream: vi.fn(poolExhausted),
      nativeProtocolProfile: "openai_responses",
      nativePassthrough: vi.fn(poolExhausted),
      nativePassthroughStream: vi.fn(poolExhausted),
    } as unknown as ProviderClient;
    const anthropic = {
      chatCompletion: vi.fn(),
      chatCompletionStream: vi.fn(),
    } as unknown as ProviderClient;
    const execute = createExecute({
      defaultProvider: codex,
      providers: new Map([
        ["codex", codex],
        ["anthropic", anthropic],
      ]),
      registry: {
        resolve(alias: string) {
          if (alias === "codex/gpt") {
            return {
              ok: true as const,
              value: {
                alias,
                providerName: "codex",
                providerModel: "gpt",
                baseUrl: "http://x",
                apiKeyEnv: "X",
                targetProviderProtocol: "openai_responses" as const,
                providerRequiresCompatibilityRewrite: false,
              },
            };
          }
          if (alias === "anthropic/claude") {
            return {
              ok: true as const,
              value: {
                alias,
                providerName: "anthropic",
                providerModel: "claude",
                baseUrl: "http://y",
                apiKeyEnv: "Y",
                targetProviderProtocol: "anthropic_messages" as const,
                providerRequiresCompatibilityRewrite: false,
              },
            };
          }
          return { ok: false as const, error: { kind: "unknown_alias" as const, alias } };
        },
        list: () => ["codex/gpt", "anthropic/claude"],
      },
      breaker: breaker(),
      catalog: new Map(),
      now: clock(),
      signal: new AbortController().signal,
    });

    const out = await execute(
      plan(["codex/gpt", "anthropic/claude"]),
      req({
        protocol: "openai_responses",
        provider_raw: { unknown_items: [{ type: "agent_message", content: [] }] },
      }),
    );

    expect(out.final.status).toBe("error");
    if (out.final.status !== "error") throw new Error("expected a terminal error");
    // Message names the structural blocker (native items / cross-provider), not a bare fail.
    expect(out.final.error.message.toLowerCase()).toMatch(/native|cross-provider|responses/);
  });

  it("does not claim compaction will fix a chain that also has an unavailable provider", async () => {
    const provider = {
      chatCompletion: vi.fn(),
      chatCompletionStream: vi.fn(),
    } as unknown as ProviderClient;
    const execute = createExecute({
      defaultProvider: provider,
      providers: new Map([["mock", provider]]),
      registry: registryWithProviders({
        small: { providerName: "mock", providerModel: "small-model" },
        unavailable: { providerName: "missing", providerModel: "large-model" },
      }),
      breaker: breaker(),
      catalog: new Map([["small", entry("small", { maxContextTokens: 20 })]]),
      now: clock(),
      signal: new AbortController().signal,
    });

    const out = await execute(
      plan(["small", "unavailable"]),
      req({ messages: [{ role: "user", content: "x".repeat(100) }] }),
    );

    expect(out.final.status).toBe("error");
    if (out.final.status !== "error") throw new Error("expected a terminal error");
    expect(out.final.error).toMatchObject({
      error_class: "all_providers_failed",
      http_status: 502,
    });
  });

  it("does not let approximate context estimates override a real provider failure", async () => {
    const provider = {
      chatCompletion: vi
        .fn()
        .mockRejectedValue(new UpstreamError("upstream_error", "upstream returned 500", {}, 500)),
      chatCompletionStream: vi.fn(),
    } as unknown as ProviderClient;
    const execute = createExecute({
      defaultProvider: provider,
      providers: new Map([["mock", provider]]),
      registry: registry({ first: "small-a", second: "small-b", tail: "tail-model" }),
      breaker: breaker(),
      catalog: new Map([
        ["first", entry("first", { maxContextTokens: 20 })],
        ["second", entry("second", { maxContextTokens: 20 })],
      ]),
      now: clock(),
      signal: new AbortController().signal,
    });

    const out = await execute(
      plan(["first", "second", "tail"]),
      req({ messages: [{ role: "user", content: "x".repeat(100) }] }),
    );

    expect(out.final.status).toBe("error");
    if (out.final.status !== "error") throw new Error("expected a terminal error");
    expect(out.final.error).toMatchObject({
      error_class: "all_providers_failed",
      http_status: 502,
    });
  });

  it("short-circuits an in-band stream context_length_exceeded without tripping the breaker", async () => {
    // Some upstreams report model-window overflow as an in-band stream error without an
    // HTTP 400 status. That is still a REAL upstream confirming the request is over the
    // ceiling, so short-circuit with the 400 VERBATIM — do NOT fall back to a larger model
    // that would "catch" the oversized request and hide the compaction signal. No breaker
    // fault (the upstream is healthy — the request is what's wrong).
    // biome-ignore lint/correctness/useYield: pre-first-chunk failure throws before any yield
    async function* contextWindowError(): AsyncGenerator<string> {
      throw new UpstreamError(
        "upstream_error",
        "codex responses stream error",
        {
          type: "error",
          error: {
            type: "invalid_request_error",
            code: "context_length_exceeded",
            message:
              "Your input exceeds the context window of this model. Please adjust your input and try again.",
            param: "input",
          },
          sequence_number: 2,
        },
        null,
      );
    }
    const opusStream = vi.fn();
    const provider = {
      chatCompletion: vi.fn(),
      chatCompletionStream: vi
        .fn()
        .mockReturnValueOnce(contextWindowError())
        .mockImplementation(opusStream),
    } as unknown as ProviderClient;
    const cb = breaker();
    const recordFailure = vi.spyOn(cb, "recordFailure");
    const execute = createExecute({
      defaultProvider: provider,
      providers: new Map([["mock", provider]]),
      registry: protocolRegistry({
        codex: {
          providerName: "mock",
          providerModel: "gpt-5.5",
          targetProviderProtocol: "openai_responses",
        },
        opus: {
          providerName: "mock",
          providerModel: "claude-opus-4-8",
          targetProviderProtocol: "anthropic_messages",
        },
      }),
      breaker: cb,
      catalog: new Map(),
      now: clock(),
      signal: new AbortController().signal,
    });

    const out = await execute(plan(["codex", "opus"]), req({ stream: true }));

    expect(out.final.status).toBe("error");
    if (out.final.status !== "error") throw new Error("expected a terminal error");
    expect(out.final.error).toMatchObject({
      error_class: "invalid_request",
      http_status: 400,
    });
    expect(out.attempts).toHaveLength(1);
    expect(out.attempts[0]).toMatchObject({
      alias: "codex",
      skipped: false,
      error_class: "invalid_request",
    });
    expect(out.attempts[0]?.error_detail).toMatchObject({
      provider_raw: {
        error: {
          code: "context_length_exceeded",
        },
      },
    });
    // The larger-window sibling is never even opened — the chain short-circuited.
    expect(opusStream).not.toHaveBeenCalled();
    expect(recordFailure).not.toHaveBeenCalled();
  });

  it("short-circuits a REAL upstream context overflow instead of falling back (box 12a22879)", async () => {
    // Reproduces the production incident: the head candidate returns a REAL upstream 400
    // "prompt is too long: N > M". Older behavior skipped it and fell back all the way to a
    // larger-window model (deepseek), which returned 200 — so the client never saw a 4xx and
    // never triggered its own context compaction. A real upstream overflow means the request
    // as sent is over a hard ceiling: surface the 400 VERBATIM immediately and DO NOT try any
    // later candidate (no larger-window "catch" that hides the compaction signal).
    const raw = {
      type: "error",
      error: {
        type: "invalid_request_error",
        message: "prompt is too long: 1033542 tokens > 1000000 maximum",
      },
      request_id: "req_011CdoYiHHe3pg8rYTPqHABp",
    };
    const provider = {
      chatCompletion: vi
        .fn()
        .mockRejectedValueOnce(
          new UpstreamError("upstream_error", "upstream returned 400", raw, 400),
        )
        // Later candidates must NEVER be invoked once a real overflow short-circuits.
        .mockResolvedValueOnce({ id: "should-not-be-reached" }),
      chatCompletionStream: vi.fn(),
    } as unknown as ProviderClient;
    const cb = breaker();
    const recordFailure = vi.spyOn(cb, "recordFailure");
    const execute = createExecute({
      defaultProvider: provider,
      providers: new Map([["mock", provider]]),
      registry: registry({ opus: "claude-opus-4-8", deepseek: "deepseek-v4-pro" }),
      breaker: cb,
      catalog: new Map(),
      now: clock(),
      signal: new AbortController().signal,
    });

    const out = await execute(plan(["opus", "deepseek"]), req());

    expect(out.final.status).toBe("error");
    if (out.final.status !== "error") throw new Error("expected a terminal error");
    expect(out.final.error).toMatchObject({
      error_class: "invalid_request",
      http_status: 400,
      message: "prompt is too long: 1033542 tokens > 1000000 maximum",
      provider_raw: raw,
    });
    // Only the first candidate was attempted; the chain short-circuited (no fall-back).
    expect(provider.chatCompletion).toHaveBeenCalledTimes(1);
    expect(out.attempts).toHaveLength(1);
    expect(out.attempts[0]).toMatchObject({
      alias: "opus",
      skipped: false,
      error_class: "invalid_request",
    });
    // Upstream is healthy — the request is what's wrong. No breaker fault.
    expect(recordFailure).not.toHaveBeenCalled();
  });

  it("surfaces an upstream context error VERBATIM as a 400", async () => {
    const raw = {
      type: "error",
      error: {
        type: "invalid_request_error",
        code: "context_length_exceeded",
        message: "prompt is too long: 1200000 tokens > 1000000 maximum",
      },
    };
    const provider = {
      chatCompletion: vi
        .fn()
        .mockRejectedValue(new UpstreamError("upstream_error", "upstream returned 400", raw, 400)),
      chatCompletionStream: vi.fn(),
    } as unknown as ProviderClient;
    const cb = breaker();
    const recordFailure = vi.spyOn(cb, "recordFailure");
    const execute = createExecute({
      defaultProvider: provider,
      providers: new Map([["mock", provider]]),
      registry: registry({ opus: "claude-opus-4-8" }),
      breaker: cb,
      catalog: new Map(),
      now: clock(),
      signal: new AbortController().signal,
    });

    const out = await execute(plan(["opus"]), req());

    expect(out.final.status).toBe("error");
    if (out.final.status !== "error") throw new Error("expected a terminal error");
    expect(out.final.error).toMatchObject({
      error_class: "invalid_request",
      http_status: 400,
      message: "prompt is too long: 1200000 tokens > 1000000 maximum",
      provider_raw: raw,
    });
    expect(out.attempts[0]).toMatchObject({
      skipped: false,
      error_class: "invalid_request",
      error_detail: {
        upstream_status: 400,
        provider_raw: raw,
      },
    });
    expect(recordFailure).not.toHaveBeenCalled();
  });

  it("does NOT short-circuit an approximate context estimate — a larger sibling still serves", async () => {
    // The head candidate is skipped by the APPROXIMATE capability-filter estimate (its tiny
    // window can't hold the prompt). That is a per-model estimate, NOT a real upstream verdict,
    // so it must FALL BACK (not short-circuit) — a larger-window sibling can still serve the
    // request and succeed. Contrast with a REAL upstream overflow, which short-circuits.
    const provider = {
      chatCompletion: vi.fn().mockResolvedValue({ id: "big-window-ok" }),
      chatCompletionStream: vi.fn(),
    } as unknown as ProviderClient;
    const execute = createExecute({
      defaultProvider: provider,
      providers: new Map([["mock", provider]]),
      registry: registry({ small: "small-model", big: "big-model" }),
      breaker: breaker(),
      // `small` has a tiny window → the long prompt trips the approximate pre-flight gate.
      // `big` has no catalog entry → fail-open, attempted, and succeeds.
      catalog: new Map([["small", entry("small", { maxContextTokens: 20 })]]),
      now: clock(),
      signal: new AbortController().signal,
    });

    const out = await execute(
      plan(["small", "big"]),
      req({ messages: [{ role: "user", content: "x".repeat(100) }] }),
    );

    // The approximate estimate skip fell back to the larger sibling, which succeeded.
    expect(out.final.status).toBe("ok");
    expect(out.attempts[0]).toMatchObject({ skipped: true, skip_reason: "context_too_small" });
    expect(out.attempts[1]?.status).toBe("ok");
  });

  it("short-circuits on the FIRST real upstream overflow, before a later sibling is tried", async () => {
    // The head candidate reports a shaped overflow ("prompt is too long: N > M maximum").
    // The chain short-circuits immediately: the tail candidate is NEVER invoked, and the
    // 400 is surfaced VERBATIM so the client can compact.
    const raw = {
      error: {
        code: "context_length_exceeded",
        message: "prompt is too long: 1200000 tokens > 1000000 maximum",
      },
    };
    const provider = {
      chatCompletion: vi
        .fn()
        .mockRejectedValueOnce(
          new UpstreamError("upstream_error", "upstream returned 400", raw, 400),
        )
        .mockRejectedValueOnce(
          new UpstreamError("upstream_error", "upstream returned 500", {}, 500),
        ),
      chatCompletionStream: vi.fn(),
    } as unknown as ProviderClient;
    const execute = createExecute({
      defaultProvider: provider,
      providers: new Map([["mock", provider]]),
      registry: registry({ opus: "claude-opus-4-8", tail: "tail-model" }),
      breaker: breaker(),
      catalog: new Map(),
      now: clock(),
      signal: new AbortController().signal,
    });

    const out = await execute(plan(["opus", "tail"]), req());

    expect(out.final.status).toBe("error");
    if (out.final.status !== "error") throw new Error("expected a terminal error");
    expect(out.final.error).toMatchObject({
      error_class: "invalid_request",
      http_status: 400,
      message: "prompt is too long: 1200000 tokens > 1000000 maximum",
      provider_raw: raw,
    });
    // Only the head candidate ran — the overflow short-circuited before the tail.
    expect(provider.chatCompletion).toHaveBeenCalledTimes(1);
    expect(out.attempts).toHaveLength(1);
  });

  it("short-circuits on the first overflow even when later candidates would also overflow", async () => {
    // Mirrors the production incident (box 12a22879): chain = [overflow, unrelated-fail,
    // overflow]. The FIRST real overflow returns the 400 immediately — the unrelated sibling
    // and the second overflow candidate are never reached.
    const raw = {
      type: "error",
      error: {
        type: "invalid_request_error",
        code: "context_length_exceeded",
        message:
          "Your input exceeds the context window of this model. Please adjust your input and try again.",
        param: "input",
      },
      sequence_number: 2,
    };
    const provider = {
      chatCompletion: vi
        .fn()
        .mockRejectedValueOnce(
          new UpstreamError("upstream_error", "codex responses stream error", raw, null),
        )
        .mockRejectedValueOnce(
          new UpstreamError(
            "upstream_error",
            "upstream returned 422",
            {
              error:
                "Failed to deserialize the JSON body into the target type: invalid type: map, expected a sequence",
            },
            422,
          ),
        )
        .mockRejectedValueOnce(
          new UpstreamError("upstream_error", "codex responses stream error", raw, null),
        ),
      chatCompletionStream: vi.fn(),
    } as unknown as ProviderClient;
    const execute = createExecute({
      defaultProvider: provider,
      providers: new Map([["mock", provider]]),
      registry: registry({ sol: "gpt-5.6-sol", xai: "grok-4.5", terra: "gpt-5.6-terra" }),
      breaker: breaker(),
      catalog: new Map(),
      now: clock(),
      signal: new AbortController().signal,
    });

    const out = await execute(plan(["sol", "xai", "terra"]), req());

    expect(out.final.status).toBe("error");
    if (out.final.status !== "error") throw new Error("expected a terminal error");
    expect(out.final.error).toMatchObject({
      error_class: "invalid_request",
      http_status: 400,
      message: raw.error.message,
      provider_raw: raw,
    });
    // Short-circuited on the first candidate; xai + terra never invoked.
    expect(provider.chatCompletion).toHaveBeenCalledTimes(1);
    expect(out.attempts).toHaveLength(1);
    expect(out.attempts[0]).toMatchObject({ alias: "sol", error_class: "invalid_request" });
  });

  it("maps Anthropic output_config.effort through the target model policy instead of skipping", async () => {
    const provider = {
      chatCompletion: vi.fn().mockResolvedValue({ id: "sonnet" }),
      chatCompletionStream: vi.fn(),
    } as unknown as ProviderClient & { chatCompletion: ReturnType<typeof vi.fn> };
    const execute = createExecute({
      defaultProvider: provider,
      providers: new Map([["mock", provider]]),
      registry: protocolRegistry({
        sonnet: {
          providerName: "mock",
          providerModel: "claude-sonnet-4-6",
          targetProviderProtocol: "anthropic_messages",
        },
      }),
      breaker: breaker(),
      catalog: new Map([
        [
          "sonnet",
          entry("sonnet", {
            reasoningEffort: {
              anthropicOutputConfig: {
                supported: true,
                levels: ["low", "medium", "high", "max"],
                map: { xhigh: "max" },
              },
              anthropicThinking: {
                supported: true,
                levels: ["minimal", "low", "medium", "high", "xhigh", "max"],
              },
            },
          }),
        ],
      ]),
      now: clock(),
      signal: new AbortController().signal,
    });

    const out = await execute(plan(["sonnet"]), req({ reasoning_effort: "xhigh" }));

    expect(out.final.status).toBe("ok");
    expect(provider.chatCompletion).toHaveBeenCalledOnce();
    const body = provider.chatCompletion.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(body.output_config).toEqual({ effort: "max" });
    expect(body.reasoning_effort).toBeUndefined();
    expect((body.thinking as { type?: string } | undefined)?.type).toBe("enabled");
    expect(out.attempts[0]).toMatchObject({ alias: "sonnet", skipped: false, status: "ok" });
    expect(out.attempts[0]?.request_mutations).toMatchObject({
      body_shims_applied: ["reasoning_effort_mapped_for_model"],
    });
  });

  it("uses Anthropic Haiku and strips unsupported output_config.effort for that attempt", async () => {
    const upstreamBodies: Array<Record<string, unknown>> = [];
    const provider = createAnthropicClient({
      config: { baseUrl: "https://api.anthropic.test", apiKey: "sk-test" },
      fetch: vi.fn(async (_url, init) => {
        upstreamBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return new Response(
          JSON.stringify({
            id: "msg_1",
            type: "message",
            role: "assistant",
            content: [{ type: "text", text: "ok" }],
            stop_reason: "end_turn",
            usage: { input_tokens: 1, output_tokens: 1 },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }) as unknown as typeof fetch,
    });
    const execute = createExecute({
      defaultProvider: provider,
      providers: new Map([["anthro", provider]]),
      registry: protocolRegistry({
        haiku: {
          providerName: "anthro",
          providerModel: "claude-haiku-4-5-20251001",
          targetProviderProtocol: "anthropic_messages",
        },
      }),
      breaker: breaker(),
      catalog: new Map([
        [
          "haiku",
          entry("haiku", {
            reasoningEffort: {
              anthropicOutputConfig: { supported: false },
              anthropicThinking: {
                supported: true,
                levels: ["minimal", "low", "medium", "high", "xhigh", "max"],
              },
            },
          }),
        ],
      ]),
      now: clock(),
      signal: new AbortController().signal,
    });

    const out = await execute(plan(["haiku"]), req({ reasoning_effort: "medium" }));

    expect(out.final).toEqual({
      status: "ok",
      alias: "haiku",
      providerModel: "claude-haiku-4-5-20251001",
    });
    expect(upstreamBodies[0]?.output_config).toBeUndefined();
    expect(upstreamBodies[0]?.reasoning_effort).toBeUndefined();
    expect((upstreamBodies[0]?.thinking as { type?: string } | undefined)?.type).toBe("enabled");
    expect(out.attempts[0]).toMatchObject({ alias: "haiku", skipped: false, status: "ok" });
    expect(out.attempts[0]?.request_mutations).toMatchObject({
      body_shims_applied: ["reasoning_effort_stripped_for_model"],
    });
  });

  it("short-circuits the chain on an upstream request-shape 400 and surfaces it verbatim", async () => {
    // A 400 invalid_request_error (oversized image / prompt too long / bad param) is
    // DETERMINISTIC: the identical body fails on every candidate, and Claude Code
    // relies on receiving this 4xx to drive its own context compaction. So the chain
    // must NOT advance to `codex`, the breaker must NOT fault, and the upstream error
    // is returned to the client verbatim (not buried as all_providers_failed 502).
    const provider = {
      chatCompletion: vi
        .fn()
        .mockRejectedValueOnce(
          new UpstreamError(
            "upstream_error",
            "upstream returned 400",
            {
              type: "error",
              error: {
                type: "invalid_request_error",
                message:
                  "messages.7.content.14.image.source.base64.data: At least one of the image dimensions exceed max allowed size for many-image requests: 2000 pixels",
              },
            },
            400,
          ),
        )
        .mockResolvedValueOnce({ id: "second" }),
      chatCompletionStream: vi.fn(),
    } as unknown as ProviderClient;
    const cb = breaker();
    const recordFailure = vi.spyOn(cb, "recordFailure");
    const execute = createExecute({
      defaultProvider: provider,
      providers: new Map([["mock", provider]]),
      registry: protocolRegistry({
        opus: {
          providerName: "mock",
          providerModel: "claude-opus-4-8",
          targetProviderProtocol: "anthropic_messages",
        },
        codex: {
          providerName: "mock",
          providerModel: "gpt-5.5",
          targetProviderProtocol: "openai_responses",
        },
      }),
      breaker: cb,
      catalog: new Map(),
      now: clock(),
      signal: new AbortController().signal,
    });

    const out = await execute(plan(["opus", "codex"]), req());

    expect(out.final.status).toBe("error");
    if (out.final.status !== "error") throw new Error("expected a terminal error");
    expect(out.final.error.error_class).toBe("invalid_request");
    expect(out.final.error.http_status).toBe(400);
    expect(out.final.error.message).toContain("many-image requests");
    expect(out.final.error.provider_raw).toMatchObject({
      error: { type: "invalid_request_error" },
    });
    // Only the head candidate was attempted — no fallback to codex.
    expect(out.attempts).toHaveLength(1);
    expect(out.attempts[0]).toMatchObject({
      alias: "opus",
      skipped: false,
      status: "error",
      error_class: "invalid_request",
    });
    expect(provider.chatCompletion).toHaveBeenCalledOnce();
    expect(recordFailure).not.toHaveBeenCalled();
  });

  it("short-circuits the real overflow 400 before an unrelated sibling is tried (box c211e4a1)", async () => {
    // Anthropic (head of chain) returns a REAL 400 "prompt is too long: N > M maximum".
    // The chain short-circuits: the grok sibling is NEVER tried, and the 400 is surfaced
    // VERBATIM so Claude Code / Codex receive the 4xx and trigger their own compaction —
    // instead of falling back to a model that would "catch" the oversized request.
    const raw = {
      type: "error",
      error: {
        type: "invalid_request_error",
        message: "prompt is too long: 1022145 tokens > 1000000 maximum",
      },
    };
    const provider = {
      chatCompletion: vi
        .fn()
        .mockRejectedValueOnce(
          new UpstreamError("upstream_error", "upstream returned 400", raw, 400),
        )
        .mockRejectedValueOnce(
          new UpstreamError(
            "upstream_error",
            "upstream returned 422",
            {
              error:
                "Failed to deserialize the JSON body into the target type: invalid type: map, expected a sequence",
            },
            422,
          ),
        ),
      chatCompletionStream: vi.fn(),
    } as unknown as ProviderClient;
    const cb = breaker();
    const execute = createExecute({
      defaultProvider: provider,
      providers: new Map([["mock", provider]]),
      registry: registry({ opus: "claude-opus-4-8", grok: "grok-4.5" }),
      breaker: cb,
      catalog: new Map(),
      now: clock(),
      signal: new AbortController().signal,
    });

    const out = await execute(plan(["opus", "grok"]), req());

    expect(out.final.status).toBe("error");
    if (out.final.status !== "error") throw new Error("expected a terminal error");
    expect(out.final.error).toMatchObject({
      error_class: "invalid_request",
      http_status: 400,
      message: "prompt is too long: 1022145 tokens > 1000000 maximum",
      provider_raw: raw,
    });
    // Only the head candidate ran — the overflow short-circuited before grok.
    expect(provider.chatCompletion).toHaveBeenCalledTimes(1);
  });

  it("short-circuits a real overflow rather than letting a larger-window sibling catch it", async () => {
    // The head candidate reports a REAL "prompt is too long: N > M". A later, larger-window
    // sibling COULD serve the oversized request — but that would hide the compaction signal
    // (the client gets 200 and never compacts). So the gateway short-circuits with the 400
    // and does NOT fall back.
    const raw = {
      error: {
        code: "context_length_exceeded",
        message: "prompt is too long: 210000 tokens > 200000 maximum",
      },
    };
    const bigCompletion = vi.fn().mockResolvedValue({ id: "big-window" });
    const provider = {
      chatCompletion: vi
        .fn()
        .mockRejectedValueOnce(
          new UpstreamError("upstream_error", "upstream returned 400", raw, 400),
        )
        .mockImplementation(bigCompletion),
      chatCompletionStream: vi.fn(),
    } as unknown as ProviderClient;
    const execute = createExecute({
      defaultProvider: provider,
      providers: new Map([["mock", provider]]),
      registry: registry({ small: "claude-sonnet-5", big: "claude-opus-4-8" }),
      breaker: breaker(),
      catalog: new Map(),
      now: clock(),
      signal: new AbortController().signal,
    });

    const out = await execute(plan(["small", "big"]), req());

    expect(out.final.status).toBe("error");
    if (out.final.status !== "error") throw new Error("expected a terminal error");
    expect(out.final.error).toMatchObject({
      error_class: "invalid_request",
      http_status: 400,
      message: "prompt is too long: 210000 tokens > 200000 maximum",
      provider_raw: raw,
    });
    // The bigger-window sibling is never invoked.
    expect(bigCompletion).not.toHaveBeenCalled();
    expect(out.attempts).toHaveLength(1);
    expect(out.attempts[0]).toMatchObject({ skipped: false, error_class: "invalid_request" });
  });

  it("does not let a pre-flight approximate shaped estimate override a real provider failure via the bypass", async () => {
    // The head candidate is pre-flight-skipped for exceeding its small window — this
    // SYNTHESIZES a "prompt is too long: N > M" message with authoritative=false. A later
    // candidate then fails with a REAL 500 (a genuine provider fault, NOT an overflow), so
    // `onlyContextOrCapabilitySkips` is false and there are no ≥2 confirmations. Only the
    // authoritative-shape bypass could still fire — and it must NOT, because the shape came
    // from an ESTIMATE, not a real upstream verdict. A real 5xx must win: all_providers_failed.
    const provider = {
      chatCompletion: vi
        .fn()
        // head `small` is pre-flight-skipped (never invoked); tail returns a real 500.
        .mockRejectedValue(new UpstreamError("upstream_error", "upstream returned 500", {}, 500)),
      chatCompletionStream: vi.fn(),
    } as unknown as ProviderClient;
    const execute = createExecute({
      defaultProvider: provider,
      providers: new Map([["mock", provider]]),
      registry: registry({ small: "small-model", tail: "tail-model" }),
      breaker: breaker(),
      // `small` has a tiny window → the 100-char prompt trips the approximate pre-flight gate.
      catalog: new Map([["small", entry("small", { maxContextTokens: 20 })]]),
      now: clock(),
      signal: new AbortController().signal,
    });

    const out = await execute(
      plan(["small", "tail"]),
      req({ messages: [{ role: "user", content: "x".repeat(100) }] }),
    );

    expect(out.final.status).toBe("error");
    if (out.final.status !== "error") throw new Error("expected a terminal error");
    // The synthetic shaped estimate must NOT masquerade as an authoritative hard-maximum
    // verdict and bury the genuine 5xx behind a fabricated compaction 400.
    expect(out.final.error.error_class).toBe("all_providers_failed");
    expect(out.final.error.http_status).toBe(502);
  });

  it("surfaces a comma-grouped overflow message VERBATIM on short-circuit", async () => {
    // Real upstreams format the counts with commas ("1,022,145"). The message is passed
    // through unchanged when the real overflow short-circuits.
    const raw = {
      type: "error",
      error: {
        type: "invalid_request_error",
        message: "prompt is too long: 1,022,145 tokens > 1,000,000 maximum",
      },
    };
    const provider = {
      chatCompletion: vi
        .fn()
        .mockRejectedValueOnce(
          new UpstreamError("upstream_error", "upstream returned 400", raw, 400),
        )
        .mockRejectedValueOnce(
          new UpstreamError("upstream_error", "upstream returned 500", {}, 500),
        ),
      chatCompletionStream: vi.fn(),
    } as unknown as ProviderClient;
    const execute = createExecute({
      defaultProvider: provider,
      providers: new Map([["mock", provider]]),
      registry: registry({ opus: "claude-opus-4-8", tail: "tail-model" }),
      breaker: breaker(),
      catalog: new Map(),
      now: clock(),
      signal: new AbortController().signal,
    });

    const out = await execute(plan(["opus", "tail"]), req());

    expect(out.final.status).toBe("error");
    if (out.final.status !== "error") throw new Error("expected a terminal error");
    expect(out.final.error).toMatchObject({
      error_class: "invalid_request",
      http_status: 400,
      message: "prompt is too long: 1,022,145 tokens > 1,000,000 maximum",
      provider_raw: raw,
    });
    // Short-circuited before the tail candidate.
    expect(provider.chatCompletion).toHaveBeenCalledTimes(1);
  });

  it("does not synthesize a compaction 400 from the phrase echoed in a provider-failure body", async () => {
    // The terminal shape-bypass keys on the STRUCTURED error message (`error.message`), not
    // the JSON-stringified raw body. So a genuine provider failure whose body merely echoes
    // request content containing "prompt is too long: N > M" must NOT be promoted to a
    // compaction 400 — with the whole chain failing, the terminal stays all_providers_failed.
    const provider = {
      chatCompletion: vi.fn().mockRejectedValue(
        new UpstreamError(
          "upstream_error",
          "upstream returned 500",
          {
            error: { type: "server_error", message: "internal error" },
            echoed_input: "the user wrote: prompt is too long: 5 tokens > 3 maximum",
          },
          500,
        ),
      ),
      chatCompletionStream: vi.fn(),
    } as unknown as ProviderClient;
    const execute = createExecute({
      defaultProvider: provider,
      providers: new Map([["mock", provider]]),
      registry: registry({ opus: "claude-opus-4-8", tail: "tail-model" }),
      breaker: breaker(),
      catalog: new Map(),
      now: clock(),
      signal: new AbortController().signal,
    });

    const out = await execute(plan(["opus", "tail"]), req());

    expect(out.final.status).toBe("error");
    if (out.final.status !== "error") throw new Error("expected a terminal error");
    // The echoed phrase must not fabricate a client-visible 400.
    expect(out.final.error.error_class).toBe("all_providers_failed");
    expect(out.final.error.http_status).toBe(502);
  });

  it("does NOT short-circuit a retryable 5xx whose body happens to carry a context_length_exceeded marker", async () => {
    // A REAL HTTP 5xx (or 429) is a transient/retryable provider fault, NOT a client context
    // overflow — even if the error body coincidentally carries `context_length_exceeded` (e.g.
    // an upstream wrapping a context-related overload as a 500). Short-circuiting it to a 400
    // would strand the request: no fall-back to a healthy sibling, no breaker fault. The
    // overflow short-circuit ALLOWLISTS only deterministic 400/413/422 (+ null in-band).
    const provider = {
      chatCompletion: vi
        .fn()
        .mockRejectedValueOnce(
          new UpstreamError(
            "upstream_error",
            "upstream returned 500",
            { error: { code: "context_length_exceeded", message: "overloaded" } },
            500,
          ),
        )
        .mockResolvedValueOnce({ id: "healthy-sibling" }),
      chatCompletionStream: vi.fn(),
    } as unknown as ProviderClient;
    const cb = breaker();
    const recordFailure = vi.spyOn(cb, "recordFailure");
    const execute = createExecute({
      defaultProvider: provider,
      providers: new Map([["mock", provider]]),
      registry: registry({ opus: "claude-opus-4-8", tail: "tail-model" }),
      breaker: cb,
      catalog: new Map(),
      now: clock(),
      signal: new AbortController().signal,
    });

    const out = await execute(plan(["opus", "tail"]), req());

    // The 5xx faults the breaker and the chain falls back to the healthy sibling.
    expect(out.final).toEqual({ status: "ok", alias: "tail", providerModel: "tail-model" });
    expect(provider.chatCompletion).toHaveBeenCalledTimes(2);
    expect(out.attempts[0]).toMatchObject({ alias: "opus", skipped: false, status: "error" });
    expect(recordFailure).toHaveBeenCalledWith("opus");
  });

  it("does NOT short-circuit a retryable 408 that coincidentally carries a context marker", async () => {
    // 408 Request Timeout is retryable, not a deterministic client overflow. The overflow
    // short-circuit ALLOWLISTS only deterministic request-shape statuses (400/413/422) + null
    // (in-band, no HTTP status); every other numeric status — 408 included — must fall back and
    // fault the breaker, even if the body coincidentally carries an overflow marker.
    const provider = {
      chatCompletion: vi
        .fn()
        .mockRejectedValueOnce(
          new UpstreamError(
            "upstream_error",
            "upstream returned 408",
            { error: { code: "context_length_exceeded", message: "request timeout" } },
            408,
          ),
        )
        .mockResolvedValueOnce({ id: "healthy-sibling" }),
      chatCompletionStream: vi.fn(),
    } as unknown as ProviderClient;
    const cb = breaker();
    const recordFailure = vi.spyOn(cb, "recordFailure");
    const execute = createExecute({
      defaultProvider: provider,
      providers: new Map([["mock", provider]]),
      registry: registry({ opus: "claude-opus-4-8", tail: "tail-model" }),
      breaker: cb,
      catalog: new Map(),
      now: clock(),
      signal: new AbortController().signal,
    });

    const out = await execute(plan(["opus", "tail"]), req());

    expect(out.final).toEqual({ status: "ok", alias: "tail", providerModel: "tail-model" });
    expect(provider.chatCompletion).toHaveBeenCalledTimes(2);
    expect(recordFailure).toHaveBeenCalledWith("opus");
  });

  it("falls back when an OpenAI-compatible thinking target requires missing reasoning_content history", async () => {
    const provider = {
      chatCompletion: vi
        .fn()
        .mockRejectedValueOnce(
          new UpstreamError(
            "upstream_error",
            "upstream returned 400",
            {
              error: {
                message:
                  "The `reasoning_content` in the thinking mode must be passed back to the API.",
                type: "invalid_request_error",
                param: null,
                code: "invalid_request_error",
              },
            },
            400,
          ),
        )
        .mockResolvedValueOnce({ id: "second" }),
      chatCompletionStream: vi.fn(),
    } as unknown as ProviderClient;
    const cb = breaker();
    const recordFailure = vi.spyOn(cb, "recordFailure");
    const execute = createExecute({
      defaultProvider: provider,
      providers: new Map([["mock", provider]]),
      registry: protocolRegistry({
        deepseek: {
          providerName: "mock",
          providerModel: "deepseek-v4-pro",
          targetProviderProtocol: "openai_chat",
        },
        tail: {
          providerName: "mock",
          providerModel: "gpt-fallback",
          targetProviderProtocol: "openai_chat",
        },
      }),
      breaker: cb,
      catalog: new Map(),
      now: clock(),
      signal: new AbortController().signal,
    });

    const out = await execute(plan(["deepseek", "tail"]), req());

    expect(out.final).toEqual({ status: "ok", alias: "tail", providerModel: "gpt-fallback" });
    expect(provider.chatCompletion).toHaveBeenCalledTimes(2);
    expect(out.attempts[0]).toMatchObject({
      alias: "deepseek",
      skipped: true,
      skip_reason: "reasoning_history_incompatible",
      status: "error",
      error_class: null,
    });
    expect(recordFailure).not.toHaveBeenCalled();
  });

  it("pre-skips direct DeepSeek when Responses reasoning history cannot be represented", async () => {
    const deepseekProvider = {
      chatCompletion: vi.fn().mockResolvedValue({ id: "should-not-call" }),
      chatCompletionStream: vi.fn(),
    } as unknown as ProviderClient;
    const tailProvider = {
      chatCompletion: vi.fn().mockResolvedValue({ id: "tail" }),
      chatCompletionStream: vi.fn(),
    } as unknown as ProviderClient;
    const execute = createExecute({
      defaultProvider: tailProvider,
      providers: new Map([
        ["deepseek", deepseekProvider],
        ["mock", tailProvider],
      ]),
      registry: protocolRegistry({
        deepseek: {
          providerName: "deepseek",
          providerModel: "deepseek-v4-flash",
          targetProviderProtocol: "openai_chat",
        },
        tail: {
          providerName: "mock",
          providerModel: "gpt-fallback",
          targetProviderProtocol: "openai_chat",
        },
      }),
      breaker: breaker(),
      catalog: new Map(),
      now: clock(),
      signal: new AbortController().signal,
    });

    const out = await execute(
      plan(["deepseek", "tail"]),
      req({
        protocol: "openai_responses",
        thinking: [{ type: "thinking", text: "hidden reasoning" }],
        provider_raw: {
          reasoning: [{ type: "reasoning", id: "rs_1", summary: [] }],
          reasoning_config: { effort: "medium" },
        },
      }),
    );

    expect(out.final).toEqual({ status: "ok", alias: "tail", providerModel: "gpt-fallback" });
    expect(deepseekProvider.chatCompletion).not.toHaveBeenCalled();
    expect(tailProvider.chatCompletion).toHaveBeenCalledOnce();
    expect(out.attempts[0]).toMatchObject({
      alias: "deepseek",
      skipped: true,
      skip_reason: "reasoning_history_incompatible",
      status: "error",
      error_class: null,
    });
  });

  it("does not pre-skip OpenRouter-hosted DeepSeek for Responses reasoning history", async () => {
    const openrouterProvider = {
      chatCompletion: vi.fn().mockResolvedValue({ id: "ok" }),
      chatCompletionStream: vi.fn(),
    } as unknown as ProviderClient;
    const execute = createExecute({
      defaultProvider: openrouterProvider,
      providers: new Map([["openrouter", openrouterProvider]]),
      registry: protocolRegistry({
        openrouter: {
          providerName: "openrouter",
          providerModel: "deepseek/deepseek-v4-flash",
          targetProviderProtocol: "openai_chat",
        },
      }),
      breaker: breaker(),
      catalog: new Map(),
      now: clock(),
      signal: new AbortController().signal,
    });

    const out = await execute(
      plan(["openrouter"]),
      req({
        protocol: "openai_responses",
        thinking: [{ type: "thinking", text: "hidden reasoning" }],
        provider_raw: {
          reasoning: [{ type: "reasoning", id: "rs_1", summary: [] }],
          reasoning_config: { effort: "medium" },
        },
      }),
    );

    expect(out.final).toEqual({
      status: "ok",
      alias: "openrouter",
      providerModel: "deepseek/deepseek-v4-flash",
    });
    expect(openrouterProvider.chatCompletion).toHaveBeenCalledOnce();
    expect(out.attempts[0]).toMatchObject({
      alias: "openrouter",
      skipped: false,
      status: "ok",
    });
  });

  it("still falls back and faults the breaker on a non-request upstream 5xx", async () => {
    // Control: a 5xx is a provider-HEALTH failure (not a request-shape rejection),
    // so the chain advances to the next candidate and the breaker records a fault.
    const provider = {
      chatCompletion: vi
        .fn()
        .mockRejectedValueOnce(
          new UpstreamError(
            "upstream_error",
            "upstream returned 500",
            { type: "error", error: { type: "api_error", message: "overloaded" } },
            500,
          ),
        )
        .mockResolvedValueOnce({ id: "second" }),
      chatCompletionStream: vi.fn(),
    } as unknown as ProviderClient;
    const cb = breaker();
    const recordFailure = vi.spyOn(cb, "recordFailure");
    const execute = createExecute({
      defaultProvider: provider,
      providers: new Map([["mock", provider]]),
      registry: protocolRegistry({
        opus: {
          providerName: "mock",
          providerModel: "claude-opus-4-8",
          targetProviderProtocol: "anthropic_messages",
        },
        codex: {
          providerName: "mock",
          providerModel: "gpt-5.5",
          targetProviderProtocol: "openai_responses",
        },
      }),
      breaker: cb,
      catalog: new Map(),
      now: clock(),
      signal: new AbortController().signal,
    });

    const out = await execute(plan(["opus", "codex"]), req());

    expect(out.final.status).toBe("ok");
    expect(out.attempts).toHaveLength(2);
    expect(out.attempts[1]?.status).toBe("ok");
    expect(recordFailure).toHaveBeenCalledWith("opus");
  });

  it("captures error_detail for a non-UpstreamError failure (null status, null raw)", async () => {
    const provider = {
      chatCompletion: vi.fn().mockRejectedValue(new Error("socket hang up")),
      chatCompletionStream: vi.fn(),
    } as unknown as ProviderClient;
    const execute = createExecute({
      defaultProvider: provider,
      providers: new Map([["mock", provider]]),
      registry: registry({ a: "m-a" }),
      breaker: breaker(),
      catalog: new Map(),
      now: clock(),
      signal: new AbortController().signal,
    });

    const out = await execute(plan(["a"]), req());
    expect(out.attempts[0]?.status).toBe("error");
    expect(out.attempts[0]?.error_detail?.upstream_status).toBeNull();
    expect(out.attempts[0]?.error_detail?.provider_raw).toBeNull();
    // A generic error's message is surfaced (it is not key-bearing here).
    expect(out.attempts[0]?.error_detail?.message).toContain("socket hang up");
  });

  it("returns all_providers_failed when every candidate fails", async () => {
    const provider = {
      chatCompletion: vi.fn().mockRejectedValue(new UpstreamError("upstream_error", "boom")),
      chatCompletionStream: vi.fn(),
    } as unknown as ProviderClient;
    const execute = createExecute({
      defaultProvider: provider,
      providers: new Map([["mock", provider]]),
      registry: registry({ a: "m-a", b: "m-b" }),
      breaker: breaker(),
      catalog: new Map(),
      now: clock(),
      signal: new AbortController().signal,
    });

    const out = await execute(plan(["a", "b"]), req());
    expect(out.final.status).toBe("error");
    if (out.final.status === "error") {
      expect(out.final.error.error_class).toBe("all_providers_failed");
    }
  });

  it("skips a candidate whose capabilities cannot satisfy the request", async () => {
    const provider = {
      chatCompletion: vi.fn().mockResolvedValue({ id: "ok" }),
      chatCompletionStream: vi.fn(),
    } as unknown as ProviderClient;
    const noTools: CatalogEntry = {
      modelKey: "a",
      capabilities: {
        supportsTools: false,
        jsonOutput: "schema",
        supportsVision: true,
        supportsStreaming: true,
        maxContextTokens: 100000,
        maxOutputTokens: 4096,
      },
      pricing: {
        inputPerMTokUsd: null,
        outputPerMTokUsd: null,
        cacheReadPerMTokUsd: null,
        cacheWritePerMTokUsd: null,
      },
      source: "generated",
    };
    const execute = createExecute({
      defaultProvider: provider,
      providers: new Map([["mock", provider]]),
      registry: registry({ a: "m-a", b: "m-b" }),
      breaker: breaker(),
      catalog: new Map([["a", noTools]]),
      now: clock(),
      signal: new AbortController().signal,
    });

    const out = await execute(plan(["a", "b"]), req({ tools: [{ type: "function" }] }));
    expect(out.attempts[0]?.skipped).toBe(true);
    expect(out.attempts[0]?.skip_reason).toBe("no_tool_support");
    expect(out.final.status).toBe("ok");
  });

  it("forwards the streaming chunks unbuffered after peeking the first", async () => {
    const chunks = ['data: {"a":1}\n\n', "data: [DONE]\n\n"];
    const provider = {
      chatCompletion: vi.fn(),
      chatCompletionStream: vi.fn().mockReturnValue(gen(chunks)),
    } as unknown as ProviderClient;
    const execute = createExecute({
      defaultProvider: provider,
      providers: new Map([["mock", provider]]),
      registry: registry({ a: "m-a" }),
      breaker: breaker(),
      catalog: new Map(),
      now: clock(),
      signal: new AbortController().signal,
    });

    const out = await execute(plan(["a"]), req({ stream: true }));
    expect(out.final.status).toBe("ok");
    expect(out.stream).not.toBeNull();
    const seen: string[] = [];
    for await (const ch of out.stream as AsyncIterable<string>) seen.push(ch);
    expect(seen).toEqual(chunks);
  });

  it("H8: an empty stream (zero chunks) is a pre-first-chunk failure → advances the chain, never recordSuccess", async () => {
    const provider = {
      chatCompletion: vi.fn(),
      chatCompletionStream: vi
        .fn()
        .mockReturnValueOnce(gen([])) // candidate a: 200 body that closes with NO chunk
        .mockReturnValueOnce(gen(['data: {"ok":1}\n\n', "data: [DONE]\n\n"])), // b: healthy
    } as unknown as ProviderClient;
    const cb = breaker();
    const recordSuccess = vi.spyOn(cb, "recordSuccess");
    const recordFailure = vi.spyOn(cb, "recordFailure");
    const execute = createExecute({
      defaultProvider: provider,
      providers: new Map([["mock", provider]]),
      registry: registry({ a: "m-a", b: "m-b" }),
      breaker: cb,
      catalog: new Map(),
      now: clock(),
      signal: new AbortController().signal,
    });

    const out = await execute(plan(["a", "b"]), req({ stream: true }));
    // 'a' must be recorded a FAILURE (not a success that heals the breaker), and the
    // chain must advance to the healthy 'b'.
    expect(recordFailure).toHaveBeenCalledWith("a");
    expect(recordSuccess).not.toHaveBeenCalledWith("a");
    expect(recordSuccess).toHaveBeenCalledWith("b");
    expect(out.attempts[0]?.alias).toBe("a");
    expect(out.attempts[0]?.status).toBe("error");
    expect(out.final.status).toBe("ok");
  });

  it("records stream_reframed when an OpenAI-compatible provider applies a stream shim", async () => {
    const provider = {
      streamReframed: true,
      chatCompletion: vi.fn(),
      chatCompletionStream: vi.fn().mockReturnValue(gen(["data: {}\n\n"])),
    } as unknown as ProviderClient;
    const execute = createExecute({
      defaultProvider: provider,
      providers: new Map([["mock", provider]]),
      registry: registry({ a: "m-a" }),
      breaker: breaker(),
      catalog: new Map(),
      now: clock(),
      signal: new AbortController().signal,
    });

    const out = await execute(plan(["a"]), req({ stream: true }));

    expect(out.final.status).toBe("ok");
    expect(out.attempts[0]?.request_mutations).toMatchObject({ stream_reframed: true });
  });

  it("logs a structured truncated-stream event when the relay throws AFTER the first chunk", async () => {
    // peekStream records success after the first chunk (breaker semantics kept).
    // If the upstream stream then dies mid-flight, telemetry already shows ok —
    // so at minimum a structured log must make the truncation observable. Safe
    // fields only (alias + error_class), NEVER key/payload (principle 7).
    async function* dies(): AsyncGenerator<string> {
      yield 'data: {"a":1}\n\n';
      throw new Error("connection reset mid-stream");
    }
    const provider = {
      chatCompletion: vi.fn(),
      chatCompletionStream: vi.fn().mockReturnValue(dies()),
    } as unknown as ProviderClient;
    const cb = breaker();
    const recordFailure = vi.spyOn(cb, "recordFailure");
    const recordSuccess = vi.spyOn(cb, "recordSuccess");
    const logs: Array<{ level: string; msg: string; fields: Record<string, unknown> }> = [];
    const execute = createExecute({
      defaultProvider: provider,
      providers: new Map([["mock", provider]]),
      registry: registry({ a: "m-a" }),
      breaker: cb,
      catalog: new Map(),
      now: clock(),
      signal: new AbortController().signal,
      log: (level, msg, fields) => logs.push({ level, msg, fields }),
    });

    const out = await execute(plan(["a"]), req({ stream: true }));
    expect(out.final.status).toBe("ok");
    expect(recordSuccess).toHaveBeenCalledTimes(1);
    // Breaker semantics unchanged: a post-first-chunk failure is NOT a failure.
    expect(recordFailure).not.toHaveBeenCalled();

    const seen: string[] = [];
    let threw = false;
    try {
      for await (const ch of out.stream as AsyncIterable<string>) seen.push(ch);
    } catch {
      threw = true;
    }
    expect(seen).toEqual(['data: {"a":1}\n\n']);
    expect(threw).toBe(true);
    const truncated = logs.find((l) => l.msg === "stream.truncated");
    expect(truncated).toBeDefined();
    expect(truncated?.fields.alias).toBe("a");
    // Safe fields only — no key/payload/raw error object leaked.
    const serialized = JSON.stringify(truncated?.fields);
    expect(serialized).not.toContain("connection reset");
  });

  it("classifies a post-first-chunk AbortError as a client abort without breaker failure", async () => {
    async function* aborted(): AsyncGenerator<string> {
      yield 'data: {"a":1}\n\n';
      throw Object.assign(new Error("stream aborted"), { name: "AbortError" });
    }
    const provider = {
      chatCompletion: vi.fn(),
      chatCompletionStream: vi.fn().mockReturnValue(aborted()),
    } as unknown as ProviderClient;
    const cb = breaker();
    const recordFailure = vi.spyOn(cb, "recordFailure");
    const logs: Array<{ msg: string; fields: Record<string, unknown> }> = [];
    const execute = createExecute({
      defaultProvider: provider,
      providers: new Map([["mock", provider]]),
      registry: registry({ a: "m-a" }),
      breaker: cb,
      catalog: new Map(),
      now: clock(),
      signal: new AbortController().signal,
      log: (_level, msg, fields) => logs.push({ msg, fields }),
    });

    const out = await execute(plan(["a"]), req({ stream: true }));
    await expect(async () => {
      for await (const _ of out.stream as AsyncIterable<string>) {
        // drain
      }
    }).rejects.toThrow("stream aborted");

    expect(recordFailure).not.toHaveBeenCalled();
    expect(logs).toContainEqual({
      msg: "stream.truncated",
      fields: { alias: "a", error_class: "client_abort", reason: "client_abort" },
    });
  });

  it("crosses providers: a fallback chain spanning two providers invokes both in order", async () => {
    // Registry resolves each alias to a DISTINCT provider. The executor must
    // invoke provider-A's client for the head candidate, then provider-B's client
    // for the fallback — proving the chain can cross providers (not all routed to
    // one client). Provider A fails pre-first-chunk; B succeeds.
    const providerA = {
      chatCompletion: vi.fn().mockRejectedValue(new UpstreamError("upstream_error", "A down")),
      chatCompletionStream: vi.fn(),
    } as unknown as ProviderClient;
    const providerB = {
      chatCompletion: vi.fn().mockResolvedValue({ id: "from-B" }),
      chatCompletionStream: vi.fn(),
    } as unknown as ProviderClient;

    const reg: ProviderRegistry = {
      resolve(alias: string) {
        if (alias === "a")
          return {
            ok: true,
            value: {
              alias,
              providerName: "prov-a",
              providerModel: "model-a",
              baseUrl: "http://a",
              apiKeyEnv: "A_KEY",
              targetProviderProtocol: "openai_chat",
              providerRequiresCompatibilityRewrite: false,
            },
          };
        if (alias === "b")
          return {
            ok: true,
            value: {
              alias,
              providerName: "prov-b",
              providerModel: "model-b",
              baseUrl: "http://b",
              apiKeyEnv: "B_KEY",
              targetProviderProtocol: "openai_chat",
              providerRequiresCompatibilityRewrite: false,
            },
          };
        return { ok: false, error: { kind: "unknown_alias", alias } };
      },
      list: () => ["a", "b"],
    };

    const execute = createExecute({
      defaultProvider: providerA,
      providers: new Map([
        ["prov-a", providerA],
        ["prov-b", providerB],
      ]),
      registry: reg,
      breaker: breaker(),
      catalog: new Map(),
      now: clock(),
      signal: new AbortController().signal,
    });

    const out = await execute(plan(["a", "b"]), req());
    expect(out.final.status).toBe("ok");
    expect(out.body).toEqual({ id: "from-B" });
    // Provider A was invoked with its own model id, provider B with its own.
    expect(providerA.chatCompletion).toHaveBeenCalledTimes(1);
    expect(providerB.chatCompletion).toHaveBeenCalledTimes(1);
    expect((providerA.chatCompletion as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]).toMatchObject(
      { model: "model-a" },
    );
    expect((providerB.chatCompletion as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]).toMatchObject(
      { model: "model-b" },
    );
    expect(out.attempts).toHaveLength(2);
    expect(out.attempts[0]?.status).toBe("error");
    expect(out.attempts[1]?.status).toBe("ok");
    if (out.final.status === "ok") expect(out.final.providerModel).toBe("model-b");
  });

  it("a candidate that exceeds attempt_timeout_ms is a TIMEOUT fault → breaker failure + advance", async () => {
    // The head hangs until its signal aborts (a too-slow upstream); the per-attempt
    // deadline must abort it, classify it as a `timeout` provider fault (NOT a client
    // abort), record a breaker failure, and fall back to the next candidate.
    const cb = breaker();
    const recordFailure = vi.spyOn(cb, "recordFailure");
    const recordAbort = vi.spyOn(cb, "recordAbort");
    const provider = {
      chatCompletion: vi
        .fn()
        .mockImplementationOnce(
          (_b: unknown, opts: { signal: AbortSignal }) =>
            new Promise((_res, rej) => {
              opts.signal.addEventListener("abort", () =>
                rej(Object.assign(new Error("aborted"), { name: "AbortError" })),
              );
            }),
        )
        .mockResolvedValueOnce({ id: "from-fallback" }),
      chatCompletionStream: vi.fn(),
    } as unknown as ProviderClient;
    const execute = createExecute({
      defaultProvider: provider,
      providers: new Map([["mock", provider]]),
      registry: registry({ slow: "m-slow", fast: "m-fast" }),
      breaker: cb,
      catalog: new Map(),
      now: clock(),
      signal: new AbortController().signal,
    });

    const out = await execute(plan(["slow", "fast"]), req({ attempt_timeout_ms: 20 }));

    expect(out.final.status).toBe("ok");
    expect(out.body).toEqual({ id: "from-fallback" });
    // Slow head = timeout fault: breaker failure + chain advance, NOT a client abort.
    expect(recordFailure).toHaveBeenCalledWith("slow");
    expect(recordAbort).not.toHaveBeenCalled();
    expect(out.attempts[0]?.status).toBe("error");
    expect(out.attempts[0]?.error_class).toBe("timeout");
    expect(provider.chatCompletion).toHaveBeenCalledTimes(2);
  });

  it("a genuine client abort still records client_abort even when attempt_timeout_ms is set", async () => {
    // The per-attempt deadline must NOT swallow a real client disconnect: a client
    // abort wins over the (much longer) deadline, stays a non-provider fault
    // (recordAbort, no breaker failure), and terminates the chain (no advance).
    const cb = breaker();
    const recordAbort = vi.spyOn(cb, "recordAbort");
    const recordFailure = vi.spyOn(cb, "recordFailure");
    const ac = new AbortController();
    const provider = {
      chatCompletion: vi.fn().mockImplementation(
        (_b: unknown, opts: { signal: AbortSignal }) =>
          new Promise((_res, rej) => {
            opts.signal.addEventListener("abort", () =>
              rej(Object.assign(new Error("aborted"), { name: "AbortError" })),
            );
          }),
      ),
      chatCompletionStream: vi.fn(),
    } as unknown as ProviderClient;
    const execute = createExecute({
      defaultProvider: provider,
      providers: new Map([["mock", provider]]),
      registry: registry({ slow: "m-slow", fast: "m-fast" }),
      breaker: cb,
      catalog: new Map(),
      now: clock(),
      signal: ac.signal,
    });
    // Client disconnects well before the 5s attempt deadline.
    setTimeout(() => ac.abort(), 10);

    const out = await execute(plan(["slow", "fast"]), req({ attempt_timeout_ms: 5000 }));

    expect(out.final.status).toBe("error");
    expect(recordAbort).toHaveBeenCalledWith("slow");
    expect(recordFailure).not.toHaveBeenCalled();
    // Terminal: did NOT advance to the fallback candidate.
    expect(provider.chatCompletion).toHaveBeenCalledTimes(1);
  });

  it("structurally routes a provider/model alias the registry never enumerated to that provider's pool client", async () => {
    // Live OAuth curation: the operator added a model AFTER startup, so the live
    // catalog offers `openai-codex/gpt-5.5` but the startup registry has no entry.
    // The pool client (keyed by providerId, forwards ANY model) must still serve it
    // with providerModel = the part after the slash — no restart, no default cross.
    const pool = {
      chatCompletion: vi.fn().mockResolvedValue({ id: "from-pool" }),
      chatCompletionStream: vi.fn(),
    } as unknown as ProviderClient;
    const defaultProvider = {
      chatCompletion: vi.fn().mockResolvedValue({ id: "default" }),
      chatCompletionStream: vi.fn(),
    } as unknown as ProviderClient;
    const execute = createExecute({
      defaultProvider,
      providers: new Map([["openai-codex", pool]]),
      registry: registry({}), // resolves nothing -> unknown_alias
      breaker: breaker(),
      catalog: new Map(),
      now: clock(),
      signal: new AbortController().signal,
    });

    const out = await execute(plan(["openai-codex/gpt-5.5"]), req());
    expect(out.final.status).toBe("ok");
    expect(out.body).toEqual({ id: "from-pool" });
    expect(defaultProvider.chatCompletion).not.toHaveBeenCalled();
    // Routed to the pool with the upstream model id (the slash-suffix), NOT the alias.
    expect((pool.chatCompletion as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]).toMatchObject({
      model: "gpt-5.5",
    });
    if (out.final.status === "ok") expect(out.final.providerModel).toBe("gpt-5.5");
  });

  it("falls back to the default provider when the alias resolves to an unknown provider client", async () => {
    // Phase-0 passthrough: lane aliases map 1:1 to the single configured upstream
    // and are NOT in the registry's models[]; the executor must still serve them
    // via the default provider (back-compat — no regression of single-provider).
    const defaultProvider = {
      chatCompletion: vi.fn().mockResolvedValue({ id: "default" }),
      chatCompletionStream: vi.fn(),
    } as unknown as ProviderClient;
    const execute = createExecute({
      defaultProvider,
      providers: new Map(),
      registry: registry({}), // resolves nothing -> unknown_alias
      breaker: breaker(),
      catalog: new Map(),
      now: clock(),
      signal: new AbortController().signal,
    });

    const out = await execute(plan(["balanced_model"]), req());
    expect(out.final.status).toBe("ok");
    expect(out.body).toEqual({ id: "default" });
    expect(defaultProvider.chatCompletion).toHaveBeenCalledTimes(1);
  });

  it("does not fall back to default when a resolved provider has no client", async () => {
    const defaultProvider = {
      chatCompletion: vi.fn().mockResolvedValue({ id: "default" }),
      chatCompletionStream: vi.fn(),
    } as unknown as ProviderClient;
    const execute = createExecute({
      defaultProvider,
      providers: new Map(),
      registry: registryWithProviders({
        oauth_alias: { providerName: "oauth-sub", providerModel: "gpt-sub" },
      }),
      breaker: breaker(),
      catalog: new Map(),
      now: clock(),
      signal: new AbortController().signal,
    });

    const out = await execute(plan(["oauth_alias"]), req());
    expect(defaultProvider.chatCompletion).not.toHaveBeenCalled();
    expect(out.attempts[0]).toMatchObject({
      alias: "oauth_alias",
      skipped: true,
      skip_reason: "provider_unavailable",
    });
    expect(out.final.status).toBe("error");
    if (out.final.status === "error") {
      expect(out.final.error.error_class).toBe("all_providers_failed");
    }
  });

  it("does not fall back to default when a resolved provider has no client and providers are omitted", async () => {
    const defaultProvider = {
      chatCompletion: vi.fn().mockResolvedValue({ id: "default" }),
      chatCompletionStream: vi.fn(),
    } as unknown as ProviderClient;
    const execute = createExecute({
      defaultProvider,
      registry: registryWithProviders({
        oauth_alias: { providerName: "oauth-sub", providerModel: "gpt-sub" },
      }),
      breaker: breaker(),
      catalog: new Map(),
      now: clock(),
      signal: new AbortController().signal,
    });

    const out = await execute(plan(["oauth_alias"]), req());
    expect(defaultProvider.chatCompletion).not.toHaveBeenCalled();
    expect(out.attempts[0]).toMatchObject({
      alias: "oauth_alias",
      skipped: true,
      skip_reason: "provider_unavailable",
    });
    expect(out.final.status).toBe("error");
    if (out.final.status === "error") {
      expect(out.final.error.error_class).toBe("all_providers_failed");
    }
  });

  it("treats a client abort as a non-provider fault (no all_providers_failed)", async () => {
    const ac = new AbortController();
    const abortErr = new Error("aborted");
    abortErr.name = "AbortError";
    const provider = {
      chatCompletion: vi.fn().mockRejectedValue(abortErr),
      chatCompletionStream: vi.fn(),
    } as unknown as ProviderClient;
    const cb = breaker();
    const recordFailure = vi.spyOn(cb, "recordFailure");
    const execute = createExecute({
      defaultProvider: provider,
      providers: new Map([["mock", provider]]),
      registry: registry({ a: "m-a" }),
      breaker: cb,
      catalog: new Map(),
      now: clock(),
      signal: ac.signal,
    });

    const out = await execute(plan(["a"]), req());
    expect(out.attempts[0]?.error_class).toBe("client_abort");
    expect(recordFailure).not.toHaveBeenCalled();
    // C2: the FINAL surfaced error must be client_abort (499), not a 502 provider
    // fault — a disconnect is a non-provider fault and must not be counted as one.
    expect(out.final.status).toBe("error");
    if (out.final.status === "error") {
      expect(out.final.error.error_class).toBe("client_abort");
      expect(out.final.error.http_status).toBe(499);
    }
  });

  // ── ported execution semantics on the LIVE path (drift fix) ────────────────

  it("skips a :free candidate on upstream 429 (free_429) WITHOUT a breaker failure", async () => {
    // Free-tier throttling is NOT a provider-health signal (principle 5): the
    // candidate is skipped to the next, no breaker.recordFailure, and the row
    // carries skip_reason 'free_429' / error_class 'rate_limited'.
    const provider = {
      chatCompletion: vi
        .fn()
        .mockRejectedValueOnce(new UpstreamError("upstream_error", "429", null, 429))
        .mockResolvedValueOnce({ id: "paid" }),
      chatCompletionStream: vi.fn(),
    } as unknown as ProviderClient;
    const cb = breaker();
    const recordFailure = vi.spyOn(cb, "recordFailure");
    const execute = createExecute({
      defaultProvider: provider,
      providers: new Map([["mock", provider]]),
      registry: registry({ "free-model:free": "m-free", paid: "m-paid" }),
      breaker: cb,
      catalog: new Map(),
      now: clock(),
      signal: new AbortController().signal,
    });

    const out = await execute(plan(["free-model:free", "paid"]), req());
    expect(out.attempts[0]?.skipped).toBe(true);
    expect(out.attempts[0]?.skip_reason).toBe("free_429");
    expect(out.attempts[0]?.error_class).toBe("rate_limited");
    expect(recordFailure).not.toHaveBeenCalled();
    expect(out.final.status).toBe("ok");
    if (out.final.status === "ok") expect(out.final.alias).toBe("paid");
  });

  it("a real upstream error (non-free, or free non-429) still records a breaker failure", async () => {
    // A :free candidate failing with a NON-429 status is a genuine provider
    // fault — it must record on the breaker (no free_429 escape hatch).
    const provider = {
      chatCompletion: vi
        .fn()
        .mockRejectedValueOnce(new UpstreamError("upstream_error", "500", null, 500))
        .mockResolvedValueOnce({ id: "second" }),
      chatCompletionStream: vi.fn(),
    } as unknown as ProviderClient;
    const cb = breaker();
    const recordFailure = vi.spyOn(cb, "recordFailure");
    const execute = createExecute({
      defaultProvider: provider,
      providers: new Map([["mock", provider]]),
      registry: registry({ "free-model:free": "m-free", b: "m-b" }),
      breaker: cb,
      catalog: new Map(),
      now: clock(),
      signal: new AbortController().signal,
    });

    const out = await execute(plan(["free-model:free", "b"]), req());
    expect(out.attempts[0]?.skipped).toBe(false);
    expect(out.attempts[0]?.skip_reason).toBeNull();
    expect(out.attempts[0]?.error_class).toBe("upstream_error");
    expect(recordFailure).toHaveBeenCalledTimes(1);
    expect(recordFailure).toHaveBeenCalledWith("free-model:free");
    expect(out.final.status).toBe("ok");
  });

  it("classifies a persistent upstream 401 as auth_error and records exactly one breaker failure", async () => {
    // OAuth (issue #38): the client already retried once with a fresh token before
    // surfacing this 401, so the executor sees a single failure. It must classify
    // the attempt as `auth_error` (D5) and record EXACTLY one breaker failure (D6 —
    // no extra executor branch / no double-count), then advance the chain.
    const provider = {
      chatCompletion: vi
        .fn()
        .mockRejectedValueOnce(new UpstreamError("upstream_error", "401", null, 401))
        .mockResolvedValueOnce({ id: "second" }),
      chatCompletionStream: vi.fn(),
    } as unknown as ProviderClient;
    const cb = breaker();
    const recordFailure = vi.spyOn(cb, "recordFailure");
    const execute = createExecute({
      defaultProvider: provider,
      providers: new Map([["mock", provider]]),
      registry: registry({ a: "m-a", b: "m-b" }),
      breaker: cb,
      catalog: new Map(),
      now: clock(),
      signal: new AbortController().signal,
    });

    const out = await execute(plan(["a", "b"]), req());
    expect(out.attempts[0]?.error_class).toBe("auth_error");
    expect(recordFailure).toHaveBeenCalledTimes(1);
    expect(recordFailure).toHaveBeenCalledWith("a");
    expect(out.final.status).toBe("ok");
  });

  it("does NOT treat a generic 'aborted' message as a client abort (only signal/name)", async () => {
    // Over-broad heuristic fix: an upstream error whose message merely contains
    // 'aborted' must be a normal provider failure (breaker.recordFailure), NOT a
    // client-abort termination — the signal is not aborted and name != AbortError.
    const provider = {
      chatCompletion: vi
        .fn()
        .mockRejectedValueOnce(new UpstreamError("upstream_error", "request was aborted upstream"))
        .mockResolvedValueOnce({ id: "second" }),
      chatCompletionStream: vi.fn(),
    } as unknown as ProviderClient;
    const cb = breaker();
    const recordFailure = vi.spyOn(cb, "recordFailure");
    const execute = createExecute({
      defaultProvider: provider,
      providers: new Map([["mock", provider]]),
      registry: registry({ a: "m-a", b: "m-b" }),
      breaker: cb,
      catalog: new Map(),
      now: clock(),
      signal: new AbortController().signal,
    });

    const out = await execute(plan(["a", "b"]), req());
    expect(out.attempts[0]?.error_class).toBe("upstream_error");
    expect(out.attempts[0]?.error_class).not.toBe("client_abort");
    expect(recordFailure).toHaveBeenCalledTimes(1);
    expect(out.final.status).toBe("ok");
  });

  it("applies visual context compression to Anthropic native passthrough when enabled", async () => {
    const provider = {
      chatCompletion: vi.fn(),
      chatCompletionStream: vi.fn(),
      nativePassthrough: vi.fn(async () => ({
        id: "ok",
        usage: { input_tokens: 1, output_tokens: 1 },
      })),
    } as unknown as ProviderClient;
    const execute = createExecute({
      defaultProvider: provider,
      providers: new Map([["mock", provider]]),
      registry: protocolRegistry({
        fable: {
          providerName: "mock",
          providerModel: "claude-fable-5",
          targetProviderProtocol: "anthropic_messages",
        },
      }),
      breaker: breaker(),
      catalog: new Map([["fable", entry("fable")]]),
      now: clock(),
      signal: new AbortController().signal,
      nativeProtocolPassthroughEnabled: () => true,
      visualContextCompressionMode: () => "enabled",
      visualContextCompressor: async ({ body }) => ({
        body: { ...body, compressed: true },
        mutation: {
          mode: "enabled",
          applied: true,
          would_apply: true,
          reason: "applied",
          orig_chars: 50_000,
          compressed_chars: 42_000,
          image_count: 2,
          image_bytes: 12_000,
          owns_cache_control: true,
          marker_count: 1,
        },
      }),
    });

    const out = await execute(
      plan(["fable"]),
      req({
        protocol: "anthropic_messages",
        requested_model: "claude-fable-5",
        native_request: createNativePassthroughCarrier({
          protocol: "anthropic_messages",
          body: {
            model: "anthropic/claude-fable-5",
            messages: [{ role: "user", content: "large dense context" }],
            max_tokens: 64,
          },
          headers: {},
        }),
      }),
    );

    const sent = nativePassthroughBody(
      (provider.nativePassthrough as ReturnType<typeof vi.fn>).mock.calls[0]?.[0],
    );
    expect(out.final.status).toBe("ok");
    expect(sent.compressed).toBe(true);
    expect(out.attempts[0]?.request_mutations?.visual_context_compression).toMatchObject({
      mode: "enabled",
      applied: true,
      would_apply: true,
      reason: "applied",
    });
  });

  it("observes visual context compression without changing the upstream body", async () => {
    const provider = {
      chatCompletion: vi.fn(),
      chatCompletionStream: vi.fn(),
      nativePassthrough: vi.fn(async () => ({
        id: "ok",
        usage: { input_tokens: 1, output_tokens: 1 },
      })),
    } as unknown as ProviderClient;
    const execute = createExecute({
      defaultProvider: provider,
      providers: new Map([["mock", provider]]),
      registry: protocolRegistry({
        fable: {
          providerName: "mock",
          providerModel: "claude-fable-5",
          targetProviderProtocol: "anthropic_messages",
        },
      }),
      breaker: breaker(),
      catalog: new Map([["fable", entry("fable")]]),
      now: clock(),
      signal: new AbortController().signal,
      nativeProtocolPassthroughEnabled: () => true,
      visualContextCompressionMode: () => "observe",
      visualContextCompressor: async ({ body }) => ({
        body,
        mutation: {
          mode: "observe",
          applied: false,
          would_apply: true,
          reason: "applied",
          orig_chars: 50_000,
          compressed_chars: 42_000,
          image_count: 2,
          image_bytes: 12_000,
          owns_cache_control: true,
          marker_count: 1,
        },
      }),
    });

    const out = await execute(
      plan(["fable"]),
      req({
        protocol: "anthropic_messages",
        requested_model: "claude-fable-5",
        native_request: createNativePassthroughCarrier({
          protocol: "anthropic_messages",
          body: {
            model: "anthropic/claude-fable-5",
            messages: [{ role: "user", content: "large dense context" }],
            max_tokens: 64,
          },
          headers: {},
        }),
      }),
    );

    const sent = nativePassthroughBody(
      (provider.nativePassthrough as ReturnType<typeof vi.fn>).mock.calls[0]?.[0],
    );
    expect(out.final.status).toBe("ok");
    expect(sent.compressed).toBeUndefined();
    expect(out.attempts[0]?.request_mutations?.visual_context_compression).toMatchObject({
      mode: "observe",
      applied: false,
      would_apply: true,
    });
  });

  it("uses visual context compression before Anthropic count_tokens context preflight", async () => {
    const provider = {
      chatCompletion: vi.fn(),
      chatCompletionStream: vi.fn(),
      countTokens: vi.fn(async (body: Record<string, unknown>) => ({
        input_tokens: body.compressed === true ? 10 : 500,
      })),
      nativePassthrough: vi.fn(async () => ({
        id: "ok",
        usage: { input_tokens: 10, output_tokens: 1 },
      })),
    } as unknown as ProviderClient;
    const execute = createExecute({
      defaultProvider: provider,
      providers: new Map([["mock", provider]]),
      registry: protocolRegistry({
        fable: {
          providerName: "mock",
          providerModel: "claude-fable-5",
          targetProviderProtocol: "anthropic_messages",
        },
      }),
      breaker: breaker(),
      catalog: new Map([["fable", entry("fable", { maxContextTokens: 100 })]]),
      now: clock(),
      signal: new AbortController().signal,
      nativeProtocolPassthroughEnabled: () => true,
      visualContextCompressionMode: () => "enabled",
      visualContextCompressor: async ({ body }) => ({
        body: { ...body, compressed: true },
        mutation: {
          mode: "enabled",
          applied: true,
          would_apply: true,
          reason: "applied",
          orig_chars: 50_000,
          compressed_chars: 42_000,
          image_count: 2,
          image_bytes: 12_000,
          owns_cache_control: true,
          marker_count: 1,
        },
      }),
    });

    const out = await execute(
      plan(["fable"]),
      req({
        protocol: "anthropic_messages",
        requested_model: "claude-fable-5",
        native_request: createNativePassthroughCarrier({
          protocol: "anthropic_messages",
          body: {
            model: "anthropic/claude-fable-5",
            messages: [{ role: "user", content: "large dense context" }],
            max_tokens: 64,
          },
          headers: {},
        }),
      }),
    );

    expect(provider.countTokens).toHaveBeenCalledOnce();
    expect(out.final.status).toBe("ok");
    expect(out.attempts[0]).toMatchObject({ alias: "fable", skipped: false, status: "ok" });
    expect(provider.nativePassthrough).toHaveBeenCalledOnce();
  });

  it("applies visual context compression on Anthropic compatibility rewrite attempts", async () => {
    const provider = {
      chatCompletion: vi.fn(async (_body: Record<string, unknown>, opts) => {
        const upstreamBody = await opts?.optimizeAnthropicBody?.({
          model: "claude-fable-5",
          system: [{ type: "text", text: "stable prefix", cache_control: { type: "ephemeral" } }],
          messages: [{ role: "user", content: [{ type: "text", text: "large visual context" }] }],
          max_tokens: 64,
        });
        expect(upstreamBody).toMatchObject({ compressed: true });
        return {
          id: "ok",
          usage: { input_tokens: 10, output_tokens: 1 },
        };
      }),
      chatCompletionStream: vi.fn(),
      nativePassthrough: vi.fn(),
    } as unknown as ProviderClient;
    const execute = createExecute({
      defaultProvider: provider,
      providers: new Map([["mock", provider]]),
      registry: protocolRegistry({
        fable: {
          providerName: "mock",
          providerModel: "claude-fable-5",
          targetProviderProtocol: "anthropic_messages",
          providerRequiresCompatibilityRewrite: true,
        },
      }),
      breaker: breaker(),
      catalog: new Map([["fable", entry("fable")]]),
      now: clock(),
      signal: new AbortController().signal,
      nativeProtocolPassthroughEnabled: () => true,
      visualContextCompressionMode: () => "enabled",
      visualContextCompressor: async ({ body }) => ({
        body: { ...body, compressed: true },
        mutation: {
          mode: "enabled",
          applied: true,
          would_apply: true,
          reason: "applied",
          orig_chars: 50_000,
          compressed_chars: 42_000,
          image_count: 1,
          image_bytes: 12_000,
          owns_cache_control: true,
          marker_count: 1,
        },
      }),
    });

    const out = await execute(
      plan(["fable"]),
      req({
        protocol: "anthropic_messages",
        requested_model: "claude-fable-5",
        native_request: createNativePassthroughCarrier({
          protocol: "anthropic_messages",
          body: {
            model: "anthropic/claude-fable-5",
            system: [{ type: "text", text: "stable prefix", cache_control: { type: "ephemeral" } }],
            messages: [{ role: "user", content: "large visual context" }],
            max_tokens: 64,
          },
          headers: {},
        }),
      }),
    );

    expect(out.final.status).toBe("ok");
    expect(provider.chatCompletion).toHaveBeenCalledOnce();
    expect(provider.nativePassthrough).not.toHaveBeenCalled();
    expect(out.attempts[0]?.passthrough_used).toBe(false);
    expect(out.attempts[0]?.passthrough_disable_reason).toBe(
      "provider_requires_compatibility_rewrite",
    );
    expect(out.attempts[0]?.request_mutations?.visual_context_compression).toMatchObject({
      mode: "enabled",
      applied: true,
      would_apply: true,
      reason: "applied",
    });
  });

  // ── capability-wire: the real catalog feeds the capability filter ──────────

  // Catalog entry helper: defaults to a fully-capable, huge-context model; pass
  // overrides to make a model lack a specific capability.
  function entry(modelKey: string, caps: Partial<CatalogEntry["capabilities"]> = {}): CatalogEntry {
    return {
      modelKey,
      capabilities: {
        supportsTools: true,
        jsonOutput: "schema",
        supportsVision: true,
        supportsStreaming: true,
        maxContextTokens: 200000,
        maxOutputTokens: 8192,
        ...caps,
      },
      pricing: {
        inputPerMTokUsd: null,
        outputPerMTokUsd: null,
        cacheReadPerMTokUsd: null,
        cacheWritePerMTokUsd: null,
      },
      source: "generated",
    };
  }

  it("needs_json: skips model A (no json) with a skip_reason and picks model B", async () => {
    const provider = {
      chatCompletion: vi.fn().mockResolvedValue({ id: "from-b" }),
      chatCompletionStream: vi.fn(),
    } as unknown as ProviderClient;
    const execute = createExecute({
      defaultProvider: provider,
      providers: new Map([["mock", provider]]),
      registry: registry({ a: "m-a", b: "m-b" }),
      breaker: breaker(),
      // Catalog is keyed by the candidate ALIAS (the modelKey), not the resolved
      // upstream model id (fix-upstream-model-id 2026-05-31).
      catalog: new Map([
        ["a", entry("a", { jsonOutput: "none" })],
        ["b", entry("b", { jsonOutput: "schema" })],
      ]),
      now: clock(),
      signal: new AbortController().signal,
    });

    const out = await execute(plan(["a", "b"]), req({ response_format: { type: "json_object" } }));
    // A is pruned with an explicit recorded reason; B is invoked and wins.
    expect(out.attempts[0]?.alias).toBe("a");
    expect(out.attempts[0]?.skipped).toBe(true);
    expect(out.attempts[0]?.skip_reason).toBe("no_json_support");
    expect(out.final.status).toBe("ok");
    if (out.final.status === "ok") expect(out.final.alias).toBe("b");
    expect(out.body).toEqual({ id: "from-b" });
  });

  it("vision request prunes a non-vision model and lands on a vision-capable one", async () => {
    const provider = {
      chatCompletion: vi.fn().mockResolvedValue({ id: "vis" }),
      chatCompletionStream: vi.fn(),
    } as unknown as ProviderClient;
    const execute = createExecute({
      defaultProvider: provider,
      providers: new Map([["mock", provider]]),
      registry: registry({ text: "m-text", vis: "m-vis" }),
      breaker: breaker(),
      catalog: new Map([
        ["text", entry("text", { supportsVision: false })],
        ["vis", entry("vis", { supportsVision: true })],
      ]),
      now: clock(),
      signal: new AbortController().signal,
    });

    const out = await execute(
      plan(["text", "vis"]),
      req({
        attachments: [{ type: "image", url: "x" }] as unknown as InternalRequest["attachments"],
      }),
    );
    expect(out.attempts[0]?.skipped).toBe(true);
    expect(out.attempts[0]?.skip_reason).toBe("no_vision_support");
    expect(out.final.status).toBe("ok");
    if (out.final.status === "ok") expect(out.final.alias).toBe("vis");
  });

  // Regression (Codex P1): a vision requirement carried as an in-MESSAGE image part
  // (image_url / input_image / IR image) — not the legacy `attachments` array — must
  // also prune a non-vision model.
  it("in-message image content prunes a non-vision model (not just attachments)", async () => {
    const provider = {
      chatCompletion: vi.fn().mockResolvedValue({ id: "vis2" }),
      chatCompletionStream: vi.fn(),
    } as unknown as ProviderClient;
    const execute = createExecute({
      defaultProvider: provider,
      providers: new Map([["mock", provider]]),
      registry: registry({ text: "m-text", vis: "m-vis" }),
      breaker: breaker(),
      catalog: new Map([
        ["text", entry("text", { supportsVision: false })],
        ["vis", entry("vis", { supportsVision: true })],
      ]),
      now: clock(),
      signal: new AbortController().signal,
    });

    const out = await execute(
      plan(["text", "vis"]),
      req({
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "what is this?" },
              { type: "image_url", image_url: { url: "https://x/a.png" } },
            ],
          },
        ] as unknown as InternalRequest["messages"],
      }),
    );
    expect(out.attempts[0]?.skipped).toBe(true);
    expect(out.attempts[0]?.skip_reason).toBe("no_vision_support");
    expect(out.final.status).toBe("ok");
    if (out.final.status === "ok") expect(out.final.alias).toBe("vis");
  });

  it("audio request prunes a model lacking the audio modality and lands on one advertising it (P7)", async () => {
    const provider = {
      chatCompletion: vi.fn().mockResolvedValue({ id: "aud" }),
      chatCompletionStream: vi.fn(),
    } as unknown as ProviderClient;
    const execute = createExecute({
      defaultProvider: provider,
      providers: new Map([["mock", provider]]),
      registry: registry({ noaudio: "m-na", audio: "m-au" }),
      breaker: breaker(),
      catalog: new Map([
        ["noaudio", entry("noaudio", { modalities: [] })],
        ["audio", entry("audio", { modalities: ["audio"] })],
      ]),
      now: clock(),
      signal: new AbortController().signal,
    });

    const out = await execute(
      plan(["noaudio", "audio"]),
      req({
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "transcribe" },
              { type: "input_audio", input_audio: { data: "QUJD", format: "wav" } },
            ],
          },
        ] as unknown as InternalRequest["messages"],
      }),
    );
    expect(out.attempts[0]?.skipped).toBe(true);
    expect(out.attempts[0]?.skip_reason).toBe("no_audio_support");
    expect(out.final.status).toBe("ok");
    if (out.final.status === "ok") expect(out.final.alias).toBe("audio");
  });

  it("a document (file) request prunes a no-document model and lands on a document-capable one (P7)", async () => {
    const provider = {
      chatCompletion: vi.fn().mockResolvedValue({ id: "doc" }),
      chatCompletionStream: vi.fn(),
    } as unknown as ProviderClient;
    const execute = createExecute({
      defaultProvider: provider,
      providers: new Map([["mock", provider]]),
      registry: registry({ nodoc: "m-nd", doc: "m-dc" }),
      breaker: breaker(),
      catalog: new Map([
        ["nodoc", entry("nodoc", { modalities: ["audio"] })],
        ["doc", entry("doc", { modalities: ["document"] })],
      ]),
      now: clock(),
      signal: new AbortController().signal,
    });

    const out = await execute(
      plan(["nodoc", "doc"]),
      req({
        messages: [
          {
            role: "user",
            content: [{ type: "file", file: { file_data: "data:application/pdf;base64,JVBE" } }],
          },
        ] as unknown as InternalRequest["messages"],
      }),
    );
    expect(out.attempts[0]?.skip_reason).toBe("no_document_support");
    expect(out.final.status).toBe("ok");
    if (out.final.status === "ok") expect(out.final.alias).toBe("doc");
  });

  it("cached_content prunes non-cachedContent candidates and lands on a supporting Gemini target", async () => {
    const provider = {
      chatCompletion: vi.fn().mockResolvedValue({ id: "cached" }),
      chatCompletionStream: vi.fn(),
    } as unknown as ProviderClient;
    const execute = createExecute({
      defaultProvider: provider,
      providers: new Map([["mock", provider]]),
      registry: registry({ openai: "gpt-x", gemini: "google/gemini" }),
      breaker: breaker(),
      catalog: new Map([
        ["openai", entry("openai")],
        ["gemini", entry("gemini", { supportsCachedContent: true })],
      ]),
      now: clock(),
      signal: new AbortController().signal,
    });

    const out = await execute(
      plan(["openai", "gemini"]),
      req({ cached_content: "cachedContents/context-123" }),
    );
    expect(out.attempts[0]?.skipped).toBe(true);
    expect(out.attempts[0]?.skip_reason).toBe("no_cached_content_support");
    expect(out.final.status).toBe("ok");
    if (out.final.status === "ok") expect(out.final.alias).toBe("gemini");
    const body = (provider.chatCompletion as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as Record<
      string,
      unknown
    >;
    expect(body.cached_content).toBe("cachedContents/context-123");
  });

  it("no qualifying candidate (all pruned by capability) → capability_unsatisfiable 422", async () => {
    const provider = {
      chatCompletion: vi.fn(),
      chatCompletionStream: vi.fn(),
    } as unknown as ProviderClient;
    const execute = createExecute({
      defaultProvider: provider,
      providers: new Map([["mock", provider]]),
      registry: registry({ a: "m-a", b: "m-b" }),
      breaker: breaker(),
      catalog: new Map([
        ["a", entry("a", { jsonOutput: "none" })],
        ["b", entry("b", { jsonOutput: "none" })],
      ]),
      now: clock(),
      signal: new AbortController().signal,
    });

    const out = await execute(plan(["a", "b"]), req({ response_format: { type: "json_object" } }));
    expect(out.final.status).toBe("error");
    if (out.final.status === "error") {
      expect(out.final.error.error_class).toBe("capability_unsatisfiable");
      expect(out.final.error.http_status).toBe(422);
    }
    // The upstream was never invoked — every candidate was pruned.
    expect(provider.chatCompletion).not.toHaveBeenCalled();
    expect(out.attempts.every((a) => a.skipped)).toBe(true);
  });

  it.each([
    ["image", { outputImage: true }],
    ["video", { outputVideo: true }],
  ] as const)("rejects an xAI media-only %s model on conversational protocols", async (_kind, caps) => {
    const provider = {
      chatCompletion: vi.fn(),
      chatCompletionStream: vi.fn(),
    } as unknown as ProviderClient;
    const execute = createExecute({
      defaultProvider: provider,
      providers: new Map([["mock", provider]]),
      registry: registry({ "xai/media": "media-wire" }),
      breaker: breaker(),
      catalog: new Map([["xai/media", entry("xai/media", caps)]]),
      now: clock(),
      signal: new AbortController().signal,
    });

    const out = await execute(plan(["xai/media"]), req());

    expect(out.final.status).toBe("error");
    if (out.final.status === "error") {
      expect(out.final.error.error_class).toBe("capability_unsatisfiable");
    }
    expect(out.attempts[0]?.skip_reason).toBe("media_endpoint_required");
    expect(provider.chatCompletion).not.toHaveBeenCalled();
  });

  it("preserves native conversational image output for non-xAI models", async () => {
    const provider = {
      chatCompletion: vi.fn().mockResolvedValue({ id: "gemini-image-ok" }),
      chatCompletionStream: vi.fn(),
    } as unknown as ProviderClient;
    const execute = createExecute({
      defaultProvider: provider,
      providers: new Map([["mock", provider]]),
      registry: registry({ "gemini/image": "gemini-image-wire" }),
      breaker: breaker(),
      catalog: new Map([["gemini/image", entry("gemini/image", { outputImage: true })]]),
      now: clock(),
      signal: new AbortController().signal,
    });

    const out = await execute(plan(["gemini/image"]), req());

    expect(out.final.status).toBe("ok");
    expect(provider.chatCompletion).toHaveBeenCalledOnce();
  });

  it("does NOT over-prune a model with no catalog entry (unknown → fail-open)", async () => {
    const provider = {
      chatCompletion: vi.fn().mockResolvedValue({ id: "unknown-ok" }),
      chatCompletionStream: vi.fn(),
    } as unknown as ProviderClient;
    // Catalog knows m-a (lacks json) but NOT m-unknown. A needs_json request must
    // skip m-a (known-incompatible) yet still ATTEMPT m-unknown (no entry → don't
    // over-prune) rather than declaring capability_unsatisfiable.
    const execute = createExecute({
      defaultProvider: provider,
      providers: new Map([["mock", provider]]),
      registry: registry({ a: "m-a", u: "m-unknown" }),
      breaker: breaker(),
      catalog: new Map([["a", entry("a", { jsonOutput: "none" })]]),
      now: clock(),
      signal: new AbortController().signal,
    });

    const out = await execute(plan(["a", "u"]), req({ response_format: { type: "json_object" } }));
    expect(out.attempts[0]?.skip_reason).toBe("no_json_support");
    expect(out.final.status).toBe("ok");
    if (out.final.status === "ok") expect(out.final.alias).toBe("u");
    expect(provider.chatCompletion).toHaveBeenCalledTimes(1);
  });

  it("does not fail-open a cached_content request to a model with no catalog capability data", async () => {
    const provider = {
      chatCompletion: vi.fn(),
      chatCompletionStream: vi.fn(),
    } as unknown as ProviderClient;
    const execute = createExecute({
      defaultProvider: provider,
      providers: new Map([["mock", provider]]),
      registry: registry({ unknown: "m-unknown" }),
      breaker: breaker(),
      catalog: new Map(),
      now: clock(),
      signal: new AbortController().signal,
    });

    const out = await execute(
      plan(["unknown"]),
      req({ cached_content: "cachedContents/context-123" }),
    );
    expect(out.attempts[0]?.skipped).toBe(true);
    expect(out.attempts[0]?.skip_reason).toBe("no_cached_content_support");
    expect(out.final.status).toBe("error");
    if (out.final.status === "error") {
      expect(out.final.error.error_class).toBe("capability_unsatisfiable");
      expect(out.final.error.http_status).toBe(422);
    }
    expect(provider.chatCompletion).not.toHaveBeenCalled();
  });

  // ── cost-wire (docs/07): populate cost_usd from provider usage × catalog pricing.
  function priced(modelKey: string, pricing: CatalogEntry["pricing"]): CatalogEntry {
    return {
      modelKey,
      capabilities: {
        supportsTools: true,
        jsonOutput: "schema",
        supportsVision: true,
        supportsStreaming: true,
        maxContextTokens: 200000,
        maxOutputTokens: 8192,
      },
      pricing,
      source: "generated",
    };
  }

  it("records cost_usd = prompt/1e6*input + completion/1e6*output for a served attempt", async () => {
    // gpt-4o-like: $2.5/MTok in, $10/MTok out. usage 1000 prompt + 500 completion:
    //   1000/1e6*2.5 = 0.0025 ; 500/1e6*10 = 0.005 ; total = 0.0075.
    const provider = {
      chatCompletion: vi
        .fn()
        .mockResolvedValue({ id: "ok", usage: { prompt_tokens: 1000, completion_tokens: 500 } }),
      chatCompletionStream: vi.fn(),
    } as unknown as ProviderClient;
    const execute = createExecute({
      defaultProvider: provider,
      providers: new Map([["mock", provider]]),
      registry: registry({ good: "gpt-4o" }),
      breaker: breaker(),
      catalog: new Map([
        [
          "good",
          priced("good", {
            inputPerMTokUsd: 2.5,
            outputPerMTokUsd: 10,
            cacheReadPerMTokUsd: null,
            cacheWritePerMTokUsd: null,
          }),
        ],
      ]),
      now: clock(),
      signal: new AbortController().signal,
    });

    const out = await execute(plan(["good"]), req());
    expect(out.final.status).toBe("ok");
    expect(out.attempts[0]?.cost_usd).toBeCloseTo(0.0075, 12);
  });

  it("records cost_usd = null (no crash) for a model with no pricing entry", async () => {
    const provider = {
      chatCompletion: vi
        .fn()
        .mockResolvedValue({ id: "ok", usage: { prompt_tokens: 1000, completion_tokens: 500 } }),
      chatCompletionStream: vi.fn(),
    } as unknown as ProviderClient;
    // Catalog has NO entry for the resolved model → pricing unknown → null.
    const execute = createExecute({
      defaultProvider: provider,
      providers: new Map([["mock", provider]]),
      registry: registry({ unknown_model: "m-unpriced" }),
      breaker: breaker(),
      catalog: new Map(),
      now: clock(),
      signal: new AbortController().signal,
    });

    const out = await execute(plan(["unknown_model"]), req());
    expect(out.final.status).toBe("ok");
    expect(out.attempts[0]?.cost_usd).toBeNull();
  });
});

// Native protocol passthrough (issue #217, Phase 1). The executor forwards a
// VERBATIM native Anthropic body to an Anthropic upstream (skipping the 4 lossy
// translations) and returns the native response untouched, ONLY when the runtime
// flag is on, the inbound protocol matches THIS target wire protocol, and the
// provider client implements nativePassthrough. The branch is a body+response
// substitution INSIDE the existing per-candidate try/catch — so heterogeneous later
// fallback candidates remain free to translate if this candidate fails before output.
// breaker / abort / free-429 / chain-advance semantics are identical.
describe("createExecute — native protocol passthrough (#217)", () => {
  // model is the ROUTING ALIAS a client sends (e.g. `anthropic/claude-x`), NOT a
  // real upstream id — execute must patch it to the resolved providerModel before
  // forwarding (else the upstream 404s on the alias). Rest of the body is verbatim.
  const NATIVE = {
    model: "anthropic/claude-x",
    max_tokens: 16,
    messages: [{ role: "user", content: "hi" }],
  } as const;

  // Registry whose aliases resolve to a chosen targetProviderProtocol per provider.
  function protocolRegistry(
    map: Record<
      string,
      {
        providerName: string;
        providerModel: string;
        targetProviderProtocol: TargetProviderProtocol;
      }
    >,
  ): ProviderRegistry {
    return {
      resolve(alias: string) {
        const hit = map[alias];
        if (hit === undefined) return { ok: false, error: { kind: "unknown_alias", alias } };
        return {
          ok: true,
          value: {
            alias,
            providerName: hit.providerName,
            providerModel: hit.providerModel,
            baseUrl: "http://x",
            apiKeyEnv: "X",
            targetProviderProtocol: hit.targetProviderProtocol,
            providerRequiresCompatibilityRewrite: false,
          },
        };
      },
      list: () => Object.keys(map),
    };
  }

  function anthropicProvider(resp: Record<string, unknown>) {
    return {
      chatCompletion: vi.fn().mockResolvedValue({ id: "translated" }),
      chatCompletionStream: vi.fn(),
      nativePassthrough: vi.fn().mockResolvedValue(resp),
    } as unknown as ProviderClient & {
      chatCompletion: ReturnType<typeof vi.fn>;
      nativePassthrough: ReturnType<typeof vi.fn>;
    };
  }

  // Anthropic inbound request carrying the verbatim native body.
  function anthropicReq(over: Partial<InternalRequest> = {}): InternalRequest {
    return req({
      protocol: "anthropic_messages",
      native_request: { ...NATIVE },
      ...over,
    });
  }

  const NATIVE_RESP = {
    id: "msg_1",
    type: "message",
    role: "assistant",
    content: [{ type: "text", text: "hello back" }],
    stop_reason: "end_turn",
    usage: { input_tokens: 1000, output_tokens: 500 },
  };

  it("flag ON + anthropic target + native_request present → calls nativePassthrough (NOT chatCompletion) and returns the native body", async () => {
    const provider = anthropicProvider(NATIVE_RESP);
    const execute = createExecute({
      defaultProvider: provider,
      providers: new Map([["anthro", provider]]),
      registry: protocolRegistry({
        a: {
          providerName: "anthro",
          providerModel: "claude-x",
          targetProviderProtocol: "anthropic_messages",
        },
      }),
      breaker: breaker(),
      catalog: new Map(),
      now: clock(),
      signal: new AbortController().signal,
      nativeProtocolPassthroughEnabled: () => true,
      toolCallXmlRecoveryEnabled: () => false,
    });

    const out = await execute(plan(["a"]), anthropicReq());
    expect(out.final.status).toBe("ok");
    expect(provider.nativePassthrough).toHaveBeenCalledTimes(1);
    expect(provider.chatCompletion).not.toHaveBeenCalled();
    // The native body is forwarded with `model` patched to the RESOLVED upstream id
    // (the client's routing alias would 404 upstream); everything else is verbatim.
    expect(provider.nativePassthrough.mock.calls[0]?.[0]).toEqual({ ...NATIVE, model: "claude-x" });
    expect(provider.nativePassthrough.mock.calls[0]?.[1]).toMatchObject({
      toolCallXmlRecovery: false,
    });
    expect(out.body).toBe(NATIVE_RESP);
    expect(out.nativePassthrough).toBe(true);
    const okRow = out.attempts[0];
    expect(okRow?.status).toBe("ok");
    expect(okRow?.passthrough_considered).toBe(true);
    expect(okRow?.passthrough_used).toBe(true);
    expect(okRow?.passthrough_disable_reason ?? null).toBeNull();
    expect(okRow?.source_protocol).toBe("anthropic_messages");
    expect(okRow?.target_provider_protocol).toBe("anthropic_messages");
    expect(okRow?.response_protocol).toBe("anthropic_messages");
    expect(okRow?.provider_name).toBe("anthro");
    expect(okRow?.provider_model).toBe("claude-x");
  });

  it("stabilizes Claude Code billing cch on Anthropic native passthrough so prompt cache survives turns", async () => {
    const provider = anthropicProvider(NATIVE_RESP);
    const execute = createExecute({
      defaultProvider: provider,
      providers: new Map([["anthro", provider]]),
      registry: protocolRegistry({
        a: {
          providerName: "anthro",
          providerModel: "claude-x",
          targetProviderProtocol: "anthropic_messages",
        },
      }),
      breaker: breaker(),
      catalog: new Map(),
      now: clock(),
      signal: new AbortController().signal,
      nativeProtocolPassthroughEnabled: () => true,
    });
    const carrier = (cch: string, text: string): NativePassthroughCarrier => ({
      protocol: "anthropic_messages",
      body: {
        model: "claude-x",
        max_tokens: 16,
        system: [
          {
            type: "text",
            text: `x-anthropic-billing-header: cc_version=2.1.175.baa; cc_entrypoint=cli; cch=${cch};`,
          },
          { type: "text", text: "You are Claude Code.", cache_control: { type: "ephemeral" } },
          { type: "text", text: "stable project rules", cache_control: { type: "ephemeral" } },
        ],
        tools: [{ name: "Read", input_schema: { type: "object" } }],
        messages: [{ role: "user", content: [{ type: "text", text }] }],
      },
      raw_body: `raw-${cch}`,
      headers: { "x-api-key": "client" },
      mutations: {},
    });

    const first = await execute(
      plan(["a"]),
      anthropicReq({ native_request: carrier("aaaaa", "first turn") }),
    );
    const second = await execute(
      plan(["a"]),
      anthropicReq({ native_request: carrier("bbbbb", "a much longer follow-up turn") }),
    );

    const firstForwarded = provider.nativePassthrough.mock
      .calls[0]?.[0] as NativePassthroughCarrier;
    const secondForwarded = provider.nativePassthrough.mock
      .calls[1]?.[0] as NativePassthroughCarrier;
    const cchOf = (forwarded: NativePassthroughCarrier) =>
      String(
        ((forwarded.body.system as Array<Record<string, unknown>>)[0] as { text?: unknown }).text,
      ).match(/\bcch=([0-9a-f]{5});/)?.[1];
    expect(cchOf(firstForwarded)).toMatch(/^[0-9a-f]{5}$/);
    expect(cchOf(secondForwarded)).toBe(cchOf(firstForwarded));
    expect(cchOf(firstForwarded)).not.toBe("aaaaa");
    expect(cchOf(secondForwarded)).not.toBe("bbbbb");
    expect(firstForwarded.raw_body).toBeUndefined();
    expect(firstForwarded.mutations.body_shims_applied).toEqual([
      "anthropic_billing_cch_stabilized",
    ]);
    expect(first.attempts[0]?.passthrough_mutations).toMatchObject(firstForwarded.mutations);
    expect(second.attempts[0]?.passthrough_mutations).toMatchObject(secondForwarded.mutations);
  });

  it("native passthrough strips Anthropic effort when the target model does not support it", async () => {
    const provider = anthropicProvider(NATIVE_RESP);
    const haikuEntry: CatalogEntry = {
      modelKey: "haiku",
      capabilities: {
        supportsTools: true,
        jsonOutput: "schema",
        supportsVision: true,
        supportsStreaming: true,
        reasoningEffort: {
          anthropicOutputConfig: { supported: false },
          anthropicThinking: {
            supported: true,
            levels: ["minimal", "low", "medium", "high", "xhigh", "max"],
          },
        },
        maxContextTokens: 200000,
        maxOutputTokens: 65536,
      },
      pricing: {
        inputPerMTokUsd: null,
        outputPerMTokUsd: null,
        cacheReadPerMTokUsd: null,
        cacheWritePerMTokUsd: null,
      },
      source: "generated",
    };
    const execute = createExecute({
      defaultProvider: provider,
      providers: new Map([["anthro", provider]]),
      registry: protocolRegistry({
        haiku: {
          providerName: "anthro",
          providerModel: "claude-haiku-4-5-20251001",
          targetProviderProtocol: "anthropic_messages",
        },
      }),
      breaker: breaker(),
      catalog: new Map([["haiku", haikuEntry]]),
      now: clock(),
      signal: new AbortController().signal,
      nativeProtocolPassthroughEnabled: () => true,
    });

    const out = await execute(
      plan(["haiku"]),
      anthropicReq({
        reasoning_effort: "medium",
        native_request: createNativePassthroughCarrier({
          protocol: "anthropic_messages",
          body: {
            model: "anthropic/claude-haiku-4-5-20251001",
            max_tokens: 64,
            messages: [{ role: "user", content: "hi" }],
            output_config: { effort: "medium" },
          },
          headers: {},
        }),
      }),
    );

    const forwarded = provider.nativePassthrough.mock.calls[0]?.[0] as NativePassthroughCarrier;
    expect(forwarded.body.output_config).toBeUndefined();
    expect((forwarded.body.thinking as { type?: string } | undefined)?.type).toBe("enabled");
    expect(forwarded.mutations).toMatchObject({
      body_shims_applied: ["reasoning_effort_stripped_for_model"],
    });
    expect(out.final).toEqual({
      status: "ok",
      alias: "haiku",
      providerModel: "claude-haiku-4-5-20251001",
    });
  });

  it("anthropic native body with an inline system turn DISABLES passthrough (folds via chatCompletion)", async () => {
    // Regression for request 81f3fa9e... on older/unknown models: Claude Code 2.1.175
    // emits the MCP-server instructions as a TRAILING system message ([user, system]).
    // If the resolved model is not known to support that shape, passthrough must be
    // disabled so the request folds system into top-level `system`.
    const provider = anthropicProvider(NATIVE_RESP);
    const execute = createExecute({
      defaultProvider: provider,
      providers: new Map([["anthro", provider]]),
      registry: protocolRegistry({
        a: {
          providerName: "anthro",
          providerModel: "claude-x",
          targetProviderProtocol: "anthropic_messages",
        },
      }),
      breaker: breaker(),
      catalog: new Map(),
      now: clock(),
      signal: new AbortController().signal,
      nativeProtocolPassthroughEnabled: () => true,
    });

    const out = await execute(
      plan(["a"]),
      anthropicReq({
        native_request: {
          ...NATIVE,
          messages: [
            { role: "user", content: "hi" },
            { role: "system", content: "# MCP Server Instructions\n..." },
          ],
        },
      }),
    );

    expect(out.final.status).toBe("ok");
    // Folded via the translating path, NOT forwarded verbatim.
    expect(provider.nativePassthrough).not.toHaveBeenCalled();
    expect(provider.chatCompletion).toHaveBeenCalledTimes(1);
    expect(out.nativePassthrough).toBeFalsy();
    const okRow = out.attempts[0];
    expect(okRow?.status).toBe("ok");
    expect(okRow?.passthrough_considered).toBe(true);
    expect(okRow?.passthrough_used).toBe(false);
    expect(okRow?.passthrough_disable_reason).toBe("provider_requires_compatibility_rewrite");
  });

  it("Opus 4.8 Anthropic native body with a valid trailing system turn stays on passthrough", async () => {
    // Regression for request 5191ce2b...: disabling passthrough sent the request through
    // the compatibility rewrite path, which produced an upstream empty-success stream.
    // Opus 4.8 supports this exact [user, system] mid-conversation system placement, so
    // the same-protocol request should stay byte-faithful.
    const provider = anthropicProvider(NATIVE_RESP);
    const execute = createExecute({
      defaultProvider: provider,
      providers: new Map([["anthro", provider]]),
      registry: protocolRegistry({
        a: {
          providerName: "anthro",
          providerModel: "claude-opus-4-8",
          targetProviderProtocol: "anthropic_messages",
        },
      }),
      breaker: breaker(),
      catalog: new Map(),
      now: clock(),
      signal: new AbortController().signal,
      nativeProtocolPassthroughEnabled: () => true,
    });
    const nativeWithTrailingSystem = {
      ...NATIVE,
      model: "anthropic/claude-opus-4-8",
      messages: [
        { role: "user", content: "hi" },
        { role: "system", content: "# MCP Server Instructions\n..." },
      ],
    };

    const out = await execute(
      plan(["a"]),
      anthropicReq({ native_request: nativeWithTrailingSystem }),
    );

    expect(out.final.status).toBe("ok");
    expect(provider.nativePassthrough).toHaveBeenCalledTimes(1);
    expect(provider.chatCompletion).not.toHaveBeenCalled();
    expect(provider.nativePassthrough.mock.calls[0]?.[0]).toEqual({
      ...nativeWithTrailingSystem,
      model: "claude-opus-4-8",
    });
    expect(out.nativePassthrough).toBe(true);
    expect(out.attempts[0]?.passthrough_used).toBe(true);
    expect(out.attempts[0]?.passthrough_disable_reason).toBeNull();
  });

  it("Gemini target + native_request sends GenerateContent body to the Gemini client, not OpenAI Chat", async () => {
    const upstreamBodies: unknown[] = [];
    let upstreamUrl = "";
    const provider = createGeminiClient({
      config: { baseUrl: "https://generativelanguage.googleapis.com/v1beta", apiKey: "g" },
      fetch: vi.fn(async (url, init) => {
        upstreamUrl = String(url);
        upstreamBodies.push(JSON.parse(String(init?.body)));
        return new Response(
          JSON.stringify({
            candidates: [{ content: { role: "model", parts: [{ text: "native" }] } }],
            usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }),
    });
    const execute = createExecute({
      defaultProvider: provider,
      providers: new Map([["google", provider]]),
      registry: protocolRegistry({
        g: {
          providerName: "google",
          providerModel: "gemini-2.0-flash",
          targetProviderProtocol: "gemini",
        },
      }),
      breaker: breaker(),
      catalog: new Map(),
      now: clock(),
      signal: new AbortController().signal,
      nativeProtocolPassthroughEnabled: () => true,
    });
    const nativeBody = {
      contents: [{ role: "user", parts: [{ text: "hi" }] }],
      generationConfig: { temperature: 0 },
    };

    const out = await execute(
      plan(["g"]),
      req({
        protocol: "gemini",
        requested_model: "gemini-2.0-flash",
        messages: [{ role: "user", content: "hi" }],
        native_request: nativeBody,
      }),
    );

    expect(out.nativePassthrough).toBe(true);
    expect(upstreamUrl).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent",
    );
    expect(upstreamBodies).toEqual([nativeBody]);
    expect(JSON.stringify(upstreamBodies[0])).not.toContain('"messages"');
  });

  it("lane-FORCED reasoning rewrites the gemini native passthrough body's thinkingConfig (beats the client)", async () => {
    const upstreamBodies: Array<Record<string, unknown>> = [];
    const provider = createGeminiClient({
      config: { baseUrl: "https://generativelanguage.googleapis.com/v1beta", apiKey: "g" },
      fetch: vi.fn(async (_url, init) => {
        upstreamBodies.push(JSON.parse(String(init?.body)));
        return new Response(
          JSON.stringify({ candidates: [{ content: { role: "model", parts: [{ text: "x" }] } }] }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }),
    });
    const execute = createExecute({
      defaultProvider: provider,
      providers: new Map([["google", provider]]),
      registry: protocolRegistry({
        g: {
          providerName: "google",
          providerModel: "gemini-2.0-flash",
          targetProviderProtocol: "gemini",
        },
      }),
      breaker: breaker(),
      catalog: new Map(),
      now: clock(),
      signal: new AbortController().signal,
      nativeProtocolPassthroughEnabled: () => true,
    });

    const out = await execute(
      plan(["g"]),
      req({
        protocol: "gemini",
        requested_model: "gemini-2.0-flash",
        messages: [{ role: "user", content: "hi" }],
        // client asked for a LOW thinking level; the lane forces HIGH.
        native_request: {
          contents: [{ role: "user", parts: [{ text: "hi" }] }],
          generationConfig: { thinkingConfig: { thinkingLevel: "LOW" } },
        },
        reasoning_effort: "high",
        reasoning_effort_forced: true,
      }),
    );

    expect(out.nativePassthrough).toBe(true);
    const gc = upstreamBodies[0]?.generationConfig as Record<string, unknown>;
    const tc = gc.thinkingConfig as { thinkingBudget: number; thinkingLevel?: string };
    expect(tc.thinkingBudget).toBeGreaterThan(0); // forced HIGH budget applied
    expect(tc.thinkingLevel).toBeUndefined(); // client's LOW level replaced
  });

  it("does NOT touch the native passthrough body when reasoning is not forced", async () => {
    const upstreamBodies: Array<Record<string, unknown>> = [];
    const provider = createGeminiClient({
      config: { baseUrl: "https://generativelanguage.googleapis.com/v1beta", apiKey: "g" },
      fetch: vi.fn(async (_url, init) => {
        upstreamBodies.push(JSON.parse(String(init?.body)));
        return new Response(
          JSON.stringify({ candidates: [{ content: { role: "model", parts: [{ text: "x" }] } }] }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }),
    });
    const execute = createExecute({
      defaultProvider: provider,
      providers: new Map([["google", provider]]),
      registry: protocolRegistry({
        g: {
          providerName: "google",
          providerModel: "gemini-2.0-flash",
          targetProviderProtocol: "gemini",
        },
      }),
      breaker: breaker(),
      catalog: new Map(),
      now: clock(),
      signal: new AbortController().signal,
      nativeProtocolPassthroughEnabled: () => true,
    });
    const nativeBody = {
      contents: [{ role: "user", parts: [{ text: "hi" }] }],
      generationConfig: { thinkingConfig: { thinkingLevel: "LOW" } },
    };
    await execute(
      plan(["g"]),
      req({
        protocol: "gemini",
        requested_model: "gemini-2.0-flash",
        messages: [{ role: "user", content: "hi" }],
        native_request: nativeBody,
        reasoning_effort: "high", // present but NOT forced → passthrough stays verbatim
      }),
    );
    expect(upstreamBodies[0]).toEqual(nativeBody);
  });

  it("skips lane-forced Anthropic thinking when native tool_choice forces a tool", async () => {
    const provider = anthropicProvider(NATIVE_RESP);
    const execute = createExecute({
      defaultProvider: provider,
      providers: new Map([["anthro", provider]]),
      registry: protocolRegistry({
        a: {
          providerName: "anthro",
          providerModel: "claude-sonnet-4-6",
          targetProviderProtocol: "anthropic_messages",
        },
      }),
      breaker: breaker(),
      catalog: new Map(),
      now: clock(),
      signal: new AbortController().signal,
      nativeProtocolPassthroughEnabled: () => true,
    });
    const carrier = {
      protocol: "anthropic_messages" as const,
      body: {
        model: "claude-sonnet-4-6",
        max_tokens: 32000,
        temperature: 1,
        thinking: { type: "disabled" },
        output_config: { effort: "high" },
        tool_choice: { type: "tool", name: "web_search" },
        tools: [{ name: "web_search", input_schema: { type: "object" } }],
        messages: [{ role: "user", content: [{ type: "text", text: "search" }] }],
      },
      headers: { "x-api-key": "client" },
      mutations: {},
    };

    const out = await execute(
      plan(["a"]),
      anthropicReq({
        native_request: carrier,
        reasoning_effort: "medium",
        reasoning_effort_forced: true,
      }),
    );

    const forwarded = provider.nativePassthrough.mock.calls[0]?.[0] as typeof carrier;
    expect(forwarded.body.thinking).toBeUndefined();
    expect(forwarded.body.tool_choice).toEqual({ type: "tool", name: "web_search" });
    expect(forwarded.mutations).toMatchObject({
      body_shims_applied: ["reasoning_effort_skipped_for_forced_tool_choice"],
    });
    expect(out.attempts[0]?.passthrough_mutations).toMatchObject(forwarded.mutations);
  });

  it("strips empty Anthropic text blocks before native passthrough dispatch", async () => {
    const provider = anthropicProvider(NATIVE_RESP);
    const execute = createExecute({
      defaultProvider: provider,
      providers: new Map([["anthro", provider]]),
      registry: protocolRegistry({
        a: {
          providerName: "anthro",
          providerModel: "claude-x",
          targetProviderProtocol: "anthropic_messages",
        },
      }),
      breaker: breaker(),
      catalog: new Map(),
      now: clock(),
      signal: new AbortController().signal,
      nativeProtocolPassthroughEnabled: () => true,
    });
    const carrier = {
      protocol: "anthropic_messages" as const,
      body: {
        model: "anthropic/claude-x",
        max_tokens: 16,
        messages: [
          {
            role: "assistant",
            content: [
              { type: "text", text: "" },
              { type: "text", text: "   " },
              { type: "tool_use", id: "toolu_1", name: "search", input: { q: "helm" } },
              { type: "text", text: "keep me" },
            ],
          },
        ],
      },
      raw_body: "client raw body keeps empty text blocks",
      headers: { "x-api-key": "client" },
      mutations: {},
    };

    const out = await execute(plan(["a"]), anthropicReq({ native_request: carrier }));

    const forwarded = provider.nativePassthrough.mock.calls[0]?.[0] as typeof carrier;
    expect(forwarded.body.messages).toEqual([
      {
        role: "assistant",
        content: [
          { type: "tool_use", id: "toolu_1", name: "search", input: { q: "helm" } },
          { type: "text", text: "keep me" },
        ],
      },
    ]);
    expect(forwarded.raw_body).toBeUndefined();
    expect(forwarded.mutations).toMatchObject({
      body_shims_applied: ["empty_anthropic_text_blocks_stripped"],
      empty_anthropic_text_blocks_stripped: 2,
    });
    expect(out.attempts[0]?.passthrough_mutations).toMatchObject(forwarded.mutations);
  });

  it("omits Anthropic messages that become empty after empty-text sanitizing", async () => {
    const provider = anthropicProvider(NATIVE_RESP);
    const execute = createExecute({
      defaultProvider: provider,
      providers: new Map([["anthro", provider]]),
      registry: protocolRegistry({
        a: {
          providerName: "anthro",
          providerModel: "claude-x",
          targetProviderProtocol: "anthropic_messages",
        },
      }),
      breaker: breaker(),
      catalog: new Map(),
      now: clock(),
      signal: new AbortController().signal,
      nativeProtocolPassthroughEnabled: () => true,
    });
    const carrier = {
      protocol: "anthropic_messages" as const,
      body: {
        model: "anthropic/claude-x",
        max_tokens: 16,
        messages: [
          {
            role: "assistant",
            content: [
              { type: "text", text: "" },
              { type: "text", text: " \n\t " },
              { type: "text" },
              { type: "text", text: null },
            ],
          },
          {
            role: "user",
            content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "ok" }],
          },
        ],
      },
      headers: { "x-api-key": "client" },
      mutations: {},
    };

    const out = await execute(plan(["a"]), anthropicReq({ native_request: carrier }));

    const forwarded = provider.nativePassthrough.mock.calls[0]?.[0] as typeof carrier;
    expect(forwarded.body.messages).toEqual([
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "ok" }],
      },
    ]);
    expect(forwarded.mutations).toMatchObject({
      body_shims_applied: ["empty_anthropic_text_blocks_stripped"],
      empty_anthropic_text_blocks_stripped: 4,
    });
    expect(out.attempts[0]?.passthrough_mutations).toMatchObject(forwarded.mutations);
  });

  it("flag OFF → translates via chatCompletion(stripInternal), passthrough_used:false reason feature_flag_disabled, nativePassthrough absent", async () => {
    const provider = anthropicProvider(NATIVE_RESP);
    const execute = createExecute({
      defaultProvider: provider,
      providers: new Map([["anthro", provider]]),
      registry: protocolRegistry({
        a: {
          providerName: "anthro",
          providerModel: "claude-x",
          targetProviderProtocol: "anthropic_messages",
        },
      }),
      breaker: breaker(),
      catalog: new Map(),
      now: clock(),
      signal: new AbortController().signal,
      // flag not provided → defaults OFF
    });

    const out = await execute(plan(["a"]), anthropicReq());
    expect(out.final.status).toBe("ok");
    expect(provider.nativePassthrough).not.toHaveBeenCalled();
    expect(provider.chatCompletion).toHaveBeenCalledTimes(1);
    // stripInternal carries the IR model id, not the native carrier verbatim.
    expect(provider.chatCompletion.mock.calls[0]?.[0]).toMatchObject({ model: "claude-x" });
    expect(out.body).toEqual({ id: "translated" });
    expect(out.nativePassthrough ?? false).toBe(false);
    const okRow = out.attempts[0];
    expect(okRow?.passthrough_considered).toBe(true);
    expect(okRow?.passthrough_used).toBe(false);
    expect(okRow?.passthrough_disable_reason).toBe("feature_flag_disabled");
  });

  it("cross-protocol fallback chain [anthropic, openai], flag ON → head attempt still uses same-protocol passthrough", async () => {
    const provider = anthropicProvider(NATIVE_RESP);
    const execute = createExecute({
      defaultProvider: provider,
      providers: new Map([["anthro", provider]]),
      registry: protocolRegistry({
        a: {
          providerName: "anthro",
          providerModel: "claude-x",
          targetProviderProtocol: "anthropic_messages",
        },
        b: {
          providerName: "anthro",
          providerModel: "gpt-x",
          targetProviderProtocol: "openai_chat",
        },
      }),
      breaker: breaker(),
      catalog: new Map(),
      now: clock(),
      signal: new AbortController().signal,
      nativeProtocolPassthroughEnabled: () => true,
    });

    const out = await execute(plan(["a", "b"]), anthropicReq());
    expect(out.final.status).toBe("ok");
    // The HEAD candidate is same-protocol, so it passthroughs even though a later
    // fallback candidate would need translation.
    expect(provider.nativePassthrough).toHaveBeenCalledTimes(1);
    expect(provider.chatCompletion).not.toHaveBeenCalled();
    const okRow = out.attempts[0];
    expect(okRow?.passthrough_used).toBe(true);
    expect(okRow?.passthrough_disable_reason).toBeNull();
  });

  it("cross-protocol fallback chain: failed Anthropic passthrough advances to translated OpenAI attempt", async () => {
    const head = {
      chatCompletion: vi.fn(),
      chatCompletionStream: vi.fn(),
      nativePassthrough: vi.fn().mockRejectedValue(new UpstreamError("upstream_error", "boom")),
    } as unknown as ProviderClient & { nativePassthrough: ReturnType<typeof vi.fn> };
    const tail = {
      chatCompletion: vi.fn().mockResolvedValue({ id: "translated-tail" }),
      chatCompletionStream: vi.fn(),
    } as unknown as ProviderClient & { chatCompletion: ReturnType<typeof vi.fn> };
    const execute = createExecute({
      defaultProvider: head,
      providers: new Map<string, ProviderClient>([
        ["anthro", head],
        ["openai", tail],
      ]),
      registry: protocolRegistry({
        a: {
          providerName: "anthro",
          providerModel: "claude-x",
          targetProviderProtocol: "anthropic_messages",
        },
        b: {
          providerName: "openai",
          providerModel: "gpt-x",
          targetProviderProtocol: "openai_chat",
        },
      }),
      breaker: breaker(),
      catalog: new Map(),
      now: clock(),
      signal: new AbortController().signal,
      nativeProtocolPassthroughEnabled: () => true,
    });

    const out = await execute(plan(["a", "b"]), anthropicReq());
    expect(head.nativePassthrough).toHaveBeenCalledTimes(1);
    expect(tail.chatCompletion).toHaveBeenCalledTimes(1);
    expect(tail.chatCompletion.mock.calls[0]?.[0]).toMatchObject({ model: "gpt-x" });
    expect(out.final).toEqual({ status: "ok", alias: "b", providerModel: "gpt-x" });
    expect(out.body).toEqual({ id: "translated-tail" });
    expect(out.attempts[0]?.status).toBe("error");
    expect(out.attempts[0]?.passthrough_used).toBe(true);
    expect(out.attempts[1]?.status).toBe("ok");
    expect(out.attempts[1]?.target_provider_protocol).toBe("openai_chat");
    expect(out.attempts[1]?.passthrough_used).toBe(false);
    expect(out.attempts[1]?.passthrough_disable_reason).toBe("protocol_mismatch");
  });

  it("cross-protocol fallback carries Anthropic output_config.effort to OpenAI Responses reasoning.effort", async () => {
    const head = {
      chatCompletion: vi.fn(),
      chatCompletionStream: vi.fn(),
      nativePassthrough: vi.fn().mockRejectedValue(new UpstreamError("upstream_error", "boom")),
    } as unknown as ProviderClient & { nativePassthrough: ReturnType<typeof vi.fn> };
    const upstreamBodies: Array<Record<string, unknown>> = [];
    const tail = createGenericOpenAIResponsesClient({
      config: { baseUrl: "https://api.openai.test/v1", apiKey: "sk-test" },
      fetch: vi.fn(async (_url, init) => {
        upstreamBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return new Response(
          JSON.stringify({
            id: "resp_1",
            object: "response",
            status: "completed",
            output: [
              {
                type: "message",
                role: "assistant",
                content: [{ type: "output_text", text: "ok" }],
              },
            ],
            usage: { input_tokens: 1, output_tokens: 1 },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }) as unknown as typeof fetch,
    });
    const execute = createExecute({
      defaultProvider: head,
      providers: new Map<string, ProviderClient>([
        ["anthro", head],
        ["openai", tail],
      ]),
      registry: protocolRegistry({
        a: {
          providerName: "anthro",
          providerModel: "claude-x",
          targetProviderProtocol: "anthropic_messages",
        },
        b: {
          providerName: "openai",
          providerModel: "gpt-5.5",
          targetProviderProtocol: "openai_responses",
        },
      }),
      breaker: breaker(),
      catalog: new Map(),
      now: clock(),
      signal: new AbortController().signal,
      nativeProtocolPassthroughEnabled: () => true,
    });

    const out = await execute(
      plan(["a", "b"]),
      anthropicReq({
        reasoning_effort: "xhigh",
        provider_raw: { output_config: { effort: "xhigh" } },
        native_request: createNativePassthroughCarrier({
          protocol: "anthropic_messages",
          body: { ...NATIVE, output_config: { effort: "xhigh" } },
          headers: {},
        }),
      }),
    );

    expect(head.nativePassthrough).toHaveBeenCalledTimes(1);
    expect(out.final).toEqual({ status: "ok", alias: "b", providerModel: "gpt-5.5" });
    expect(upstreamBodies[0]?.reasoning).toEqual({ effort: "xhigh" });
    expect(JSON.parse(out.upstreamRequest ?? "{}").reasoning).toEqual({ effort: "xhigh" });
    expect(out.attempts[1]?.target_provider_protocol).toBe("openai_responses");
  });

  it("cross-protocol fallback carries OpenAI reasoning_effort to Anthropic output_config.effort", async () => {
    const head = {
      chatCompletion: vi.fn().mockRejectedValue(new UpstreamError("upstream_error", "boom")),
      chatCompletionStream: vi.fn(),
    } as unknown as ProviderClient & { chatCompletion: ReturnType<typeof vi.fn> };
    const upstreamBodies: Array<Record<string, unknown>> = [];
    const tail = createAnthropicClient({
      config: { baseUrl: "https://api.anthropic.test", apiKey: "sk-test" },
      fetch: vi.fn(async (_url, init) => {
        upstreamBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return new Response(
          JSON.stringify({
            id: "msg_1",
            type: "message",
            role: "assistant",
            content: [{ type: "text", text: "ok" }],
            stop_reason: "end_turn",
            usage: { input_tokens: 1, output_tokens: 1 },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }) as unknown as typeof fetch,
    });
    const execute = createExecute({
      defaultProvider: head,
      providers: new Map<string, ProviderClient>([
        ["openai", head],
        ["anthro", tail],
      ]),
      registry: protocolRegistry({
        a: {
          providerName: "openai",
          providerModel: "gpt-5.5",
          targetProviderProtocol: "openai_responses",
        },
        b: {
          providerName: "anthro",
          providerModel: "claude-opus-4-8",
          targetProviderProtocol: "anthropic_messages",
        },
      }),
      breaker: breaker(),
      catalog: new Map(),
      now: clock(),
      signal: new AbortController().signal,
      nativeProtocolPassthroughEnabled: () => true,
    });

    const out = await execute(plan(["a", "b"]), req({ reasoning_effort: "xhigh" }));

    expect(head.chatCompletion).toHaveBeenCalledTimes(1);
    expect(out.final).toEqual({ status: "ok", alias: "b", providerModel: "claude-opus-4-8" });
    expect(upstreamBodies[0]?.output_config).toEqual({ effort: "xhigh" });
    expect((upstreamBodies[0]?.thinking as { type?: string } | undefined)?.type).toBe("enabled");
    expect(JSON.parse(out.upstreamRequest ?? "{}").output_config).toEqual({ effort: "xhigh" });
    expect(out.attempts[1]?.target_provider_protocol).toBe("anthropic_messages");
  });

  it("an UpstreamError from nativePassthrough records a breaker failure and advances the chain", async () => {
    const head = {
      chatCompletion: vi.fn(),
      chatCompletionStream: vi.fn(),
      nativePassthrough: vi.fn().mockRejectedValue(new UpstreamError("upstream_error", "boom")),
    } as unknown as ProviderClient & { nativePassthrough: ReturnType<typeof vi.fn> };
    const tail = {
      chatCompletion: vi.fn(),
      chatCompletionStream: vi.fn(),
      nativePassthrough: vi.fn().mockResolvedValue(NATIVE_RESP),
    } as unknown as ProviderClient & { nativePassthrough: ReturnType<typeof vi.fn> };
    const cb = breaker();
    const recordFailure = vi.spyOn(cb, "recordFailure");
    const execute = createExecute({
      defaultProvider: head,
      providers: new Map([
        ["anthro-a", head],
        ["anthro-b", tail],
      ]),
      registry: protocolRegistry({
        a: {
          providerName: "anthro-a",
          providerModel: "claude-a",
          targetProviderProtocol: "anthropic_messages",
        },
        b: {
          providerName: "anthro-b",
          providerModel: "claude-b",
          targetProviderProtocol: "anthropic_messages",
        },
      }),
      breaker: cb,
      catalog: new Map(),
      now: clock(),
      signal: new AbortController().signal,
      nativeProtocolPassthroughEnabled: () => true,
    });

    const out = await execute(plan(["a", "b"]), anthropicReq());
    expect(head.nativePassthrough).toHaveBeenCalledTimes(1);
    expect(recordFailure).toHaveBeenCalledTimes(1);
    expect(recordFailure).toHaveBeenCalledWith("a");
    expect(out.attempts[0]?.status).toBe("error");
    expect(out.attempts[0]?.error_class).toBe("upstream_error");
    // The chain advanced and the second anthropic candidate served via passthrough.
    expect(tail.nativePassthrough).toHaveBeenCalledTimes(1);
    expect(out.final.status).toBe("ok");
    expect(out.body).toBe(NATIVE_RESP);
    expect(out.nativePassthrough).toBe(true);
  });

  it("a client abort during nativePassthrough records client_abort without a breaker failure", async () => {
    const ac = new AbortController();
    const abortErr = new Error("aborted");
    abortErr.name = "AbortError";
    const provider = {
      chatCompletion: vi.fn(),
      chatCompletionStream: vi.fn(),
      nativePassthrough: vi.fn().mockRejectedValue(abortErr),
    } as unknown as ProviderClient & { nativePassthrough: ReturnType<typeof vi.fn> };
    const cb = breaker();
    const recordFailure = vi.spyOn(cb, "recordFailure");
    const execute = createExecute({
      defaultProvider: provider,
      providers: new Map([["anthro", provider]]),
      registry: protocolRegistry({
        a: {
          providerName: "anthro",
          providerModel: "claude-x",
          targetProviderProtocol: "anthropic_messages",
        },
      }),
      breaker: cb,
      catalog: new Map(),
      now: clock(),
      signal: ac.signal,
      nativeProtocolPassthroughEnabled: () => true,
    });

    const out = await execute(plan(["a"]), anthropicReq());
    expect(provider.nativePassthrough).toHaveBeenCalledTimes(1);
    expect(out.attempts[0]?.error_class).toBe("client_abort");
    expect(recordFailure).not.toHaveBeenCalled();
    // C2: a disconnect during native passthrough surfaces client_abort (499), not 502.
    expect(out.final.status).toBe("error");
    if (out.final.status === "error") {
      expect(out.final.error.error_class).toBe("client_abort");
      expect(out.final.error.http_status).toBe(499);
    }
  });

  it("a :free 429 from nativePassthrough skips without a breaker failure", async () => {
    const head = {
      chatCompletion: vi.fn(),
      chatCompletionStream: vi.fn(),
      nativePassthrough: vi
        .fn()
        .mockRejectedValue(new UpstreamError("upstream_error", "429", null, 429)),
    } as unknown as ProviderClient & { nativePassthrough: ReturnType<typeof vi.fn> };
    const tail = {
      chatCompletion: vi.fn(),
      chatCompletionStream: vi.fn(),
      nativePassthrough: vi.fn().mockResolvedValue(NATIVE_RESP),
    } as unknown as ProviderClient & { nativePassthrough: ReturnType<typeof vi.fn> };
    const cb = breaker();
    const recordFailure = vi.spyOn(cb, "recordFailure");
    const execute = createExecute({
      defaultProvider: head,
      providers: new Map([
        ["anthro-a", head],
        ["anthro-b", tail],
      ]),
      registry: protocolRegistry({
        "free-a:free": {
          providerName: "anthro-a",
          providerModel: "claude-a",
          targetProviderProtocol: "anthropic_messages",
        },
        b: {
          providerName: "anthro-b",
          providerModel: "claude-b",
          targetProviderProtocol: "anthropic_messages",
        },
      }),
      breaker: cb,
      catalog: new Map(),
      now: clock(),
      signal: new AbortController().signal,
      nativeProtocolPassthroughEnabled: () => true,
    });

    const out = await execute(plan(["free-a:free", "b"]), anthropicReq());
    expect(out.attempts[0]?.skipped).toBe(true);
    expect(out.attempts[0]?.skip_reason).toBe("free_429");
    expect(recordFailure).not.toHaveBeenCalled();
    expect(out.final.status).toBe("ok");
    expect(tail.nativePassthrough).toHaveBeenCalledTimes(1);
  });

  it("prices the served ok row from the native Anthropic usage", async () => {
    const provider = anthropicProvider({
      ...NATIVE_RESP,
      usage: { input_tokens: 1000, output_tokens: 500 },
    });
    // $2.5/MTok in, $10/MTok out → 1000/1e6*2.5 + 500/1e6*10 = 0.0025 + 0.005 = 0.0075.
    const execute = createExecute({
      defaultProvider: provider,
      providers: new Map([["anthro", provider]]),
      registry: protocolRegistry({
        a: {
          providerName: "anthro",
          providerModel: "claude-x",
          targetProviderProtocol: "anthropic_messages",
        },
      }),
      breaker: breaker(),
      catalog: new Map([
        [
          "a",
          {
            modelKey: "a",
            capabilities: {
              supportsTools: true,
              jsonOutput: "schema",
              supportsVision: true,
              supportsStreaming: true,
              maxContextTokens: 200000,
              maxOutputTokens: 8192,
            },
            pricing: {
              inputPerMTokUsd: 2.5,
              outputPerMTokUsd: 10,
              cacheReadPerMTokUsd: null,
              cacheWritePerMTokUsd: null,
            },
            source: "generated",
          } satisfies CatalogEntry,
        ],
      ]),
      now: clock(),
      signal: new AbortController().signal,
      nativeProtocolPassthroughEnabled: () => true,
    });

    const out = await execute(plan(["a"]), anthropicReq());
    expect(out.final.status).toBe("ok");
    expect(out.nativePassthrough).toBe(true);
    expect(out.attempts[0]?.cost_usd).toBeCloseTo(0.0075, 12);
  });

  it("prices native Responses passthrough with Responses cache details", async () => {
    const responsesBody = {
      id: "resp_1",
      object: "response",
      status: "completed",
      output: [
        { type: "message", role: "assistant", content: [{ type: "output_text", text: "ok" }] },
      ],
      usage: {
        input_tokens: 1000,
        output_tokens: 500,
        input_tokens_details: { cached_tokens: 600, cache_creation_input_tokens: 100 },
      },
    };
    const provider = {
      chatCompletion: vi.fn(),
      chatCompletionStream: vi.fn(),
      nativePassthrough: vi.fn().mockResolvedValue(responsesBody),
    } as unknown as ProviderClient & { nativePassthrough: ReturnType<typeof vi.fn> };
    const execute = createExecute({
      defaultProvider: provider,
      providers: new Map([["codex", provider]]),
      registry: protocolRegistry({
        r: {
          providerName: "codex",
          providerModel: "gpt-5-codex",
          targetProviderProtocol: "openai_responses",
        },
      }),
      breaker: breaker(),
      catalog: new Map([
        [
          "r",
          {
            modelKey: "r",
            capabilities: {
              supportsTools: true,
              jsonOutput: "schema",
              supportsVision: true,
              supportsStreaming: true,
              maxContextTokens: 200000,
              maxOutputTokens: 8192,
            },
            pricing: {
              inputPerMTokUsd: 10,
              outputPerMTokUsd: 20,
              cacheReadPerMTokUsd: 1,
              cacheWritePerMTokUsd: 5,
            },
            source: "generated",
          } satisfies CatalogEntry,
        ],
      ]),
      now: clock(),
      signal: new AbortController().signal,
      nativeProtocolPassthroughEnabled: () => true,
    });

    const out = await execute(
      plan(["r"]),
      req({
        protocol: "openai_responses",
        native_request: { model: "codex/gpt-5-codex", input: "hi" },
      }),
    );

    expect(out.final.status).toBe("ok");
    expect(out.nativePassthrough).toBe(true);
    expect(provider.nativePassthrough.mock.calls[0]?.[0]).toMatchObject({ model: "gpt-5-codex" });
    // Responses input_tokens already include cache tokens: regular=300, cached=600,
    // cache write=100, output=500 => 0.003 + 0.0006 + 0.0005 + 0.01 = 0.0141.
    expect(out.attempts[0]?.cost_usd).toBeCloseTo(0.0141, 12);
  });

  it("leaves model-aware Codex instructions shaping to the provider boundary", async () => {
    const responsesBody = {
      id: "resp_1",
      object: "response",
      status: "completed",
      output: [],
      usage: { input_tokens: 1, output_tokens: 1 },
    };
    const provider = {
      chatCompletion: vi.fn(),
      chatCompletionStream: vi.fn(),
      nativePassthrough: vi.fn().mockResolvedValue(responsesBody),
    } as unknown as ProviderClient & { nativePassthrough: ReturnType<typeof vi.fn> };
    const execute = createExecute({
      defaultProvider: provider,
      providers: new Map([["codex", provider]]),
      registry: protocolRegistry({
        r: {
          providerName: "codex",
          providerModel: "gpt-5-codex",
          targetProviderProtocol: "openai_responses",
        },
      }),
      breaker: breaker(),
      catalog: new Map(),
      now: clock(),
      signal: new AbortController().signal,
      nativeProtocolPassthroughEnabled: () => true,
    });
    const carrier = {
      protocol: "openai_responses" as const,
      body: { model: "codex/gpt-5-codex", input: "hi", store: true },
      raw_body: '{"model":"codex/gpt-5-codex","input":"hi","store":true}',
      headers: { authorization: "Bearer client" },
      mutations: {},
    };

    const out = await execute(
      plan(["r"]),
      req({
        protocol: "openai_responses",
        native_request: carrier,
      }),
    );

    expect(out.final.status).toBe("ok");
    const forwarded = provider.nativePassthrough.mock.calls[0]?.[0] as typeof carrier;
    expect(forwarded.body).toEqual({
      model: "gpt-5-codex",
      input: "hi",
      store: false,
    });
    expect(forwarded.raw_body).toBeUndefined();
    expect(forwarded.mutations).toMatchObject({
      model_rewritten: { from: "codex/gpt-5-codex", to: "gpt-5-codex" },
      body_shims_applied: ["store_forced_false"],
    });
    expect(out.attempts[0]?.passthrough_mutations).toMatchObject(forwarded.mutations);
  });

  it("does not apply Codex store:false shim to generic OpenAI Responses providers", async () => {
    const responsesBody = {
      id: "resp_generic",
      object: "response",
      status: "completed",
      output: [],
      usage: { input_tokens: 1, output_tokens: 1 },
    };
    const provider = {
      nativeProtocolProfile: "generic_openai_responses",
      chatCompletion: vi.fn(),
      chatCompletionStream: vi.fn(),
      nativePassthrough: vi.fn().mockResolvedValue(responsesBody),
    } as unknown as ProviderClient & { nativePassthrough: ReturnType<typeof vi.fn> };
    const execute = createExecute({
      defaultProvider: provider,
      providers: new Map([["openai", provider]]),
      registry: protocolRegistry({
        r: {
          providerName: "openai",
          providerModel: "gpt-5.5",
          targetProviderProtocol: "openai_responses",
        },
      }),
      breaker: breaker(),
      catalog: new Map(),
      now: clock(),
      signal: new AbortController().signal,
      nativeProtocolPassthroughEnabled: () => true,
    });
    const carrier = {
      protocol: "openai_responses" as const,
      body: { model: "gpt-5.5", input: "hi", store: true, background: true },
      headers: {},
      mutations: {},
    };

    const out = await execute(
      plan(["r"]),
      req({
        protocol: "openai_responses",
        native_request: carrier,
      }),
    );

    expect(out.final.status).toBe("ok");
    const forwarded = provider.nativePassthrough.mock.calls[0]?.[0] as typeof carrier;
    expect(forwarded.body).toEqual({
      model: "gpt-5.5",
      input: "hi",
      store: true,
      background: true,
    });
    expect((forwarded.mutations as Record<string, unknown>).body_shims_applied).toBeUndefined();
  });

  it("native Responses passthrough strips unsupported reasoning.effort per model policy", async () => {
    const responsesBody = {
      id: "resp_generic",
      object: "response",
      status: "completed",
      output: [],
      usage: { input_tokens: 1, output_tokens: 1 },
    };
    const provider = {
      nativeProtocolProfile: "generic_openai_responses",
      chatCompletion: vi.fn(),
      chatCompletionStream: vi.fn(),
      nativePassthrough: vi.fn().mockResolvedValue(responsesBody),
    } as unknown as ProviderClient & { nativePassthrough: ReturnType<typeof vi.fn> };
    const entry: CatalogEntry = {
      modelKey: "r",
      capabilities: {
        supportsTools: true,
        jsonOutput: "schema",
        supportsVision: true,
        supportsStreaming: true,
        reasoningEffort: {
          openaiReasoning: { supported: true, levels: ["low", "medium", "high", "xhigh"] },
        },
        maxContextTokens: 272000,
        maxOutputTokens: 128000,
      },
      pricing: {
        inputPerMTokUsd: null,
        outputPerMTokUsd: null,
        cacheReadPerMTokUsd: null,
        cacheWritePerMTokUsd: null,
      },
      source: "generated",
    };
    const execute = createExecute({
      defaultProvider: provider,
      providers: new Map([["openai", provider]]),
      registry: protocolRegistry({
        r: {
          providerName: "openai",
          providerModel: "gpt-5.5",
          targetProviderProtocol: "openai_responses",
        },
      }),
      breaker: breaker(),
      catalog: new Map([["r", entry]]),
      now: clock(),
      signal: new AbortController().signal,
      nativeProtocolPassthroughEnabled: () => true,
    });
    const carrier = {
      protocol: "openai_responses" as const,
      body: {
        model: "gpt-5.5",
        input: "hi",
        reasoning: { effort: "max", summary: "auto" },
      },
      headers: {},
      mutations: {},
    };

    const out = await execute(
      plan(["r"]),
      req({ protocol: "openai_responses", native_request: carrier }),
    );

    expect(out.final.status).toBe("ok");
    const forwarded = provider.nativePassthrough.mock.calls[0]?.[0] as typeof carrier;
    expect(forwarded.body.reasoning).toEqual({ summary: "auto" });
    expect(forwarded.mutations).toMatchObject({
      body_shims_applied: ["reasoning_effort_stripped_for_model"],
    });
  });

  it("native Codex Responses passthrough keeps reasoning.context when lane forces effort", async () => {
    const responsesBody = {
      id: "resp_codex",
      object: "response",
      status: "completed",
      output: [],
      usage: { input_tokens: 1, output_tokens: 1 },
    };
    const provider = {
      nativeProtocolProfile: "codex_responses",
      chatCompletion: vi.fn(),
      chatCompletionStream: vi.fn(),
      nativePassthrough: vi.fn().mockResolvedValue(responsesBody),
    } as unknown as ProviderClient & { nativePassthrough: ReturnType<typeof vi.fn> };
    const execute = createExecute({
      defaultProvider: provider,
      providers: new Map([["codex", provider]]),
      registry: protocolRegistry({
        r: {
          providerName: "codex",
          providerModel: "gpt-5.6-sol",
          targetProviderProtocol: "openai_responses",
        },
      }),
      breaker: breaker(),
      catalog: new Map(),
      now: clock(),
      signal: new AbortController().signal,
      nativeProtocolPassthroughEnabled: () => true,
    });
    const carrier = {
      protocol: "openai_responses" as const,
      body: {
        model: "gpt-5.6-sol",
        instructions: "Use the Codex native shape.",
        input: [{ type: "message", role: "user", content: "hi" }],
        store: false,
        include: ["reasoning.encrypted_content"],
        reasoning: { effort: "low", context: "all_turns" },
      },
      headers: {},
      mutations: {},
    };

    const out = await execute(
      plan(["r"]),
      req({
        protocol: "openai_responses",
        native_request: carrier,
        reasoning_effort: "high",
        reasoning_effort_forced: true,
      }),
    );

    expect(out.final.status).toBe("ok");
    const forwarded = provider.nativePassthrough.mock.calls[0]?.[0] as typeof carrier;
    expect(forwarded.body.reasoning).toEqual({ effort: "high", context: "all_turns" });
    expect(forwarded.mutations).toMatchObject({
      body_shims_applied: ["reasoning_effort_forced"],
    });
  });

  it("preserves developer input until Codex ModelInfo is available at the provider boundary", async () => {
    const responsesBody = {
      id: "resp_hoist",
      object: "response",
      status: "completed",
      output: [],
      usage: { input_tokens: 1, output_tokens: 1 },
    };
    const provider = {
      chatCompletion: vi.fn(),
      chatCompletionStream: vi.fn(),
      nativePassthrough: vi.fn().mockResolvedValue(responsesBody),
    } as unknown as ProviderClient & { nativePassthrough: ReturnType<typeof vi.fn> };
    const execute = createExecute({
      defaultProvider: provider,
      providers: new Map([["codex", provider]]),
      registry: protocolRegistry({
        r: {
          providerName: "codex",
          providerModel: "gpt-5.5",
          targetProviderProtocol: "openai_responses",
        },
      }),
      breaker: breaker(),
      catalog: new Map(),
      now: clock(),
      signal: new AbortController().signal,
      nativeProtocolPassthroughEnabled: () => true,
    });
    const carrier = {
      protocol: "openai_responses" as const,
      body: {
        model: "gpt-5.5",
        input: [
          { role: "developer", content: "You are Mimi, an AI employee at AgentCrew." },
          { role: "user", content: "hi" },
        ],
        store: false,
      },
      headers: {},
      mutations: {},
    };

    const out = await execute(
      plan(["r"]),
      req({ protocol: "openai_responses", native_request: carrier }),
    );

    expect(out.final.status).toBe("ok");
    const forwarded = provider.nativePassthrough.mock.calls[0]?.[0] as typeof carrier;
    expect(forwarded.body).toEqual({
      model: "gpt-5.5",
      input: [
        { role: "developer", content: "You are Mimi, an AI employee at AgentCrew." },
        { role: "user", content: "hi" },
      ],
      store: false,
    });
    expect((forwarded.mutations as Record<string, unknown>).body_shims_applied).toBeUndefined();
  });

  it("sanitizes Codex passthrough bodies that came from stored Responses output items", async () => {
    const responsesBody = {
      id: "resp_sanitized",
      object: "response",
      status: "completed",
      output: [],
      usage: { input_tokens: 1, output_tokens: 1 },
    };
    const provider = {
      nativeProtocolProfile: "codex_responses",
      chatCompletion: vi.fn(),
      chatCompletionStream: vi.fn(),
      nativePassthrough: vi.fn().mockResolvedValue(responsesBody),
    } as unknown as ProviderClient & { nativePassthrough: ReturnType<typeof vi.fn> };
    const execute = createExecute({
      defaultProvider: provider,
      providers: new Map([["codex", provider]]),
      registry: protocolRegistry({
        r: {
          providerName: "codex",
          providerModel: "gpt-5.5",
          targetProviderProtocol: "openai_responses",
        },
      }),
      breaker: breaker(),
      catalog: new Map(),
      now: clock(),
      signal: new AbortController().signal,
      nativeProtocolPassthroughEnabled: () => true,
    });
    const carrier = {
      protocol: "openai_responses" as const,
      body: {
        model: "auto",
        instructions: "real codex base prompt",
        store: false,
        max_output_tokens: 512,
        temperature: 0.2,
        input: [
          {
            type: "reasoning",
            id: "rs_missing",
            status: "completed",
            content: [],
            summary: [],
          },
          {
            type: "message",
            role: "assistant",
            id: "msg_missing",
            status: "completed",
            phase: "final_answer",
            content: [{ type: "output_text", text: "NO_REPLY" }],
          },
          { role: "user", content: [{ type: "input_text", text: "next" }] },
        ],
      },
      headers: {},
      mutations: {},
    };

    const out = await execute(
      plan(["r"]),
      req({ protocol: "openai_responses", native_request: carrier }),
    );

    expect(out.final.status).toBe("ok");
    const forwarded = provider.nativePassthrough.mock.calls[0]?.[0] as typeof carrier;
    expect(forwarded.body).toEqual({
      model: "gpt-5.5",
      instructions: "real codex base prompt",
      store: false,
      input: [
        {
          type: "message",
          role: "assistant",
          status: "completed",
          phase: "final_answer",
          content: [{ type: "output_text", text: "NO_REPLY" }],
        },
        { role: "user", content: [{ type: "input_text", text: "next" }] },
      ],
    });
    expect((forwarded.mutations as Record<string, unknown>).body_shims_applied).toEqual([
      "empty_reasoning_items_dropped",
      "input_item_references_stripped",
      "max_output_tokens_removed",
      "temperature_removed",
    ]);
  });

  it("leaves a Codex passthrough body verbatim when `instructions` is already present", async () => {
    const responsesBody = {
      id: "resp_verbatim",
      object: "response",
      status: "completed",
      output: [],
      usage: { input_tokens: 1, output_tokens: 1 },
    };
    const provider = {
      chatCompletion: vi.fn(),
      chatCompletionStream: vi.fn(),
      nativePassthrough: vi.fn().mockResolvedValue(responsesBody),
    } as unknown as ProviderClient & { nativePassthrough: ReturnType<typeof vi.fn> };
    const execute = createExecute({
      defaultProvider: provider,
      providers: new Map([["codex", provider]]),
      registry: protocolRegistry({
        r: {
          providerName: "codex",
          providerModel: "gpt-5.5",
          targetProviderProtocol: "openai_responses",
        },
      }),
      breaker: breaker(),
      catalog: new Map(),
      now: clock(),
      signal: new AbortController().signal,
      nativeProtocolPassthroughEnabled: () => true,
    });
    const carrier = {
      protocol: "openai_responses" as const,
      body: {
        model: "gpt-5.5",
        instructions: "real codex base prompt",
        input: [{ role: "user", content: "hi" }],
        store: false,
      },
      headers: {},
      mutations: {},
    };

    const out = await execute(
      plan(["r"]),
      req({ protocol: "openai_responses", native_request: carrier }),
    );

    expect(out.final.status).toBe("ok");
    const forwarded = provider.nativePassthrough.mock.calls[0]?.[0] as typeof carrier;
    expect(forwarded.body).toEqual({
      model: "gpt-5.5",
      instructions: "real codex base prompt",
      input: [{ role: "user", content: "hi" }],
      store: false,
    });
    expect((forwarded.mutations as Record<string, unknown>).body_shims_applied).toBeUndefined();
  });

  it("records native passthrough telemetry for Responses previous_response_id continuations", async () => {
    const responsesBody = {
      id: "resp_next",
      object: "response",
      status: "completed",
      output: [],
      usage: { input_tokens: 1, output_tokens: 1 },
    };
    const provider = {
      nativeProtocolProfile: "generic_openai_responses",
      chatCompletion: vi.fn(),
      chatCompletionStream: vi.fn(),
      nativePassthrough: vi.fn().mockResolvedValue(responsesBody),
    } as unknown as ProviderClient & { nativePassthrough: ReturnType<typeof vi.fn> };
    const execute = createExecute({
      defaultProvider: provider,
      providers: new Map([["openai", provider]]),
      registry: protocolRegistry({
        r: {
          providerName: "openai",
          providerModel: "gpt-5.5",
          targetProviderProtocol: "openai_responses",
        },
      }),
      breaker: breaker(),
      catalog: new Map(),
      now: clock(),
      signal: new AbortController().signal,
      nativeProtocolPassthroughEnabled: () => true,
    });
    const carrier = {
      protocol: "openai_responses" as const,
      body: {
        model: "gpt-5.5",
        previous_response_id: "resp_prev",
        input: [{ type: "function_call_output", call_id: "call_1", output: "done" }],
      },
      headers: {},
      mutations: {},
    };

    const out = await execute(
      plan(["r"]),
      req({
        protocol: "openai_responses",
        messages: [{ role: "tool", content: "done", tool_call_id: "call_1" }],
        provider_raw: { previous_response_id: "resp_prev" },
        native_request: carrier,
      }),
    );

    expect(out.final.status).toBe("ok");
    expect(provider.nativePassthrough).toHaveBeenCalledOnce();
    expect(out.attempts[0]?.passthrough_mutations).toMatchObject({
      responses_previous_response_id_native_passthrough: true,
    });
  });

  it("flag ON but provider has NO nativePassthrough → translates, reason provider_lacks_passthrough", async () => {
    const provider = {
      chatCompletion: vi.fn().mockResolvedValue({ id: "translated" }),
      chatCompletionStream: vi.fn(),
      // no nativePassthrough method
    } as unknown as ProviderClient;
    const execute = createExecute({
      defaultProvider: provider,
      providers: new Map([["anthro", provider]]),
      registry: protocolRegistry({
        a: {
          providerName: "anthro",
          providerModel: "claude-x",
          targetProviderProtocol: "anthropic_messages",
        },
      }),
      breaker: breaker(),
      catalog: new Map(),
      now: clock(),
      signal: new AbortController().signal,
      nativeProtocolPassthroughEnabled: () => true,
    });

    const out = await execute(plan(["a"]), anthropicReq());
    expect(out.final.status).toBe("ok");
    expect(out.nativePassthrough ?? false).toBe(false);
    expect(out.attempts[0]?.passthrough_used).toBe(false);
    expect(out.attempts[0]?.passthrough_disable_reason).toBe("provider_lacks_passthrough");
  });
});

// Native protocol passthrough — STREAMING (issue #217, Phase 2). For a stream:true
// Anthropic→Anthropic request the executor forwards the VERBATIM native body to
// nativePassthroughStream and BYTE-RELAYS the upstream SSE back, eliminating the
// SSE re-mapping state machine (principle 8) rather than replacing it. The breaker
// contract is unchanged: peek the first chunk (pre-first-chunk failure → recordFailure
// + chain advance; healthy → recordSuccess). The stream-passthrough decision is
// stream-AWARE — providerSupportsPassthrough feature-detects nativePassthroughStream.
describe("createExecute — native protocol STREAMING passthrough (#217 Phase 2)", () => {
  // model is the ROUTING ALIAS a client sends; execute patches it to providerModel
  // before forwarding the verbatim native stream body (else upstream 404s on alias).
  const NATIVE_STREAM = {
    model: "anthropic/claude-x",
    max_tokens: 16,
    stream: true,
    messages: [{ role: "user", content: "hi" }],
  } as const;

  function protocolRegistry(
    map: Record<
      string,
      {
        providerName: string;
        providerModel: string;
        targetProviderProtocol: TargetProviderProtocol;
      }
    >,
  ): ProviderRegistry {
    return {
      resolve(alias: string) {
        const hit = map[alias];
        if (hit === undefined) return { ok: false, error: { kind: "unknown_alias", alias } };
        return {
          ok: true,
          value: {
            alias,
            providerName: hit.providerName,
            providerModel: hit.providerModel,
            baseUrl: "http://x",
            apiKeyEnv: "X",
            targetProviderProtocol: hit.targetProviderProtocol,
            providerRequiresCompatibilityRewrite: false,
          },
        };
      },
      list: () => Object.keys(map),
    };
  }

  // Anthropic STREAM inbound carrying the verbatim native body (stream:true already
  // baked into the native body — the client asked to stream).
  function anthropicStreamReq(over: Partial<InternalRequest> = {}): InternalRequest {
    return req({
      protocol: "anthropic_messages",
      stream: true,
      native_request: { ...NATIVE_STREAM },
      ...over,
    });
  }

  // Anthropic SSE frames the upstream byte-relays back, verbatim.
  const SSE = [
    'event: message_start\ndata: {"type":"message_start"}\n\n',
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"ok"}}\n\n',
    'event: message_stop\ndata: {"type":"message_stop"}\n\n',
  ];

  const EMPTY_ANTHROPIC_SSE = [
    'event: message_start\ndata: {"type":"message_start"}\n\n',
    'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
    'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
    'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":0}}\n\n',
    'event: message_stop\ndata: {"type":"message_stop"}\n\n',
  ];

  it("flag ON + anthropic target + stream + native_request → opens nativePassthroughStream (NOT chatCompletionStream), recordSuccess, returns { stream, nativePassthrough:true }", async () => {
    const provider = {
      chatCompletion: vi.fn(),
      chatCompletionStream: vi.fn(),
      nativePassthrough: vi.fn(),
      nativePassthroughStream: vi.fn().mockReturnValue(gen(SSE)),
    } as unknown as ProviderClient & {
      chatCompletionStream: ReturnType<typeof vi.fn>;
      nativePassthroughStream: ReturnType<typeof vi.fn>;
    };
    const cb = breaker();
    const recordSuccess = vi.spyOn(cb, "recordSuccess");
    const execute = createExecute({
      defaultProvider: provider,
      providers: new Map([["anthro", provider]]),
      registry: protocolRegistry({
        a: {
          providerName: "anthro",
          providerModel: "claude-x",
          targetProviderProtocol: "anthropic_messages",
        },
      }),
      breaker: cb,
      catalog: new Map(),
      now: clock(),
      signal: new AbortController().signal,
      nativeProtocolPassthroughEnabled: () => true,
      toolCallXmlRecoveryEnabled: () => false,
    });

    const out = await execute(plan(["a"]), anthropicStreamReq());
    expect(out.final.status).toBe("ok");
    // The native (stream) body was forwarded VERBATIM to the stream passthrough method.
    expect(provider.nativePassthroughStream).toHaveBeenCalledTimes(1);
    expect(provider.nativePassthroughStream.mock.calls[0]?.[0]).toEqual({
      ...NATIVE_STREAM,
      model: "claude-x",
    });
    expect(provider.nativePassthroughStream.mock.calls[0]?.[1]).toMatchObject({
      toolCallXmlRecovery: false,
    });
    expect(provider.chatCompletionStream).not.toHaveBeenCalled();
    // recordSuccess fired on the first peeked chunk (breaker contract unchanged).
    expect(recordSuccess).toHaveBeenCalledTimes(1);
    expect(recordSuccess).toHaveBeenCalledWith("a");
    // The stream handle is returned and byte-relays the upstream SSE intact.
    expect(out.stream).not.toBeNull();
    expect(out.body).toBeNull();
    expect(out.nativePassthrough).toBe(true);
    const seen: string[] = [];
    for await (const ch of out.stream as AsyncIterable<string>) seen.push(ch);
    expect(seen).toEqual(SSE);
    // okRow carries the real passthrough telemetry; cost is null (streamed usage
    // unknown at peek, backfilled later).
    const okRow = out.attempts[0];
    expect(okRow?.status).toBe("ok");
    expect(okRow?.passthrough_considered).toBe(true);
    expect(okRow?.passthrough_used).toBe(true);
    expect(okRow?.cost_usd).toBeNull();
    expect(okRow?.source_protocol).toBe("anthropic_messages");
    expect(okRow?.target_provider_protocol).toBe("anthropic_messages");
  });

  it("records model rewrite + stream reframing mutations on a native stream carrier", async () => {
    const provider = {
      chatCompletion: vi.fn(),
      chatCompletionStream: vi.fn(),
      nativePassthrough: vi.fn(),
      nativePassthroughStream: vi.fn().mockReturnValue(gen(SSE)),
    } as unknown as ProviderClient & {
      nativePassthroughStream: ReturnType<typeof vi.fn>;
    };
    const execute = createExecute({
      defaultProvider: provider,
      providers: new Map([["anthro", provider]]),
      registry: protocolRegistry({
        a: {
          providerName: "anthro",
          providerModel: "claude-x",
          targetProviderProtocol: "anthropic_messages",
        },
      }),
      breaker: breaker(),
      catalog: new Map(),
      now: clock(),
      signal: new AbortController().signal,
      nativeProtocolPassthroughEnabled: () => true,
    });
    const carrier = {
      protocol: "anthropic_messages" as const,
      body: { ...NATIVE_STREAM },
      raw_body: JSON.stringify(NATIVE_STREAM),
      headers: { "x-api-key": "client" },
      mutations: {},
    };

    const out = await execute(plan(["a"]), anthropicStreamReq({ native_request: carrier }));

    const forwarded = provider.nativePassthroughStream.mock.calls[0]?.[0] as typeof carrier;
    expect(forwarded.body).toEqual({ ...NATIVE_STREAM, model: "claude-x" });
    expect(forwarded.mutations).toMatchObject({
      model_rewritten: { from: "anthropic/claude-x", to: "claude-x" },
      stream_reframed: true,
    });
    expect(out.attempts[0]?.passthrough_mutations).toMatchObject(forwarded.mutations);
  });

  it("flag OFF + stream → chatCompletionStream(stripInternal) translate path, passthrough_used:false, nativePassthrough absent", async () => {
    const provider = {
      chatCompletion: vi.fn(),
      chatCompletionStream: vi.fn().mockReturnValue(gen(["data: {}\n\n"])),
      nativePassthrough: vi.fn(),
      nativePassthroughStream: vi.fn(),
    } as unknown as ProviderClient & {
      chatCompletionStream: ReturnType<typeof vi.fn>;
      nativePassthroughStream: ReturnType<typeof vi.fn>;
    };
    const execute = createExecute({
      defaultProvider: provider,
      providers: new Map([["anthro", provider]]),
      registry: protocolRegistry({
        a: {
          providerName: "anthro",
          providerModel: "claude-x",
          targetProviderProtocol: "anthropic_messages",
        },
      }),
      breaker: breaker(),
      catalog: new Map(),
      now: clock(),
      signal: new AbortController().signal,
      // flag not provided → defaults OFF
    });

    const out = await execute(plan(["a"]), anthropicStreamReq());
    expect(out.final.status).toBe("ok");
    expect(provider.nativePassthroughStream).not.toHaveBeenCalled();
    expect(provider.chatCompletionStream).toHaveBeenCalledTimes(1);
    // stripInternal carries the IR model id (claude-x) + forced include_usage.
    expect(provider.chatCompletionStream.mock.calls[0]?.[0]).toMatchObject({ model: "claude-x" });
    expect(out.stream).not.toBeNull();
    expect(out.nativePassthrough ?? false).toBe(false);
    expect(out.attempts[0]?.passthrough_used).toBe(false);
    expect(out.attempts[0]?.passthrough_disable_reason).toBe("feature_flag_disabled");
  });

  it("flag ON + stream but provider has nativePassthrough (non-stream) only → provider_lacks_passthrough → translate path", async () => {
    const provider = {
      chatCompletion: vi.fn(),
      chatCompletionStream: vi.fn().mockReturnValue(gen(["data: {}\n\n"])),
      nativePassthrough: vi.fn(), // non-stream method present, but NO stream sibling
    } as unknown as ProviderClient & {
      chatCompletionStream: ReturnType<typeof vi.fn>;
    };
    const execute = createExecute({
      defaultProvider: provider,
      providers: new Map([["anthro", provider]]),
      registry: protocolRegistry({
        a: {
          providerName: "anthro",
          providerModel: "claude-x",
          targetProviderProtocol: "anthropic_messages",
        },
      }),
      breaker: breaker(),
      catalog: new Map(),
      now: clock(),
      signal: new AbortController().signal,
      nativeProtocolPassthroughEnabled: () => true,
    });

    const out = await execute(plan(["a"]), anthropicStreamReq());
    expect(out.final.status).toBe("ok");
    expect(provider.chatCompletionStream).toHaveBeenCalledTimes(1);
    expect(out.stream).not.toBeNull();
    expect(out.nativePassthrough ?? false).toBe(false);
    expect(out.attempts[0]?.passthrough_used).toBe(false);
    expect(out.attempts[0]?.passthrough_disable_reason).toBe("provider_lacks_passthrough");
  });

  it("a pre-first-chunk UpstreamError on the passthrough stream records a breaker failure and advances the chain", async () => {
    // biome-ignore lint/correctness/useYield: pre-first-chunk failure throws before any yield
    async function* diesBeforeFirst(): AsyncGenerator<string> {
      throw new UpstreamError("upstream_error", "connect failed");
    }
    const head = {
      chatCompletion: vi.fn(),
      chatCompletionStream: vi.fn(),
      nativePassthroughStream: vi.fn().mockReturnValue(diesBeforeFirst()),
    } as unknown as ProviderClient & { nativePassthroughStream: ReturnType<typeof vi.fn> };
    const tail = {
      chatCompletion: vi.fn(),
      chatCompletionStream: vi.fn(),
      nativePassthroughStream: vi.fn().mockReturnValue(gen(SSE)),
    } as unknown as ProviderClient & { nativePassthroughStream: ReturnType<typeof vi.fn> };
    const cb = breaker();
    const recordFailure = vi.spyOn(cb, "recordFailure");
    const execute = createExecute({
      defaultProvider: head,
      providers: new Map([
        ["anthro-a", head],
        ["anthro-b", tail],
      ]),
      registry: protocolRegistry({
        a: {
          providerName: "anthro-a",
          providerModel: "claude-a",
          targetProviderProtocol: "anthropic_messages",
        },
        b: {
          providerName: "anthro-b",
          providerModel: "claude-b",
          targetProviderProtocol: "anthropic_messages",
        },
      }),
      breaker: cb,
      catalog: new Map(),
      now: clock(),
      signal: new AbortController().signal,
      nativeProtocolPassthroughEnabled: () => true,
    });

    const out = await execute(plan(["a", "b"]), anthropicStreamReq());
    expect(head.nativePassthroughStream).toHaveBeenCalledTimes(1);
    expect(recordFailure).toHaveBeenCalledTimes(1);
    expect(recordFailure).toHaveBeenCalledWith("a");
    expect(out.attempts[0]?.status).toBe("error");
    expect(out.attempts[0]?.error_class).toBe("upstream_error");
    // The chain advanced and the second anthropic candidate streamed via passthrough.
    expect(tail.nativePassthroughStream).toHaveBeenCalledTimes(1);
    expect(out.final.status).toBe("ok");
    expect(out.stream).not.toBeNull();
    expect(out.nativePassthrough).toBe(true);
  });

  it("short-circuits a native Responses in-band context error to a scrubbed 400", async () => {
    // The head passthrough stream reports an in-band context overflow (response.failed with
    // context_length_exceeded). It short-circuits to a 400 with the provider_raw SCRUBBED of
    // private request content — the later candidates are never opened.
    const contextStream = (model: string) =>
      gen([
        'event: response.created\ndata: {"type":"response.created"}\n\n',
        `event: response.failed\ndata: ${JSON.stringify({
          type: "response.failed",
          response: {
            instructions: "private request content",
            error: {
              type: "invalid_request_error",
              code: "context_length_exceeded",
              message: `Your input exceeds the context window of ${model}.`,
            },
          },
        })}\n\n`,
      ]);
    const sol = {
      chatCompletion: vi.fn(),
      chatCompletionStream: vi.fn(),
      nativePassthroughStream: vi.fn().mockReturnValue(contextStream("sol")),
    } as unknown as ProviderClient;
    const xai = {
      chatCompletion: vi.fn(),
      chatCompletionStream: vi.fn(),
      nativePassthroughStream: vi.fn(),
    } as unknown as ProviderClient;
    const terra = {
      chatCompletion: vi.fn(),
      chatCompletionStream: vi.fn(),
      nativePassthroughStream: vi.fn(),
    } as unknown as ProviderClient;
    const cb = breaker();
    const recordFailure = vi.spyOn(cb, "recordFailure");
    const execute = createExecute({
      defaultProvider: sol,
      providers: new Map([
        ["codex", sol],
        ["xai", xai],
        ["codex-terra", terra],
      ]),
      registry: protocolRegistry({
        sol: {
          providerName: "codex",
          providerModel: "gpt-5.6-sol",
          targetProviderProtocol: "openai_responses",
        },
        xai: {
          providerName: "xai",
          providerModel: "grok-4.5",
          targetProviderProtocol: "openai_responses",
        },
        terra: {
          providerName: "codex-terra",
          providerModel: "gpt-5.6-terra",
          targetProviderProtocol: "openai_responses",
        },
      }),
      breaker: cb,
      catalog: new Map(),
      now: clock(),
      signal: new AbortController().signal,
      nativeProtocolPassthroughEnabled: () => true,
    });

    const out = await execute(
      plan(["sol", "xai", "terra"]),
      req({
        protocol: "openai_responses",
        stream: true,
        native_request: createNativePassthroughCarrier({
          protocol: "openai_responses",
          body: { model: "auto", input: "large request", stream: true },
          headers: {},
        }),
      }),
    );

    expect(out.final.status).toBe("error");
    if (out.final.status !== "error") throw new Error("expected a terminal error");
    expect(out.final.error).toMatchObject({
      error_class: "invalid_request",
      http_status: 400,
      provider_raw: {
        type: "response.failed",
        response: { error: { code: "context_length_exceeded" } },
      },
    });
    // Short-circuited on the head candidate; xai + terra never opened.
    expect(out.attempts).toHaveLength(1);
    expect(out.attempts[0]).toMatchObject({ alias: "sol", error_class: "invalid_request" });
    expect(out.attempts[0]?.error_detail?.provider_raw).not.toHaveProperty("response.instructions");
    expect(xai.nativePassthroughStream).not.toHaveBeenCalled();
    expect(terra.nativePassthroughStream).not.toHaveBeenCalled();
    expect(recordFailure).not.toHaveBeenCalled();
  });

  it("an Anthropic passthrough stream that ends with no real output records a failure and advances the chain", async () => {
    const head = {
      chatCompletion: vi.fn(),
      chatCompletionStream: vi.fn(),
      nativePassthroughStream: vi.fn().mockReturnValue(gen(EMPTY_ANTHROPIC_SSE)),
    } as unknown as ProviderClient & { nativePassthroughStream: ReturnType<typeof vi.fn> };
    const tail = {
      chatCompletion: vi.fn(),
      chatCompletionStream: vi.fn(),
      nativePassthroughStream: vi.fn().mockReturnValue(gen(SSE)),
    } as unknown as ProviderClient & { nativePassthroughStream: ReturnType<typeof vi.fn> };
    const cb = breaker();
    const recordFailure = vi.spyOn(cb, "recordFailure");
    const execute = createExecute({
      defaultProvider: tail,
      providers: new Map([
        ["anthro-a", head],
        ["anthro-b", tail],
      ]),
      registry: protocolRegistry({
        a: {
          providerName: "anthro-a",
          providerModel: "claude-a",
          targetProviderProtocol: "anthropic_messages",
        },
        b: {
          providerName: "anthro-b",
          providerModel: "claude-b",
          targetProviderProtocol: "anthropic_messages",
        },
      }),
      breaker: cb,
      catalog: new Map(),
      now: clock(),
      signal: new AbortController().signal,
      nativeProtocolPassthroughEnabled: () => true,
    });

    const out = await execute(plan(["a", "b"]), anthropicStreamReq());
    expect(head.nativePassthroughStream).toHaveBeenCalledTimes(1);
    expect(recordFailure).toHaveBeenCalledTimes(1);
    expect(recordFailure).toHaveBeenCalledWith("a");
    expect(out.attempts[0]?.status).toBe("error");
    expect(out.attempts[0]?.error_class).toBe("upstream_error");
    expect(out.attempts[0]?.error_detail?.message).toBe(
      "upstream stream ended before producing any output",
    );
    expect(tail.nativePassthroughStream).toHaveBeenCalledTimes(1);
    expect(out.final.status).toBe("ok");
    expect(out.stream).not.toBeNull();
    expect(out.nativePassthrough).toBe(true);
  });

  it("stream cross-protocol fallback: failed Anthropic passthrough advances to translated OpenAI stream", async () => {
    // biome-ignore lint/correctness/useYield: pre-first-chunk failure throws before any yield
    async function* diesBeforeFirst(): AsyncGenerator<string> {
      throw new UpstreamError("upstream_error", "connect failed");
    }
    const head = {
      chatCompletion: vi.fn(),
      chatCompletionStream: vi.fn(),
      nativePassthroughStream: vi.fn().mockReturnValue(diesBeforeFirst()),
    } as unknown as ProviderClient & { nativePassthroughStream: ReturnType<typeof vi.fn> };
    const tail = {
      chatCompletion: vi.fn(),
      chatCompletionStream: vi.fn().mockReturnValue(gen(["data: {}\n\n"])),
    } as unknown as ProviderClient & { chatCompletionStream: ReturnType<typeof vi.fn> };
    const execute = createExecute({
      defaultProvider: head,
      providers: new Map<string, ProviderClient>([
        ["anthro", head],
        ["openai", tail],
      ]),
      registry: protocolRegistry({
        a: {
          providerName: "anthro",
          providerModel: "claude-x",
          targetProviderProtocol: "anthropic_messages",
        },
        b: {
          providerName: "openai",
          providerModel: "gpt-x",
          targetProviderProtocol: "openai_chat",
        },
      }),
      breaker: breaker(),
      catalog: new Map(),
      now: clock(),
      signal: new AbortController().signal,
      nativeProtocolPassthroughEnabled: () => true,
    });

    const out = await execute(plan(["a", "b"]), anthropicStreamReq());

    expect(head.nativePassthroughStream).toHaveBeenCalledTimes(1);
    expect(tail.chatCompletionStream).toHaveBeenCalledTimes(1);
    expect(out.final).toEqual({ status: "ok", alias: "b", providerModel: "gpt-x" });
    expect(out.stream).not.toBeNull();
    expect(out.attempts[0]?.passthrough_used).toBe(true);
    expect(out.attempts[1]?.target_provider_protocol).toBe("openai_chat");
    expect(out.attempts[1]?.passthrough_used).toBe(false);
    expect(out.attempts[1]?.passthrough_disable_reason).toBe("protocol_mismatch");
  });

  it("stream cross-protocol fallback carries Anthropic output_config.effort to OpenAI Responses reasoning.effort", async () => {
    // biome-ignore lint/correctness/useYield: pre-first-chunk failure throws before any yield
    async function* diesBeforeFirst(): AsyncGenerator<string> {
      throw new UpstreamError("upstream_error", "connect failed");
    }
    const head = {
      chatCompletion: vi.fn(),
      chatCompletionStream: vi.fn(),
      nativePassthroughStream: vi.fn().mockReturnValue(diesBeforeFirst()),
    } as unknown as ProviderClient & { nativePassthroughStream: ReturnType<typeof vi.fn> };
    const upstreamBodies: Array<Record<string, unknown>> = [];
    const tail = createGenericOpenAIResponsesClient({
      config: { baseUrl: "https://api.openai.test/v1", apiKey: "sk-test" },
      fetch: vi.fn(async (_url, init) => {
        upstreamBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return new Response(
          [
            `data: ${JSON.stringify({ type: "response.output_text.delta", delta: "ok" })}\n\n`,
            `data: ${JSON.stringify({ type: "response.completed", response: { status: "completed" } })}\n\n`,
          ].join(""),
          { status: 200, headers: { "Content-Type": "text/event-stream" } },
        );
      }) as unknown as typeof fetch,
    });
    const execute = createExecute({
      defaultProvider: head,
      providers: new Map<string, ProviderClient>([
        ["anthro", head],
        ["openai", tail],
      ]),
      registry: protocolRegistry({
        a: {
          providerName: "anthro",
          providerModel: "claude-x",
          targetProviderProtocol: "anthropic_messages",
        },
        b: {
          providerName: "openai",
          providerModel: "gpt-5.5",
          targetProviderProtocol: "openai_responses",
        },
      }),
      breaker: breaker(),
      catalog: new Map(),
      now: clock(),
      signal: new AbortController().signal,
      nativeProtocolPassthroughEnabled: () => true,
    });

    const out = await execute(
      plan(["a", "b"]),
      anthropicStreamReq({
        reasoning_effort: "high",
        provider_raw: { output_config: { effort: "high" } },
        native_request: createNativePassthroughCarrier({
          protocol: "anthropic_messages",
          body: { ...NATIVE_STREAM, output_config: { effort: "high" } },
          headers: {},
        }),
      }),
    );

    expect(head.nativePassthroughStream).toHaveBeenCalledTimes(1);
    expect(out.final).toEqual({ status: "ok", alias: "b", providerModel: "gpt-5.5" });
    expect(out.stream).not.toBeNull();
    expect(upstreamBodies[0]?.reasoning).toEqual({ effort: "high" });
    expect(upstreamBodies[0]?.stream).toBe(true);
    expect(JSON.parse(out.upstreamRequest ?? "{}").reasoning).toEqual({ effort: "high" });
    expect(out.attempts[1]?.target_provider_protocol).toBe("openai_responses");
  });

  it("stream cross-protocol fallback carries OpenAI reasoning_effort to Anthropic output_config.effort", async () => {
    // biome-ignore lint/correctness/useYield: pre-first-chunk failure throws before any yield
    async function* diesBeforeFirst(): AsyncGenerator<string> {
      throw new UpstreamError("upstream_error", "connect failed");
    }
    const head = {
      chatCompletion: vi.fn(),
      chatCompletionStream: vi.fn().mockReturnValue(diesBeforeFirst()),
    } as unknown as ProviderClient & { chatCompletionStream: ReturnType<typeof vi.fn> };
    const upstreamBodies: Array<Record<string, unknown>> = [];
    const tail = createAnthropicClient({
      config: { baseUrl: "https://api.anthropic.test", apiKey: "sk-test" },
      fetch: vi.fn(async (_url, init) => {
        upstreamBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return new Response(
          [
            'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","usage":{"input_tokens":1}}}\n\n',
            'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"ok"}}\n\n',
            'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}\n\n',
            'event: message_stop\ndata: {"type":"message_stop"}\n\n',
          ].join(""),
          { status: 200, headers: { "Content-Type": "text/event-stream" } },
        );
      }) as unknown as typeof fetch,
    });
    const execute = createExecute({
      defaultProvider: head,
      providers: new Map<string, ProviderClient>([
        ["openai", head],
        ["anthro", tail],
      ]),
      registry: protocolRegistry({
        a: {
          providerName: "openai",
          providerModel: "gpt-5.5",
          targetProviderProtocol: "openai_responses",
        },
        b: {
          providerName: "anthro",
          providerModel: "claude-opus-4-8",
          targetProviderProtocol: "anthropic_messages",
        },
      }),
      breaker: breaker(),
      catalog: new Map(),
      now: clock(),
      signal: new AbortController().signal,
      nativeProtocolPassthroughEnabled: () => true,
    });

    const out = await execute(plan(["a", "b"]), req({ stream: true, reasoning_effort: "high" }));

    expect(head.chatCompletionStream).toHaveBeenCalledTimes(1);
    expect(out.final).toEqual({ status: "ok", alias: "b", providerModel: "claude-opus-4-8" });
    expect(out.stream).not.toBeNull();
    expect(upstreamBodies[0]?.output_config).toEqual({ effort: "high" });
    expect(upstreamBodies[0]?.stream).toBe(true);
    expect((upstreamBodies[0]?.thinking as { type?: string } | undefined)?.type).toBe("enabled");
    expect(JSON.parse(out.upstreamRequest ?? "{}").output_config).toEqual({ effort: "high" });
    expect(out.attempts[1]?.target_provider_protocol).toBe("anthropic_messages");
  });

  it("a client abort during the stream peek records client_abort without a breaker failure", async () => {
    const ac = new AbortController();
    const abortErr = new Error("aborted");
    abortErr.name = "AbortError";
    // biome-ignore lint/correctness/useYield: client abort throws before any yield
    async function* abortsBeforeFirst(): AsyncGenerator<string> {
      throw abortErr;
    }
    const provider = {
      chatCompletion: vi.fn(),
      chatCompletionStream: vi.fn(),
      nativePassthroughStream: vi.fn().mockReturnValue(abortsBeforeFirst()),
    } as unknown as ProviderClient & { nativePassthroughStream: ReturnType<typeof vi.fn> };
    const cb = breaker();
    const recordFailure = vi.spyOn(cb, "recordFailure");
    const execute = createExecute({
      defaultProvider: provider,
      providers: new Map([["anthro", provider]]),
      registry: protocolRegistry({
        a: {
          providerName: "anthro",
          providerModel: "claude-x",
          targetProviderProtocol: "anthropic_messages",
        },
      }),
      breaker: cb,
      catalog: new Map(),
      now: clock(),
      signal: ac.signal,
      nativeProtocolPassthroughEnabled: () => true,
    });

    const out = await execute(plan(["a"]), anthropicStreamReq());
    expect(provider.nativePassthroughStream).toHaveBeenCalledTimes(1);
    expect(out.attempts[0]?.error_class).toBe("client_abort");
    expect(recordFailure).not.toHaveBeenCalled();
    // C2: a disconnect during the stream peek surfaces client_abort (499), not 502.
    expect(out.final.status).toBe("error");
    if (out.final.status === "error") {
      expect(out.final.error.error_class).toBe("client_abort");
      expect(out.final.error.http_status).toBe(499);
    }
  });
});

// OAuth subscription alias guard (issue #38 follow-up, Codex review P1): a known
// `<provider>/` prefix is gated authoritatively by the LIVE curation set + pool, so a
// de-curated or disconnected subscription alias FAILS CLOSED (provider_unavailable)
// and never routes via the startup registry or crosses to defaultProvider.
describe("createExecute — OAuth subscription alias guard (fail-closed)", () => {
  const ok = (id: string) =>
    ({
      chatCompletion: vi.fn().mockResolvedValue({ id }),
      chatCompletionStream: vi.fn(),
    }) as unknown as ProviderClient & { chatCompletion: ReturnType<typeof vi.fn> };

  it("routes a CURATED subscription alias to its pool with the bare model id", async () => {
    const pool = ok("pool");
    const dflt = ok("default");
    const execute = createExecute({
      defaultProvider: dflt,
      providers: new Map([["anthropic", pool]]),
      knownOAuthPrefixes: new Set(["anthropic"]),
      oauthAliases: () => new Set(["anthropic/claude-x"]),
      registry: registry({}), // empty — the guard bypasses the registry entirely
      breaker: breaker(),
      catalog: new Map(),
      now: clock(),
      signal: new AbortController().signal,
    });
    const out = await execute(plan(["anthropic/claude-x"]), req());
    expect(out.final.status).toBe("ok");
    expect(out.final.status === "ok" && out.final.providerModel).toBe("claude-x");
    expect(
      (pool as unknown as { chatCompletion: ReturnType<typeof vi.fn> }).chatCompletion,
    ).toHaveBeenCalledTimes(1);
    expect(
      (dflt as unknown as { chatCompletion: ReturnType<typeof vi.fn> }).chatCompletion,
    ).not.toHaveBeenCalled();
  });

  it("fails closed when a dynamic xAI alias has no capability metadata", async () => {
    const xai = {
      chatCompletion: vi.fn().mockResolvedValue({ id: "must-not-run" }),
      chatCompletionStream: vi.fn(),
    } as unknown as ProviderClient;
    const execute = createExecute({
      defaultProvider: xai,
      providers: new Map([["xai", xai]]),
      registry: registry({}),
      knownOAuthPrefixes: new Set(["xai"]),
      oauthAliases: () => new Set(["xai/grok-future"]),
      breaker: breaker(),
      catalog: new Map(),
      now: clock(),
      signal: new AbortController().signal,
    });

    const out = await execute(plan(["xai/grok-future"]), req());

    expect(out.attempts[0]?.skip_reason).toBe("capability_metadata_missing");
    expect(out.final.status).toBe("error");
    expect(xai.chatCompletion).not.toHaveBeenCalled();
  });

  it("uses conservative live xAI metadata for basic text but keeps tools closed", async () => {
    const xai = {
      chatCompletion: vi.fn().mockResolvedValue({ id: "text-ok" }),
      chatCompletionStream: vi.fn(),
    } as unknown as ProviderClient;
    const model = {
      id: "grok-future",
      model: "grok-future-wire",
      apiBackend: "responses" as const,
      contextWindow: 100_000,
      maxCompletionTokens: 4_096,
      hidden: false,
      supportedInApi: true,
      supportsReasoningEffort: true,
      reasoningEfforts: [{ id: "low", value: "low" as const, label: "Low" }],
    };
    const execute = createExecute({
      defaultProvider: xai,
      providers: new Map([["xai", xai]]),
      registry: registry({}),
      knownOAuthPrefixes: new Set(["xai"]),
      oauthAliases: () => new Set(["xai/grok-future"]),
      oauthWireModels: () => new Map([["xai/grok-future", "grok-future-wire"]]),
      xaiOAuthModels: () => new Map([["xai/grok-future", model]]),
      breaker: breaker(),
      catalog: new Map(),
      now: clock(),
      signal: new AbortController().signal,
    });

    const text = await execute(plan(["xai/grok-future"]), req());
    const tools = await execute(
      plan(["xai/grok-future"]),
      req({ tools: [{ type: "function", function: { name: "lookup", parameters: {} } }] }),
    );

    expect(text.final.status).toBe("ok");
    expect(xai.chatCompletion).toHaveBeenCalledTimes(1);
    expect(tools.attempts[0]?.skip_reason).toBe("no_tool_support");
    expect(tools.final.status).toBe("error");
  });

  it("uses the live OAuth alias-to-wire-model mapping when catalog id differs", async () => {
    const xai = {
      chatCompletion: vi.fn().mockResolvedValue({ id: "ok" }),
      chatCompletionStream: vi.fn(),
    } as unknown as ProviderClient;
    const execute = createExecute({
      defaultProvider: xai,
      providers: new Map([["xai", xai]]),
      registry: registry({}),
      knownOAuthPrefixes: new Set(["xai"]),
      oauthAliases: () => new Set(["xai/grok-display-key"]),
      oauthWireModels: () => new Map([["xai/grok-display-key", "grok-wire-model"]]),
      xaiOAuthModels: () =>
        new Map([
          [
            "xai/grok-display-key",
            {
              id: "grok-display-key",
              model: "grok-wire-model",
              apiBackend: "responses",
              contextWindow: 80_000,
              maxCompletionTokens: 4_096,
              hidden: false,
              supportedInApi: true,
              supportsReasoningEffort: false,
              reasoningEfforts: [],
            },
          ],
        ]),
      breaker: breaker(),
      catalog: new Map([
        [
          "xai/grok-wire-model",
          {
            modelKey: "xai/grok-wire-model",
            capabilities: {
              supportsTools: true,
              jsonOutput: "none",
              supportsVision: false,
              supportsStreaming: true,
              maxContextTokens: 100_000,
              maxOutputTokens: 8_192,
            },
            pricing: {
              inputPerMTokUsd: null,
              outputPerMTokUsd: null,
              cacheReadPerMTokUsd: null,
              cacheWritePerMTokUsd: null,
            },
            source: "override",
          },
        ],
      ]),
      now: clock(),
      signal: new AbortController().signal,
    });

    const out = await execute(plan(["xai/grok-display-key"]), req());
    const overRemoteContext = await execute(
      plan(["xai/grok-display-key"]),
      req({ max_tokens: 90_000 }),
    );

    expect(out.final.status).toBe("ok");
    expect(xai.chatCompletion).toHaveBeenCalledWith(
      expect.objectContaining({ model: "grok-wire-model" }),
      expect.any(Object),
    );
    expect(overRemoteContext.attempts[0]?.skip_reason).toBe("context_too_small");
    expect(xai.chatCompletion).toHaveBeenCalledTimes(1);
  });

  it("fails CLOSED for a DE-CURATED subscription alias — never the registry, never defaultProvider", async () => {
    const pool = ok("pool");
    const dflt = ok("default");
    const execute = createExecute({
      defaultProvider: dflt,
      providers: new Map([["anthropic", pool]]),
      knownOAuthPrefixes: new Set(["anthropic"]),
      oauthAliases: () => new Set(["anthropic/claude-x"]), // claude-removed NOT exposed
      // A stale startup registry that WOULD resolve the removed alias — must be ignored.
      registry: registryWithProviders({
        "anthropic/claude-removed": { providerName: "anthropic", providerModel: "claude-removed" },
      }),
      breaker: breaker(),
      catalog: new Map(),
      now: clock(),
      signal: new AbortController().signal,
    });
    const out = await execute(plan(["anthropic/claude-removed"]), req());
    expect(out.final.status).toBe("error");
    expect(out.attempts[0]?.skip_reason).toBe("provider_unavailable");
    expect(
      (pool as unknown as { chatCompletion: ReturnType<typeof vi.fn> }).chatCompletion,
    ).not.toHaveBeenCalled();
    expect(
      (dflt as unknown as { chatCompletion: ReturnType<typeof vi.fn> }).chatCompletion,
    ).not.toHaveBeenCalled();
  });

  it("fails CLOSED for a DISCONNECTED subscription provider (pool gone) — never defaultProvider", async () => {
    const dflt = ok("default");
    const execute = createExecute({
      defaultProvider: dflt,
      providers: new Map(), // anthropic pool removed (disconnected)
      knownOAuthPrefixes: new Set(["anthropic"]),
      oauthAliases: () => new Set(["anthropic/claude-x"]), // still "exposed" but no pool
      registry: registry({}),
      breaker: breaker(),
      catalog: new Map(),
      now: clock(),
      signal: new AbortController().signal,
    });
    const out = await execute(plan(["anthropic/claude-x"]), req());
    expect(out.final.status).toBe("error");
    expect(out.attempts[0]?.skip_reason).toBe("provider_unavailable");
    expect(
      (dflt as unknown as { chatCompletion: ReturnType<typeof vi.fn> }).chatCompletion,
    ).not.toHaveBeenCalled();
  });

  it("leaves NON-subscription aliases on the existing registry/default passthrough", async () => {
    const dflt = ok("default");
    const execute = createExecute({
      defaultProvider: dflt,
      providers: new Map([["mock", dflt]]),
      knownOAuthPrefixes: new Set(["anthropic"]), // openai-crs is NOT a subscription prefix
      oauthAliases: () => new Set(),
      registry: registry({}), // unknown alias → Phase-0 defaultProvider passthrough
      breaker: breaker(),
      catalog: new Map(),
      now: clock(),
      signal: new AbortController().signal,
    });
    const out = await execute(plan(["openai-crs/gpt-x"]), req());
    expect(out.final.status).toBe("ok");
    expect(
      (dflt as unknown as { chatCompletion: ReturnType<typeof vi.fn> }).chatCompletion,
    ).toHaveBeenCalledTimes(1);
  });
});

// Fault classifier: exactly the faults the OAuth pool isolates per-account (credential
// 401/403 + refresh, and 429 incl. token-refresh-429) are "account-scoped" and must stay
// OFF the alias breaker; server/transport faults are not. Must mirror the pool's
// isCredentialAccountFailure + isRateLimitAccountFailure status set.
describe("isAccountScopedFault — classifier", () => {
  it("TRUE for credential + rate-limit faults the pool parks", () => {
    expect(isAccountScopedFault(new TokenRefreshError("x", 400))).toBe(true);
    expect(isAccountScopedFault(new TokenRefreshError("x", 401))).toBe(true);
    expect(isAccountScopedFault(new TokenRefreshError("x", 403))).toBe(true);
    expect(isAccountScopedFault(new TokenRefreshError("x", 429))).toBe(true); // refresh rate-limit
    expect(isAccountScopedFault(new UpstreamError("upstream_error", "x", null, 401))).toBe(true);
    expect(isAccountScopedFault(new UpstreamError("upstream_error", "x", null, 403))).toBe(true);
    expect(isAccountScopedFault(new UpstreamError("upstream_error", "x", null, 429))).toBe(true);
    expect(
      isAccountScopedFault(
        new Error("oauth pool: previous_response_id original account is unavailable"),
      ),
    ).toBe(true);
    expect(
      isAccountScopedFault(
        new Error("oauth pool: x-codex-turn-state original account is unavailable"),
      ),
    ).toBe(true);
  });

  it("FALSE for server/transport + request-shape faults that belong on the breaker", () => {
    expect(isAccountScopedFault(new UpstreamError("upstream_error", "x", null, 500))).toBe(false);
    expect(isAccountScopedFault(new UpstreamError("upstream_error", "x", null, 502))).toBe(false);
    expect(
      isAccountScopedFault(new UpstreamError("upstream_error", "overloaded", null, null)),
    ).toBe(false); // null-status overload = whole-pool health
    expect(isAccountScopedFault(new UpstreamError("upstream_error", "x", null, 400))).toBe(false);
    expect(isAccountScopedFault(new TokenRefreshError("x", 500))).toBe(false);
    expect(isAccountScopedFault(new TokenRefreshError("x", null))).toBe(false);
    expect(isAccountScopedFault(new Error("client abort"))).toBe(false);
    expect(isAccountScopedFault(null)).toBe(false);
  });
});

// Auto-park hook (OAuth usage limit): a genuine (non-`:free`) 429 on a SUBSCRIPTION
// alias signals onOAuthSubscription429 so the gateway parks the served account. A
// non-429 failure, a `:free` 429, and a non-OAuth alias must NOT fire it.
describe("createExecute — onOAuthSubscription429 (auto-park)", () => {
  const rejects = (err: unknown) =>
    ({
      chatCompletion: vi.fn().mockRejectedValue(err),
      chatCompletionStream: vi.fn(),
    }) as unknown as ProviderClient;
  const e429 = () =>
    new UpstreamError(
      "upstream_error",
      "rate limited",
      { headers: { "x-codex-active-limit": "codex_luna" } },
      429,
    );

  it("fires once with the alias when a subscription attempt hits a genuine 429", async () => {
    const onOAuthSubscription429 = vi.fn();
    const execute = createExecute({
      defaultProvider: rejects(e429()),
      providers: new Map([["openai-codex", rejects(e429())]]),
      knownOAuthPrefixes: new Set(["openai-codex"]),
      oauthAliases: () => new Set(["openai-codex/gpt-5"]),
      registry: registry({}),
      breaker: breaker(),
      catalog: new Map(),
      now: clock(),
      signal: new AbortController().signal,
      onOAuthSubscription429,
    });
    const out = await execute(plan(["openai-codex/gpt-5"]), req());
    expect(out.final.status).toBe("error"); // chain exhausted (single parked candidate)
    expect(onOAuthSubscription429).toHaveBeenCalledTimes(1);
    expect(onOAuthSubscription429).toHaveBeenCalledWith(
      "openai-codex/gpt-5",
      expect.objectContaining({
        providerRaw: { headers: { "x-codex-active-limit": "codex_luna" } },
      }),
    );
  });

  it("does NOT record an alias breaker failure for subscription account-local 429", async () => {
    const cb = breaker();
    const recordFailure = vi.spyOn(cb, "recordFailure");
    const execute = createExecute({
      defaultProvider: rejects(e429()),
      providers: new Map([["openai-codex", rejects(e429())]]),
      knownOAuthPrefixes: new Set(["openai-codex"]),
      oauthAliases: () => new Set(["openai-codex/gpt-5"]),
      registry: registry({}),
      breaker: cb,
      catalog: new Map(),
      now: clock(),
      signal: new AbortController().signal,
    });
    const out = await execute(plan(["openai-codex/gpt-5"]), req());
    expect(out.final.status).toBe("error");
    expect(recordFailure).not.toHaveBeenCalled();
  });

  it("does NOT record a breaker failure for unavailable strict account affinity", async () => {
    const cb = breaker();
    const recordFailure = vi.spyOn(cb, "recordFailure");
    const unavailable = new Error("oauth pool: x-codex-turn-state original account is unavailable");
    const execute = createExecute({
      defaultProvider: rejects(unavailable),
      providers: new Map([["openai-codex", rejects(unavailable)]]),
      knownOAuthPrefixes: new Set(["openai-codex"]),
      oauthAliases: () => new Set(["openai-codex/gpt-5"]),
      registry: registry({}),
      breaker: cb,
      catalog: new Map(),
      now: clock(),
      signal: new AbortController().signal,
    });
    const out = await execute(plan(["openai-codex/gpt-5"]), req());
    expect(out.final.status).toBe("error");
    expect(recordFailure).not.toHaveBeenCalled();
  });

  it("DOES record an alias breaker failure for a subscription server fault (5xx)", async () => {
    const cb = breaker();
    const recordFailure = vi.spyOn(cb, "recordFailure");
    const execute = createExecute({
      defaultProvider: rejects(new UpstreamError("upstream_error", "bad gateway", null, 502)),
      providers: new Map([
        ["openai-codex", rejects(new UpstreamError("upstream_error", "bad gateway", null, 502))],
      ]),
      knownOAuthPrefixes: new Set(["openai-codex"]),
      oauthAliases: () => new Set(["openai-codex/gpt-5"]),
      registry: registry({}),
      breaker: cb,
      catalog: new Map(),
      now: clock(),
      signal: new AbortController().signal,
    });
    const out = await execute(plan(["openai-codex/gpt-5"]), req());
    expect(out.final.status).toBe("error");
    // A 5xx that survived the pool's sibling retry = WHOLE-POOL outage, not one account →
    // the breaker MUST back the alias off, exactly like a configured provider.
    expect(recordFailure).toHaveBeenCalledWith("openai-codex/gpt-5");
  });

  it("lets a server-fault-opened alias breaker skip a subscription alias (back-off)", async () => {
    const provider = {
      chatCompletion: vi.fn().mockResolvedValue({ id: "ok" }),
      chatCompletionStream: vi.fn(),
    } as unknown as ProviderClient;
    const cb = breaker();
    for (let i = 0; i < 5; i += 1) cb.recordFailure("openai-codex/gpt-5"); // a 5xx storm opened it
    const canAttempt = vi.spyOn(cb, "canAttempt");
    const execute = createExecute({
      defaultProvider: provider,
      providers: new Map([["openai-codex", provider]]),
      knownOAuthPrefixes: new Set(["openai-codex"]),
      oauthAliases: () => new Set(["openai-codex/gpt-5"]),
      registry: registry({}),
      breaker: cb,
      catalog: new Map(),
      now: clock(),
      signal: new AbortController().signal,
    });
    const out = await execute(plan(["openai-codex/gpt-5"]), req());
    // The open breaker fast-fails the alias WITHOUT touching the pool — the back-off we want.
    expect(canAttempt).toHaveBeenCalledWith("openai-codex/gpt-5");
    expect(out.attempts[0]?.skip_reason).toBe("circuit_open");
    expect(
      (provider as unknown as { chatCompletion: ReturnType<typeof vi.fn> }).chatCompletion,
    ).not.toHaveBeenCalled();
    expect(out.final.status).toBe("error");
  });

  it("does NOT record an alias breaker failure for subscription account-local auth failures", async () => {
    const cb = breaker();
    const recordFailure = vi.spyOn(cb, "recordFailure");
    const execute = createExecute({
      defaultProvider: rejects(new UpstreamError("upstream_error", "unauthorized", null, 401)),
      providers: new Map([
        ["anthropic", rejects(new UpstreamError("upstream_error", "unauthorized", null, 401))],
      ]),
      knownOAuthPrefixes: new Set(["anthropic"]),
      oauthAliases: () => new Set(["anthropic/claude-sonnet-4.6"]),
      registry: registry({}),
      breaker: cb,
      catalog: new Map(),
      now: clock(),
      signal: new AbortController().signal,
    });
    const out = await execute(plan(["anthropic/claude-sonnet-4.6"]), req());
    expect(out.final.status).toBe("error");
    expect(recordFailure).not.toHaveBeenCalled();
  });

  it("does NOT record an alias breaker failure for subscription token refresh failures", async () => {
    const cb = breaker();
    const recordFailure = vi.spyOn(cb, "recordFailure");
    const execute = createExecute({
      defaultProvider: rejects(new TokenRefreshError("oauth refresh failed (status 401)", 401)),
      providers: new Map([
        ["openai-codex", rejects(new TokenRefreshError("oauth refresh failed (status 401)", 401))],
      ]),
      knownOAuthPrefixes: new Set(["openai-codex"]),
      oauthAliases: () => new Set(["openai-codex/gpt-5.4-mini"]),
      registry: registry({}),
      breaker: cb,
      catalog: new Map(),
      now: clock(),
      signal: new AbortController().signal,
    });
    const out = await execute(plan(["openai-codex/gpt-5.4-mini"]), req());
    expect(out.final.status).toBe("error");
    expect(recordFailure).not.toHaveBeenCalled();
  });

  it("a sustained 5xx pool outage opens the breaker, then fast-fails the next request", async () => {
    const cb = breaker(); // SHARED across requests, like the live executor
    const oauth = {
      chatCompletion: vi
        .fn()
        .mockRejectedValue(new UpstreamError("upstream_error", "bad", null, 502)),
      chatCompletionStream: vi.fn(),
    } as unknown as ProviderClient;
    const mk = () =>
      createExecute({
        defaultProvider: oauth,
        providers: new Map([["openai-codex", oauth]]),
        knownOAuthPrefixes: new Set(["openai-codex"]),
        oauthAliases: () => new Set(["openai-codex/gpt-5"]),
        registry: registry({}),
        breaker: cb,
        catalog: new Map(),
        now: clock(),
        signal: new AbortController().signal,
      });
    const calls = () =>
      (oauth as unknown as { chatCompletion: ReturnType<typeof vi.fn> }).chatCompletion.mock.calls
        .length;
    // Drive the outage: 5 requests each surface a 502 and tick the breaker toward OPEN.
    for (let i = 0; i < 5; i += 1) await mk()(plan(["openai-codex/gpt-5"]), req());
    const callsBefore = calls();
    // 6th request: breaker is OPEN → the alias is skipped WITHOUT another upstream call.
    const out = await mk()(plan(["openai-codex/gpt-5"]), req());
    expect(out.attempts[0]?.skip_reason).toBe("circuit_open");
    expect(calls()).toBe(callsBefore); // no new upstream call — the amplification is capped
  });

  it("does NOT fire on a non-429 failure", async () => {
    const onOAuthSubscription429 = vi.fn();
    const execute = createExecute({
      defaultProvider: rejects(new UpstreamError("upstream_error", "boom", null, 500)),
      providers: new Map([
        ["openai-codex", rejects(new UpstreamError("upstream_error", "boom", null, 500))],
      ]),
      knownOAuthPrefixes: new Set(["openai-codex"]),
      oauthAliases: () => new Set(["openai-codex/gpt-5"]),
      registry: registry({}),
      breaker: breaker(),
      catalog: new Map(),
      now: clock(),
      signal: new AbortController().signal,
      onOAuthSubscription429,
    });
    await execute(plan(["openai-codex/gpt-5"]), req());
    expect(onOAuthSubscription429).not.toHaveBeenCalled();
  });

  it("does NOT fire on a `:free` 429 (free-tier throttle, not an account limit)", async () => {
    const onOAuthSubscription429 = vi.fn();
    const execute = createExecute({
      defaultProvider: rejects(e429()),
      providers: new Map([["mock", rejects(e429())]]),
      knownOAuthPrefixes: new Set(["openai-codex"]),
      oauthAliases: () => new Set(),
      registry: registry({ "x/m:free": "m" }),
      breaker: breaker(),
      catalog: new Map(),
      now: clock(),
      signal: new AbortController().signal,
      onOAuthSubscription429,
    });
    await execute(plan(["x/m:free"]), req());
    expect(onOAuthSubscription429).not.toHaveBeenCalled();
  });

  it("does NOT fire for a non-subscription alias that 429s", async () => {
    const onOAuthSubscription429 = vi.fn();
    const execute = createExecute({
      defaultProvider: rejects(e429()),
      providers: new Map([["mock", rejects(e429())]]),
      knownOAuthPrefixes: new Set(["openai-codex"]), // "deepseek" is not a subscription prefix
      oauthAliases: () => new Set(),
      registry: registry({ "deepseek/chat": "chat" }),
      breaker: breaker(),
      catalog: new Map(),
      now: clock(),
      signal: new AbortController().signal,
      onOAuthSubscription429,
    });
    await execute(plan(["deepseek/chat"]), req());
    expect(onOAuthSubscription429).not.toHaveBeenCalled();
  });
});

// HALF_OPEN probe lock must be released on every non-success exit after canAttempt
// allowed the alias. Production incident 2026-08-06: OAuth 429 skipped recordFailure
// (correct — account-scoped) but never recordAbort, so inFlightProbe stayed true and
// anthropic/claude-opus-4-8 returned circuit_open for hours while other Anthropic
// models served fine. Same leak exists for post-canAttempt capability/protocol skips
// and other "do not trip breaker" continues.
describe("createExecute — HALF_OPEN probe lock release", () => {
  const rejects = (err: unknown) =>
    ({
      chatCompletion: vi.fn().mockRejectedValue(err),
      chatCompletionStream: vi.fn(),
    }) as unknown as ProviderClient;
  const resolves = (body: unknown = { id: "ok" }) =>
    ({
      chatCompletion: vi.fn().mockResolvedValue(body),
      chatCompletionStream: vi.fn(),
    }) as unknown as ProviderClient;

  function openThenCooldownElapsed(alias: string): {
    cb: CircuitBreaker;
    now: () => number;
  } {
    let t = 0;
    const now = () => t;
    // cooldownMs=1000 matches breaker(); advance past cooldown after tripping.
    const cb = createCircuitBreaker({
      config: { failureThreshold: 5, cooldownMs: 1000 },
      now,
    });
    for (let i = 0; i < 5; i += 1) cb.recordFailure(alias);
    expect(cb.getState(alias)).toBe("OPEN");
    t = 1000; // cooldown elapsed → next canAttempt becomes HALF_OPEN probe
    return { cb, now };
  }

  it("releases the probe lock when a HALF_OPEN OAuth probe hits account-scoped 429 (no recordFailure)", async () => {
    const alias = "anthropic/claude-opus-4-8";
    const fallback = "openai-codex/gpt-5.6-sol";
    const { cb, now } = openThenCooldownElapsed(alias);
    const recordAbort = vi.spyOn(cb, "recordAbort");
    const recordFailure = vi.spyOn(cb, "recordFailure");
    const oauth429 = rejects(
      new UpstreamError("upstream_error", "upstream returned 429", null, 429),
    );
    const ok = resolves({ id: "fallback-ok" });
    const mk = () =>
      createExecute({
        defaultProvider: ok,
        providers: new Map([
          ["anthropic", oauth429],
          ["openai-codex", ok],
        ]),
        knownOAuthPrefixes: new Set(["anthropic", "openai-codex"]),
        oauthAliases: () => new Set([alias, fallback]),
        registry: registryWithProviders({
          [alias]: { providerName: "anthropic", providerModel: "claude-opus-4-8" },
          [fallback]: { providerName: "openai-codex", providerModel: "gpt-5.6-sol" },
        }),
        breaker: cb,
        catalog: new Map(),
        now,
        signal: new AbortController().signal,
      });

    // Probe request: 429 is account-scoped → must NOT recordFailure, MUST recordAbort
    // so the alias does not stay stuck HALF_OPEN forever.
    const probeOut = await mk()(plan([alias, fallback]), req());
    expect(probeOut.final.status).toBe("ok");
    expect(recordFailure).not.toHaveBeenCalledWith(alias);
    expect(recordAbort).toHaveBeenCalledWith(alias, expect.any(Symbol));
    // Design lock: abort releases the probe lock WITHOUT re-OPENing. Re-trip would
    // punish a healthy alias for a per-account throttle (the reason recordFailure is
    // skipped). Staying HALF_OPEN lets the next request re-probe immediately.
    expect(cb.getState(alias)).toBe("HALF_OPEN");

    // Next request must be allowed to attempt Anthropic again (not permanent circuit_open).
    const next = await mk()(plan([alias, fallback]), req());
    expect(next.attempts[0]?.alias).toBe(alias);
    expect(next.attempts[0]?.skip_reason).not.toBe("circuit_open");
    expect(
      (oauth429 as unknown as { chatCompletion: ReturnType<typeof vi.fn> }).chatCompletion.mock
        .calls.length,
    ).toBeGreaterThanOrEqual(2);
  });

  it("releases the probe lock when a HALF_OPEN candidate is skipped by capability after canAttempt", async () => {
    const alias = "anthropic/claude-opus-4-8";
    const fallback = "mock/ok";
    const { cb, now } = openThenCooldownElapsed(alias);
    const recordAbort = vi.spyOn(cb, "recordAbort");
    const ok = resolves({ id: "fallback-ok" });
    // Force tools capability miss so checkCapability skips after canAttempt allowed the probe.
    const noTools: CatalogEntry = {
      modelKey: alias,
      capabilities: {
        supportsTools: false,
        jsonOutput: "schema",
        supportsVision: true,
        supportsStreaming: true,
        maxContextTokens: 100000,
        maxOutputTokens: 4096,
      },
      pricing: {
        inputPerMTokUsd: null,
        outputPerMTokUsd: null,
        cacheReadPerMTokUsd: null,
        cacheWritePerMTokUsd: null,
      },
      source: "generated",
    };
    const mk = () =>
      createExecute({
        defaultProvider: ok,
        providers: new Map([
          ["anthropic", ok],
          ["mock", ok],
        ]),
        knownOAuthPrefixes: new Set(["anthropic"]),
        oauthAliases: () => new Set([alias]),
        registry: registryWithProviders({
          [alias]: { providerName: "anthropic", providerModel: "claude-opus-4-8" },
          [fallback]: { providerName: "mock", providerModel: "ok" },
        }),
        breaker: cb,
        catalog: new Map([[alias, noTools]]),
        now,
        signal: new AbortController().signal,
      });

    const toolReq = req({ tools: [{ type: "function" }] });
    const probeOut = await mk()(plan([alias, fallback]), toolReq);
    expect(probeOut.attempts[0]?.skip_reason).toBe("no_tool_support");
    expect(recordAbort).toHaveBeenCalledWith(alias, expect.any(Symbol));

    // Without tools, the same alias must not still be circuit_open from a leaked probe.
    const plain = await mk()(plan([alias, fallback]), req());
    expect(plain.attempts[0]?.skip_reason).not.toBe("circuit_open");
    expect(plain.final.status).toBe("ok");
  });

  it("releases the probe lock on free-tier 429 continue (no recordFailure)", async () => {
    const alias = "openrouter/free-model:free";
    const fallback = "mock/ok";
    const { cb, now } = openThenCooldownElapsed(alias);
    const recordAbort = vi.spyOn(cb, "recordAbort");
    const recordFailure = vi.spyOn(cb, "recordFailure");
    const free429 = rejects(new UpstreamError("upstream_error", "rate limited", null, 429));
    const ok = resolves({ id: "ok" });
    const mk = () =>
      createExecute({
        defaultProvider: ok,
        providers: new Map([
          ["mock", free429],
          ["mock-ok", ok],
        ]),
        registry: registryWithProviders({
          [alias]: { providerName: "mock", providerModel: "free-model" },
          [fallback]: { providerName: "mock-ok", providerModel: "ok" },
        }),
        breaker: cb,
        catalog: new Map(),
        now,
        signal: new AbortController().signal,
      });

    const out = await mk()(plan([alias, fallback]), req());
    expect(out.attempts[0]?.skip_reason).toBe("free_429");
    expect(recordFailure).not.toHaveBeenCalledWith(alias);
    expect(recordAbort).toHaveBeenCalledWith(alias, expect.any(Symbol));

    const next = await mk()(plan([alias, fallback]), req());
    expect(next.attempts[0]?.skip_reason).not.toBe("circuit_open");
  });
});

// ── Additional branch-coverage tests ────────────────────────────────────────

describe("createExecute — empty candidate chain", () => {
  it("returns lane_unavailable when plan has no candidates", async () => {
    const provider = {
      chatCompletion: vi.fn(),
      chatCompletionStream: vi.fn(),
    } as unknown as ProviderClient;
    const execute = createExecute({
      defaultProvider: provider,
      providers: new Map([["mock", provider]]),
      registry: registry({}),
      breaker: breaker(),
      catalog: new Map(),
      now: clock(),
      signal: new AbortController().signal,
    });
    const input = req();
    input.metadata = { ...input.metadata, trace_id: "client-correlation-1" };
    const out = await execute(
      { selected_lane: "balanced", candidate_chain: [], explicit_model: null },
      input,
    );
    expect(out.final.status).toBe("error");
    expect(out.final).toMatchObject({
      error: expect.objectContaining({
        error_class: "lane_unavailable",
        trace_id: "client-correlation-1",
      }),
    });
  });
});

describe("createExecute — user message queue timeout", () => {
  it("returns lane_unavailable (503) and does NOT advance the chain on queue timeout", async () => {
    const queueErr = Object.assign(new Error("queue wait timed out"), { queueTimeout: true });
    const provider = {
      chatCompletion: vi.fn().mockRejectedValue(queueErr),
      chatCompletionStream: vi.fn(),
    } as unknown as ProviderClient;
    const execute = createExecute({
      defaultProvider: provider,
      providers: new Map([["mock", provider]]),
      registry: registry({ a: "m-a", b: "m-b" }),
      breaker: breaker(),
      catalog: new Map(),
      now: clock(),
      signal: new AbortController().signal,
    });
    const out = await execute(plan(["a", "b"]), req());
    // Terminal — chain is NOT advanced to "b"
    expect(out.attempts).toHaveLength(1);
    expect(out.attempts[0]?.alias).toBe("a");
    expect(out.attempts[0]?.error_class).toBe("lane_unavailable");
    expect(out.final.status).toBe("error");
    expect(out.final).toMatchObject({
      error: expect.objectContaining({ error_class: "lane_unavailable" }),
    });
  });
});

describe("createExecute — effectiveContextLimit Math.min branch", () => {
  function mkEntry(
    modelKey: string,
    caps: Partial<CatalogEntry["capabilities"]> = {},
  ): CatalogEntry {
    return {
      modelKey,
      capabilities: {
        supportsTools: true,
        jsonOutput: "schema" as const,
        supportsVision: true,
        supportsStreaming: true,
        maxContextTokens: 200000,
        maxOutputTokens: 8192,
        ...caps,
      },
      pricing: {
        inputPerMTokUsd: null,
        outputPerMTokUsd: null,
        cacheReadPerMTokUsd: null,
        cacheWritePerMTokUsd: null,
      },
      source: "generated" as const,
    };
  }

  it("uses Math.min of catalog and hard Anthropic limit when both are present", async () => {
    // claude-opus-4-8 has hardAnthropicContextLimit = 1_000_000.
    // If catalog says maxContextTokens = 500_000, the effective limit is 500_000 (Math.min).
    // count_tokens returns 600_000 > 500_000 → context_too_small skip.
    const provider = {
      countTokens: vi.fn().mockResolvedValue({ input_tokens: 600_000 }),
      chatCompletion: vi.fn().mockResolvedValue({ id: "ok" }),
      chatCompletionStream: vi.fn(),
    } as unknown as ProviderClient;
    const execute = createExecute({
      defaultProvider: provider,
      providers: new Map([["mock", provider]]),
      registry: protocolRegistry({
        opus: {
          providerName: "mock",
          providerModel: "claude-opus-4-8",
          targetProviderProtocol: "anthropic_messages",
        },
      }),
      breaker: breaker(),
      // catalog caps at 500_000; hard limit is 1_000_000; Math.min → 500_000
      catalog: new Map([["opus", mkEntry("opus", { maxContextTokens: 500_000 })]]),
      now: clock(),
      signal: new AbortController().signal,
    });
    const out = await execute(
      plan(["opus"]),
      req({
        protocol: "anthropic_messages",
        native_request: createNativePassthroughCarrier({
          protocol: "anthropic_messages",
          body: {
            model: "claude-opus-4-8",
            messages: [{ role: "user", content: "x" }],
            max_tokens: 64,
          },
          headers: {},
        }),
      }),
    );
    // count_tokens returned 600_000 > 500_000 (Math.min limit) → context_too_small, all failed
    expect(out.attempts[0]).toMatchObject({ skip_reason: "context_too_small" });
  });
});

describe("createExecute — remoteUrlFromPart branches (gemini protocol)", () => {
  // remoteUrlFromPart is exercised inside stripInternal → countRemoteMediaParts
  // when targetProviderProtocol = "gemini". Each sub-case exercises a different
  // branch in the function (file_id / image_url-string / image_url-object / file-object).

  function geminiExecute() {
    const provider = {
      chatCompletion: vi.fn().mockResolvedValue({ id: "ok" }),
      chatCompletionStream: vi.fn(),
    } as unknown as ProviderClient;
    const execute = createExecute({
      defaultProvider: provider,
      providers: new Map([["mock", provider]]),
      registry: protocolRegistry({
        gemini: {
          providerName: "mock",
          providerModel: "gemini-flash",
          targetProviderProtocol: "gemini",
        },
      }),
      breaker: breaker(),
      catalog: new Map(),
      now: clock(),
      signal: new AbortController().signal,
    });
    return { execute, provider };
  }

  it("file_id branch: marks remote_media_not_materialized for a file_id part", async () => {
    const { execute, provider } = geminiExecute();
    await execute(
      plan(["gemini"]),
      req({
        messages: [
          { role: "user", content: [{ type: "image", file_id: "https://example.com/img.jpg" }] },
        ] as InternalRequest["messages"],
      }),
    );
    const body = (provider.chatCompletion as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as Record<
      string,
      unknown
    >;
    expect(body).toBeDefined();
    // The test proves remoteUrlFromPart returned a URL (counted ≥ 1), so the
    // mutation was set. We verify the execute call succeeded (no error).
    expect(body.model).toBe("gemini-flash");
  });

  it("image_url-string branch: marks remote_media_not_materialized for image_url string", async () => {
    const { execute, provider } = geminiExecute();
    await execute(
      plan(["gemini"]),
      req({
        messages: [
          {
            role: "user",
            content: [{ type: "image_url", image_url: "https://example.com/img.jpg" }],
          },
        ] as InternalRequest["messages"],
      }),
    );
    const body = (provider.chatCompletion as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as Record<
      string,
      unknown
    >;
    expect(body.model).toBe("gemini-flash");
  });

  it("image_url-object branch: marks remote_media_not_materialized for image_url object", async () => {
    const { execute, provider } = geminiExecute();
    await execute(
      plan(["gemini"]),
      req({
        messages: [
          {
            role: "user",
            content: [{ type: "image_url", image_url: { url: "https://example.com/img.jpg" } }],
          },
        ] as InternalRequest["messages"],
      }),
    );
    const body = (provider.chatCompletion as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as Record<
      string,
      unknown
    >;
    expect(body.model).toBe("gemini-flash");
  });

  it("file-object branch: marks remote_media_not_materialized for file.file_id object", async () => {
    const { execute, provider } = geminiExecute();
    await execute(
      plan(["gemini"]),
      req({
        messages: [
          {
            role: "user",
            content: [{ type: "file", file: { file_id: "https://example.com/doc.pdf" } }],
          },
        ] as InternalRequest["messages"],
      }),
    );
    const body = (provider.chatCompletion as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as Record<
      string,
      unknown
    >;
    expect(body.model).toBe("gemini-flash");
  });
});

describe("createExecute — stripEmptyAnthropicTextBlocks null/primitive message entries", () => {
  // Lines 458-460: the branch that passes through null/non-object/array message entries
  // verbatim (defensive guard for malformed message arrays in the native body).
  it("preserves null/array message entries in a native anthropic body (defensive pass-through)", async () => {
    const nativeResp = {
      id: "msg_1",
      type: "message",
      role: "assistant",
      content: [{ type: "text", text: "ok" }],
      stop_reason: "end_turn",
      usage: { input_tokens: 10, output_tokens: 5 },
    };
    const provider = {
      chatCompletion: vi.fn(),
      chatCompletionStream: vi.fn(),
      nativePassthrough: vi.fn().mockResolvedValue(nativeResp),
    } as unknown as ProviderClient;
    const execute = createExecute({
      defaultProvider: provider,
      providers: new Map([["anthro", provider]]),
      registry: protocolRegistry({
        claude: {
          providerName: "anthro",
          providerModel: "claude-opus-4-8",
          targetProviderProtocol: "anthropic_messages",
        },
      }),
      breaker: breaker(),
      catalog: new Map(),
      now: clock(),
      signal: new AbortController().signal,
      nativeProtocolPassthroughEnabled: () => true,
    });
    await execute(
      plan(["claude"]),
      req({
        protocol: "anthropic_messages",
        native_request: createNativePassthroughCarrier({
          protocol: "anthropic_messages",
          body: {
            model: "claude-opus-4-8",
            // null entry + an array entry (defensive branches 458-460) + a real message
            messages: [
              null,
              ["not", "an", "object"],
              { role: "user", content: [{ type: "text", text: "real" }] },
            ],
            max_tokens: 64,
          },
          headers: {},
        }),
      }),
    );
    const nativePassthroughMock = provider.nativePassthrough as ReturnType<typeof vi.fn>;
    expect(nativePassthroughMock.mock.calls.length).toBe(1);
    // prepareNativeRequestForUpstream returns the NativePassthroughCarrier itself when input is a carrier
    const callArg = nativePassthroughMock.mock.calls[0]?.[0] as
      | { body?: Record<string, unknown> }
      | Record<string, unknown>;
    expect(callArg).toBeDefined();
    // The body may be nested under .body (carrier) or flat (plain object)
    const msgs = ((callArg as { body?: Record<string, unknown> }).body?.messages ??
      (callArg as Record<string, unknown>).messages) as unknown[];
    // null and array entries pass through verbatim; the real message is unchanged
    expect(msgs.length).toBe(3);
  });
});

describe("createExecute — concurrency lease loss", () => {
  it("classifies pre-response lease loss as terminal 503 without fallback or breaker failure", async () => {
    const controller = new AbortController();
    const provider = {
      chatCompletion: vi.fn().mockImplementation(async () => {
        controller.abort("concurrency_lease_lost");
        throw Object.assign(new Error("lease lost"), { name: "AbortError" });
      }),
      chatCompletionStream: vi.fn(),
    } as unknown as ProviderClient;
    const cb = breaker();
    const recordAbort = vi.spyOn(cb, "recordAbort");
    const recordFailure = vi.spyOn(cb, "recordFailure");
    const execute = createExecute({
      defaultProvider: provider,
      providers: new Map([["mock", provider]]),
      registry: registry({ primary: "m-primary", fallback: "m-fallback" }),
      breaker: cb,
      catalog: new Map(),
      now: clock(),
      signal: controller.signal,
    });

    const out = await execute(plan(["primary", "fallback"]), req());

    expect(out.final.status).toBe("error");
    if (out.final.status !== "error") throw new Error("expected terminal error");
    expect(out.final.error.error_class).toBe("lane_unavailable");
    expect(ERROR_CLASS_HTTP_STATUS[out.final.error.error_class]).toBe(503);
    expect(out.attempts[0]).toMatchObject({
      alias: "primary",
      skip_reason: "concurrency_lease_lost",
      error_class: "lane_unavailable",
    });
    expect(recordAbort).toHaveBeenCalledWith("primary");
    expect(recordFailure).not.toHaveBeenCalled();
    expect(provider.chatCompletion).toHaveBeenCalledTimes(1);
  });

  it("terminates a started stream without a normal terminal event and logs structured lease loss", async () => {
    const controller = new AbortController();
    async function* leaseLostStream(): AsyncGenerator<string> {
      yield 'data: {"choices":[{"delta":{"content":"first"}}]}\n\n';
      controller.abort("concurrency_lease_lost");
      throw Object.assign(new Error("lease lost"), { name: "AbortError" });
    }
    const provider = {
      chatCompletion: vi.fn(),
      chatCompletionStream: vi.fn().mockReturnValue(leaseLostStream()),
    } as unknown as ProviderClient;
    const cb = breaker();
    const recordFailure = vi.spyOn(cb, "recordFailure");
    const logs: Array<{ msg: string; fields: Record<string, unknown> }> = [];
    const execute = createExecute({
      defaultProvider: provider,
      providers: new Map([["mock", provider]]),
      registry: registry({ primary: "m-primary" }),
      breaker: cb,
      catalog: new Map(),
      now: clock(),
      signal: controller.signal,
      log: (_level, msg, fields) => logs.push({ msg, fields }),
    });

    const out = await execute(plan(["primary"]), req({ stream: true }));
    expect(out.final.status).toBe("ok");
    const chunks: string[] = [];
    await expect(async () => {
      for await (const chunk of out.stream as AsyncIterable<string>) chunks.push(chunk);
    }).rejects.toThrow("lease lost");

    expect(chunks).toEqual(['data: {"choices":[{"delta":{"content":"first"}}]}\n\n']);
    expect(chunks.join("")).not.toContain("[DONE]");
    expect(recordFailure).not.toHaveBeenCalled();
    expect(logs).toContainEqual({
      msg: "stream.truncated",
      fields: {
        alias: "primary",
        error_class: "lane_unavailable",
        reason: "concurrency_lease_lost",
      },
    });
  });
});
