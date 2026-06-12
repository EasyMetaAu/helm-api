import type { CircuitBreaker, ExecutionPlan, ProviderClient, ProviderRegistry } from "@helm/core";
import { createCircuitBreaker, UpstreamError } from "@helm/core";
import type { CatalogEntry, InternalRequest } from "@helm/shared";
import { describe, expect, it, vi } from "vitest";
import { createExecute } from "./execute.js";

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
        provider_raw: { metadata: { prompt_version: "v1" }, store: false },
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

  it("captures per-attempt error_detail (upstream status + message + raw body) on a failed attempt", async () => {
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
    });
    // ok / skipped rows must NOT carry a detail.
    expect(out.attempts[1]?.error_detail ?? null).toBeNull();
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
        supportsJsonMode: true,
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
    if (out.final.status === "error") {
      expect(out.final.error.error_class).not.toBe("all_providers_failed");
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

  // ── capability-wire: the real catalog feeds the capability filter ──────────

  // Catalog entry helper: defaults to a fully-capable, huge-context model; pass
  // overrides to make a model lack a specific capability.
  function entry(modelKey: string, caps: Partial<CatalogEntry["capabilities"]> = {}): CatalogEntry {
    return {
      modelKey,
      capabilities: {
        supportsTools: true,
        supportsJsonMode: true,
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
        ["a", entry("a", { supportsJsonMode: false })],
        ["b", entry("b", { supportsJsonMode: true })],
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
        ["a", entry("a", { supportsJsonMode: false })],
        ["b", entry("b", { supportsJsonMode: false })],
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
      catalog: new Map([["a", entry("a", { supportsJsonMode: false })]]),
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
        supportsJsonMode: true,
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
