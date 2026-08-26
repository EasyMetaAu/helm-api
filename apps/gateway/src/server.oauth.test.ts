import {
  __setWreqModuleForTesting,
  CODEX_RESPONSES_WEBSOCKET_SESSION_HEADER,
  type CodexModelInfo,
  type CodexResponsesWebSocketConnection,
  createKeyedSerialGate,
  createRuntimeMemoryCoordinator,
  createSqliteDb,
  DEFAULT_OPENAI_CODEX_CLIENT_VERSION,
  encryptSecret,
  runtimeResponseWorkAdmission,
  SqliteConfigStore,
  SqliteOAuthTokenStore,
} from "@helm/core";
import type { ProviderConfig as ProviderConfigShared } from "@helm/shared";
import { ProviderConfigSchema } from "@helm/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getAccountSettings,
  loadAccountSettings,
  setAccountSettings,
} from "./oauth/account-settings.js";
import { createCodexModelCache } from "./oauth/codex-model-cache.js";
import { createCodexModelCatalog } from "./oauth/codex-model-catalog.js";
import { createOAuthModelDiscoveryCache } from "./oauth/model-discovery-cache.js";
import { markServingAccount } from "./runtime/serving-account.js";
import {
  buildCredential,
  buildProviderClients,
  createHotCodexCompactExecutor,
  loadCodexCatalogForClientVersion,
  makeProviderFetch,
  normalizeCodexNativeClientVersion,
  type OAuthPoolReuseCache,
  type OAuthRuntimeCtx,
  resolveProviderTransportProfile,
  resolveXaiMediaEmergencyState,
  runCodexCompactProviderCall,
  synthesizeOAuthProviders,
  tlsTransportProviders,
} from "./server.js";

describe("xAI media emergency latch", () => {
  it("survives ordinary and failed restore rebuilds until a successful restore", () => {
    let disabled = resolveXaiMediaEmergencyState(false, "disable", true);
    expect(disabled).toBe(true);
    disabled = resolveXaiMediaEmergencyState(disabled, undefined, true);
    expect(disabled).toBe(true);
    disabled = resolveXaiMediaEmergencyState(disabled, "restore", false);
    expect(disabled).toBe(true);
    disabled = resolveXaiMediaEmergencyState(disabled, "restore", true);
    expect(disabled).toBe(false);
  });
});

function sseResponse(events: object[]): Response {
  const body = events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("");
  return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } });
}

// Compose a validated shared ProviderConfig (so tests exercise the real schema
// shape, not a hand-rolled object). Parse never fails for these fixtures.
function provider(raw: Record<string, unknown>): ProviderConfigShared {
  return ProviderConfigSchema.parse(raw);
}

const OAUTH_PROVIDER = provider({
  name: "claude-sub",
  type: "openai",
  base_url: "https://oauth.example.com/v1",
  oauth: {
    grant: "refresh_token",
    token_url: "https://oauth.example.com/token",
    client_id_env: "OA_CLIENT_ID",
    client_secret_env: "OA_CLIENT_SECRET",
    refresh_token_env: "OA_REFRESH_TOKEN",
  },
  models: [{ alias: "claude-sub/opus", provider_model: "claude-opus" }],
});

const KEY_PROVIDER = provider({
  name: "openai",
  type: "openai",
  base_url: "https://api.openai.com/v1",
  api_key_env: "OPENAI_API_KEY",
  models: [{ alias: "openai/gpt", provider_model: "gpt-4o" }],
});

const OAUTH_ENV = {
  OA_CLIENT_ID: "cid",
  OA_CLIENT_SECRET: "csecret",
  OA_REFRESH_TOKEN: "rtok",
};

function setEnv(env: Record<string, string>): string[] {
  const keys: string[] = [];
  for (const [k, v] of Object.entries(env)) {
    process.env[k] = v;
    keys.push(k);
  }
  return keys;
}

const ADDED_KEYS: string[] = [];
beforeEach(() => {
  runtimeResponseWorkAdmission(
    createRuntimeMemoryCoordinator({ capacityBytes: () => Number.MAX_SAFE_INTEGER }),
  );
});
afterEach(() => {
  for (const k of ADDED_KEYS.splice(0)) delete process.env[k];
  __setWreqModuleForTesting(undefined);
  vi.restoreAllMocks();
});

describe("buildCredential (issue #38 OAuth wiring)", () => {
  it("returns a static apiKey credential when api_key_env is set", () => {
    ADDED_KEYS.push(...setEnv({ OPENAI_API_KEY: "sk-static" }));
    const cred = buildCredential(KEY_PROVIDER);
    expect(cred).toEqual({ apiKey: "sk-static" });
  });

  it("returns null when a key provider's env is unset (fail-open at caller)", () => {
    const cred = buildCredential(KEY_PROVIDER);
    expect(cred).toBeNull();
  });

  it("builds a dynamic OAuth credential when all secrets are present", () => {
    ADDED_KEYS.push(...setEnv(OAUTH_ENV));
    const cred = buildCredential(OAUTH_PROVIDER);
    expect(cred).not.toBeNull();
    if (cred && "getAuthHeader" in cred) {
      expect(typeof cred.getAuthHeader).toBe("function");
      expect(typeof cred.onUnauthorized).toBe("function");
      expect(typeof cred.currentSecrets).toBe("function");
    } else {
      throw new Error("expected a dynamic OAuth credential");
    }
  });

  it("returns null when a required OAuth secret env is unset (fail-open)", () => {
    ADDED_KEYS.push(...setEnv({ OA_CLIENT_ID: "cid", OA_CLIENT_SECRET: "csecret" }));
    // refresh_token_env missing for a refresh_token grant → cannot build.
    const cred = buildCredential(OAUTH_PROVIDER);
    expect(cred).toBeNull();
  });
});

