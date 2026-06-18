import {
  __setWreqModuleForTesting,
  createSqliteDb,
  encryptSecret,
  SqliteConfigStore,
  SqliteOAuthTokenStore,
} from "@helm/core";
import type { ProviderConfig as ProviderConfigShared } from "@helm/shared";
import { ProviderConfigSchema } from "@helm/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setAccountSettings } from "./oauth/account-settings.js";
import {
  buildCredential,
  buildProviderClients,
  makeProviderFetch,
  type OAuthRuntimeCtx,
  resolveProviderTransportProfile,
  synthesizeOAuthProviders,
} from "./server.js";

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

describe("synthesizeOAuthProviders (Stage 3 account pool)", () => {
  const noop = () => {};

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

  it("returns empty when no OAuth runtime is wired (no enc key)", async () => {
    const { config } = oauthStores();
    const out = await synthesizeOAuthProviders([], undefined, config, "https://f/v1", 60_000, noop);
    expect(out).toEqual({ providers: [], poolClients: new Map() });
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

  it("routes a bound Codex account: synthesizes an `openai-responses` pool with its curated aliases", async () => {
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
      enabledModels: ["gpt-5.5", "gpt-5.4"],
    });
    const { providers, poolClients } = await synthesizeOAuthProviders(
      [],
      ctx,
      config,
      "https://fallback/v1",
      60_000,
      noop,
    );
    // Codex is now routable: one synthetic provider keyed by providerId, executor
    // type `openai-responses`, served by ONE pool client.
    expect(providers).toHaveLength(1);
    expect(providers[0]?.name).toBe("openai-codex");
    expect(providers[0]?.type).toBe("openai-responses");
    expect(poolClients.has("openai-codex")).toBe(true);
    const aliases = (providers[0]?.models ?? []).map((m) => m.alias).sort();
    expect(aliases).toEqual(["openai-codex/gpt-5.4", "openai-codex/gpt-5.5"]);
  });
});