describe("buildProviderClients (issue #38 OAuth wiring)", () => {
  it("captures the compact wire request and actual serving account before reporting execution", async () => {
    const onExecution = vi.fn();
    const signal = new AbortController().signal;
    const result = await runCodexCompactProviderCall({
      execute: async (options) => {
        markServingAccount("openai-codex", "docker-live");
        options.captureUpstream('{"model":"gpt-5.6-terra","input":"compact this"}');
        return { id: "resp_compact" };
      },
      signal,
      modelAlias: "openai-codex/gpt-5.6-terra",
      providerModel: "gpt-5.6-terra",
      providerName: "openai-codex",
      onExecution,
    });

    expect(result).toEqual({ id: "resp_compact" });
    expect(onExecution).toHaveBeenCalledWith({
      modelAlias: "openai-codex/gpt-5.6-terra",
      providerModel: "gpt-5.6-terra",
      providerName: "openai-codex",
      upstreamRequest: '{"model":"gpt-5.6-terra","input":"compact this"}',
      servingAccount: { providerId: "openai-codex", account: "docker-live" },
    });
  });

  it("reports the compact execution context when the provider call fails", async () => {
    const onExecution = vi.fn();

    await expect(
      runCodexCompactProviderCall({
        execute: async (options) => {
          markServingAccount("openai-codex", "docker-live");
          options.captureUpstream('{"model":"gpt-5.6-luna"}');
          throw new Error("compact failed");
        },
        signal: new AbortController().signal,
        modelAlias: "openai-codex/gpt-5.6-luna",
        providerModel: "gpt-5.6-luna",
        providerName: "openai-codex",
        onExecution,
      }),
    ).rejects.toThrow("compact failed");
    expect(onExecution).toHaveBeenCalledWith({
      modelAlias: "openai-codex/gpt-5.6-luna",
      providerModel: "gpt-5.6-luna",
      providerName: "openai-codex",
      upstreamRequest: '{"model":"gpt-5.6-luna"}',
      servingAccount: { providerId: "openai-codex", account: "docker-live" },
    });
  });

  it("resolves the current compact provider client on every call", async () => {
    let currentClient: { responsesCompact?: ReturnType<typeof vi.fn> } | null = null;
    const execute = createHotCodexCompactExecutor(
      () => currentClient,
      () => new Error("compact unavailable"),
    );
    const carrier = {
      protocol: "openai_responses" as const,
      body: { model: "gpt-5.6-sol", input: [] },
      headers: {},
      mutations: {},
    };

    await expect(
      execute(carrier, {
        signal: new AbortController().signal,
        captureUpstream: vi.fn(),
      }),
    ).rejects.toThrow("compact unavailable");

    const first = vi.fn().mockResolvedValue({ output: [{ type: "compaction_summary" }] });
    currentClient = { responsesCompact: first };
    await expect(
      execute(carrier, {
        signal: new AbortController().signal,
        captureUpstream: vi.fn(),
      }),
    ).resolves.toEqual({ output: [{ type: "compaction_summary" }] });
    expect(first).toHaveBeenCalledOnce();

    const refreshed = vi.fn().mockResolvedValue({ output: [{ type: "compaction_summary_v2" }] });
    currentClient = { responsesCompact: refreshed };
    await expect(
      execute(carrier, {
        signal: new AbortController().signal,
        captureUpstream: vi.fn(),
      }),
    ).resolves.toEqual({ output: [{ type: "compaction_summary_v2" }] });
    expect(first).toHaveBeenCalledOnce();
    expect(refreshed).toHaveBeenCalledOnce();
  });

  it("normalizes inbound Codex request versions before the provider boundary", () => {
    const carrier = {
      protocol: "openai_responses" as const,
      body: { model: "gpt-5.6-sol", input: [] },
      headers: {
        version: "0.145.0-alpha.4",
        "x-codex-client-version": "9.9.9",
        accept: "text/event-stream",
      },
      mutations: {},
    };

    expect(normalizeCodexNativeClientVersion(carrier)).toEqual({
      ...carrier,
      headers: {
        version: "0.145.0",
        accept: "text/event-stream",
      },
    });
    expect(
      normalizeCodexNativeClientVersion({
        ...carrier,
        headers: { version: "latest", accept: "text/event-stream" },
      }),
    ).toEqual({
      ...carrier,
      headers: { accept: "text/event-stream" },
    });
  });

  it("builds an OAuth client that requests with a fetched Bearer", async () => {
    ADDED_KEYS.push(...setEnv(OAUTH_ENV));
    // Intercept BOTH the token endpoint and the chat endpoint.
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (input: Parameters<typeof fetch>[0]) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url.includes("/token")) {
          return new Response(JSON.stringify({ access_token: "fetched-at", expires_in: 3600 }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        return new Response(JSON.stringify({ id: "ok" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      });
    const clients = buildProviderClients([OAUTH_PROVIDER], "https://fallback/v1", 60_000);
    const client = clients.get("claude-sub");
    expect(client).toBeDefined();
    await client?.chatCompletion({ model: "m" });
    // Find the chat call and assert it carried the fetched Bearer.
    const chatCall = fetchSpy.mock.calls.find(
      (c) => typeof c[0] === "string" && (c[0] as string).includes("/chat/completions"),
    );
    expect(chatCall).toBeDefined();
    const init = chatCall?.[1] as RequestInit & { headers: Record<string, string> };
    expect(init.headers.Authorization).toBe("Bearer fetched-at");
  });

  it("skips an OAuth provider whose secret is unset but keeps the others (fail-open)", () => {
    ADDED_KEYS.push(...setEnv({ OPENAI_API_KEY: "sk-static" }));
    // OAUTH_ENV intentionally NOT set → the OAuth provider is skipped.
    const clients = buildProviderClients(
      [KEY_PROVIDER, OAUTH_PROVIDER],
      "https://fallback/v1",
      60_000,
    );
    expect(clients.has("openai")).toBe(true);
    expect(clients.has("claude-sub")).toBe(false);
  });

  it("threads the provider developer-role compatibility flag into OpenAI-compatible clients", async () => {
    ADDED_KEYS.push(...setEnv({ DEEPSEEK_API_KEY: "sk-deepseek" }));
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    const deepseek = provider({
      name: "deepseek",
      type: "openai",
      base_url: "https://api.deepseek.com/v1",
      api_key_env: "DEEPSEEK_API_KEY",
      map_developer_role_to_system: true,
      models: [{ alias: "deepseek/deepseek-v4-flash", provider_model: "deepseek-v4-flash" }],
    });

    const clients = buildProviderClients([deepseek], "https://fallback/v1", 60_000);
    await clients.get("deepseek")?.chatCompletion({
      model: "deepseek-v4-flash",
      messages: [{ role: "developer", content: "Be concise." }],
    });

    const init = fetchSpy.mock.calls[0]?.[1] as RequestInit;
    expect(JSON.parse(init.body as string)).toMatchObject({
      messages: [{ role: "system", content: "Be concise." }],
    });
  });

  it("uses TLS impersonation fetch for opted-in Anthropic preset OAuth execution", async () => {
    const { ctx } = oauthStores();
    await seedAnthropic(ctx, "default");
    const wreqCalls: Array<{ transport: unknown; url: string; init: Record<string, unknown> }> = [];
    const transport = { close: vi.fn() };
    __setWreqModuleForTesting({
      createTransport: async (transportOptions) => {
        wreqCalls.push({ transport: transportOptions, url: "createTransport", init: {} });
        return transport;
      },
      fetch: async (url, init = {}) => {
        wreqCalls.push({ transport: init.transport, url, init });
        return new Response(
          JSON.stringify({
            id: "msg_1",
            type: "message",
            role: "assistant",
            model: "claude-opus",
            content: [{ type: "text", text: "ok" }],
            stop_reason: "end_turn",
            usage: { input_tokens: 1, output_tokens: 1 },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      },
    });
    const anthropic = provider({
      name: "anthropic",
      type: "anthropic",
      base_url: "https://api.anthropic.com",
      oauth: { provider: "anthropic", account: "default" },
      transport_profile: "tls_chrome",
      models: [{ alias: "anthropic/opus", provider_model: "claude-opus" }],
    });

    const clients = buildProviderClients([anthropic], "https://fallback/v1", 60_000, ctx);
    await clients.get("anthropic")?.chatCompletion({
      model: "claude-opus",
      messages: [{ role: "user", content: "hello" }],
    });

    expect(wreqCalls).toHaveLength(2);
    expect(wreqCalls[0]?.transport).toMatchObject({ browser: "chrome_142", os: "macos" });
    expect(wreqCalls[1]?.transport).toBe(transport);
    expect(wreqCalls[1]?.url).toBe("https://api.anthropic.com/v1/messages");
    expect(wreqCalls[1]?.init.cookieMode).toBe("ephemeral");
    const headers = wreqCalls[1]?.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer access-default");
  });

  it("auto-enables TLS transport only for Anthropic preset OAuth providers", () => {
    const anthropic = provider({
      name: "anthropic",
      type: "anthropic",
      base_url: "https://api.anthropic.com",
      oauth: { provider: "anthropic", account: "default" },
      models: [{ alias: "anthropic/opus", provider_model: "claude-opus" }],
    });

    expect(resolveProviderTransportProfile(anthropic)).toBe("tls_chrome");
    expect(resolveProviderTransportProfile(KEY_PROVIDER)).toBe("default");
  });

  it("lets explicit default opt Anthropic preset OAuth out of TLS transport", () => {
    const anthropic = provider({
      name: "anthropic",
      type: "anthropic",
      base_url: "https://api.anthropic.com",
      oauth: { provider: "anthropic", account: "default" },
      transport_profile: "default",
      models: [{ alias: "anthropic/opus", provider_model: "claude-opus" }],
    });

    expect(resolveProviderTransportProfile(anthropic)).toBe("default");
  });

  it("rejects explicit TLS transport on unsupported providers", () => {
    const unsupported = provider({
      name: "static-anthropic",
      type: "anthropic",
      base_url: "https://api.anthropic.com",
      api_key_env: "ANTHROPIC_API_KEY",
      transport_profile: "tls_chrome",
      models: [{ alias: "anthropic/opus", provider_model: "claude-opus" }],
    });

    expect(() => makeProviderFetch(unsupported)).toThrow(/Anthropic preset OAuth/);
  });

  it("tlsTransportProviders lists only the providers that resolve to tls_chrome", () => {
    const anthropicAuto = provider({
      name: "anthropic",
      type: "anthropic",
      base_url: "https://api.anthropic.com",
      oauth: { provider: "anthropic", account: "default" },
      models: [{ alias: "anthropic/opus", provider_model: "claude-opus" }],
    });
    const anthropicOptedOut = provider({
      name: "anthropic-undici",
      type: "anthropic",
      base_url: "https://api.anthropic.com",
      oauth: { provider: "anthropic", account: "default" },
      transport_profile: "default",
      models: [{ alias: "anthropic-undici/opus", provider_model: "claude-opus" }],
    });

    expect(
      tlsTransportProviders([anthropicAuto, anthropicOptedOut, KEY_PROVIDER, OAUTH_PROVIDER]),
    ).toEqual(["anthropic"]);
    expect(tlsTransportProviders([KEY_PROVIDER, OAUTH_PROVIDER])).toEqual([]);
  });
});

// ── synthesizeOAuthProviders (Stage 3: priority + round-robin account pool) ────
// Anthropic discovers its models from the CURATED list (offline — no network), so
// a far-future access-token expiry makes the whole synthesis run without touching
// the network. Two bound accounts → ONE synthetic provider exposing the UNION of
// their enabled models, served by ONE pool client keyed by providerId.
const ENC_KEY = Buffer.alloc(32, 7);
const FAR_FUTURE = 9_999_999_999_999; // ms epoch well past any clock skew → no refresh

function oauthStores(): { ctx: OAuthRuntimeCtx; config: SqliteConfigStore } {
  const db = createSqliteDb(":memory:");
  return {
    ctx: { store: new SqliteOAuthTokenStore(db), encKey: ENC_KEY },
    config: new SqliteConfigStore(db),
  };
}

async function seedAnthropic(ctx: OAuthRuntimeCtx, account: string): Promise<void> {
  await ctx.store.upsert({
    providerId: "anthropic",
    account,
    accessEnc: encryptSecret(`access-${account}`, ENC_KEY),
    refreshEnc: encryptSecret(`refresh-${account}`, ENC_KEY),
    expiresAt: FAR_FUTURE,
    meta: null,
    updatedAt: 1,
  });
}

async function seedXai(
  ctx: OAuthRuntimeCtx,
  account: string,
  expiresAt = FAR_FUTURE,
  tier?: unknown,
): Promise<void> {
  const access =
    tier === undefined
      ? `xai-access-${account}`
      : codexJwt({ sub: `xai-user-${account}`, email: `${account}@example.test`, tier });
  await ctx.store.upsert({
    providerId: "xai",
    account,
    accessEnc: encryptSecret(access, ENC_KEY),
    refreshEnc: encryptSecret(`xai-refresh-${account}`, ENC_KEY),
    expiresAt,
    meta: JSON.stringify({
      tokenEndpoint: "https://auth.x.ai/oauth2/token",
      accountId: `xai-user-${account}`,
      email: `${account}@example.test`,
    }),
    updatedAt: 1,
  });
}

function codexModel(slug: string, overrides: Partial<CodexModelInfo> = {}): CodexModelInfo {
  return {
    slug,
    display_name: slug,
    description: null,
    default_reasoning_level: "medium",
    supported_reasoning_levels: [{ effort: "medium", description: "medium" }],
    shell_type: "shell_command",
    visibility: "list",
    supported_in_api: true,
    priority: 1,
    additional_speed_tiers: [],
    service_tiers: [],
    default_service_tier: null,
    availability_nux: null,
    upgrade: null,
    base_instructions: "You are Codex.",
    model_messages: null,
    include_skills_usage_instructions: false,
    supports_reasoning_summaries: true,
    default_reasoning_summary: "none",
    support_verbosity: true,
    default_verbosity: "low",
    apply_patch_tool_type: "freeform",
    web_search_tool_type: "text_and_image",
    truncation_policy: { mode: "tokens", limit: 10_000 },
    supports_parallel_tool_calls: true,
    supports_image_detail_original: true,
    context_window: 372_000,
    max_context_window: 372_000,
    auto_compact_token_limit: null,
    comp_hash: "3000",
    effective_context_window_percent: 95,
    experimental_supported_tools: [],
    input_modalities: ["text", "image"],
    supports_search_tool: true,
    use_responses_lite: false,
    auto_review_model_override: null,
    tool_mode: "code_mode_only",
    multi_agent_version: "v2",
    ...overrides,
  };
}

function codexJwt(payload: Record<string, unknown>): string {
  const segment = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${segment({ alg: "none" })}.${segment(payload)}.sig`;
}

describe("synthesizeOAuthProviders (Stage 3 account pool)", () => {
  const noop = () => {};
  const mediaModels = [
    {
      alias: "xai/grok-imagine-image",
      provider_model: "grok-imagine-image",
    },
    {
      alias: "xai/grok-imagine-image-quality",
      provider_model: "grok-imagine-image-quality",
    },
    {
      alias: "xai/grok-imagine-video-1.5-preview",
      provider_model: "grok-imagine-video-1.5-preview",
    },
    { alias: "xai/grok-imagine-video", provider_model: "grok-imagine-video" },
  ];
  const runInBackground = (task: () => Promise<unknown>) => {
    void task();
    return true;
  };
  const xaiMediaQuotaSeeds = (...accounts: string[]) =>
    new Map(
      accounts.map((account) => [
        `xai ${account}`,
        {
          windows: [
            {
              key: "7d",
              usedPercent: 1,
              resetsAtMs: Date.now() + 7 * 24 * 60 * 60_000,
              windowMinutes: 7 * 24 * 60,
            },
          ],
          capturedAt: Date.now(),
          usageLimitedUntilMs: null,
        },
      ]),
    );

  it("refreshes a subscription token before the request-timeout lease begins", async () => {
    const { ctx, config } = oauthStores();
    await seedXai(ctx, "lease", Date.now() + 90_000);
    const refreshedAccess = codexJwt({ sub: "xai-user-lease", email: "lease@example.test" });
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
      const target = String(url);
      if (target === "https://auth.x.ai/oauth2/token") {
        return Response.json({
          access_token: refreshedAccess,
          refresh_token: "xai-refresh-rotated",
          expires_in: 3_600,
        });
      }
      if (target.endsWith("/models")) {
        expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${refreshedAccess}`);
        return Response.json({
          data: [{ id: "grok-4.5", apiBackend: "responses", streamToolCalls: true }],
        });
      }
      throw new Error(`unexpected URL ${target}`);
    });

    await synthesizeOAuthProviders([], ctx, config, "https://fallback/v1", 60_000, noop);
    expect(fetchMock).toHaveBeenCalledWith("https://auth.x.ai/oauth2/token", expect.any(Object));
  });

  it("routes xAI subscription OAuth through the generic Responses proxy by default", async () => {
    const { ctx, config } = oauthStores();
    await seedXai(ctx, "heavy", FAR_FUTURE, 1);
    const heavyAccess = codexJwt({
      sub: "xai-user-heavy",
      email: "heavy@example.test",
      tier: 1,
    });
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
      if (String(url).endsWith("/models")) {
        return new Response(
          JSON.stringify({
            data: [
              {
                id: "grok-composer-2.5-fast",
                apiBackend: "responses",
                streamToolCalls: true,
                maxCompletionTokens: 32_768,
              },
            ],
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        );
      }
      expect(String(url)).toBe("https://cli-chat-proxy.grok.com/v1/responses");
      const headers = new Headers(init?.headers);
      expect(headers.get("Authorization")).toBe(`Bearer ${heavyAccess}`);
      expect(headers.get("chatgpt-account-id")).toBeNull();
      expect(headers.get("X-XAI-Token-Auth")).toBe("xai-grok-cli");
      expect(headers.get("x-authenticateresponse")).toBe("authenticate-response");
      expect(headers.get("x-grok-client-version")).toBe("0.2.101");
      expect(headers.get("x-grok-user-id")).toBe("xai-user-heavy");
      expect(headers.get("x-grok-model-override")).toBe("grok-composer-2.5-fast");
      expect(headers.get("Accept")).toBe("text/event-stream");
      expect(JSON.parse(String(init?.body))).toEqual({
        model: "grok-composer-2.5-fast",
        instructions: "You are a helpful assistant.",
        input: "hello",
        include: ["reasoning.encrypted_content"],
        stream_tool_calls: true,
        max_output_tokens: 32_768,
        stream: true,
        store: false,
      });
      return sseResponse([
        { type: "response.created", response: { id: "resp-grok" } },
        {
          type: "response.completed",
          response: { id: "resp-grok", object: "response", status: "completed", output: [] },
        },
      ]);
    });

    const enabled = await synthesizeOAuthProviders(
      [],
      ctx,
      config,
      "https://fallback/v1",
      60_000,
      noop,
      undefined,
      undefined,
      xaiMediaQuotaSeeds("heavy"),
    );
    expect(enabled.providers[0]).toMatchObject({
      name: "xai",
      type: "openai-responses-generic",
      base_url: "https://cli-chat-proxy.grok.com/v1",
      targetProviderProtocol: "openai_responses",
      models: [
        { alias: "xai/grok-composer-2.5-fast", provider_model: "grok-composer-2.5-fast" },
        ...mediaModels,
      ],
    });
    expect(enabled.poolClients.has("xai")).toBe(true);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://cli-chat-proxy.grok.com/v1/models",
      expect.any(Object),
    );
    await expect(
      enabled.poolClients
        .get("xai")
        ?.nativePassthrough?.({ model: "grok-composer-2.5-fast", input: "hello" }),
    ).resolves.toMatchObject({ id: "resp-grok", status: "completed" });
  });

  it("synthesizes Grok Imagine aliases and routes media through api.x.ai with the same OAuth bearer", async () => {
    const { ctx, config } = oauthStores();
    await seedXai(ctx, "media", FAR_FUTURE, 1);
    const mediaAccess = codexJwt({
      sub: "xai-user-media",
      email: "media@example.test",
      tier: 1,
    });
    const calls: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
      const target = String(url);
      calls.push(`${init?.method ?? "GET"} ${target}`);
      if (target.endsWith("/models")) {
        return Response.json({ data: [{ id: "grok-4.5", apiBackend: "responses" }] });
      }
      const headers = new Headers(init?.headers);
      expect(headers.get("Authorization")).toBe(`Bearer ${mediaAccess}`);
      if (target === "https://api.x.ai/v1/images/generations") {
        expect(JSON.parse(String(init?.body))).toMatchObject({
          model: "grok-imagine-image-quality",
          prompt: "draw",
        });
        return Response.json({ data: [{ b64_json: "image" }] });
      }
      if (target === "https://api.x.ai/v1/videos/generations") {
        return Response.json({ request_id: "video_1" });
      }
      if (target === "https://api.x.ai/v1/videos/extensions") {
        return Response.json({ request_id: "video_2" });
      }
      if (target === "https://api.x.ai/v1/videos/video_1") {
        return Response.json({ status: "done", video: { url: "https://cdn.test/video" } });
      }
      throw new Error(`unexpected URL ${target}`);
    });

    const enabled = await synthesizeOAuthProviders(
      [],
      ctx,
      config,
      "https://fallback/v1",
      60_000,
      noop,
      undefined,
      undefined,
      xaiMediaQuotaSeeds("media"),
    );
    expect(enabled.providers[0]?.models).toEqual(
      expect.arrayContaining([
        {
          alias: "xai/grok-imagine-image",
          provider_model: "grok-imagine-image",
        },
        {
          alias: "xai/grok-imagine-image-quality",
          provider_model: "grok-imagine-image-quality",
        },
        {
          alias: "xai/grok-imagine-video-1.5-preview",
          provider_model: "grok-imagine-video-1.5-preview",
        },
        { alias: "xai/grok-imagine-video", provider_model: "grok-imagine-video" },
      ]),
    );
    const pool = enabled.poolClients.get("xai");
    await expect(
      pool?.imageGeneration?.({ model: "grok-imagine-image-quality", prompt: "draw" }),
    ).resolves.toEqual({ data: [{ b64_json: "image" }] });
    await expect(
      pool?.videoGeneration?.({ model: "grok-imagine-video", prompt: "move" }),
    ).resolves.toEqual({ request_id: "video_1" });
    await expect(
      pool?.videoExtension?.({
        model: "grok-imagine-video",
        prompt: "continue",
        video: { url: "https://cdn.test/source.mp4" },
        duration: 30,
      }),
    ).resolves.toEqual({ request_id: "video_2" });
    await expect(
      pool?.videoRetrieve?.("video_1", { providerAccount: "media" }),
    ).resolves.toMatchObject({ status: "done" });
    expect(calls).toContain("POST https://api.x.ai/v1/images/generations");
    expect(calls).toContain("POST https://api.x.ai/v1/videos/generations");
    expect(calls).toContain("POST https://api.x.ai/v1/videos/extensions");
    expect(calls).toContain("GET https://api.x.ai/v1/videos/video_1");
  });

  it("keeps xAI text routable but omits media without positive persisted billing evidence", async () => {
    const { ctx, config } = oauthStores();
    await seedXai(ctx, "free-or-unknown");
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({ data: [{ id: "grok-4.5", apiBackend: "responses" }] }),
    );

    const enabled = await synthesizeOAuthProviders(
      [],
      ctx,
      config,
      "https://fallback/v1",
      60_000,
      noop,
      undefined,
      undefined,
      new Map(),
    );

    expect((enabled.providers[0]?.models ?? []).map((model) => model.alias)).toEqual([
      "xai/grok-4.5",
    ]);
  });

  it("keeps xAI text routable but omits media when fresh billing has no known paid tier", async () => {
    const { ctx, config } = oauthStores();
    await seedXai(ctx, "opaque-tier");
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({ data: [{ id: "grok-4.5", apiBackend: "responses" }] }),
    );

    const enabled = await synthesizeOAuthProviders(
      [],
      ctx,
      config,
      "https://fallback/v1",
      60_000,
      noop,
      undefined,
      undefined,
      xaiMediaQuotaSeeds("opaque-tier"),
    );

    expect((enabled.providers[0]?.models ?? []).map((model) => model.alias)).toEqual([
      "xai/grok-4.5",
    ]);
  });

  it("removes synthesized xAI media at runtime when its billing evidence TTL expires", async () => {
    const nowMs = Date.parse("2026-08-18T00:00:00Z");
    const now = vi.spyOn(Date, "now").mockReturnValue(nowMs);
    const { ctx, config } = oauthStores();
    await seedXai(ctx, "expiring-media", FAR_FUTURE, 1);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({ data: [{ id: "grok-4.5", apiBackend: "responses" }] }),
    );

    const enabled = await synthesizeOAuthProviders(
      [],
      ctx,
      config,
      "https://fallback/v1",
      60_000,
      noop,
      undefined,
      undefined,
      new Map([
        [
          "xai expiring-media",
          {
            windows: [
              {
                key: "7d",
                usedPercent: 1,
                resetsAtMs: nowMs + 7 * 24 * 60 * 60_000,
                windowMinutes: 7 * 24 * 60,
              },
            ],
            capturedAt: nowMs,
            usageLimitedUntilMs: null,
          },
        ],
      ]),
    );
    const pool = enabled.poolClients.get("xai");
    expect(pool?.hasAvailableModel("grok-imagine-image")).toBe(true);

    now.mockReturnValue(nowMs + 24 * 60 * 60_000);
    expect(pool?.hasAvailableModel("grok-imagine-image")).toBe(false);
    expect(pool?.hasAvailableModel("grok-4.5")).toBe(true);
  });

  it("never serves media from an unentitled sibling in a mixed xAI pool", async () => {
    const { ctx, config } = oauthStores();
    await seedXai(ctx, "entitled", FAR_FUTURE, 1);
    await seedXai(ctx, "unknown");
    const mediaAuth: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
      const target = String(url);
      if (target.endsWith("/models")) {
        return Response.json({ data: [{ id: "grok-4.5", apiBackend: "responses" }] });
      }
      if (target === "https://api.x.ai/v1/images/generations") {
        mediaAuth.push(new Headers(init?.headers).get("authorization") ?? "");
        throw new Error("stop after account selection");
      }
      throw new Error(`unexpected URL ${target}`);
    });

    const enabled = await synthesizeOAuthProviders(
      [],
      ctx,
      config,
      "https://fallback/v1",
      60_000,
      noop,
      undefined,
      undefined,
      xaiMediaQuotaSeeds("entitled"),
    );

    await expect(
      enabled.poolClients
        .get("xai")
        ?.imageGeneration?.({ model: "grok-imagine-image", prompt: "draw" }),
    ).rejects.toThrow();
    expect(mediaAuth).toEqual([
      `Bearer ${codexJwt({
        sub: "xai-user-entitled",
        email: "entitled@example.test",
        tier: 1,
      })}`,
    ]);
  });

  it("honors each xAI account's manual media allowlist", async () => {
    const { ctx, config } = oauthStores();
    await seedXai(ctx, "media-enabled", FAR_FUTURE, 1);
    await seedXai(ctx, "text-only", FAR_FUTURE, 1);
    await setAccountSettings(config, ENC_KEY, "xai", "media-enabled", {
      modelsMode: "manual",
      enabledModels: ["grok-imagine-image-quality"],
    });
    await setAccountSettings(config, ENC_KEY, "xai", "text-only", {
      modelsMode: "manual",
      enabledModels: ["grok-4.5"],
    });
    const mediaAuth: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
      const target = String(url);
      if (target.endsWith("/models")) {
        return Response.json({ data: [{ id: "grok-4.5", apiBackend: "responses" }] });
      }
      if (target === "https://api.x.ai/v1/images/generations") {
        mediaAuth.push(new Headers(init?.headers).get("authorization") ?? "");
        return Response.json({ data: [{ b64_json: "image" }] });
      }
      throw new Error(`unexpected URL ${target}`);
    });

    const enabled = await synthesizeOAuthProviders(
      [],
      ctx,
      config,
      "https://fallback/v1",
      60_000,
      noop,
      undefined,
      undefined,
      xaiMediaQuotaSeeds("media-enabled", "text-only"),
    );

    expect((enabled.providers[0]?.models ?? []).map((model) => model.alias)).toEqual([
      "xai/grok-imagine-image-quality",
      "xai/grok-4.5",
    ]);
    await enabled.poolClients
      .get("xai")
      ?.imageGeneration?.({ model: "grok-imagine-image-quality", prompt: "draw" });
    expect(mediaAuth).toEqual([
      `Bearer ${codexJwt({
        sub: "xai-user-media-enabled",
        email: "media-enabled@example.test",
        tier: 1,
      })}`,
    ]);
  });

  it("refreshes x-grok-user-id from current xAI credential metadata on a 401 retry", async () => {
    const { ctx, config } = oauthStores();
    await seedXai(ctx, "heavy");
    const refreshedAccess = codexJwt({ sub: "xai-user-refreshed", email: "new@example.test" });
    let inferenceAttempt = 0;
    const inferenceBodies: Array<Record<string, unknown>> = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
      const target = String(url);
      if (target.endsWith("/models")) {
        return Response.json({
          data: [
            {
              id: "grok-4.5",
              apiBackend: "responses",
              streamToolCalls: true,
              maxCompletionTokens: 16_384,
            },
          ],
        });
      }
      if (target === "https://auth.x.ai/oauth2/token") {
        return Response.json({
          access_token: refreshedAccess,
          refresh_token: "xai-refresh-rotated",
          expires_in: 3_600,
        });
      }
      expect(target).toBe("https://cli-chat-proxy.grok.com/v1/responses");
      inferenceAttempt += 1;
      inferenceBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      const headers = new Headers(init?.headers);
      if (inferenceAttempt === 1) {
        expect(headers.get("Authorization")).toBe("Bearer xai-access-heavy");
        expect(headers.get("x-grok-user-id")).toBe("xai-user-heavy");
        return new Response(null, { status: 401 });
      }
      expect(headers.get("Authorization")).toBe(`Bearer ${refreshedAccess}`);
      expect(headers.get("x-grok-user-id")).toBe("xai-user-refreshed");
      return sseResponse([
        { type: "response.created", response: { id: "resp-refreshed" } },
        {
          type: "response.completed",
          response: { id: "resp-refreshed", object: "response", status: "completed", output: [] },
        },
      ]);
    });

    const enabled = await synthesizeOAuthProviders(
      [],
      ctx,
      config,
      "https://fallback/v1",
      60_000,
      noop,
    );
    await expect(
      enabled.poolClients.get("xai")?.nativePassthrough?.({ model: "grok-4.5", input: "hello" }),
    ).resolves.toMatchObject({ id: "resp-refreshed", status: "completed" });
    expect(inferenceAttempt).toBe(2);
    expect(inferenceBodies).toEqual([
      expect.objectContaining({ stream_tool_calls: true, max_output_tokens: 16_384 }),
      expect.objectContaining({ stream_tool_calls: true, max_output_tokens: 16_384 }),
    ]);
  });

  it("routes an xAI catalog id with the distinct first-party wire model", async () => {
    const { ctx, config } = oauthStores();
    await seedXai(ctx, "heavy");
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
      if (String(url).endsWith("/models")) {
        const headers = new Headers(init?.headers);
        expect(headers.get("x-userid")).toBe("xai-user-heavy");
        expect(headers.get("x-email")).toBe("heavy@example.test");
        expect(headers.get("x-grok-client-mode")).toBe("headless");
        expect(headers.get("x-authenticateresponse")).toBeNull();
        expect(headers.get("x-grok-model-override")).toBeNull();
        return Response.json({
          data: [
            {
              id: "grok-display-key",
              model: "grok-wire-model",
              apiBackend: "responses",
              contextWindow: 500_000,
            },
            { id: "grok-chat", model: "grok-chat-wire", apiBackend: "chat_completions" },
          ],
        });
      }
      expect(String(url)).toBe("https://cli-chat-proxy.grok.com/v1/responses");
      expect(new Headers(init?.headers).get("x-grok-model-override")).toBe("grok-wire-model");
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(body).toMatchObject({ model: "grok-wire-model" });
      expect(body).not.toHaveProperty("stream_tool_calls");
      expect(body).not.toHaveProperty("max_output_tokens");
      return sseResponse([
        { type: "response.created", response: { id: "resp-wire" } },
        {
          type: "response.completed",
          response: { id: "resp-wire", object: "response", status: "completed", output: [] },
        },
      ]);
    });

    const enabled = await synthesizeOAuthProviders(
      [],
      ctx,
      config,
      "https://fallback/v1",
      60_000,
      noop,
    );

    expect(enabled.providers[0]?.models).toEqual([
      { alias: "xai/grok-display-key", provider_model: "grok-wire-model" },
    ]);
    expect(enabled.xaiModels.get("xai/grok-display-key")).toMatchObject({
      id: "grok-display-key",
      model: "grok-wire-model",
      apiBackend: "responses",
      contextWindow: 500_000,
    });
    await expect(
      enabled.poolClients
        .get("xai")
        ?.nativePassthrough?.({ model: "grok-wire-model", input: "hello" }),
    ).resolves.toMatchObject({ id: "resp-wire" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("persists xAI structured discovery and falls back to it after a transient restart failure", async () => {
    const { ctx, config } = oauthStores();
    await seedXai(ctx, "heavy");
    let discoveryFails = false;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      expect(String(url)).toBe("https://cli-chat-proxy.grok.com/v1/models");
      if (discoveryFails) throw new Error("temporary catalog outage");
      return Response.json({
        data: [
          {
            id: "grok-display-lkg",
            model: "grok-wire-lkg",
            apiBackend: "responses",
            contextWindow: 500_000,
            streamToolCalls: true,
            maxCompletionTokens: 32_768,
          },
        ],
      });
    });

    const live = await synthesizeOAuthProviders(
      [],
      ctx,
      config,
      "https://fallback/v1",
      60_000,
      noop,
    );
    expect(live.providers[0]?.models).toEqual([
      { alias: "xai/grok-display-lkg", provider_model: "grok-wire-lkg" },
    ]);
    expect(
      getAccountSettings(await loadAccountSettings(config, ENC_KEY), "xai", "heavy")
        .xaiDiscoveredModels,
    ).toEqual([
      expect.objectContaining({
        id: "grok-display-lkg",
        model: "grok-wire-lkg",
        contextWindow: 500_000,
      }),
    ]);

    discoveryFails = true;
    const restarted = await synthesizeOAuthProviders(
      [],
      ctx,
      config,
      "https://fallback/v1",
      60_000,
      noop,
    );
    expect(restarted.providers[0]?.models).toEqual([
      { alias: "xai/grok-display-lkg", provider_model: "grok-wire-lkg" },
    ]);
    expect(restarted.xaiModelAccounts).toEqual(new Map([["xai/grok-display-lkg", ["heavy"]]]));
  });

  it("treats a successful empty xAI catalog as authoritative and clears stale LKG", async () => {
    const { ctx, config } = oauthStores();
    await seedXai(ctx, "heavy");
    let models: unknown[] = [
      { id: "grok-stale", model: "grok-stale-wire", apiBackend: "responses" },
    ];
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => Response.json({ data: models }));

    const seeded = await synthesizeOAuthProviders(
      [],
      ctx,
      config,
      "https://fallback/v1",
      60_000,
      noop,
    );
    expect(seeded.providers).toHaveLength(1);

    models = [];
    const emptied = await synthesizeOAuthProviders(
      [],
      ctx,
      config,
      "https://fallback/v1",
      60_000,
      noop,
    );
    expect(emptied.providers).toEqual([]);
    expect(emptied.xaiModelAccounts).toEqual(new Map());
    expect(getAccountSettings(await loadAccountSettings(config, ENC_KEY), "xai", "heavy")).toEqual({
      xaiDiscoveredModels: [],
    });
  });

  it("fails closed for a second xAI account whose metadata conflicts for the same alias", async () => {
    const { ctx, config } = oauthStores();
    await seedXai(ctx, "a");
    await seedXai(ctx, "b");
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      const authorization = new Headers(init?.headers).get("authorization");
      return Response.json({
        data: [
          {
            id: "shared-grok",
            model: "shared-grok-wire",
            apiBackend: "responses",
            contextWindow: authorization?.endsWith("-a") ? 500_000 : 100_000,
          },
        ],
      });
    });
    const logs: Array<{ msg: string; fields?: Record<string, unknown> }> = [];

    const enabled = await synthesizeOAuthProviders(
      [],
      ctx,
      config,
      "https://fallback/v1",
      60_000,
      (_level, msg, fields) => logs.push({ msg, fields }),
    );

    expect(enabled.providers[0]?.models).toEqual([
      { alias: "xai/shared-grok", provider_model: "shared-grok-wire" },
    ]);
    expect(logs).toContainEqual(
      expect.objectContaining({ msg: "oauth.autoroute.model_metadata_conflict" }),
    );
    expect(logs).toContainEqual({
      msg: "oauth.autoroute",
      fields: expect.objectContaining({ providerId: "xai", accounts: 1, models: 1 }),
    });
  });

  it("preserves data and HTTPS image URLs when translating Chat input for Grok 4.5", async () => {
    const { ctx, config } = oauthStores();
    await seedXai(ctx, "heavy");
    const inferenceBodies: Array<Record<string, unknown>> = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
      if (String(url).endsWith("/models")) {
        return new Response(
          JSON.stringify({ data: [{ id: "grok-4.5", apiBackend: "responses" }] }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        );
      }
      expect(String(url)).toBe("https://cli-chat-proxy.grok.com/v1/responses");
      expect(init?.method).toBe("POST");
      const headers = new Headers(init?.headers);
      expect(headers.get("Content-Type")).toBe("application/json");
      expect(headers.get("Authorization")).toBe("Bearer xai-access-heavy");
      expect(headers.get("X-XAI-Token-Auth")).toBe("xai-grok-cli");
      expect(headers.get("x-grok-model-override")).toBe("grok-4.5");
      expect(headers.get("chatgpt-account-id")).toBeNull();
      expect(headers.get("OpenAI-Beta")).toBeNull();
      expect(headers.get("session-id")).toBeNull();
      expect(headers.get("thread-id")).toBeNull();
      expect(headers.get("originator")).toBeNull();
      inferenceBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return sseResponse([
        { type: "response.created", response: { id: "resp-grok-vision" } },
        {
          type: "response.completed",
          response: {
            id: "resp-grok-vision",
            object: "response",
            status: "completed",
            output: [],
            usage: {
              input_tokens: 10,
              output_tokens: 5,
              input_tokens_details: { cached_tokens: 4 },
            },
          },
        },
      ]);
    });

    const enabled = await synthesizeOAuthProviders(
      [],
      ctx,
      config,
      "https://fallback/v1",
      60_000,
      noop,
    );
    const imageUrls = [
      "data:image/png;base64,SU1H",
      "https://cdn.example.test/images/diagram.png?version=2",
    ];
    for (const imageUrl of imageUrls) {
      await expect(
        enabled.poolClients.get("xai")?.chatCompletion({
          model: "grok-4.5",
          messages: [
            {
              role: "user",
              content: [
                { type: "text", text: "Describe this image" },
                { type: "image", url: imageUrl, detail: "auto" },
              ],
            },
          ],
        }),
      ).resolves.toMatchObject({
        id: "resp-grok-vision",
        usage: {
          prompt_tokens: 10,
          completion_tokens: 5,
          prompt_tokens_details: { cached_tokens: 4 },
        },
      });
    }

    expect(inferenceBodies).toEqual(
      imageUrls.map((imageUrl) => ({
        model: "grok-4.5",
        instructions: "You are a helpful assistant.",
        include: ["reasoning.encrypted_content"],
        input: [
          {
            type: "message",
            role: "user",
            content: [
              { type: "input_text", text: "Describe this image" },
              { type: "input_image", image_url: imageUrl, detail: "auto" },
            ],
          },
        ],
        stream: true,
        store: false,
      })),
    );
  });

  it("rejects xAI native continuation before contacting the subscription proxy", async () => {
    const { ctx, config } = oauthStores();
    await seedXai(ctx, "heavy");
    const inferenceBodies: Array<Record<string, unknown>> = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
      if (String(url).endsWith("/models")) {
        return new Response(
          JSON.stringify({ data: [{ id: "grok-4.5", api_backend: "responses" }] }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        );
      }
      inferenceBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return sseResponse([
        { type: "response.created", response: { id: "resp-next" } },
        {
          type: "response.completed",
          response: { id: "resp-next", object: "response", status: "completed", output: [] },
        },
      ]);
    });

    const enabled = await synthesizeOAuthProviders(
      [],
      ctx,
      config,
      "https://fallback/v1",
      60_000,
      noop,
    );
    await expect(
      enabled.poolClients.get("xai")?.nativePassthrough?.(
        {
          model: "grok-4.5",
          previous_response_id: "resp-prev",
          instructions: "Follow the repository policy.",
          input: [
            { type: "message", role: "user", content: [{ type: "input_text", text: "next" }] },
          ],
        },
        { statefulAccount: "heavy" },
      ),
    ).rejects.toMatchObject({
      upstreamStatus: 400,
      providerRaw: expect.objectContaining({ code: "previous_response_id_unsupported" }),
    });
    expect(inferenceBodies).toEqual([]);
  });

  it("does not discover non-Codex models when manual mode is authoritative", async () => {
    const { ctx, config } = oauthStores();
    await seedAnthropic(ctx, "manual");
    await setAccountSettings(config, ENC_KEY, "anthropic", "manual", {
      modelsMode: "manual",
      enabledModels: ["claude-custom"],
    });
    const modelsFetch = vi.spyOn(globalThis, "fetch");

    const result = await synthesizeOAuthProviders(
      [],
      ctx,
      config,
      "https://fallback/v1",
      60_000,
      noop,
    );

    expect(result.providers[0]?.models.map((model) => model.alias)).toEqual([
      "anthropic/claude-custom",
    ]);
    expect(modelsFetch).not.toHaveBeenCalled();
  });

  it("reuses account discovery across pool synthesis with a shared cache", async () => {
    const { ctx, config } = oauthStores();
    await seedAnthropic(ctx, "auto");
    await setAccountSettings(config, ENC_KEY, "anthropic", "auto", {
      modelsMode: "auto",
    });
    const modelsFetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ data: [{ id: "claude-fable-5" }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const discoveryCache = createOAuthModelDiscoveryCache();

    const first = await synthesizeOAuthProviders(
      [],
      ctx,
      config,
      "https://fallback/v1",
      60_000,
      noop,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      discoveryCache,
    );
    const second = await synthesizeOAuthProviders(
      [],
      ctx,
      config,
      "https://fallback/v1",
      60_000,
      noop,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      discoveryCache,
    );

    expect(first.providers[0]?.models.map((model) => model.alias)).toEqual([
      "anthropic/claude-fable-5",
    ]);
    expect(second.providers[0]?.models.map((model) => model.alias)).toEqual([
      "anthropic/claude-fable-5",
    ]);
    expect(modelsFetch).toHaveBeenCalledOnce();
  });

  it("pools MULTIPLE accounts into one provider exposing the UNION of enabled models", async () => {
    const { ctx, config } = oauthStores();
    await seedAnthropic(ctx, "work");
    await seedAnthropic(ctx, "home");
    // Curate disjoint subsets so the union is observable + de-duplicated.
    await setAccountSettings(config, ENC_KEY, "anthropic", "work", {
      enabledModels: ["claude-opus-4-6", "claude-sonnet-4-6"],
    });
    await setAccountSettings(config, ENC_KEY, "anthropic", "home", {
      enabledModels: ["claude-sonnet-4-6", "claude-haiku-4-5"],
    });

    const { providers, poolClients } = await synthesizeOAuthProviders(
      [],
      ctx,
      config,
      "https://fallback/v1",
      60_000,
      noop,
    );

    // ONE synthetic provider keyed by providerId, ONE pool client serving it.
    expect(providers).toHaveLength(1);
    expect(providers[0]?.name).toBe("anthropic");
    expect(poolClients.has("anthropic")).toBe(true);
    expect(poolClients.size).toBe(1);
    // modelAliases = UNION of both accounts' enabled models (deduped), as
    // `<provider>/<model>` aliases.
    const aliases = (providers[0]?.models ?? []).map((m) => m.alias).sort();
    expect(aliases).toEqual([
      "anthropic/claude-haiku-4-5",
      "anthropic/claude-opus-4-6",
      "anthropic/claude-sonnet-4-6",
    ]);
  });

  it("excludes an UNSCHEDULABLE (parked) account from the pool union", async () => {
    const { ctx, config } = oauthStores();
    await seedAnthropic(ctx, "live");
    await seedAnthropic(ctx, "parked");
    await setAccountSettings(config, ENC_KEY, "anthropic", "live", {
      enabledModels: ["claude-opus-4-6"],
    });
    await setAccountSettings(config, ENC_KEY, "anthropic", "parked", {
      enabledModels: ["claude-haiku-4-5"],
      schedulable: false,
    });

    const { providers } = await synthesizeOAuthProviders(
      [],
      ctx,
      config,
      "https://fallback/v1",
      60_000,
      noop,
    );
    // Only the live account's model is exposed; the parked one drops out.
    const aliases = (providers[0]?.models ?? []).map((m) => m.alias);
    expect(aliases).toEqual(["anthropic/claude-opus-4-6"]);
  });

  it("excludes a credential-failed account from the synthesized pool until reconnect", async () => {
    const { ctx, config } = oauthStores();
    await seedAnthropic(ctx, "dead");
    await setAccountSettings(config, ENC_KEY, "anthropic", "dead", {
      enabledModels: ["claude-opus-4-6"],
      credentialFailedAt: 12_345,
      credentialFailureReason: "oauth refresh failed (anthropic, status 401)",
      autoDisabledForCredentialFailure: true,
      schedulable: false,
    });

    const { providers, poolClients } = await synthesizeOAuthProviders(
      [],
      ctx,
      config,
      "https://fallback/v1",
      60_000,
      noop,
    );

    expect(providers).toEqual([]);
    expect(poolClients.size).toBe(0);
  });

  it("returns empty when no OAuth runtime is wired (no enc key)", async () => {
    const { config } = oauthStores();
    const out = await synthesizeOAuthProviders([], undefined, config, "https://f/v1", 60_000, noop);
    expect(out).toEqual({
      providers: [],
      poolClients: new Map(),
      codexKeys: [],
      xaiModels: new Map(),
      xaiModelAccounts: new Map(),
    });
  });

  // Hot-reload data path (issue #38 follow-up): rebuildOAuthPool re-invokes
  // synthesizeOAuthProviders, which re-reads account settings + bound credentials
  // every call. A re-synthesis after an admin edit MUST reflect the change — this is
  // exactly what makes proxy/priority/schedulable/connect/disconnect apply WITHOUT a
  // restart once server.ts swaps the freshly-synthesized pool into providerClients.
  it("re-synthesis reflects a schedulable change made AFTER the first build (no restart)", async () => {
    const { ctx, config } = oauthStores();
    await seedAnthropic(ctx, "a");
    await seedAnthropic(ctx, "b");
    await setAccountSettings(config, ENC_KEY, "anthropic", "a", {
      enabledModels: ["claude-opus-4-6"],
    });
    await setAccountSettings(config, ENC_KEY, "anthropic", "b", {
      enabledModels: ["claude-haiku-4-5"],
    });

    // First synthesis: both accounts live → union of both models.
    const first = await synthesizeOAuthProviders([], ctx, config, "https://f/v1", 60_000, noop);
    expect((first.providers[0]?.models ?? []).map((m) => m.alias).sort()).toEqual([
      "anthropic/claude-haiku-4-5",
      "anthropic/claude-opus-4-6",
    ]);

    // Admin parks account "b" (the same call the PUT .../account route makes)…
    await setAccountSettings(config, ENC_KEY, "anthropic", "b", { schedulable: false });

    // …a fresh synthesis (what rebuildOAuthPool runs) drops it WITHOUT a restart.
    const second = await synthesizeOAuthProviders([], ctx, config, "https://f/v1", 60_000, noop);
    expect((second.providers[0]?.models ?? []).map((m) => m.alias)).toEqual([
      "anthropic/claude-opus-4-6",
    ]);

    // And a disconnect (logout) of the last live account drops the provider entirely.
    await ctx.store.delete("anthropic", "a");
    const third = await synthesizeOAuthProviders([], ctx, config, "https://f/v1", 60_000, noop);
    expect(third.poolClients.has("anthropic")).toBe(false);
  });

  it("routes a bound Codex account from its exact account catalog", async () => {
    const { ctx, config } = oauthStores();
    // Seed an openai-codex account (far-future expiry → no token refresh/network).
    await ctx.store.upsert({
      providerId: "openai-codex",
      account: "default",
      accessEnc: encryptSecret("codex-access", ENC_KEY),
      refreshEnc: encryptSecret("codex-refresh", ENC_KEY),
      expiresAt: FAR_FUTURE,
      meta: null,
      updatedAt: 1,
    });
    await setAccountSettings(config, ENC_KEY, "openai-codex", "default", {
      modelsMode: "manual",
      enabledModels: ["gpt-5.6-sol", "gpt-5.6-luna"],
    });
    const catalog = createCodexModelCatalog({
      cache: createCodexModelCache(config, ENC_KEY),
    });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          models: [codexModel("gpt-5.6-sol"), codexModel("gpt-5.6-luna")],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    const { providers, poolClients } = await synthesizeOAuthProviders(
      [],
      ctx,
      config,
      "https://fallback/v1",
      60_000,
      noop,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { catalog, runInBackground },
    );
    // Codex is now routable: one synthetic provider keyed by providerId, executor
    // type `openai-responses`, served by ONE pool client.
    expect(providers).toHaveLength(1);
    expect(providers[0]?.name).toBe("openai-codex");
    expect(providers[0]?.type).toBe("openai-responses");
    expect(poolClients.has("openai-codex")).toBe(true);
    const aliases = (providers[0]?.models ?? []).map((m) => m.alias).sort();
    expect(aliases).toEqual(["openai-codex/gpt-5.6-luna", "openai-codex/gpt-5.6-sol"]);
  });

  it("keeps a live Codex continuation websocket across an unchanged OAuth hot rebuild", async () => {
    const { ctx, config } = oauthStores();
    await ctx.store.upsert({
      providerId: "openai-codex",
      account: "default",
      accessEnc: encryptSecret("codex-access", ENC_KEY),
      refreshEnc: encryptSecret("codex-refresh", ENC_KEY),
      expiresAt: FAR_FUTURE,
      meta: JSON.stringify({ accountId: "workspace-42" }),
      updatedAt: 1,
    });
    await setAccountSettings(config, ENC_KEY, "openai-codex", "default", {
      modelsMode: "manual",
      enabledModels: ["gpt-5.6-sol"],
    });
    const catalog = createCodexModelCatalog({
      cache: createCodexModelCache(config, ENC_KEY),
    });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({ models: [codexModel("gpt-5.6-sol"), codexModel("gpt-5.6-luna")] }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      ),
    );
    const pending: string[] = [];
    const waiters: Array<(value: string | null) => void> = [];
    const replies = [
      [
        { type: "response.created", response: { id: "resp-parent" } },
        {
          type: "response.completed",
          response: { id: "resp-parent", status: "completed", usage: {} },
        },
      ],
      [
        { type: "response.created", response: { id: "resp-child" } },
        {
          type: "response.completed",
          response: { id: "resp-child", status: "completed", usage: {} },
        },
      ],
    ];
    const sent: string[] = [];
    const connection: CodexResponsesWebSocketConnection = {
      responseHeaders: new Headers(),
      async send(text) {
        sent.push(text);
        for (const event of replies[sent.length - 1] ?? []) {
          const payload = JSON.stringify(event);
          const waiter = waiters.shift();
          if (waiter) waiter(payload);
          else pending.push(payload);
        }
      },
      async receive() {
        const next = pending.shift();
        if (next !== undefined) return next;
        return await new Promise<string | null>((resolve) => waiters.push(resolve));
      },
      async close() {
        for (const waiter of waiters.splice(0)) waiter(null);
      },
    };
    const connect = vi.fn(async () => connection);
    const reuseCache: OAuthPoolReuseCache = new Map();
    const build = () =>
      synthesizeOAuthProviders(
        [],
        ctx,
        config,
        "https://fallback/v1",
        60_000,
        noop,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        { catalog, runInBackground, responsesWebSocketConnector: connect },
        undefined,
        reuseCache,
      );

    const first = await build();
    const sessionHeaders = {
      [CODEX_RESPONSES_WEBSOCKET_SESSION_HEADER]: "ingress-session",
      "session-id": "client-session",
    };
    const drain = async (
      pool: NonNullable<ReturnType<typeof reuseCache.get>>["pool"],
      body: Record<string, unknown>,
    ) => {
      const chunks: string[] = [];
      for await (const chunk of pool.nativePassthroughStream?.({
        protocol: "openai_responses",
        body,
        headers: sessionHeaders,
        mutations: {},
      }) ?? []) {
        chunks.push(chunk);
      }
      return chunks.join("");
    };
    const firstPool = first.poolClients.get("openai-codex");
    if (!firstPool) throw new Error("expected synthesized Codex pool");
    expect(
      await drain(firstPool, {
        model: "gpt-5.6-sol",
        input: "parent",
        stream: true,
        store: false,
      }),
    ).toContain("resp-parent");
    const second = await build();

    const secondPool = second.poolClients.get("openai-codex");
    expect(secondPool).toBe(firstPool);
    if (!secondPool) throw new Error("expected reused Codex pool");
    expect(
      await drain(secondPool, {
        model: "gpt-5.6-sol",
        input: "child",
        stream: true,
        store: false,
        previous_response_id: "resp-parent",
      }),
    ).toContain("resp-child");
    expect(connect).toHaveBeenCalledTimes(1);
    expect(sent.map((body) => JSON.parse(body))).toEqual([
      expect.objectContaining({ model: "gpt-5.6-sol" }),
      expect.objectContaining({ previous_response_id: "resp-parent" }),
    ]);

    await ctx.store.upsert({
      providerId: "openai-codex",
      account: "default",
      accessEnc: encryptSecret("codex-access", ENC_KEY),
      refreshEnc: encryptSecret("codex-refresh", ENC_KEY),
      expiresAt: FAR_FUTURE,
      meta: JSON.stringify({ accountId: "workspace-42", isFedramp: true }),
      updatedAt: 2,
    });
    const identityChanged = await build();
    expect(identityChanged.poolClients.get("openai-codex")).not.toBe(secondPool);

    await setAccountSettings(config, ENC_KEY, "openai-codex", "default", {
      modelsMode: "manual",
      enabledModels: ["gpt-5.6-luna"],
    });
    const modelChanged = await build();
    expect(modelChanged.poolClients.get("openai-codex")).not.toBe(
      identityChanged.poolClients.get("openai-codex"),
    );
  });

  it("wires the account-scoped Codex catalog, persisted identity, and model entitlement into the live client", async () => {
    const { ctx, config } = oauthStores();
    await ctx.store.upsert({
      providerId: "openai-codex",
      account: "team",
      accessEnc: encryptSecret("opaque-access", ENC_KEY),
      refreshEnc: encryptSecret("codex-refresh", ENC_KEY),
      expiresAt: FAR_FUTURE,
      meta: JSON.stringify({
        accountId: "workspace-42",
        chatgptUserId: "user-7",
        isFedramp: true,
      }),
      updatedAt: 1,
    });
    await setAccountSettings(config, ENC_KEY, "openai-codex", "team", {
      modelsMode: "auto",
    });
    const catalog = createCodexModelCatalog({
      cache: createCodexModelCache(config, ENC_KEY),
    });
    const modelRequests: Headers[] = [];
    const responseRequests: Array<{ headers: Headers; body: Record<string, unknown> }> = [];
    const realtimeRequests: Headers[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = typeof input === "string" ? input : input.toString();
      const headers = new Headers(init?.headers);
      if (url.includes("/models?")) {
        modelRequests.push(headers);
        return new Response(
          JSON.stringify({
            models: [
              codexModel("gpt-5.6-sol", {
                use_responses_lite: true,
                supports_parallel_tool_calls: false,
              }),
              codexModel("codex-auto-review", {
                priority: 2,
                visibility: "hide",
              }),
            ],
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json", ETag: '"catalog-v1"' },
          },
        );
      }
      if (url.includes("/realtime/calls")) {
        realtimeRequests.push(headers);
        return new Response("v=answer\\r\\n", {
          status: 201,
          headers: { Location: "/v1/live/rtc_1" },
        });
      }
      responseRequests.push({
        headers,
        body: JSON.parse(String(init?.body)) as Record<string, unknown>,
      });
      return sseResponse([
        { type: "response.output_text.delta", delta: "ok" },
        { type: "response.completed", response: { status: "completed", usage: {} } },
      ]);
    });

    const { providers, poolClients } = await synthesizeOAuthProviders(
      [],
      ctx,
      config,
      "https://fallback/v1",
      60_000,
      noop,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      {
        catalog,
        clientVersion: DEFAULT_OPENAI_CODEX_CLIENT_VERSION,
        runInBackground,
        userAgent: "codex_cli_rs/test",
      },
    );

    expect((providers[0]?.models ?? []).map((model) => model.alias)).toEqual([
      "openai-codex/gpt-5.6-sol",
      "openai-codex/codex-auto-review",
      "openai-codex/gpt-5.6",
    ]);
    await poolClients.get("openai-codex")?.chatCompletion({
      model: "gpt-5.6-sol",
      messages: [{ role: "user", content: "hi" }],
      tools: [{ type: "function", function: { name: "run", parameters: { type: "object" } } }],
    });

    expect(modelRequests).toHaveLength(1);
    expect(modelRequests[0]?.get("chatgpt-account-id")).toBe("workspace-42");
    expect(modelRequests[0]?.get("X-OpenAI-Fedramp")).toBe("true");
    expect(modelRequests[0]?.get("version")).toBe(DEFAULT_OPENAI_CODEX_CLIENT_VERSION);
    expect(responseRequests).toHaveLength(1);
    expect(responseRequests[0]?.headers.get("chatgpt-account-id")).toBe("workspace-42");
    expect(responseRequests[0]?.headers.get("X-OpenAI-Fedramp")).toBe("true");
    expect(responseRequests[0]?.headers.get("x-openai-internal-codex-responses-lite")).toBe("true");
    expect(responseRequests[0]?.body.parallel_tool_calls).toBe(false);

    await poolClients.get("openai-codex")?.realtimeCall?.({
      endpoint: "live",
      query: "",
      sdp: "v=offer\\r\\n",
      session: { type: "quicksilver", model: "gpt-live-1-boulder-alpha" },
      headers: {},
    });
    expect(realtimeRequests[0]?.get("user-agent")).toContain(
      `codex_cli_rs/${DEFAULT_OPENAI_CODEX_CLIENT_VERSION}`,
    );
  });

  it("normalizes prerelease discovery to the Codex whole version and reuses its cache", async () => {
    const { ctx, config } = oauthStores();
    await ctx.store.upsert({
      providerId: "openai-codex",
      account: "default",
      accessEnc: encryptSecret("opaque-access", ENC_KEY),
      refreshEnc: encryptSecret("codex-refresh", ENC_KEY),
      expiresAt: FAR_FUTURE,
      meta: JSON.stringify({ accountId: "workspace-42" }),
      updatedAt: 1,
    });
    await setAccountSettings(config, ENC_KEY, "openai-codex", "default", {
      modelsMode: "auto",
    });
    const catalog = createCodexModelCatalog({
      cache: createCodexModelCache(config, ENC_KEY),
    });
    const tokenManagers = new Map();
    const tokenReads = vi.spyOn(ctx.store, "get");
    const requests: Array<{ url: URL; headers: Headers }> = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = new URL(typeof input === "string" ? input : input.toString());
      const headers = new Headers(init?.headers);
      requests.push({ url, headers });
      const version = url.searchParams.get("client_version");
      const models =
        version === "0.139.0"
          ? [codexModel("gpt-5.5")]
          : [
              codexModel("gpt-5.6-sol"),
              codexModel("gpt-5.6-terra", { priority: 2 }),
              codexModel("gpt-5.6-luna", { priority: 3 }),
            ];
      return new Response(JSON.stringify({ models }), {
        status: 200,
        headers: { "Content-Type": "application/json", ETag: `"models-${version}"` },
      });
    });

    const older = await loadCodexCatalogForClientVersion({
      configured: [],
      oauthCtx: ctx,
      config,
      catalog,
      clientVersion: "0.139.0",
      tokenManagers,
    });
    const current = await loadCodexCatalogForClientVersion({
      configured: [],
      oauthCtx: ctx,
      config,
      catalog,
      clientVersion: "0.145.0-alpha.4",
      tokenManagers,
    });
    const currentAgain = await loadCodexCatalogForClientVersion({
      configured: [],
      oauthCtx: ctx,
      config,
      catalog,
      clientVersion: "0.145.0",
      tokenManagers,
    });

    expect(older.models).toEqual(["gpt-5.5"]);
    expect(older.keys.map((key) => key.clientVersion)).toEqual(["0.139.0"]);
    expect(current.models).toEqual(["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.6"]);
    expect(current.keys.map((key) => key.clientVersion)).toEqual(["0.145.0"]);
    expect(currentAgain).toEqual(current);
    expect(requests).toHaveLength(2);
    expect(tokenReads).toHaveBeenCalledTimes(1);
    expect(requests.map(({ url }) => url.searchParams.get("client_version"))).toEqual([
      "0.139.0",
      "0.145.0",
    ]);
    expect(requests.map(({ headers }) => headers.get("version"))).toEqual(["0.139.0", "0.145.0"]);
    expect(
      requests.every(({ headers }) => headers.get("chatgpt-account-id") === "workspace-42"),
    ).toBe(true);
  });

  it("fails closed before account or network work for invalid client versions", async () => {
    const { ctx, config } = oauthStores();
    const catalog = createCodexModelCatalog({
      cache: createCodexModelCache(config, ENC_KEY),
    });
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    await expect(
      loadCodexCatalogForClientVersion({
        configured: [],
        oauthCtx: ctx,
        config,
        catalog,
        clientVersion: "latest",
      }),
    ).resolves.toEqual({ keys: [], models: [] });
    await expect(
      loadCodexCatalogForClientVersion({
        configured: [],
        oauthCtx: ctx,
        config,
        catalog,
        clientVersion: `0.145.0-${"a".repeat(80)}`,
      }),
    ).resolves.toEqual({ keys: [], models: [] });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("hoists non-Lite native instructions, preserves Lite input, and sends ultra as max", async () => {
    // This protocol-shaping test is unrelated to live host pressure. Keep the
    // shared response-work coordinator deterministic when the developer machine
    // happens to be low on free memory; admission behavior has dedicated tests.
    vi.spyOn(process, "availableMemory").mockReturnValue(4 * 1024 * 1024 * 1024);
    const { ctx, config } = oauthStores();
    await ctx.store.upsert({
      providerId: "openai-codex",
      account: "team",
      accessEnc: encryptSecret("opaque-access", ENC_KEY),
      refreshEnc: encryptSecret("codex-refresh", ENC_KEY),
      expiresAt: FAR_FUTURE,
      meta: JSON.stringify({ accountId: "workspace-42" }),
      updatedAt: 1,
    });
    await setAccountSettings(config, ENC_KEY, "openai-codex", "team", {
      modelsMode: "auto",
    });
    const catalog = createCodexModelCatalog({
      cache: createCodexModelCache(config, ENC_KEY),
    });
    const responseBodies: Record<string, unknown>[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/models?")) {
        return new Response(
          JSON.stringify({
            models: [
              codexModel("gpt-5.6-luna", { use_responses_lite: false }),
              codexModel("gpt-5.6-sol", { use_responses_lite: true }),
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      responseBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response(JSON.stringify({ id: `resp_${responseBodies.length}` }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    const { poolClients } = await synthesizeOAuthProviders(
      [],
      ctx,
      config,
      "https://fallback/v1",
      60_000,
      noop,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { catalog, runInBackground },
    );
    const client = poolClients.get("openai-codex");
    if (!client?.nativePassthrough) throw new Error("Codex native passthrough is unavailable");

    const nonLite = {
      protocol: "openai_responses" as const,
      body: {
        model: "gpt-5.6-luna",
        input: [
          { role: "developer", content: "Use the workspace carefully." },
          { role: "user", content: "Fix it" },
        ],
        reasoning: { effort: "ultra" },
        stream: false,
      },
      headers: {},
      mutations: {},
    };
    const lite = {
      protocol: "openai_responses" as const,
      body: {
        model: "gpt-5.6-sol",
        input: [
          { role: "developer", content: "Keep this in input." },
          { role: "user", content: "Fix it" },
        ],
        reasoning: { effort: "ultra" },
        stream: false,
      },
      headers: {},
      mutations: {},
    };

    await client.nativePassthrough(nonLite);
    await client.nativePassthrough(lite);

    expect(responseBodies[0]).toMatchObject({
      instructions: "Use the workspace carefully.",
      input: [{ role: "user", content: "Fix it" }],
      reasoning: { effort: "max" },
    });
    expect(responseBodies[1]).toMatchObject({
      input: [
        { type: "additional_tools", role: "developer", tools: [] },
        { role: "developer", content: "Keep this in input." },
        { role: "user", content: "Fix it" },
      ],
      reasoning: { effort: "max", context: "all_turns" },
    });
    expect(responseBodies[1]).not.toHaveProperty("instructions");
    expect(nonLite.mutations).toMatchObject({
      body_shims_applied: [
        "codex_ultra_reasoning_mapped_to_max",
        "instructions_hoisted_from_input",
      ],
    });
    expect(lite.mutations).toMatchObject({
      body_shims_applied: ["codex_ultra_reasoning_mapped_to_max"],
    });
  });

  it("uses x-codex-active-limit to cool a model scope while default Codex 429 parks the account", async () => {
    const { ctx, config } = oauthStores();
    for (const [account, priority] of [
      ["a", 10],
      ["b", 50],
    ] as const) {
      await ctx.store.upsert({
        providerId: "openai-codex",
        account,
        accessEnc: encryptSecret(`access-${account}`, ENC_KEY),
        refreshEnc: encryptSecret(`refresh-${account}`, ENC_KEY),
        expiresAt: FAR_FUTURE,
        meta: JSON.stringify({ accountId: `workspace-${account}` }),
        updatedAt: 1,
      });
      await setAccountSettings(config, ENC_KEY, "openai-codex", account, {
        modelsMode: "auto",
        priority,
      });
    }
    const catalog = createCodexModelCatalog({
      cache: createCodexModelCache(config, ENC_KEY),
    });
    const calls: string[] = [];
    let scopedFailure = true;
    let accountFailure = false;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/models?")) {
        return new Response(
          JSON.stringify({
            models: [codexModel("gpt-5.6-luna"), codexModel("gpt-5.6-terra")],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      const authorization = new Headers(init?.headers).get("authorization");
      const account = authorization === "Bearer access-a" ? "a" : "b";
      const body = JSON.parse(String(init?.body)) as { model?: string };
      calls.push(`${account}:${body.model}`);
      if (account === "a" && body.model === "gpt-5.6-luna" && scopedFailure) {
        scopedFailure = false;
        return new Response(JSON.stringify({ error: { type: "usage_limit_reached" } }), {
          status: 429,
          headers: {
            "Content-Type": "application/json",
            "x-codex-active-limit": "codex_luna",
          },
        });
      }
      if (account === "a" && body.model === "gpt-5.6-terra" && accountFailure) {
        accountFailure = false;
        return new Response(JSON.stringify({ error: { type: "usage_limit_reached" } }), {
          status: 429,
          headers: {
            "Content-Type": "application/json",
            "x-codex-active-limit": "codex",
          },
        });
      }
      return sseResponse([
        { type: "response.output_text.delta", delta: "ok" },
        { type: "response.completed", response: { status: "completed", usage: {} } },
      ]);
    });

    const { poolClients } = await synthesizeOAuthProviders(
      [],
      ctx,
      config,
      "https://fallback/v1",
      60_000,
      noop,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { catalog, runInBackground },
    );
    const client = poolClients.get("openai-codex");
    if (!client) throw new Error("Codex pool is unavailable");

    await client.chatCompletion({ model: "gpt-5.6-luna", messages: [] });
    await client.chatCompletion({ model: "gpt-5.6-luna", messages: [] });
    await client.chatCompletion({ model: "gpt-5.6-terra", messages: [] });
    expect(calls).toEqual([
      "a:gpt-5.6-luna",
      "b:gpt-5.6-luna",
      "b:gpt-5.6-luna",
      "a:gpt-5.6-terra",
    ]);
    expect(client.getUsageLimit("a")).toBeNull();

    accountFailure = true;
    await client.chatCompletion({ model: "gpt-5.6-terra", messages: [] });
    await client.chatCompletion({ model: "gpt-5.6-terra", messages: [] });
    expect(calls.slice(-3)).toEqual(["a:gpt-5.6-terra", "b:gpt-5.6-terra", "b:gpt-5.6-terra"]);
    expect(client.getUsageLimit("a")).toBeGreaterThan(Date.now());
  });

  it("does not grant manual Codex models when the account catalog has no fresh or stale entry", async () => {
    const { ctx, config } = oauthStores();
    await ctx.store.upsert({
      providerId: "openai-codex",
      account: "default",
      accessEnc: encryptSecret("codex-access", ENC_KEY),
      refreshEnc: encryptSecret("codex-refresh", ENC_KEY),
      expiresAt: FAR_FUTURE,
      meta: JSON.stringify({ accountId: "workspace-1" }),
      updatedAt: 1,
    });
    await setAccountSettings(config, ENC_KEY, "openai-codex", "default", {
      modelsMode: "manual",
      enabledModels: ["gpt-5.6-sol"],
    });
    const catalog = createCodexModelCatalog({
      cache: createCodexModelCache(config, ENC_KEY),
    });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ error: "unavailable" }), {
        status: 503,
        headers: { "Content-Type": "application/json" },
      }),
    );

    const result = await synthesizeOAuthProviders(
      [],
      ctx,
      config,
      "https://fallback/v1",
      60_000,
      noop,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { catalog, runInBackground },
    );

    expect(result.providers).toEqual([]);
    expect(result.poolClients.size).toBe(0);
  });

  it("refreshes once and retries /models after a 401 without changing account identity", async () => {
    const { ctx, config } = oauthStores();
    await ctx.store.upsert({
      providerId: "openai-codex",
      account: "default",
      accessEnc: encryptSecret("expired-access", ENC_KEY),
      refreshEnc: encryptSecret("codex-refresh", ENC_KEY),
      expiresAt: FAR_FUTURE,
      meta: JSON.stringify({
        accountId: "workspace-1",
        chatgptUserId: "user-1",
        chatgptPlanType: "business",
      }),
      updatedAt: 1,
    });
    await setAccountSettings(config, ENC_KEY, "openai-codex", "default", {
      modelsMode: "auto",
    });
    const catalog = createCodexModelCatalog({
      cache: createCodexModelCache(config, ENC_KEY),
    });
    const refreshedToken = codexJwt({
      "https://api.openai.com/auth": {
        chatgpt_account_id: "workspace-1",
        chatgpt_user_id: "user-1",
        chatgpt_plan_type: "enterprise",
      },
    });
    let modelCalls = 0;
    let refreshCalls = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url === "https://auth.openai.com/oauth/token") {
        refreshCalls += 1;
        return new Response(
          JSON.stringify({
            access_token: refreshedToken,
            refresh_token: "rotated-refresh",
            expires_in: 3600,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.includes("/models?")) {
        modelCalls += 1;
        const authorization = new Headers(init?.headers).get("authorization");
        if (authorization === "Bearer expired-access") {
          return new Response(JSON.stringify({ error: "expired" }), {
            status: 401,
            headers: { "Content-Type": "application/json" },
          });
        }
        expect(authorization).toBe(`Bearer ${refreshedToken}`);
        return new Response(JSON.stringify({ models: [codexModel("gpt-5.6-sol")] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      throw new Error(`unexpected request: ${url}`);
    });

    const result = await synthesizeOAuthProviders(
      [],
      ctx,
      config,
      "https://fallback/v1",
      60_000,
      noop,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { catalog, runInBackground },
    );

    expect(modelCalls).toBe(2);
    expect(refreshCalls).toBe(1);
    expect((result.providers[0]?.models ?? []).map((model) => model.alias)).toEqual([
      "openai-codex/gpt-5.6-sol",
      "openai-codex/gpt-5.6",
    ]);
  });

  it("intersects a Codex manual allowlist with the account catalog", async () => {
    const { ctx, config } = oauthStores();
    await ctx.store.upsert({
      providerId: "openai-codex",
      account: "default",
      accessEnc: encryptSecret("codex-access", ENC_KEY),
      refreshEnc: encryptSecret("codex-refresh", ENC_KEY),
      expiresAt: FAR_FUTURE,
      meta: JSON.stringify({ accountId: "workspace-1" }),
      updatedAt: 1,
    });
    await setAccountSettings(config, ENC_KEY, "openai-codex", "default", {
      modelsMode: "manual",
      enabledModels: ["gpt-5.6-sol", "gpt-not-entitled"],
    });
    const catalog = createCodexModelCatalog({
      cache: createCodexModelCache(config, ENC_KEY),
    });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          models: [codexModel("gpt-5.6-sol"), codexModel("gpt-5.6-luna")],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    const result = await synthesizeOAuthProviders(
      [],
      ctx,
      config,
      "https://fallback/v1",
      60_000,
      noop,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { catalog, runInBackground },
    );

    expect((result.providers[0]?.models ?? []).map((model) => model.alias)).toEqual([
      "openai-codex/gpt-5.6-sol",
    ]);
  });

  it("selects only a Codex account whose dynamic catalog contains the requested model", async () => {
    const { ctx, config } = oauthStores();
    for (const account of ["sol", "luna"]) {
      await ctx.store.upsert({
        providerId: "openai-codex",
        account,
        accessEnc: encryptSecret(`access-${account}`, ENC_KEY),
        refreshEnc: encryptSecret(`refresh-${account}`, ENC_KEY),
        expiresAt: FAR_FUTURE,
        meta: JSON.stringify({ accountId: `workspace-${account}` }),
        updatedAt: 1,
      });
      await setAccountSettings(config, ENC_KEY, "openai-codex", account, {
        modelsMode: "auto",
      });
    }
    const catalog = createCodexModelCatalog({
      cache: createCodexModelCache(config, ENC_KEY),
    });
    const responseAuth: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = typeof input === "string" ? input : input.toString();
      const headers = new Headers(init?.headers);
      if (url.includes("/models?")) {
        const accountId = headers.get("chatgpt-account-id");
        const slug = accountId === "workspace-sol" ? "gpt-5.6-sol" : "gpt-5.6-luna";
        return new Response(JSON.stringify({ models: [codexModel(slug)] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      responseAuth.push(headers.get("authorization") ?? "");
      return sseResponse([
        { type: "response.output_text.delta", delta: "ok" },
        { type: "response.completed", response: { status: "completed", usage: {} } },
      ]);
    });

    const { poolClients } = await synthesizeOAuthProviders(
      [],
      ctx,
      config,
      "https://fallback/v1",
      60_000,
      noop,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { catalog, runInBackground },
    );
    await poolClients.get("openai-codex")?.chatCompletion({
      model: "gpt-5.6-luna",
      messages: [{ role: "user", content: "hi" }],
    });

    expect(responseAuth).toEqual(["Bearer access-luna"]);
  });

  it("threads per-account Fast mode into the synthesized Codex pool client", async () => {
    const { ctx, config } = oauthStores();
    await ctx.store.upsert({
      providerId: "openai-codex",
      account: "fast",
      accessEnc: encryptSecret("codex-access", ENC_KEY),
      refreshEnc: encryptSecret("codex-refresh", ENC_KEY),
      expiresAt: FAR_FUTURE,
      meta: null,
      updatedAt: 1,
    });
    await setAccountSettings(config, ENC_KEY, "openai-codex", "fast", {
      modelsMode: "manual",
      enabledModels: ["gpt-5.5"],
      fastMode: true,
    });
    const catalog = createCodexModelCatalog({
      cache: createCodexModelCache(config, ENC_KEY),
    });
    let sentBody: Record<string, unknown> | null = null;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/models?")) {
        return new Response(
          JSON.stringify({
            models: [
              codexModel("gpt-5.5", {
                additional_speed_tiers: ["fast"],
                service_tiers: [
                  {
                    id: "priority",
                    name: "Fast",
                    description: "1.5x speed, increased usage",
                  },
                ],
              }),
            ],
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        );
      }
      sentBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return sseResponse([
        { type: "response.output_item.added", item: { type: "message", role: "assistant" } },
        { type: "response.output_text.delta", delta: "ok" },
        { type: "response.completed", response: { status: "completed", usage: {} } },
      ]);
    });

    const { poolClients } = await synthesizeOAuthProviders(
      [],
      ctx,
      config,
      "https://fallback/v1",
      60_000,
      noop,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { catalog, runInBackground },
    );

    await poolClients.get("openai-codex")?.chatCompletion({
      model: "gpt-5.5",
      messages: [{ role: "user", content: "hi" }],
      service_tier: "default",
    });
    expect(sentBody).toEqual(expect.objectContaining({ service_tier: "priority" }));
  });

  it("synthesizes capacity-aware account selection from the shared user-message queue", async () => {
    const { ctx, config } = oauthStores();
    for (const account of ["a", "b"]) {
      await ctx.store.upsert({
        providerId: "openai-codex",
        account,
        accessEnc: encryptSecret(`access-${account}`, ENC_KEY),
        refreshEnc: encryptSecret(`refresh-${account}`, ENC_KEY),
        expiresAt: FAR_FUTURE,
        meta: null,
        updatedAt: 1,
      });
      await setAccountSettings(config, ENC_KEY, "openai-codex", account, {
        modelsMode: "manual",
        enabledModels: ["gpt-5.5"],
        priority: 50,
      });
    }
    const catalog = createCodexModelCatalog({
      cache: createCodexModelCache(config, ENC_KEY),
    });

    const gate = createKeyedSerialGate();
    const held = await gate.acquire({
      key: "openai-codex a",
      delayMs: 0,
      timeoutMs: 5_000,
    });
    expect(held.ok).toBe(true);
    const authHeaders: string[] = [];
    const logs: Array<{ msg: string; fields?: Record<string, unknown> }> = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/models?")) {
        return new Response(JSON.stringify({ models: [codexModel("gpt-5.5")] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.endsWith("/responses")) {
        authHeaders.push(new Headers(init?.headers).get("authorization") ?? "");
      }
      return sseResponse([
        { type: "response.output_item.added", item: { type: "message", role: "assistant" } },
        { type: "response.output_text.delta", delta: "ok" },
        { type: "response.completed", response: { status: "completed", usage: {} } },
      ]);
    });

    const { poolClients } = await synthesizeOAuthProviders(
      [],
      ctx,
      config,
      "https://fallback/v1",
      60_000,
      (_lvl, msg, fields) => logs.push({ msg, fields }),
      undefined,
      {
        gate,
        getConfig: () => ({ enabled: true, delayMs: 0, timeoutMs: 5_000 }),
      },
      undefined,
      undefined,
      undefined,
      { catalog, runInBackground },
    );

    await poolClients.get("openai-codex")?.chatCompletion({
      model: "gpt-5.5",
      messages: [{ role: "user", content: "hi" }],
      prompt_cache_key: "stick-a",
    });

    // stick-a hashes to account "a", but account a is already holding the queue
    // lease, so the synthesized pool commits this request to account b.
    expect(authHeaders).toEqual(["Bearer access-b"]);
    const selectLog = logs.find((l) => l.msg === "oauth.pool.select");
    expect(selectLog?.fields).toMatchObject({
      providerId: "openai-codex",
      account: "b",
      selection_reason: "hash_assign",
      affinity_key_source: "prompt_cache_key",
      capacity_avoided: true,
      busy_eligible_accounts: 1,
      retry_attempt: 0,
    });
    if (held.ok) held.release();
  });

  it("does not steer away from the sticky target when the shared queue is disabled", async () => {
    const { ctx, config } = oauthStores();
    for (const account of ["a", "b"]) {
      await ctx.store.upsert({
        providerId: "openai-codex",
        account,
        accessEnc: encryptSecret(`access-${account}`, ENC_KEY),
        refreshEnc: encryptSecret(`refresh-${account}`, ENC_KEY),
        expiresAt: FAR_FUTURE,
        meta: null,
        updatedAt: 1,
      });
      await setAccountSettings(config, ENC_KEY, "openai-codex", account, {
        modelsMode: "manual",
        enabledModels: ["gpt-5.5"],
        priority: 50,
      });
    }
    const catalog = createCodexModelCatalog({
      cache: createCodexModelCache(config, ENC_KEY),
    });

    const gate = createKeyedSerialGate();
    const held = await gate.acquire({
      key: "openai-codex a",
      delayMs: 0,
      timeoutMs: 5_000,
    });
    expect(held.ok).toBe(true);
    const authHeaders: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/models?")) {
        return new Response(JSON.stringify({ models: [codexModel("gpt-5.5")] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.endsWith("/responses")) {
        authHeaders.push(new Headers(init?.headers).get("authorization") ?? "");
      }
      return sseResponse([
        { type: "response.output_item.added", item: { type: "message", role: "assistant" } },
        { type: "response.output_text.delta", delta: "ok" },
        { type: "response.completed", response: { status: "completed", usage: {} } },
      ]);
    });

    const { poolClients } = await synthesizeOAuthProviders(
      [],
      ctx,
      config,
      "https://fallback/v1",
      60_000,
      noop,
      undefined,
      {
        gate,
        getConfig: () => ({ enabled: false, delayMs: 0, timeoutMs: 5_000 }),
      },
      undefined,
      undefined,
      undefined,
      { catalog, runInBackground },
    );

    await poolClients.get("openai-codex")?.chatCompletion({
      model: "gpt-5.5",
      messages: [{ role: "user", content: "hi" }],
      prompt_cache_key: "stick-a",
    });

    expect(authHeaders).toEqual(["Bearer access-a"]);
    if (held.ok) held.release();
  });
});
