import {
  type ConfigStore,
  createSqliteDb,
  decryptSecret,
  encryptSecret,
  GROK_OAUTH_MEDIA_MODELS,
  type ProxyConfig,
  SqliteConfigStore,
  SqliteOAuthTokenStore,
  XAI_GROK_CLIENT_VERSION,
  type XaiOAuthModel,
} from "@helm/core";
import type { OAuthQuotaWindow } from "@helm/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type AccountSettings,
  getAccountSettings,
  loadAccountSettings,
  setAccountSettings,
} from "./account-settings.js";
import { createOAuthAdmin, MAX_PENDING_OAUTH_SESSIONS } from "./admin-oauth.js";
import type { CodexModelCatalog } from "./codex-model-catalog.js";
import { createOAuthModelDiscoveryCache } from "./model-discovery-cache.js";

const KEY = Buffer.alloc(32, 4);

const XAI_STRUCTURED_MODEL: XaiOAuthModel = {
  id: "display-grok",
  model: "wire-grok",
  apiBackend: "responses",
  contextWindow: 500_000,
  maxCompletionTokens: 32_768,
  hidden: false,
  supportedInApi: true,
  supportsReasoningEffort: true,
  reasoningEffort: "high",
  reasoningEfforts: [{ id: "high", value: "high", label: "High" }],
  streamToolCalls: true,
};
const XAI_ADMIN_MODELS = [XAI_STRUCTURED_MODEL.id, ...GROK_OAUTH_MEDIA_MODELS];

type XaiAccountSettings = AccountSettings & { xaiDiscoveredModels?: XaiOAuthModel[] };

function makeStore(): SqliteOAuthTokenStore {
  return new SqliteOAuthTokenStore(createSqliteDb(":memory:"));
}

// A token store + config store sharing ONE in-memory db (createSqliteDb migrates
// both tables), for the model-curation tests that need the ConfigStore-backed
// per-account settings blob.
function makeStores(): { tokens: SqliteOAuthTokenStore; config: SqliteConfigStore } {
  const db = createSqliteDb(":memory:");
  return { tokens: new SqliteOAuthTokenStore(db), config: new SqliteConfigStore(db) };
}

// A throwaway ConfigStore for the flow tests that don't exercise account settings.
function makeConfig(): SqliteConfigStore {
  return new SqliteConfigStore(createSqliteDb(":memory:"));
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// Route a mocked fetch by URL so a single stub serves the whole multi-step flow.
function routeFetch(routes: Array<[RegExp, () => Response]>): typeof fetch {
  return vi.fn(async (url: string | URL) => {
    const u = String(url);
    for (const [re, res] of routes) if (re.test(u)) return res();
    throw new Error(`unexpected fetch ${u}`);
  }) as unknown as typeof fetch;
}

function codexCatalog(
  models: Array<{
    slug: string;
    priority?: number;
    visibility?: "list" | "hide" | "none";
  }>,
  onKey?: (accountIdentity: string) => void,
): CodexModelCatalog {
  const snapshot = {
    etag: "models-etag",
    source: "network",
    models: models.map((model) => ({
      slug: model.slug,
      priority: model.priority ?? 1,
      visibility: model.visibility ?? "list",
    })),
  } as Awaited<ReturnType<CodexModelCatalog["load"]>>;
  return {
    load: async (key) => {
      onKey?.(key.accountIdentity);
      return snapshot;
    },
    snapshot: (key) => {
      onKey?.(key.accountIdentity);
      return snapshot ?? undefined;
    },
    resolve: () => undefined,
    listRoutable: () => null,
    observeEtag: async () => {},
  };
}

afterEach(() => vi.unstubAllGlobals());

describe("createOAuthAdmin", () => {
  it("lists all four built-in providers with xAI available by default", async () => {
    const admin = createOAuthAdmin({ store: makeStore(), encKey: KEY, config: makeConfig() });
    const status = await admin.listStatus();
    expect(status.selectionStrategy).toBe("balanced");
    expect(status.providers.map((p) => p.id).sort()).toEqual([
      "anthropic",
      "github-copilot",
      "openai-codex",
      "xai",
    ]);
    expect(status.providers.find((p) => p.id === "anthropic")?.flow).toBe("manual_paste");
    expect(status.providers.find((p) => p.id === "openai-codex")?.flow).toBe("manual_paste");
    expect(status.providers.find((p) => p.id === "github-copilot")?.flow).toBe("device_code");
    expect(status.providers.find((p) => p.id === "xai")?.flow).toBe("device_code");
    expect(status.providers.every((p) => p.accounts.length === 0)).toBe(true);
  });

  it("xAI device-code: starts, polls, and persists rotating credentials encrypted", async () => {
    const store = makeStore();
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        json({
          token_endpoint: "https://auth.x.ai/oauth2/token",
          device_authorization_endpoint: "https://auth.x.ai/oauth2/device/code",
        }),
      )
      .mockResolvedValueOnce(
        json({
          device_code: "device-secret",
          user_code: "ABCD-EFGH",
          verification_uri: "https://auth.x.ai/activate",
          expires_in: 600,
          interval: 5,
        }),
      )
      .mockResolvedValueOnce(json({ error: "authorization_pending" }, 400))
      .mockResolvedValueOnce(json({ access_token: "AT", refresh_token: "RT", expires_in: 3600 }));
    const admin = createOAuthAdmin({
      store,
      encKey: KEY,
      config: makeConfig(),
      makeFetch: () => fetchImpl,
      now: () => 1_000,
      genSessionId: () => "xai-session",
    });

    const start = await admin.startDeviceCode({ providerId: "xai" });
    expect(start).toEqual({
      sessionId: "xai-session",
      userCode: "ABCD-EFGH",
      verificationUri: "https://auth.x.ai/activate",
      intervalMs: 5_000,
      expiresAt: 601_000,
      serverNowMs: 1_000,
    });
    await expect(
      admin.pollDeviceCode({ sessionId: start.sessionId, account: "heavy" }),
    ).resolves.toEqual({ status: "pending" });
    await expect(
      admin.pollDeviceCode({ sessionId: start.sessionId, account: "heavy" }),
    ).resolves.toEqual({ status: "done" });
    const row = await store.get("xai", "heavy");
    expect(decryptSecret(row?.accessEnc ?? "", KEY)).toBe("AT");
    expect(decryptSecret(row?.refreshEnc ?? "", KEY)).toBe("RT");
    expect(row?.meta).toContain("https://auth.x.ai/oauth2/token");
  });

  it("xAI device-code: rejects polling after the upstream device code expires", async () => {
    let now = 1_000;
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        json({
          token_endpoint: "https://auth.x.ai/oauth2/token",
          device_authorization_endpoint: "https://auth.x.ai/oauth2/device/code",
        }),
      )
      .mockResolvedValueOnce(
        json({
          device_code: "device-secret",
          user_code: "ABCD-EFGH",
          verification_uri: "https://auth.x.ai/activate",
          expires_in: 10,
          interval: 2,
        }),
      );
    const admin = createOAuthAdmin({
      store: makeStore(),
      encKey: KEY,
      config: makeConfig(),
      makeFetch: () => fetchImpl,
      now: () => now,
      genSessionId: () => "xai-expiring-session",
    });

    const start = await admin.startDeviceCode({ providerId: "xai" });
    expect(start).toMatchObject({ intervalMs: 2_000, expiresAt: 11_000 });
    now = 11_000;

    await expect(
      admin.pollDeviceCode({ sessionId: start.sessionId, account: "heavy" }),
    ).rejects.toThrow(/session not found or expired/);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("manual-paste: start -> complete persists an ENCRYPTED credential", async () => {
    const store = makeStore();
    let seq = 0;
    const admin = createOAuthAdmin({
      store,
      encKey: KEY,
      config: makeConfig(),
      now: () => 1000,
      genSessionId: () => `s${++seq}`,
    });
    vi.stubGlobal(
      "fetch",
      routeFetch([
        [/oauth\/token/, () => json({ access_token: "AT", refresh_token: "RT", expires_in: 3600 })],
      ]),
    );
    const { sessionId, authorizeUrl } = await admin.startManualPaste({ providerId: "anthropic" });
    expect(sessionId).toBe("s1");
    const state = new URL(authorizeUrl).searchParams.get("state");
    await admin.completeManualPaste({
      sessionId,
      redirectInput: `https://x/cb?code=THECODE&state=${state}`,
      account: "default",
    });
    const row = await store.get("anthropic", "default");
    expect(row).not.toBeNull();
    // Stored ciphertext, NOT plaintext.
    expect(row?.refreshEnc).toContain("v1:");
    expect(row?.refreshEnc).not.toBe("RT");
    expect(decryptSecret(row?.accessEnc ?? "", KEY)).toBe("AT");
    expect(decryptSecret(row?.refreshEnc ?? "", KEY)).toBe("RT");
    // Listed as a logged-in account now.
    const status = await admin.listStatus();
    expect(status.providers.find((p) => p.id === "anthropic")?.accounts).toHaveLength(1);
  });

  it("binds MULTIPLE accounts of the SAME provider (each connect = a new account)", async () => {
    const store = makeStore();
    let seq = 0;
    const admin = createOAuthAdmin({
      store,
      encKey: KEY,
      config: makeConfig(),
      genSessionId: () => `s${++seq}`,
    });
    vi.stubGlobal(
      "fetch",
      routeFetch([
        [/oauth\/token/, () => json({ access_token: "AT", refresh_token: "RT", expires_in: 3600 })],
      ]),
    );
    for (const account of ["work", "personal"]) {
      const { sessionId, authorizeUrl } = await admin.startManualPaste({ providerId: "anthropic" });
      const state = new URL(authorizeUrl).searchParams.get("state");
      await admin.completeManualPaste({
        sessionId,
        redirectInput: `https://x/cb?code=C&state=${state}`,
        account,
      });
    }
    const anthropic = (await admin.listStatus()).providers.find((p) => p.id === "anthropic");
    expect(anthropic?.accounts.map((a) => a.account).sort()).toEqual(["personal", "work"]);

    // Disconnecting one leaves the other intact.
    await admin.logout({ providerId: "anthropic", account: "work" });
    const after = (await admin.listStatus()).providers.find((p) => p.id === "anthropic");
    expect(after?.accounts.map((a) => a.account)).toEqual(["personal"]);
  });

  it("manual-paste: Codex start -> complete persists encrypted creds (form-encoded exchange)", async () => {
    const store = makeStore();
    const admin = createOAuthAdmin({
      store,
      encKey: KEY,
      config: makeConfig(),
      genSessionId: () => "cdx",
    });
    // A Codex access token is a JWT; carry an account id claim so completion succeeds.
    const seg = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
    const identityClaims = {
      email: "codex@example.com",
      "https://api.openai.com/auth": {
        chatgpt_plan_type: "pro",
        chatgpt_user_id: "user_9",
        chatgpt_account_id: "acc_9",
        chatgpt_account_is_fedramp: true,
      },
    };
    const jwt = `${seg({ alg: "none" })}.${seg(identityClaims)}.s`;
    const idToken = `${seg({ alg: "none" })}.${seg(identityClaims)}.id`;
    vi.stubGlobal(
      "fetch",
      routeFetch([
        [
          /auth\.openai\.com\/oauth\/token/,
          () =>
            json({
              id_token: idToken,
              access_token: jwt,
              refresh_token: "RTC",
              expires_in: 3600,
            }),
        ],
      ]),
    );
    const { sessionId, authorizeUrl } = await admin.startManualPaste({
      providerId: "openai-codex",
    });
    expect(authorizeUrl).toContain("auth.openai.com");
    const state = new URL(authorizeUrl).searchParams.get("state");
    await admin.completeManualPaste({
      sessionId,
      redirectInput: `https://x/cb?code=C&state=${state}`,
      account: "default",
    });
    const row = await store.get("openai-codex", "default");
    expect(decryptSecret(row?.refreshEnc ?? "", KEY)).toBe("RTC");
    const meta = JSON.parse(row?.meta ?? "{}") as Record<string, unknown>;
    expect(meta).toMatchObject({
      email: "codex@example.com",
      chatgptPlanType: "pro",
      chatgptUserId: "user_9",
      accountId: "acc_9",
      isFedramp: true,
    });
    expect(meta).not.toHaveProperty("idToken");
    expect(row?.meta).not.toContain(idToken);
    const account = (await admin.listStatus()).providers
      .find((provider) => provider.id === "openai-codex")
      ?.accounts.find((candidate) => candidate.account === "default");
    expect(account).toMatchObject({
      email: "codex@example.com",
      chatgptPlanType: "pro",
      chatgptAccountId: "acc_9",
      isFedramp: true,
    });
  });

  it("device-code: start -> poll(pending) -> poll(done) persists + stores enterprise meta", async () => {
    const store = makeStore();
    const admin = createOAuthAdmin({
      store,
      encKey: KEY,
      config: makeConfig(),
      genSessionId: () => "dev",
    });
    const tokenResponses = [{ error: "authorization_pending" }, { access_token: "gho_x" }];
    let i = 0;
    vi.stubGlobal(
      "fetch",
      routeFetch([
        [
          /login\/device\/code/,
          () =>
            json({
              device_code: "DC",
              user_code: "WXYZ-1234",
              verification_uri: "https://github.com/login/device",
              interval: 5,
              expires_in: 900,
            }),
        ],
        [/login\/oauth\/access_token/, () => json(tokenResponses[i++])],
        [
          /copilot_internal\/v2\/token/,
          () =>
            json({
              token: "tid=x;proxy-ep=proxy.indiv.githubcopilot.com;",
              expires_at: Math.floor(Date.now() / 1000) + 3600,
            }),
        ],
      ]),
    );
    const start = await admin.startDeviceCode({ providerId: "github-copilot" });
    expect(start.userCode).toBe("WXYZ-1234");
    expect(await admin.pollDeviceCode({ sessionId: "dev", account: "default" })).toEqual({
      status: "pending",
    });
    expect(await admin.pollDeviceCode({ sessionId: "dev", account: "default" })).toEqual({
      status: "done",
    });
    const row = await store.get("github-copilot", "default");
    expect(decryptSecret(row?.refreshEnc ?? "", KEY)).toBe("gho_x");
    expect(decryptSecret(row?.accessEnc ?? "", KEY)).toContain("proxy-ep=");
  });

  it("logout deletes the stored credential and clears that account's settings", async () => {
    const { tokens, config } = makeStores();
    await tokens.upsert({
      providerId: "anthropic",
      account: "default",
      accessEnc: "v1:a",
      refreshEnc: "v1:r",
      expiresAt: 1,
      meta: null,
      updatedAt: 1,
    });
    const admin = createOAuthAdmin({ store: tokens, encKey: KEY, config });
    await admin.setAccountProxy({
      providerId: "anthropic",
      account: "default",
      proxy: { type: "socks5", host: "10.0.0.1", port: 1080, password: "secret" },
    });
    await admin.setEnabledModels({
      providerId: "github-copilot",
      account: "other",
      mode: "manual",
      models: ["gpt-4o"],
    });

    await admin.logout({ providerId: "anthropic", account: "default" });
    expect(await tokens.get("anthropic", "default")).toBeNull();
    const map = await loadAccountSettings(config, KEY);
    expect(getAccountSettings(map, "anthropic", "default")).toEqual({});
    expect(getAccountSettings(map, "github-copilot", "other")).toEqual({
      modelsMode: "manual",
      enabledModels: ["gpt-4o"],
    });
    expect(decryptSecret((await config.get("oauth.account_settings")) ?? "", KEY)).not.toContain(
      "secret",
    );
  });

  it("rejects an unknown/expired session", async () => {
    const admin = createOAuthAdmin({ store: makeStore(), encKey: KEY, config: makeConfig() });
    await expect(
      admin.completeManualPaste({ sessionId: "nope", redirectInput: "code=x", account: "default" }),
    ).rejects.toThrow(/session not found/);
  });

  it("bounds abandoned starts, prunes them on the next start, and retains live sessions", async () => {
    let now = 0;
    let sequence = 0;
    const admin = createOAuthAdmin({
      store: makeStore(),
      encKey: KEY,
      config: makeConfig(),
      now: () => now,
      genSessionId: () => `pending-${++sequence}`,
    });
    vi.stubGlobal(
      "fetch",
      routeFetch([
        [/oauth\/token/, () => json({ access_token: "AT", refresh_token: "RT", expires_in: 3600 })],
      ]),
    );

    const pending = await Promise.all(
      Array.from({ length: MAX_PENDING_OAUTH_SESSIONS }, () =>
        admin.startManualPaste({ providerId: "anthropic" }),
      ),
    );
    await expect(admin.startManualPaste({ providerId: "anthropic" })).rejects.toThrow(
      /too many pending OAuth sessions/,
    );

    const retained = pending[0];
    if (!retained) throw new Error("missing retained session");
    await expect(
      admin.completeManualPaste({
        sessionId: retained.sessionId,
        redirectInput: `https://x/cb?code=C&state=${new URL(retained.authorizeUrl).searchParams.get("state")}`,
        account: "retained",
      }),
    ).resolves.toBeUndefined();

    now = 15 * 60 * 1000 - 1;
    const live = await admin.startManualPaste({ providerId: "anthropic" });
    now = 15 * 60 * 1000 + 1;
    await expect(admin.startManualPaste({ providerId: "anthropic" })).resolves.toBeDefined();
    await expect(
      admin.completeManualPaste({
        sessionId: live.sessionId,
        redirectInput: `https://x/cb?code=C&state=${new URL(live.authorizeUrl).searchParams.get("state")}`,
        account: "live",
      }),
    ).resolves.toBeUndefined();
  });

  it("reserves device-code capacity before the upstream request and releases it on failure", async () => {
    let release!: () => void;
    const upstreamGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fetchImpl = vi.fn(async () => {
      await upstreamGate;
      throw new Error("upstream failed");
    }) as unknown as typeof fetch;
    const admin = createOAuthAdmin({
      store: makeStore(),
      encKey: KEY,
      config: makeConfig(),
      makeFetch: () => fetchImpl,
    });

    const starts = Array.from({ length: MAX_PENDING_OAUTH_SESSIONS + 1 }, () =>
      admin.startDeviceCode({ providerId: "github-copilot" }),
    );
    const settled = Promise.allSettled(starts);
    expect(fetchImpl).toHaveBeenCalledTimes(MAX_PENDING_OAUTH_SESSIONS);

    release();
    const results = await settled;
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(
      MAX_PENDING_OAUTH_SESSIONS + 1,
    );
    await expect(admin.startDeviceCode({ providerId: "github-copilot" })).rejects.toThrow(
      /upstream failed/,
    );
    expect(fetchImpl).toHaveBeenCalledTimes(MAX_PENDING_OAUTH_SESSIONS + 1);
  });

  it("listStatus AUTO-RENEWS an expired account on view (openclaw-style lazy refresh)", async () => {
    const store = makeStore();
    const NOW = 10_000_000;
    // An EXPIRED Copilot account whose durable GitHub token is still valid.
    await store.upsert({
      providerId: "github-copilot",
      account: "mylukin",
      accessEnc: encryptSecret("old;proxy-ep=proxy.x.com;", KEY),
      refreshEnc: encryptSecret("gho_valid", KEY),
      expiresAt: 1000, // long past
      meta: null,
      updatedAt: 1,
    });
    const admin = createOAuthAdmin({ store, encKey: KEY, config: makeConfig(), now: () => NOW });
    vi.stubGlobal(
      "fetch",
      routeFetch([
        [
          /copilot_internal\/v2\/token/,
          () => json({ token: "tid=y;proxy-ep=proxy.y.com;", expires_at: NOW / 1000 + 1800 }),
        ],
      ]),
    );
    const acct = (await admin.listStatus()).providers.find((p) => p.id === "github-copilot")
      ?.accounts[0];
    expect(acct?.healthy).toBe(true);
    expect(acct?.expiresAt ?? 0).toBeGreaterThan(NOW); // renewed into the future
    // The store now holds the freshly re-minted token.
    expect(
      decryptSecret((await store.get("github-copilot", "mylukin"))?.accessEnc ?? "", KEY),
    ).toContain("proxy-ep=proxy.y.com");
  });

  it("listCachedStatus never refreshes an expired credential or discovers models upstream", async () => {
    const { tokens, config } = makeStores();
    await tokens.upsert({
      providerId: "anthropic",
      account: "cached",
      accessEnc: encryptSecret("expired-access", KEY),
      refreshEnc: encryptSecret("durable-refresh", KEY),
      expiresAt: 1_000,
      meta: null,
      updatedAt: 500,
    });
    await setAccountSettings(config, KEY, "anthropic", "cached", {
      modelsMode: "manual",
      enabledModels: ["claude-opus-4-6"],
    });
    const fetchFn = vi.fn(async () => {
      throw new Error("cached status must not access the network");
    });
    const admin = createOAuthAdmin({
      store: tokens,
      encKey: KEY,
      config,
      now: () => 10_000_000,
      makeFetch: () => fetchFn as unknown as typeof fetch,
    });

    const account = (await admin.listCachedStatus()).providers
      .find((provider) => provider.id === "anthropic")
      ?.accounts.find((candidate) => candidate.account === "cached");

    expect(account).toMatchObject({
      account: "cached",
      expiresAt: 1_000,
      updatedAt: 500,
      healthy: true,
      models: ["claude-opus-4-6"],
    });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("listStatus marks an account unhealthy when its refresh fails (needs reconnect)", async () => {
    const store = makeStore();
    const config = makeConfig();
    const onCredentialFailure = vi.fn(async () => {});
    await store.upsert({
      providerId: "github-copilot",
      account: "dead",
      accessEnc: encryptSecret("x", KEY),
      refreshEnc: encryptSecret("gho_revoked", KEY),
      expiresAt: 1000,
      meta: null,
      updatedAt: 1,
    });
    const admin = createOAuthAdmin({
      store,
      encKey: KEY,
      config,
      now: () => 10_000_000,
      onCredentialFailure,
    });
    vi.stubGlobal(
      "fetch",
      routeFetch([[/copilot_internal\/v2\/token/, () => json({ error: "bad" }, 401)]]),
    );
    const acct = (await admin.listStatus()).providers.find((p) => p.id === "github-copilot")
      ?.accounts[0];
    expect(acct?.healthy).toBe(false);
    expect(acct?.credentialFailed).toBe(true);
    expect(onCredentialFailure).toHaveBeenCalledWith(
      "github-copilot",
      "dead",
      "oauth refresh failed (github-copilot, status 401)",
    );
    const settings = getAccountSettings(
      await loadAccountSettings(config, KEY),
      "github-copilot",
      "dead",
    );
    expect(settings.credentialFailedAt).toBe(10_000_000);
    expect(settings.schedulable).toBe(false);
  });

  it("does not persist a bare Codex refresh 403 as a dead credential", async () => {
    const { tokens, config } = makeStores();
    await tokens.upsert({
      providerId: "openai-codex",
      account: "proxied",
      accessEnc: encryptSecret("expired", KEY),
      refreshEnc: encryptSecret("still-present", KEY),
      expiresAt: 1_000,
      meta: null,
      updatedAt: 1,
    });
    const admin = createOAuthAdmin({
      store: tokens,
      encKey: KEY,
      config,
      now: () => 10_000_000,
      makeFetch: () => vi.fn(async () => json({ error: "access_denied" }, 403)),
    });

    const account = (await admin.listStatus()).providers.find((p) => p.id === "openai-codex")
      ?.accounts[0];
    const settings = getAccountSettings(
      await loadAccountSettings(config, KEY),
      "openai-codex",
      "proxied",
    );

    expect(account).toMatchObject({
      healthy: false,
      credentialFailed: false,
      schedulable: true,
    });
    expect(settings.credentialFailedAt).toBeUndefined();
    expect(settings.schedulable).toBeUndefined();
  });

  it("listStatus treats a persisted credential failure as reconnect-only and does not refresh", async () => {
    const { tokens, config } = makeStores();
    await tokens.upsert({
      providerId: "openai-codex",
      account: "dead",
      accessEnc: encryptSecret("x", KEY),
      refreshEnc: encryptSecret("revoked", KEY),
      expiresAt: 1000,
      meta: null,
      updatedAt: 1,
    });
    await setAccountSettings(config, KEY, "openai-codex", "dead", {
      credentialFailedAt: 12_345,
      credentialFailureReason: "oauth refresh failed (openai-codex, status 401)",
      schedulable: false,
    });
    const fetchFn = vi.fn(async () => {
      throw new Error("must not refresh a credential-failed account");
    });
    const admin = createOAuthAdmin({
      store: tokens,
      encKey: KEY,
      config,
      makeFetch: () => fetchFn as unknown as typeof fetch,
    });

    const acct = (await admin.listStatus()).providers.find((p) => p.id === "openai-codex")
      ?.accounts[0];

    expect(acct?.healthy).toBe(false);
    expect(acct?.credentialFailed).toBe(true);
    expect(acct?.schedulable).toBe(false);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("rejects the wrong flow for a provider", async () => {
    const admin = createOAuthAdmin({ store: makeStore(), encKey: KEY, config: makeConfig() });
    await expect(admin.startManualPaste({ providerId: "github-copilot" })).rejects.toThrow(
      /manual-paste/,
    );
    await expect(admin.startDeviceCode({ providerId: "anthropic" })).rejects.toThrow(/device-code/);
  });

  // ── per-account model curation (Stage 1) ───────────────────────────────────

  it("listModels: an unconfigured auto account enables every live-discovered model", async () => {
    const { tokens, config } = makeStores();
    // A stored Anthropic credential whose access token refresh succeeds.
    await tokens.upsert({
      providerId: "anthropic",
      account: "default",
      accessEnc: encryptSecret("AT", KEY),
      refreshEnc: encryptSecret("RT", KEY),
      expiresAt: Date.now() + 3_600_000, // still fresh → no network on getAuthHeader
      meta: null,
      updatedAt: 1,
    });
    vi.stubGlobal(
      "fetch",
      routeFetch([
        [
          /api\.anthropic\.com\/v1\/models/,
          () =>
            json({
              data: [
                { id: "claude-opus-4-8" },
                { id: "claude-sonnet-4-7" },
                { id: "claude-haiku-4-6" },
              ],
            }),
        ],
      ]),
    );
    const admin = createOAuthAdmin({ store: tokens, encKey: KEY, config });
    const { available, enabled, canPull } = await admin.listModels({
      providerId: "anthropic",
      account: "default",
    });
    expect(available).toEqual(["claude-haiku-4-6", "claude-opus-4-8", "claude-sonnet-4-7"]);
    // Unset settings ⇒ everything is enabled.
    expect(enabled).toEqual(available);
    // Anthropic has a live list-models API → the UI may offer "pull from provider".
    expect(canPull).toBe(true);
  });

  it("listModels: Codex uses the exact account catalog, derives gpt-5.6 from Sol, and fingerprints the full identity", async () => {
    const { tokens, config } = makeStores();
    await tokens.upsert({
      providerId: "openai-codex",
      account: "default",
      accessEnc: encryptSecret("AT", KEY),
      refreshEnc: encryptSecret("RT", KEY),
      expiresAt: Date.now() + 3_600_000,
      meta: JSON.stringify({
        accountId: "workspace-1",
        chatgptUserId: "user-1",
        chatgptPlanType: "business",
        email: "codex@example.com",
      }),
      updatedAt: 1,
    });
    let accountIdentity = "";
    const admin = createOAuthAdmin({
      store: tokens,
      encKey: KEY,
      config,
      codexCatalog: codexCatalog(
        [
          { slug: "gpt-5.6-sol", priority: 1 },
          { slug: "codex-auto-review", priority: 2, visibility: "hide" },
          { slug: "gpt-5.6-luna", priority: 3 },
        ],
        (value) => {
          accountIdentity = value;
        },
      ),
    });
    const { available, enabled, canPull, modelsMode } = await admin.listModels({
      providerId: "openai-codex",
      account: "default",
    });
    expect(available).toEqual(["gpt-5.6-sol", "gpt-5.6-luna", "gpt-5.6"]);
    expect(enabled).toEqual(["gpt-5.6-sol", "codex-auto-review", "gpt-5.6-luna", "gpt-5.6"]);
    expect(canPull).toBe(true);
    expect(modelsMode).toBe("auto");
    expect(accountIdentity).toBe(
      JSON.stringify(["workspace-1", "user-1", true, "codex@example.com"]),
    );
  });

  it("listModels: Codex manual mode can only narrow the full account entitlement", async () => {
    const { tokens, config } = makeStores();
    await tokens.upsert({
      providerId: "openai-codex",
      account: "default",
      accessEnc: encryptSecret("AT", KEY),
      refreshEnc: encryptSecret("RT", KEY),
      expiresAt: Date.now() + 3_600_000,
      meta: JSON.stringify({ accountId: "workspace-1" }),
      updatedAt: 1,
    });
    await setAccountSettings(config, KEY, "openai-codex", "default", {
      modelsMode: "manual",
      enabledModels: ["gpt-5.6", "codex-auto-review", "gpt-never-entitled"],
    });
    const admin = createOAuthAdmin({
      store: tokens,
      encKey: KEY,
      config,
      codexCatalog: codexCatalog([
        { slug: "gpt-5.6-sol", priority: 1 },
        { slug: "codex-auto-review", priority: 2, visibility: "hide" },
      ]),
    });

    await expect(
      admin.listModels({ providerId: "openai-codex", account: "default" }),
    ).resolves.toMatchObject({
      available: ["gpt-5.6-sol", "gpt-5.6"],
      enabled: ["gpt-5.6", "codex-auto-review"],
      modelsMode: "manual",
      canPull: true,
    });
  });

  it("listStatus: Codex reports the account catalog and applies manual entitlement intersection", async () => {
    const { tokens, config } = makeStores();
    await tokens.upsert({
      providerId: "openai-codex",
      account: "default",
      accessEnc: encryptSecret("AT", KEY),
      refreshEnc: encryptSecret("RT", KEY),
      expiresAt: Date.now() + 3_600_000,
      meta: JSON.stringify({ accountId: "workspace-1" }),
      updatedAt: 1,
    });
    await setAccountSettings(config, KEY, "openai-codex", "default", {
      modelsMode: "manual",
      enabledModels: ["gpt-5.6", "codex-auto-review", "gpt-never-entitled"],
    });
    const admin = createOAuthAdmin({
      store: tokens,
      encKey: KEY,
      config,
      codexCatalog: codexCatalog([
        { slug: "gpt-5.6-sol", priority: 1 },
        { slug: "codex-auto-review", priority: 2, visibility: "hide" },
      ]),
    });

    const account = (await admin.listStatus()).providers
      .find((provider) => provider.id === "openai-codex")
      ?.accounts.find((candidate) => candidate.account === "default");
    expect(account?.models).toEqual(["gpt-5.6", "codex-auto-review"]);
  });

  it("listStatus: auto mode reports the account's live-discovered models", async () => {
    const { tokens, config } = makeStores();
    await tokens.upsert({
      providerId: "anthropic",
      account: "default",
      accessEnc: encryptSecret("AT", KEY),
      refreshEnc: encryptSecret("RT", KEY),
      expiresAt: Date.now() + 3_600_000,
      meta: null,
      updatedAt: 1,
    });
    const fetchMock = routeFetch([
      [
        /api\.anthropic\.com\/v1\/models/,
        () =>
          json({
            data: [{ id: "claude-fable-5" }, { id: "claude-sonnet-4-7" }],
          }),
      ],
    ]);
    vi.stubGlobal("fetch", fetchMock);
    const admin = createOAuthAdmin({ store: tokens, encKey: KEY, config });

    const account = (await admin.listStatus()).providers
      .find((provider) => provider.id === "anthropic")
      ?.accounts.find((candidate) => candidate.account === "default");

    expect(account?.models).toEqual(["claude-fable-5", "claude-sonnet-4-7"]);
    expect(
      getAccountSettings(await loadAccountSettings(config, KEY), "anthropic", "default")
        .discoveredModels,
    ).toEqual(["claude-fable-5", "claude-sonnet-4-7"]);
    await expect(
      admin.listModels({ providerId: "anthropic", account: "default" }),
    ).resolves.toMatchObject({
      available: ["claude-fable-5", "claude-sonnet-4-7"],
      enabled: ["claude-fable-5", "claude-sonnet-4-7"],
    });
    await admin.listStatus();
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("listStatus: auto discovery failure stays empty instead of showing curated defaults", async () => {
    const { tokens, config } = makeStores();
    await tokens.upsert({
      providerId: "anthropic",
      account: "default",
      accessEnc: encryptSecret("AT", KEY),
      refreshEnc: encryptSecret("RT", KEY),
      expiresAt: Date.now() + 3_600_000,
      meta: null,
      updatedAt: 1,
    });
    vi.stubGlobal(
      "fetch",
      routeFetch([[/api\.anthropic\.com\/v1\/models/, () => json({ error: "unavailable" }, 503)]]),
    );
    const admin = createOAuthAdmin({ store: tokens, encKey: KEY, config });

    const account = (await admin.listStatus()).providers
      .find((provider) => provider.id === "anthropic")
      ?.accounts.find((candidate) => candidate.account === "default");

    expect(account?.models).toEqual([]);
  });

  it("xAI structured refresh persists metadata and treats an empty catalog as authoritative", async () => {
    const { tokens, config } = makeStores();
    await tokens.upsert({
      providerId: "xai",
      account: "heavy",
      accessEnc: encryptSecret("xai-access", KEY),
      refreshEnc: encryptSecret("xai-refresh", KEY),
      expiresAt: Date.now() + 3_600_000,
      meta: JSON.stringify({ accountId: "xai-user-heavy", email: "heavy@example.test" }),
      updatedAt: 1,
    });
    await setAccountSettings(config, KEY, "xai", "heavy", {
      discoveredModels: ["stale-string-model"],
      xaiDiscoveredModels: [{ ...XAI_STRUCTURED_MODEL, id: "stale-structured" }],
    } as XaiAccountSettings);
    const responses = [
      Response.json({
        data: [
          {
            id: XAI_STRUCTURED_MODEL.id,
            model: XAI_STRUCTURED_MODEL.model,
            api_backend: XAI_STRUCTURED_MODEL.apiBackend,
            context_window: XAI_STRUCTURED_MODEL.contextWindow,
            max_completion_tokens: XAI_STRUCTURED_MODEL.maxCompletionTokens,
            supports_reasoning_effort: true,
            reasoning_effort: "high",
            reasoning_efforts: [{ id: "high", value: "high", label: "High" }],
            stream_tool_calls: true,
          },
        ],
      }),
      Response.json({ data: [] }),
    ];
    const seenHeaders: Headers[] = [];
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      seenHeaders.push(new Headers(init?.headers));
      const response = responses.shift();
      if (!response) throw new Error("unexpected xAI model refresh");
      return response;
    }) as typeof fetch;
    const admin = createOAuthAdmin({
      store: tokens,
      encKey: KEY,
      config,
      makeFetch: () => fetchMock,
    });

    const live = (await admin.listStatus({ forceRefresh: true })).providers
      .find((provider) => provider.id === "xai")
      ?.accounts.find((account) => account.account === "heavy");
    expect(live?.models).toEqual(XAI_ADMIN_MODELS);
    expect(
      getAccountSettings(
        await loadAccountSettings(config, KEY),
        "xai",
        "heavy",
      ) as XaiAccountSettings,
    ).toMatchObject({
      discoveredModels: ["display-grok"],
      xaiDiscoveredModels: [XAI_STRUCTURED_MODEL],
    });

    const empty = (await admin.listStatus({ forceRefresh: true })).providers
      .find((provider) => provider.id === "xai")
      ?.accounts.find((account) => account.account === "heavy");
    expect(empty?.models).toEqual(GROK_OAUTH_MEDIA_MODELS);
    expect(
      getAccountSettings(
        await loadAccountSettings(config, KEY),
        "xai",
        "heavy",
      ) as XaiAccountSettings,
    ).toEqual({ xaiDiscoveredModels: [] });
    expect(seenHeaders).toHaveLength(2);
    for (const headers of seenHeaders) {
      expect(headers.get("x-userid")).toBe("xai-user-heavy");
      expect(headers.get("x-email")).toBe("heavy@example.test");
    }
  });

  it("xAI structured refresh failure returns validated LKG instead of stale string fallbacks", async () => {
    const { tokens, config } = makeStores();
    await tokens.upsert({
      providerId: "xai",
      account: "heavy",
      accessEnc: encryptSecret("xai-access", KEY),
      refreshEnc: encryptSecret("xai-refresh", KEY),
      expiresAt: Date.now() + 3_600_000,
      meta: JSON.stringify({ accountId: "xai-user-heavy", email: "heavy@example.test" }),
      updatedAt: 1,
    });
    await setAccountSettings(config, KEY, "xai", "heavy", {
      discoveredModels: ["grok-4.5", "stale-string-model"],
      xaiDiscoveredModels: [XAI_STRUCTURED_MODEL],
    } as XaiAccountSettings);
    const modelDiscoveryCache = createOAuthModelDiscoveryCache();
    await modelDiscoveryCache.load({ providerId: "xai", account: "heavy" }, async () => [
      "stale-generic-cache",
    ]);
    const fetchMock = vi.fn(async () => Response.json({ error: "unavailable" }, { status: 503 }));
    const admin = createOAuthAdmin({
      store: tokens,
      encKey: KEY,
      config,
      modelDiscoveryCache,
      makeFetch: () => fetchMock as typeof fetch,
    });

    const account = (await admin.listStatus({ forceRefresh: true })).providers
      .find((provider) => provider.id === "xai")
      ?.accounts.find((candidate) => candidate.account === "heavy");

    expect(account?.models).toEqual(XAI_ADMIN_MODELS);
    expect(account?.models).not.toContain("stale-generic-cache");
    expect(account?.models).not.toContain("stale-string-model");
    expect(account?.models).not.toContain("grok-4.5");
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("xAI cached status projects the validated structured LKG without network or string-cache fallback", async () => {
    const { tokens, config } = makeStores();
    await tokens.upsert({
      providerId: "xai",
      account: "heavy",
      accessEnc: encryptSecret("xai-access", KEY),
      refreshEnc: encryptSecret("xai-refresh", KEY),
      expiresAt: Date.now() + 3_600_000,
      meta: JSON.stringify({ accountId: "xai-user-heavy", email: "heavy@example.test" }),
      updatedAt: 1,
    });
    await setAccountSettings(config, KEY, "xai", "heavy", {
      discoveredModels: ["stale-string-model"],
      xaiDiscoveredModels: [XAI_STRUCTURED_MODEL],
    } as XaiAccountSettings);
    const modelDiscoveryCache = createOAuthModelDiscoveryCache();
    await modelDiscoveryCache.load({ providerId: "xai", account: "heavy" }, async () => [
      "stale-generic-cache",
    ]);
    const fetchMock = vi.fn(async () => {
      throw new Error("cached status must not access the network");
    });
    const admin = createOAuthAdmin({
      store: tokens,
      encKey: KEY,
      config,
      modelDiscoveryCache,
      makeFetch: () => fetchMock as unknown as typeof fetch,
    });

    const account = (await admin.listCachedStatus()).providers
      .find((provider) => provider.id === "xai")
      ?.accounts.find((candidate) => candidate.account === "heavy");

    expect(account?.models).toEqual(XAI_ADMIN_MODELS);
    expect(account?.models).not.toContain("stale-string-model");
    expect(account?.models).not.toContain("stale-generic-cache");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("xAI admin status and model manager include the executable Grok media aliases", async () => {
    const { tokens, config } = makeStores();
    await tokens.upsert({
      providerId: "xai",
      account: "heavy",
      accessEnc: encryptSecret("xai-access", KEY),
      refreshEnc: encryptSecret("xai-refresh", KEY),
      expiresAt: Date.now() + 3_600_000,
      meta: JSON.stringify({ accountId: "xai-user-heavy", email: "heavy@example.test" }),
      updatedAt: 1,
    });
    await setAccountSettings(config, KEY, "xai", "heavy", {
      xaiDiscoveredModels: [XAI_STRUCTURED_MODEL],
    } as XaiAccountSettings);
    const fetchMock = vi.fn(async () =>
      Response.json({
        data: [
          {
            id: XAI_STRUCTURED_MODEL.id,
            model: XAI_STRUCTURED_MODEL.model,
            api_backend: XAI_STRUCTURED_MODEL.apiBackend,
            context_window: XAI_STRUCTURED_MODEL.contextWindow,
            max_completion_tokens: XAI_STRUCTURED_MODEL.maxCompletionTokens,
            supports_reasoning_effort: true,
            reasoning_effort: "high",
            reasoning_efforts: [{ id: "high", value: "high", label: "High" }],
            stream_tool_calls: true,
          },
        ],
      }),
    );
    const admin = createOAuthAdmin({
      store: tokens,
      encKey: KEY,
      config,
      makeFetch: () => fetchMock as typeof fetch,
    });

    const account = (await admin.listCachedStatus()).providers
      .find((provider) => provider.id === "xai")
      ?.accounts.find((candidate) => candidate.account === "heavy");
    const modelManager = await admin.listModels({ providerId: "xai", account: "heavy" });
    expect(account?.models).toEqual(XAI_ADMIN_MODELS);
    expect(modelManager.available).toEqual(XAI_ADMIN_MODELS);
    expect(modelManager.enabled).toEqual(XAI_ADMIN_MODELS);
    expect(new Set(modelManager.available).size).toBe(modelManager.available.length);

    await admin.setEnabledModels({
      providerId: "xai",
      account: "heavy",
      mode: "manual",
      models: [XAI_STRUCTURED_MODEL.id, GROK_OAUTH_MEDIA_MODELS[0]],
    });
    expect((await admin.listModels({ providerId: "xai", account: "heavy" })).enabled).toEqual([
      XAI_STRUCTURED_MODEL.id,
      GROK_OAUTH_MEDIA_MODELS[0],
    ]);
  });

  it("does not persist an old discovery result after its credential cache generation is invalidated", async () => {
    const { tokens, config } = makeStores();
    await tokens.upsert({
      providerId: "anthropic",
      account: "default",
      accessEnc: encryptSecret("AT", KEY),
      refreshEnc: encryptSecret("RT", KEY),
      expiresAt: Date.now() + 3_600_000,
      meta: null,
      updatedAt: 1,
    });
    let resolveModels!: (response: Response) => void;
    const pendingModels = new Promise<Response>((resolve) => {
      resolveModels = resolve;
    });
    const fetchMock = vi.fn(async () => pendingModels);
    vi.stubGlobal("fetch", fetchMock);
    const modelDiscoveryCache = createOAuthModelDiscoveryCache();
    const admin = createOAuthAdmin({
      store: tokens,
      encKey: KEY,
      config,
      modelDiscoveryCache,
    });

    const pending = admin.listModels({ providerId: "anthropic", account: "default" });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    modelDiscoveryCache.invalidate({ providerId: "anthropic", account: "default" });
    resolveModels(json({ data: [{ id: "claude-old-identity" }] }));
    await expect(pending).resolves.toMatchObject({ available: ["claude-old-identity"] });

    expect(
      getAccountSettings(await loadAccountSettings(config, KEY), "anthropic", "default")
        .discoveredModels,
    ).toBeUndefined();
  });

  it("keeps the old credential when its identity-bound model snapshot cannot be cleared", async () => {
    const db = createSqliteDb(":memory:");
    const tokens = new SqliteOAuthTokenStore(db);
    const storedConfig = new SqliteConfigStore(db);
    await tokens.upsert({
      providerId: "anthropic",
      account: "default",
      accessEnc: encryptSecret("OLD", KEY),
      refreshEnc: encryptSecret("OLD-RT", KEY),
      expiresAt: Date.now() + 3_600_000,
      meta: null,
      updatedAt: 1,
    });
    await setAccountSettings(storedConfig, KEY, "anthropic", "default", {
      discoveredModels: ["claude-old-identity"],
    });
    const failingConfig: ConfigStore = {
      get: (key) => storedConfig.get(key),
      set: async () => {
        throw new Error("database unavailable");
      },
    };
    vi.stubGlobal(
      "fetch",
      routeFetch([
        [
          /oauth\/token/,
          () => json({ access_token: "NEW", refresh_token: "NEW-RT", expires_in: 3600 }),
        ],
      ]),
    );
    const admin = createOAuthAdmin({
      store: tokens,
      encKey: KEY,
      config: failingConfig,
      genSessionId: () => "replace",
    });
    const { authorizeUrl } = await admin.startManualPaste({ providerId: "anthropic" });
    const state = new URL(authorizeUrl).searchParams.get("state");

    await expect(
      admin.completeManualPaste({
        sessionId: "replace",
        redirectInput: `https://x/cb?code=C&state=${state}`,
        account: "default",
      }),
    ).rejects.toThrow();
    expect(decryptSecret((await tokens.get("anthropic", "default"))?.accessEnc ?? "", KEY)).toBe(
      "OLD",
    );
  });

  it("setEnabledModels persists a subset; listModels then returns it as `enabled`", async () => {
    const { tokens, config } = makeStores();
    await tokens.upsert({
      providerId: "anthropic",
      account: "default",
      accessEnc: encryptSecret("AT", KEY),
      refreshEnc: encryptSecret("RT", KEY),
      expiresAt: Date.now() + 3_600_000,
      meta: null,
      updatedAt: 1,
    });
    vi.stubGlobal(
      "fetch",
      routeFetch([
        [
          /api\.anthropic\.com\/v1\/models/,
          () => json({ data: [{ id: "claude-opus-4-6" }, { id: "claude-sonnet-4-7" }] }),
        ],
      ]),
    );
    const admin = createOAuthAdmin({ store: tokens, encKey: KEY, config });
    await admin.setEnabledModels({
      providerId: "anthropic",
      account: "default",
      mode: "manual",
      models: ["claude-opus-4-6"],
    });
    const { available, enabled } = await admin.listModels({
      providerId: "anthropic",
      account: "default",
    });
    expect(available).toContain("claude-opus-4-6");
    expect(enabled).toEqual(["claude-opus-4-6"]);
    // The persisted blob is ENCRYPTED (never plaintext model JSON).
    const blob = await config.get("oauth.account_settings");
    expect(blob).toContain("v1:");
    expect(blob).not.toContain("claude-opus-4-6");
    expect(decryptSecret(blob ?? "", KEY)).toContain("claude-opus-4-6");
  });

  it("listModels: a CUSTOM (undiscovered) enabled id survives verbatim — the list is authoritative", async () => {
    const { tokens, config } = makeStores();
    await tokens.upsert({
      providerId: "anthropic",
      account: "default",
      accessEnc: encryptSecret("AT", KEY),
      refreshEnc: encryptSecret("RT", KEY),
      expiresAt: Date.now() + 3_600_000,
      meta: null,
      updatedAt: 1,
    });
    const admin = createOAuthAdmin({ store: tokens, encKey: KEY, config });
    // An id the operator typed by hand that discovery does NOT report (stale
    // catalog). It must NOT be intersected away — the saved list wins.
    await admin.setEnabledModels({
      providerId: "anthropic",
      account: "default",
      mode: "manual",
      models: ["claude-future-9", "claude-opus-4-6"],
    });
    const { available, enabled } = await admin.listModels({
      providerId: "anthropic",
      account: "default",
    });
    expect(available).not.toContain("claude-future-9"); // not discovered…
    expect(enabled).toEqual(["claude-future-9", "claude-opus-4-6"]); // …but kept verbatim
  });

  it("listModels: Copilot discovers live models via the refreshed token (fail-open)", async () => {
    const { tokens, config } = makeStores();
    const NOW = 10_000_000;
    await tokens.upsert({
      providerId: "github-copilot",
      account: "default",
      accessEnc: encryptSecret("old;proxy-ep=proxy.x.com;", KEY),
      refreshEnc: encryptSecret("gho_valid", KEY),
      expiresAt: 1000, // expired → getAuthHeader re-mints the copilot token
      meta: null,
      updatedAt: 1,
    });
    vi.stubGlobal(
      "fetch",
      routeFetch([
        [
          /copilot_internal\/v2\/token/,
          () => json({ token: "tid=y;proxy-ep=proxy.y.com;", expires_at: NOW / 1000 + 1800 }),
        ],
        [
          /api\.y\.com\/models/, // proxy-ep=proxy.y.com → base https://api.y.com
          () =>
            json({
              data: [
                { id: "gpt-4o", object: "model", capabilities: { type: "chat" } },
                { id: "claude-sonnet-4", object: "model", capabilities: { type: "chat" } },
                { id: "accounts/x", object: "model" }, // dropped
              ],
            }),
        ],
      ]),
    );
    const admin = createOAuthAdmin({ store: tokens, encKey: KEY, config, now: () => NOW });
    const { available, enabled } = await admin.listModels({
      providerId: "github-copilot",
      account: "default",
    });
    expect(available).toEqual(["claude-sonnet-4", "gpt-4o"]);
    expect(enabled).toEqual(available);
  });

  it("listModels fails open to [] when discovery throws", async () => {
    const { tokens, config } = makeStores();
    // No stored credential → token manager getAuthHeader throws → caught, [].
    const admin = createOAuthAdmin({ store: tokens, encKey: KEY, config });
    const { available, enabled } = await admin.listModels({
      providerId: "github-copilot",
      account: "missing",
    });
    expect(available).toEqual([]);
    expect(enabled).toEqual([]);
  });

  // ── per-account proxy (issue #38 follow-up) ─────────────────────────────────
  it("getAccountProxy returns null when no proxy is configured", async () => {
    const { tokens, config } = makeStores();
    const admin = createOAuthAdmin({ store: tokens, encKey: KEY, config });
    expect(await admin.getAccountProxy({ providerId: "anthropic", account: "default" })).toBeNull();
  });

  it("setAccountProxy persists; getAccountProxy returns it WITHOUT the password", async () => {
    const { tokens, config } = makeStores();
    const admin = createOAuthAdmin({ store: tokens, encKey: KEY, config });
    await admin.setAccountProxy({
      providerId: "anthropic",
      account: "default",
      proxy: { type: "socks5", host: "10.0.0.1", port: 1080, username: "u", password: "secret" },
    });
    const view = await admin.getAccountProxy({ providerId: "anthropic", account: "default" });
    expect(view).toEqual({
      type: "socks5",
      host: "10.0.0.1",
      port: 1080,
      username: "u",
      hasPassword: true,
    });
    // The password is NEVER in the projection (principle 7).
    expect(JSON.stringify(view)).not.toContain("secret");
    // …but it IS persisted (encrypted) so routing can use it.
    const blob = await config.get("oauth.account_settings");
    expect(blob).toContain("v1:");
    expect(blob).not.toContain("secret");
    expect(decryptSecret(blob ?? "", KEY)).toContain("secret");
  });

  it("setAccountProxy with an omitted password PRESERVES the stored one", async () => {
    const { tokens, config } = makeStores();
    const admin = createOAuthAdmin({ store: tokens, encKey: KEY, config });
    await admin.setAccountProxy({
      providerId: "anthropic",
      account: "default",
      proxy: { type: "http", host: "p", port: 8080, password: "keep-me" },
    });
    // Edit host/port only; no password field → the prior password survives.
    await admin.setAccountProxy({
      providerId: "anthropic",
      account: "default",
      proxy: { type: "http", host: "p2", port: 9090 },
    });
    const view = await admin.getAccountProxy({ providerId: "anthropic", account: "default" });
    expect(view).toMatchObject({ host: "p2", port: 9090, hasPassword: true });
    expect(decryptSecret((await config.get("oauth.account_settings")) ?? "", KEY)).toContain(
      "keep-me",
    );
  });

  it("setAccountProxy(null) CLEARS the proxy back to a direct connection", async () => {
    const { tokens, config } = makeStores();
    const admin = createOAuthAdmin({ store: tokens, encKey: KEY, config });
    await admin.setAccountProxy({
      providerId: "anthropic",
      account: "default",
      proxy: { type: "http", host: "p", port: 8080 },
    });
    await admin.setAccountProxy({ providerId: "anthropic", account: "default", proxy: null });
    expect(await admin.getAccountProxy({ providerId: "anthropic", account: "default" })).toBeNull();
  });

  it("setAccountProxy rejects a malformed proxy (fail-closed)", async () => {
    const { tokens, config } = makeStores();
    const admin = createOAuthAdmin({ store: tokens, encKey: KEY, config });
    await expect(
      admin.setAccountProxy({
        providerId: "anthropic",
        account: "default",
        proxy: { type: "http", host: "", port: 8080 },
      }),
    ).rejects.toThrow(/host/);
  });

  it("listStatus surfaces effective priority + schedulable + fastMode per account (defaults + tuned)", async () => {
    const { tokens, config } = makeStores();
    let seq = 0;
    const admin = createOAuthAdmin({
      store: tokens,
      encKey: KEY,
      config,
      genSessionId: () => `s${++seq}`,
    });
    vi.stubGlobal(
      "fetch",
      routeFetch([
        [/oauth\/token/, () => json({ access_token: "AT", refresh_token: "RT", expires_in: 3600 })],
      ]),
    );
    for (const account of ["tuned", "untuned"]) {
      const { sessionId, authorizeUrl } = await admin.startManualPaste({ providerId: "anthropic" });
      const state = new URL(authorizeUrl).searchParams.get("state");
      await admin.completeManualPaste({
        sessionId,
        redirectInput: `https://x/cb?code=C&state=${state}`,
        account,
      });
    }
    // Tune one account; leave the other at defaults.
    await admin.setAccountSchedule({
      providerId: "anthropic",
      account: "tuned",
      priority: 10,
      schedulable: false,
      fastMode: true,
    });
    const accts =
      (await admin.listStatus()).providers.find((p) => p.id === "anthropic")?.accounts ?? [];
    expect(accts.find((a) => a.account === "tuned")).toMatchObject({
      priority: 10,
      schedulable: false,
      fastMode: true,
    });
    expect(accts.find((a) => a.account === "untuned")).toMatchObject({
      priority: 50,
      schedulable: true,
      fastMode: false,
    });
  });

  it("listStatus surfaces each account's redacted proxy + mode-derived models", async () => {
    const { tokens, config } = makeStores();
    let seq = 0;
    const admin = createOAuthAdmin({
      store: tokens,
      encKey: KEY,
      config,
      genSessionId: () => `s${++seq}`,
    });
    vi.stubGlobal(
      "fetch",
      routeFetch([
        [/oauth\/token/, () => json({ access_token: "AT", refresh_token: "RT", expires_in: 3600 })],
        [
          /api\.anthropic\.com\/v1\/models/,
          () => json({ data: [{ id: "claude-fable-5" }, { id: "claude-sonnet-4-7" }] }),
        ],
      ]),
    );
    for (const account of ["proxied", "bare"]) {
      const { sessionId, authorizeUrl } = await admin.startManualPaste({ providerId: "anthropic" });
      const state = new URL(authorizeUrl).searchParams.get("state");
      await admin.completeManualPaste({
        sessionId,
        redirectInput: `https://x/cb?code=C&state=${state}`,
        account,
      });
    }
    // One account pins a proxy (with a password) + a manual model subset; the other
    // is left untouched in auto mode.
    await admin.setAccountProxy({
      providerId: "anthropic",
      account: "proxied",
      proxy: { type: "socks5", host: "10.0.0.1", port: 1080, username: "u", password: "secret" },
    });
    await admin.setEnabledModels({
      providerId: "anthropic",
      account: "proxied",
      mode: "manual",
      models: ["claude-opus-4-6"],
    });
    const accts =
      (await admin.listStatus()).providers.find((p) => p.id === "anthropic")?.accounts ?? [];

    const proxied = accts.find((a) => a.account === "proxied");
    // Proxy is surfaced REDACTED (principle 7: hasPassword, never the secret).
    expect(proxied?.proxy).toEqual({
      type: "socks5",
      host: "10.0.0.1",
      port: 1080,
      username: "u",
      hasPassword: true,
    });
    expect(JSON.stringify(proxied)).not.toContain("secret");
    // Effective models = the operator's curated subset verbatim.
    expect(proxied?.models).toEqual(["claude-opus-4-6"]);

    const bare = accts.find((a) => a.account === "bare");
    // No proxy configured → null (direct connection); auto mode uses live discovery.
    expect(bare?.proxy).toBeNull();
    expect(bare?.models).toEqual(["claude-fable-5", "claude-sonnet-4-7"]);
  });

  // ── per-account pool scheduling (Stage 3) ──────────────────────────────────
  it("getAccountSchedule returns the defaults (priority 50, schedulable true, autoReset false, fastMode false)", async () => {
    const { tokens, config } = makeStores();
    const admin = createOAuthAdmin({ store: tokens, encKey: KEY, config });
    expect(await admin.getAccountSchedule({ providerId: "anthropic", account: "default" })).toEqual(
      {
        priority: 50,
        schedulable: true,
        autoReset: false,
        allowSpendRemainingCredits: false,
        fastMode: false,
      },
    );
  });

  it("setAccountSchedule persists priority + schedulable + autoReset + allowSpendRemainingCredits + fastMode; round-trips", async () => {
    const { tokens, config } = makeStores();
    const admin = createOAuthAdmin({ store: tokens, encKey: KEY, config });
    await admin.setAccountSchedule({
      providerId: "anthropic",
      account: "a1",
      priority: 10,
      schedulable: false,
      autoReset: true,
      allowSpendRemainingCredits: true,
      fastMode: true,
    });
    expect(await admin.getAccountSchedule({ providerId: "anthropic", account: "a1" })).toEqual({
      priority: 10,
      schedulable: false,
      autoReset: true,
      allowSpendRemainingCredits: true,
      fastMode: true,
    });
  });

  it("setAccountSchedule rejects re-enabling a credential-failed account until reconnect", async () => {
    const { tokens, config } = makeStores();
    await setAccountSettings(config, KEY, "openai-codex", "dead", {
      schedulable: false,
      credentialFailedAt: 12_345,
      credentialFailureReason: "oauth refresh failed (openai-codex, status 401)",
      autoDisabledForCredentialFailure: true,
    });
    const admin = createOAuthAdmin({ store: tokens, encKey: KEY, config });

    await expect(
      admin.setAccountSchedule({
        providerId: "openai-codex",
        account: "dead",
        schedulable: true,
      }),
    ).rejects.toThrow(/needs reconnect/);

    expect(await admin.getAccountSchedule({ providerId: "openai-codex", account: "dead" })).toEqual(
      {
        priority: 50,
        schedulable: false,
        autoReset: false,
        allowSpendRemainingCredits: false,
        fastMode: false,
      },
    );
    const settings = getAccountSettings(
      await loadAccountSettings(config, KEY),
      "openai-codex",
      "dead",
    );
    expect(settings.credentialFailedAt).toBe(12_345);
    expect(settings.autoDisabledForCredentialFailure).toBe(true);
  });

  it("setAccountSchedule leaves an omitted field unchanged + preserves proxy", async () => {
    const { tokens, config } = makeStores();
    const admin = createOAuthAdmin({ store: tokens, encKey: KEY, config });
    await admin.setAccountProxy({
      providerId: "anthropic",
      account: "default",
      proxy: { type: "http", host: "p", port: 8080, password: "keep" },
    });
    await admin.setAccountSchedule({ providerId: "anthropic", account: "default", priority: 5 });
    // schedulable + autoReset omitted → defaults; priority set; proxy untouched.
    expect(await admin.getAccountSchedule({ providerId: "anthropic", account: "default" })).toEqual(
      {
        priority: 5,
        schedulable: true,
        autoReset: false,
        allowSpendRemainingCredits: false,
        fastMode: false,
      },
    );
    await admin.setAccountSchedule({
      providerId: "anthropic",
      account: "default",
      schedulable: false,
    });
    expect(await admin.getAccountSchedule({ providerId: "anthropic", account: "default" })).toEqual(
      {
        priority: 5,
        schedulable: false,
        autoReset: false,
        allowSpendRemainingCredits: false,
        fastMode: false,
      },
    );
    expect(decryptSecret((await config.get("oauth.account_settings")) ?? "", KEY)).toContain(
      "keep",
    );
  });
});

// ── proxy from the FIRST bind step: no real-IP leak (issue #38) ───────────────
// These prove the central fix: when the operator enters a proxy in the connect
// dialog, EVERY binding HTTP call tunnels through it from the very first call, and
// the global (real-IP) fetch is never touched. The injected `makeFetch` returns the
// routed spy for a proxy and a THROWING global otherwise, so any leak fails loudly.
describe("createOAuthAdmin > bind-time egress proxy", () => {
  it("device-code: the FIRST device-code call + poll go through the proxy, never the global", async () => {
    const { tokens, config } = makeStores();
    const PROXY: ProxyConfig = { type: "socks5", host: "10.9.9.9", port: 1080 };
    const seenProxies: Array<ProxyConfig | undefined> = [];
    const routed = routeFetch([
      [
        /login\/device\/code/,
        () =>
          json({
            device_code: "DC",
            user_code: "WXYZ-1234",
            verification_uri: "https://github.com/login/device",
            interval: 5,
            expires_in: 900,
          }),
      ],
      [/login\/oauth\/access_token/, () => json({ access_token: "gho_x" })],
      [
        /copilot_internal\/v2\/token/,
        () =>
          json({
            token: "tid=x;proxy-ep=proxy.indiv.githubcopilot.com;",
            expires_at: Math.floor(Date.now() / 1000) + 3600,
          }),
      ],
    ]);
    // If ANY call reaches the global fetch, the bind throws → the test fails.
    const globalThrow = vi.fn(() => {
      throw new Error("REAL IP LEAK: global fetch used");
    });
    vi.stubGlobal("fetch", globalThrow);
    const admin = createOAuthAdmin({
      store: tokens,
      encKey: KEY,
      config,
      genSessionId: () => "dev",
      makeFetch: (proxy) => {
        seenProxies.push(proxy);
        return proxy ? routed : (globalThis.fetch as typeof fetch);
      },
    });
    const start = await admin.startDeviceCode({ providerId: "github-copilot", proxy: PROXY });
    expect(start.userCode).toBe("WXYZ-1234");
    expect(await admin.pollDeviceCode({ sessionId: "dev", account: "default" })).toEqual({
      status: "done",
    });
    // The real-IP global was NEVER touched — including the first device-code POST.
    expect(globalThrow).not.toHaveBeenCalled();
    // makeFetch was asked for the proxy at least once (so the calls had it).
    expect(seenProxies).toContainEqual(PROXY);
    // Credential persisted (proving the routed fetch actually served the flow).
    expect(
      decryptSecret((await tokens.get("github-copilot", "default"))?.refreshEnc ?? "", KEY),
    ).toBe("gho_x");
    // …and the proxy is saved to account settings so refresh/execution reuse it (全程).
    expect(decryptSecret((await config.get("oauth.account_settings")) ?? "", KEY)).toContain(
      "10.9.9.9",
    );
  });

  it("manual-paste: the token exchange goes through the proxy + persists it (with password)", async () => {
    const { tokens, config } = makeStores();
    const PROXY: ProxyConfig = {
      type: "http",
      host: "p.example",
      port: 8080,
      username: "u",
      password: "pw",
    };
    const routed = routeFetch([
      [/oauth\/token/, () => json({ access_token: "AT", refresh_token: "RT", expires_in: 3600 })],
    ]);
    const globalThrow = vi.fn(() => {
      throw new Error("REAL IP LEAK: global fetch used");
    });
    vi.stubGlobal("fetch", globalThrow);
    const admin = createOAuthAdmin({
      store: tokens,
      encKey: KEY,
      config,
      genSessionId: () => "m1",
      makeFetch: (proxy) => (proxy ? routed : (globalThis.fetch as typeof fetch)),
    });
    const { sessionId, authorizeUrl } = await admin.startManualPaste({
      providerId: "anthropic",
      proxy: PROXY,
    });
    const state = new URL(authorizeUrl).searchParams.get("state");
    await admin.completeManualPaste({
      sessionId,
      redirectInput: `https://x/cb?code=C&state=${state}`,
      account: "default",
    });
    expect(globalThrow).not.toHaveBeenCalled();
    expect(decryptSecret((await tokens.get("anthropic", "default"))?.refreshEnc ?? "", KEY)).toBe(
      "RT",
    );
    // Persisted proxy is readable back (redacted) — password kept, never echoed.
    const view = await admin.getAccountProxy({ providerId: "anthropic", account: "default" });
    expect(view).toMatchObject({
      type: "http",
      host: "p.example",
      port: 8080,
      username: "u",
      hasPassword: true,
    });
    expect(decryptSecret((await config.get("oauth.account_settings")) ?? "", KEY)).toContain("pw");
  });

  it("rejects a malformed proxy at start BEFORE any network call (fail-closed)", async () => {
    const globalThrow = vi.fn(() => {
      throw new Error("REAL IP LEAK: global fetch used");
    });
    vi.stubGlobal("fetch", globalThrow);
    const admin = createOAuthAdmin({ store: makeStore(), encKey: KEY, config: makeConfig() });
    await expect(
      admin.startDeviceCode({
        providerId: "github-copilot",
        proxy: { type: "http", host: "", port: 8080 },
      }),
    ).rejects.toThrow(/host/);
    // No proxy ⇒ no device-code call ⇒ the global was never reached either.
    expect(globalThrow).not.toHaveBeenCalled();
  });

  it("no proxy: binding still works (direct connection unchanged)", async () => {
    const { tokens, config } = makeStores();
    let proxyArg: ProxyConfig | undefined | "unset" = "unset";
    const routed = routeFetch([
      [/oauth\/token/, () => json({ access_token: "AT", refresh_token: "RT", expires_in: 3600 })],
    ]);
    const admin = createOAuthAdmin({
      store: tokens,
      encKey: KEY,
      config,
      genSessionId: () => "m2",
      // No proxy → makeFetch is called with undefined; serve via routed so we avoid
      // a real socket, and assert no proxy was pinned.
      makeFetch: (proxy) => {
        proxyArg = proxy;
        return routed;
      },
    });
    const { sessionId, authorizeUrl } = await admin.startManualPaste({ providerId: "anthropic" });
    const state = new URL(authorizeUrl).searchParams.get("state");
    await admin.completeManualPaste({
      sessionId,
      redirectInput: `https://x/cb?code=C&state=${state}`,
      account: "default",
    });
    expect(proxyArg).toBeUndefined();
    expect(await admin.getAccountProxy({ providerId: "anthropic", account: "default" })).toBeNull();
  });
});

describe("createOAuthAdmin > fetchAnthropicQuota", () => {
  // Connect one Anthropic account, then expose the admin + a usage-endpoint hit
  // counter. `now` is pinned so the 5-min cache window never elapses between calls.
  async function connected(usage: () => Response): Promise<{
    fetchQuota: (input: { account: string }) => Promise<OAuthQuotaWindow[] | null>;
    usageHits: () => number;
    logs: Array<{ level: string; message: string; fields?: Record<string, unknown> }>;
  }> {
    let hits = 0;
    vi.stubGlobal(
      "fetch",
      routeFetch([
        [/oauth\/token/, () => json({ access_token: "AT", refresh_token: "RT", expires_in: 3600 })],
        [
          /oauth\/usage/,
          () => {
            hits++;
            return usage();
          },
        ],
      ]),
    );
    let seq = 0;
    const logs: Array<{ level: string; message: string; fields?: Record<string, unknown> }> = [];
    const admin = createOAuthAdmin({
      store: makeStore(),
      encKey: KEY,
      config: makeConfig(),
      now: () => 1000,
      genSessionId: () => `s${++seq}`,
      log: (level, message, fields) => logs.push({ level, message, fields }),
    });
    const { sessionId, authorizeUrl } = await admin.startManualPaste({ providerId: "anthropic" });
    const state = new URL(authorizeUrl).searchParams.get("state");
    await admin.completeManualPaste({
      sessionId,
      redirectInput: `https://x/cb?code=C&state=${state}`,
      account: "default",
    });
    const fetchQuota = admin.fetchAnthropicQuota;
    if (!fetchQuota) throw new Error("fetchAnthropicQuota not wired");
    return { fetchQuota, usageHits: () => hits, logs };
  }

  it("negative-caches a failed usage fetch (no upstream hammering within the TTL)", async () => {
    const { fetchQuota, usageHits } = await connected(
      () => new Response("rate_limited", { status: 429 }),
    );
    expect(await fetchQuota({ account: "default" })).toBeNull();
    expect(await fetchQuota({ account: "default" })).toBeNull();
    expect(usageHits()).toBe(1); // the second open is served from the negative cache
  });

  it("warns when a 200 body yields ZERO windows (a silent parse failure froze the page for ~23h)", async () => {
    // A schema-rejected body parses to [] — previously cached silently, leaving the
    // stored snapshot stale forever with no log evidence. The warn is the tripwire.
    const { fetchQuota, logs } = await connected(() =>
      json({ five_hour: { utilization: "not-a-number" } }),
    );
    expect(await fetchQuota({ account: "default" })).toEqual([]);
    expect(logs).toEqual([
      {
        level: "warn",
        message: "oauth.quota.pull_empty",
        fields: { provider_id: "anthropic", account: "default" },
      },
    ]);
  });

  it("warns with the HTTP status when the usage endpoint replies non-ok", async () => {
    const { fetchQuota, logs } = await connected(
      () => new Response("rate_limited", { status: 429 }),
    );
    expect(await fetchQuota({ account: "default" })).toBeNull();
    expect(logs).toEqual([
      {
        level: "warn",
        message: "oauth.quota.pull_failed",
        fields: { provider_id: "anthropic", account: "default", status: 429 },
      },
    ]);
  });

  it("warns when the usage fetch throws (network / dead token)", async () => {
    const { fetchQuota, logs } = await connected(() => {
      throw new Error("boom");
    });
    expect(await fetchQuota({ account: "default" })).toBeNull();
    expect(logs).toEqual([
      {
        level: "warn",
        message: "oauth.quota.pull_failed",
        fields: { provider_id: "anthropic", account: "default", error: "boom" },
      },
    ]);
  });

  it("does NOT warn on a healthy pull", async () => {
    const { fetchQuota, logs } = await connected(() =>
      json({ five_hour: { utilization: 3, resets_at: "2026-06-04T12:00:00.000Z" } }),
    );
    expect((await fetchQuota({ account: "default" }))?.length).toBe(1);
    expect(logs).toEqual([]);
  });

  it("caches a successful snapshot and surfaces utilization as 0–100 percent as-is", async () => {
    const { fetchQuota, usageHits } = await connected(() =>
      json({
        five_hour: { utilization: 3, resets_at: "2026-06-04T12:00:00.000Z" },
        seven_day: { utilization: 17, resets_at: "2026-06-08T12:00:00.000Z" },
        seven_day_sonnet: null,
        limits: [
          {
            kind: "session",
            group: "session",
            percent: 3,
            resets_at: "2026-06-04T12:00:00.000Z",
            scope: null,
          },
          {
            kind: "weekly_all",
            group: "weekly",
            percent: 17,
            resets_at: "2026-06-08T12:00:00.000Z",
            scope: null,
          },
          {
            kind: "weekly_scoped",
            group: "weekly",
            percent: 5,
            resets_at: "2026-06-08T12:00:00.000Z",
            scope: { model: { id: null, display_name: "Fable" }, surface: null },
          },
        ],
      }),
    );
    const first = await fetchQuota({ account: "default" });
    const second = await fetchQuota({ account: "default" });
    expect(first?.map((w) => `${w.key}:${w.usedPercent}`)).toEqual(["5h:3", "7d:17", "7d-fable:5"]);
    expect(second).toEqual(first); // served from the warm cache
    expect(usageHits()).toBe(1);
  });

  it("rejects a successful usage response whose declared size exceeds the operator limit", async () => {
    let cancelled = false;
    const { fetchQuota } = await connected(
      () =>
        new Response(
          new ReadableStream({
            pull(controller) {
              controller.enqueue(new TextEncoder().encode("{}"));
              controller.close();
            },
            cancel() {
              cancelled = true;
            },
          }),
          { headers: { "content-length": String(1024 * 1024 + 1) } },
        ),
    );

    await expect(fetchQuota({ account: "default" })).resolves.toBeNull();
    expect(cancelled).toBe(true);
  });
});

describe("createOAuthAdmin > fetchXaiQuota", () => {
  async function seedFreshXai(tokens: SqliteOAuthTokenStore): Promise<void> {
    await tokens.upsert({
      providerId: "xai",
      account: "default",
      accessEnc: encryptSecret("fresh-access", KEY),
      refreshEnc: encryptSecret("refresh-token", KEY),
      expiresAt: 1_000_000,
      meta: JSON.stringify({
        tokenEndpoint: "https://auth.x.ai/oauth2/token",
        accountId: "user-123",
      }),
      updatedAt: 1,
    });
  }

  it("refreshes through the account proxy and sends Grok Build's official billing request", async () => {
    const { tokens, config } = makeStores();
    await tokens.upsert({
      providerId: "xai",
      account: "default",
      accessEnc: encryptSecret("expired-access", KEY),
      refreshEnc: encryptSecret("refresh-token", KEY),
      expiresAt: 999,
      meta: JSON.stringify({
        tokenEndpoint: "https://auth.x.ai/oauth2/token",
        accountId: "user-123",
      }),
      updatedAt: 1,
    });
    const proxy: ProxyConfig = { type: "http", host: "proxy.test", port: 8080 };
    await setAccountSettings(config, KEY, "xai", "default", { proxy });

    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const routed = vi.fn(async (url: string | URL, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      if (String(url).includes("/oauth2/token")) {
        return json({ access_token: "fresh-access", expires_in: 3600 });
      }
      if (String(url).endsWith("/v1/billing?format=credits")) {
        return Response.json({
          config: {
            creditUsagePercent: 12.5,
            currentPeriod: {
              type: "USAGE_PERIOD_TYPE_WEEKLY",
              start: "2025-07-08T18:40:00Z",
              end: "2025-07-15T18:40:00Z",
            },
            prepaidBalance: { val: 1_250 },
          },
        });
      }
      throw new Error(`unexpected fetch ${String(url)}`);
    }) as typeof fetch;
    const seenProxies: Array<ProxyConfig | undefined> = [];
    const admin = createOAuthAdmin({
      store: tokens,
      config,
      encKey: KEY,
      now: () => 1_752_100_000_000,
      makeFetch: (value) => {
        seenProxies.push(value);
        return routed;
      },
    });

    const expected = [
      {
        key: "7d",
        usedPercent: 12.5,
        resetsAtMs: 1_752_604_800_000,
        windowMinutes: 10_080,
      },
    ];
    await expect(admin.fetchXaiQuota?.({ account: "default" })).resolves.toEqual(expected);
    await expect(admin.fetchXaiQuota?.({ account: "default" })).resolves.toEqual(expected);
    expect(seenProxies).toContainEqual(proxy);
    expect(calls).toHaveLength(2);
    const quota = calls[1];
    expect(quota?.url).toBe("https://cli-chat-proxy.grok.com/v1/billing?format=credits");
    expect(quota?.init).toMatchObject({ method: "GET", redirect: "error" });
    const quotaHeaders = new Headers(quota?.init?.headers);
    expect(quotaHeaders.get("accept")).toBe("application/json");
    expect(quotaHeaders.get("authorization")).toBe("Bearer fresh-access");
    expect(quotaHeaders.get("X-XAI-Token-Auth")).toBe("xai-grok-cli");
    expect(quotaHeaders.get("x-userid")).toBe("user-123");
    expect(quotaHeaders.get("x-grok-client-version")).toBe(XAI_GROK_CLIENT_VERSION);
    expect(quotaHeaders.get("x-grok-client-mode")).toBe("headless");
    expect(quotaHeaders.get("content-type")).toBeNull();
    expect(quota?.init?.body).toBeUndefined();
    expect(quota?.init?.signal).toBeInstanceOf(AbortSignal);
  });

  it("fail-opens and negative-caches malformed successful JSON", async () => {
    const { tokens, config } = makeStores();
    await seedFreshXai(tokens);
    const doFetch = vi.fn(async () => new Response("{", { status: 200 })) as typeof fetch;
    const admin = createOAuthAdmin({
      store: tokens,
      config,
      encKey: KEY,
      now: () => 1_000,
      makeFetch: () => doFetch,
    });

    await expect(admin.fetchXaiQuota?.({ account: "default" })).resolves.toBeNull();
    await expect(admin.fetchXaiQuota?.({ account: "default" })).resolves.toBeNull();
    expect(doFetch).toHaveBeenCalledTimes(1);
  });

  it("fails open before network I/O when the stored credential has no xAI user id", async () => {
    const { tokens, config } = makeStores();
    await tokens.upsert({
      providerId: "xai",
      account: "default",
      accessEnc: encryptSecret("fresh-access", KEY),
      refreshEnc: encryptSecret("refresh-token", KEY),
      expiresAt: 1_000_000,
      meta: JSON.stringify({ tokenEndpoint: "https://auth.x.ai/oauth2/token" }),
      updatedAt: 1,
    });
    const doFetch = vi.fn() as unknown as typeof fetch;
    const admin = createOAuthAdmin({
      store: tokens,
      config,
      encKey: KEY,
      now: () => 1_000,
      makeFetch: () => doFetch,
    });

    await expect(admin.fetchXaiQuota?.({ account: "default" })).resolves.toBeNull();
    expect(doFetch).not.toHaveBeenCalled();
  });

  it("fail-opens and negative-caches a rejected redirect response", async () => {
    const { tokens, config } = makeStores();
    await seedFreshXai(tokens);
    let hits = 0;
    const logs: Array<{ level: string; message: string; fields?: Record<string, unknown> }> = [];
    const doFetch = vi.fn(async () => {
      hits++;
      return new Response(null, { status: 307, headers: { location: "https://evil.test" } });
    }) as typeof fetch;
    const admin = createOAuthAdmin({
      store: tokens,
      config,
      encKey: KEY,
      now: () => 1_000,
      makeFetch: () => doFetch,
      log: (level, message, fields) => logs.push({ level, message, fields }),
    });

    await expect(admin.fetchXaiQuota?.({ account: "default" })).resolves.toBeNull();
    await expect(admin.fetchXaiQuota?.({ account: "default" })).resolves.toBeNull();
    expect(hits).toBe(1);
    expect(logs).toEqual([
      {
        level: "warn",
        message: "oauth.quota.pull_failed",
        fields: { provider_id: "xai", account: "default", status: 307 },
      },
    ]);
  });

  it("rejects an oversized declared response before buffering and negative-caches it", async () => {
    const { tokens, config } = makeStores();
    await seedFreshXai(tokens);
    let cancelled = false;
    let hits = 0;
    const doFetch = vi.fn(async () => {
      hits++;
      return new Response(
        new ReadableStream({
          cancel: () => {
            cancelled = true;
          },
        }),
        { headers: { "content-length": String(1024 * 1024 + 1) } },
      );
    }) as typeof fetch;
    const admin = createOAuthAdmin({
      store: tokens,
      config,
      encKey: KEY,
      now: () => 1_000,
      makeFetch: () => doFetch,
    });

    await expect(admin.fetchXaiQuota?.({ account: "default" })).resolves.toBeNull();
    await expect(admin.fetchXaiQuota?.({ account: "default" })).resolves.toBeNull();
    expect(hits).toBe(1);
    expect(cancelled).toBe(true);
  });

  it("stops reading a streamed response once it crosses the size limit", async () => {
    const { tokens, config } = makeStores();
    await seedFreshXai(tokens);
    let cancelled = false;
    const doFetch = vi.fn(
      async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new Uint8Array(600 * 1024));
              controller.enqueue(new Uint8Array(600 * 1024));
            },
            cancel: () => {
              cancelled = true;
            },
          }),
        ),
    ) as typeof fetch;
    const admin = createOAuthAdmin({
      store: tokens,
      config,
      encKey: KEY,
      now: () => 1_000,
      makeFetch: () => doFetch,
    });

    await expect(admin.fetchXaiQuota?.({ account: "default" })).resolves.toBeNull();
    expect(cancelled).toBe(true);
  });
});

describe("createOAuthAdmin > quota cache credential lifecycle", () => {
  async function harness(): Promise<{
    admin: ReturnType<typeof createOAuthAdmin>;
    connect: () => Promise<void>;
    usageHits: () => number;
    tokens: SqliteOAuthTokenStore;
  }> {
    const tokens = makeStore();
    let usageHits = 0;
    vi.stubGlobal(
      "fetch",
      routeFetch([
        [/oauth\/token/, () => json({ access_token: "AT", refresh_token: "RT", expires_in: 3600 })],
        [
          /oauth\/usage/,
          () => {
            usageHits++;
            return json({
              five_hour: {
                utilization: usageHits,
                resets_at: "2026-06-04T12:00:00.000Z",
              },
            });
          },
        ],
      ]),
    );
    let sequence = 0;
    const admin = createOAuthAdmin({
      store: tokens,
      config: makeConfig(),
      encKey: KEY,
      now: () => 1_000,
      genSessionId: () => `quota-lifecycle-${++sequence}`,
    });
    const connect = async () => {
      const { sessionId, authorizeUrl } = await admin.startManualPaste({
        providerId: "anthropic",
      });
      const state = new URL(authorizeUrl).searchParams.get("state");
      await admin.completeManualPaste({
        sessionId,
        redirectInput: `https://x/cb?code=C&state=${state}`,
        account: "same-name",
      });
    };
    await connect();
    return { admin, connect, usageHits: () => usageHits, tokens };
  }

  it("invalidates cached quota when the same account label reconnects", async () => {
    const { admin, connect, usageHits } = await harness();
    expect((await admin.fetchAnthropicQuota?.({ account: "same-name" }))?.[0]?.usedPercent).toBe(1);

    await connect();

    expect((await admin.fetchAnthropicQuota?.({ account: "same-name" }))?.[0]?.usedPercent).toBe(2);
    expect(usageHits()).toBe(2);
  });

  it("invalidates cached quota on logout before a same-name credential is restored", async () => {
    const { admin, usageHits, tokens } = await harness();
    expect((await admin.fetchAnthropicQuota?.({ account: "same-name" }))?.[0]?.usedPercent).toBe(1);

    await admin.logout({ providerId: "anthropic", account: "same-name" });
    await tokens.upsert({
      providerId: "anthropic",
      account: "same-name",
      accessEnc: encryptSecret("replacement-access", KEY),
      refreshEnc: encryptSecret("replacement-refresh", KEY),
      expiresAt: 1_000_000,
      meta: null,
      updatedAt: 2,
    });

    expect((await admin.fetchAnthropicQuota?.({ account: "same-name" }))?.[0]?.usedPercent).toBe(2);
    expect(usageHits()).toBe(2);
  });

  it.each([
    "reconnect",
    "logout",
  ] as const)("discards an in-flight old-identity pull when %s replaces its credential", async (lifecycle) => {
    const tokens = makeStore();
    await tokens.upsert({
      providerId: "anthropic",
      account: "same-name",
      accessEnc: encryptSecret("old-access", KEY),
      refreshEnc: encryptSecret("old-refresh", KEY),
      expiresAt: 1_000_000,
      meta: null,
      updatedAt: 1,
    });
    let releaseOld: (() => void) | undefined;
    const oldBlocked = new Promise<void>((resolve) => {
      releaseOld = resolve;
    });
    let signalOldStarted: (() => void) | undefined;
    const oldStarted = new Promise<void>((resolve) => {
      signalOldStarted = resolve;
    });
    let usageHits = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL) => {
        const value = String(url);
        if (value.includes("/oauth/token")) {
          return json({
            access_token: "replacement-access",
            refresh_token: "replacement-refresh",
            expires_in: 3600,
          });
        }
        if (value.includes("/oauth/usage")) {
          usageHits++;
          if (usageHits === 1) {
            signalOldStarted?.();
            await oldBlocked;
          }
          return json({
            five_hour: {
              utilization: usageHits,
              resets_at: "2026-06-04T12:00:00.000Z",
            },
          });
        }
        throw new Error(`unexpected fetch ${value}`);
      }),
    );
    let sequence = 0;
    const admin = createOAuthAdmin({
      store: tokens,
      config: makeConfig(),
      encKey: KEY,
      now: () => 1_000,
      genSessionId: () => `generation-${++sequence}`,
    });

    const stalePull = admin.fetchAnthropicQuota?.({ account: "same-name" });
    await oldStarted;
    if (lifecycle === "reconnect") {
      const { sessionId, authorizeUrl } = await admin.startManualPaste({
        providerId: "anthropic",
      });
      const state = new URL(authorizeUrl).searchParams.get("state");
      await admin.completeManualPaste({
        sessionId,
        redirectInput: `https://x/cb?code=C&state=${state}`,
        account: "same-name",
      });
    } else {
      await admin.logout({ providerId: "anthropic", account: "same-name" });
      await tokens.upsert({
        providerId: "anthropic",
        account: "same-name",
        accessEnc: encryptSecret("replacement-access", KEY),
        refreshEnc: encryptSecret("replacement-refresh", KEY),
        expiresAt: 1_000_000,
        meta: null,
        updatedAt: 2,
      });
    }
    releaseOld?.();

    await expect(stalePull).resolves.toBeNull();
    expect((await admin.fetchAnthropicQuota?.({ account: "same-name" }))?.[0]?.usedPercent).toBe(2);
    expect(usageHits).toBe(2);
  });
});

// ── Codex rate-limit reset credit (the "reset usage limit" action) ────────────
describe("createOAuthAdmin > codex reset credit", () => {
  // Persist the workspace identity from the id_token while the current access token
  // is opaque. Quota/reset must keep using the stored account + FedRAMP identity.
  const seg = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const CODEX_ACCESS_TOKEN = "opaque-codex-access";
  const CODEX_ID_TOKEN = `${seg({ alg: "none" })}.${seg({
    "https://api.openai.com/auth": {
      chatgpt_account_id: "acc_9",
      chatgpt_account_is_fedramp: true,
    },
  })}.id`;

  type Logs = Array<{ level: string; message: string; fields?: Record<string, unknown> }>;

  // Connect one Codex account and route the usage PULL + reset-credit CONSUME.
  // `now` is pinned so the stored token stays fresh (no refresh round-trip) and
  // the 5-min quota cache never elapses between calls.
  async function connectCodex(opts: {
    onUsage?: () => Response;
    onDetails?: () => Response;
    onConsume?: () => Response;
  }): Promise<{
    admin: ReturnType<typeof createOAuthAdmin>;
    usageHits: () => number;
    detailsHits: () => number;
    usageCalls: () => Array<{ url: string; init?: RequestInit }>;
    consumeCalls: () => Array<{ url: string; init?: RequestInit }>;
    logs: Logs;
  }> {
    let usageHits = 0;
    let detailsHits = 0;
    const usageCalls: Array<{ url: string; init?: RequestInit }> = [];
    const consumeCalls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      if (/auth\.openai\.com\/oauth\/token/.test(u)) {
        return json({
          id_token: CODEX_ID_TOKEN,
          access_token: CODEX_ACCESS_TOKEN,
          refresh_token: "RTC",
          expires_in: 3600,
        });
      }
      if (/wham\/rate-limit-reset-credits\/consume/.test(u)) {
        consumeCalls.push({ url: u, init });
        return (opts.onConsume ?? (() => json({ code: "reset", windows_reset: 2 })))();
      }
      if (/wham\/rate-limit-reset-credits$/.test(u)) {
        detailsHits++;
        return (opts.onDetails ?? (() => json({ credits: [], available_count: 0 })))();
      }
      if (/wham\/usage/.test(u)) {
        usageHits++;
        usageCalls.push({ url: u, init });
        return (opts.onUsage ?? (() => json({})))();
      }
      throw new Error(`unexpected fetch ${u}`);
    }) as unknown as typeof fetch;
    vi.stubGlobal("fetch", fetchImpl);
    let seq = 0;
    const logs: Logs = [];
    const admin = createOAuthAdmin({
      store: makeStore(),
      encKey: KEY,
      config: makeConfig(),
      now: () => 1000,
      genSessionId: () => `s${++seq}`,
      log: (level, message, fields) => logs.push({ level, message, fields }),
    });
    const { sessionId, authorizeUrl } = await admin.startManualPaste({
      providerId: "openai-codex",
    });
    const state = new URL(authorizeUrl).searchParams.get("state");
    await admin.completeManualPaste({
      sessionId,
      redirectInput: `https://x/cb?code=C&state=${state}`,
      account: "default",
    });
    return {
      admin,
      usageHits: () => usageHits,
      detailsHits: () => detailsHits,
      usageCalls: () => usageCalls,
      consumeCalls: () => consumeCalls,
      logs,
    };
  }

  it("fetchCodexQuota returns full Codex CLI quota metadata and reset-credit details", async () => {
    const { admin, usageHits, detailsHits, usageCalls } = await connectCodex({
      onUsage: () =>
        json({
          rate_limit: { primary_window: { used_percent: 6, reset_after_seconds: 120 } },
          credits: { has_credits: true, unlimited: false, balance: "9.99" },
          spend_control: {
            reached: false,
            individual_limit: {
              limit: "25000",
              used: "8000",
              remaining_percent: 68,
              reset_at: 1_735_693_200,
            },
          },
          rate_limit_reached_type: {
            type: "workspace_member_usage_limit_reached",
          },
          additional_rate_limits: [
            {
              limit_name: "GPT-5.6-Codex-Luna",
              metered_feature: "codex_luna",
              rate_limit: { primary_window: { used_percent: 88 } },
            },
          ],
          rate_limit_reset_credits: { available_count: 3 },
        }),
      onDetails: () =>
        json({
          available_count: 2,
          credits: [
            {
              id: "credit-1",
              reset_type: "codex_rate_limits",
              status: "available",
              granted_at: "2026-06-17T00:00:00Z",
              expires_at: "2026-07-17T00:00:00Z",
              title: "Full reset",
              description: "Ready to redeem",
            },
          ],
        }),
    });
    const fetchQuota = admin.fetchCodexQuota;
    if (!fetchQuota) throw new Error("fetchCodexQuota not wired");
    const first = await fetchQuota({ account: "default" });
    expect(first?.windows.map((w) => `${w.key}:${w.usedPercent}`)).toEqual([
      "primary:6",
      "codex_luna-primary:88",
    ]);
    expect(first?.resetCredits).toBe(2);
    expect(first).toMatchObject({
      credits: { hasCredits: true, unlimited: false, balance: "9.99" },
      individualLimit: {
        limit: "25000",
        used: "8000",
        remainingPercent: 68,
        resetsAtMs: 1_735_693_200_000,
      },
      rateLimitReachedType: "workspace_member_usage_limit_reached",
      resetCreditDetails: [
        {
          id: "credit-1",
          resetType: "codexRateLimits",
          status: "available",
          grantedAt: 1_781_654_400,
          expiresAt: 1_784_246_400,
        },
      ],
    });
    // Second open is served from the warm cache — no second PULL.
    const second = await fetchQuota({ account: "default" });
    expect(second).toEqual(first);
    expect(usageHits()).toBe(1);
    expect(detailsHits()).toBe(1);
    const headers = usageCalls()[0]?.init?.headers as Record<string, string>;
    expect(headers.authorization).toBe(`Bearer ${CODEX_ACCESS_TOKEN}`);
    expect(headers["chatgpt-account-id"]).toBe("acc_9");
    expect(headers["X-OpenAI-Fedramp"]).toBe("true");
  });

  it("fetchCodexQuota preserves usage count when reset-credit details fail", async () => {
    const { admin } = await connectCodex({
      onUsage: () =>
        json({
          rate_limit: { primary_window: { used_percent: 1 } },
          rate_limit_reset_credits: { available_count: 3 },
        }),
      onDetails: () => new Response("boom", { status: 500 }),
    });
    const result = await admin.fetchCodexQuota?.({ account: "default" });
    expect(result?.windows).toHaveLength(1);
    expect(result?.resetCredits).toBe(3);
    expect(result).toMatchObject({ resetCreditDetails: null });
  });

  it("rejects a streamed Codex quota response once it crosses the operator limit", async () => {
    const payload = new TextEncoder().encode(
      JSON.stringify({ padding: "x".repeat(1024 * 1024 + 1) }),
    );
    let offset = 0;
    const { admin } = await connectCodex({
      onUsage: () =>
        new Response(
          new ReadableStream({
            pull(controller) {
              if (offset >= payload.byteLength) return controller.close();
              const end = Math.min(offset + 600 * 1024, payload.byteLength);
              controller.enqueue(payload.slice(offset, end));
              offset = end;
            },
          }),
        ),
    });

    await expect(admin.fetchCodexQuota?.({ account: "default" })).resolves.toBeNull();
  });

  it("consumeCodexResetCredit POSTs and audits a redeem id with the bearer + account-id headers", async () => {
    const { admin, consumeCalls, logs } = await connectCodex({
      onConsume: () => json({ code: "reset", credit: { id: "c_1" }, windows_reset: 2 }),
    });
    const result = await admin.consumeCodexResetCredit?.({ account: "default" });
    expect(result).toMatchObject({ code: "reset", outcome: "reset", windowsReset: 2 });

    expect(consumeCalls()).toHaveLength(1);
    const init = consumeCalls()[0]?.init;
    expect(init?.method).toBe("POST");
    const headers = init?.headers as Record<string, string>;
    expect(headers.authorization).toBe(`Bearer ${CODEX_ACCESS_TOKEN}`);
    expect(headers["chatgpt-account-id"]).toBe("acc_9");
    expect(headers["X-OpenAI-Fedramp"]).toBe("true");
    expect(headers["content-type"]).toBe("application/json");
    const body = JSON.parse(String(init?.body)) as { redeem_request_id?: unknown };
    expect(typeof body.redeem_request_id).toBe("string");
    expect(result?.redeemRequestId).toBe(body.redeem_request_id);
    expect(logs).toContainEqual(
      expect.objectContaining({
        level: "info",
        message: "oauth.reset_credit.consumed",
        fields: expect.objectContaining({
          account: "default",
          redeem_request_id: body.redeem_request_id,
          windows_reset: 2,
        }),
      }),
    );
  });

  it("consumeCodexResetCredit forwards a selected credit_id", async () => {
    const { admin, consumeCalls } = await connectCodex({});
    const consume = admin.consumeCodexResetCredit as unknown as (input: {
      account: string;
      creditId?: string;
    }) => Promise<unknown>;

    await consume({ account: "default", creditId: "credit-123" });

    const body = JSON.parse(String(consumeCalls()[0]?.init?.body)) as Record<string, unknown>;
    expect(body.credit_id).toBe("credit-123");
  });

  it("consumeCodexResetCredit reuses a caller-provided idempotency key", async () => {
    const { admin, consumeCalls } = await connectCodex({});
    const consume = admin.consumeCodexResetCredit as unknown as (input: {
      account: string;
      idempotencyKey?: string;
    }) => Promise<unknown>;

    await consume({ account: "default", idempotencyKey: "stable-request-1" });

    const body = JSON.parse(String(consumeCalls()[0]?.init?.body)) as Record<string, unknown>;
    expect(body.redeem_request_id).toBe("stable-request-1");
  });

  it("consumeCodexResetCredit rejects empty credit and idempotency ids before fetch", async () => {
    const { admin, consumeCalls } = await connectCodex({});
    const consume = admin.consumeCodexResetCredit as unknown as (input: {
      account: string;
      creditId?: string;
      idempotencyKey?: string;
    }) => Promise<unknown>;

    await expect(consume({ account: "default", creditId: "" })).rejects.toThrow(
      /creditId must not be empty/,
    );
    await expect(consume({ account: "default", idempotencyKey: "" })).rejects.toThrow(
      /idempotencyKey must not be empty/,
    );
    expect(consumeCalls()).toHaveLength(0);
  });

  it.each([
    ["reset", "reset"],
    ["nothing_to_reset", "nothingToReset"],
    ["no_credit", "noCredit"],
    ["already_redeemed", "alreadyRedeemed"],
  ] as const)("maps consume code %s to outcome %s", async (code, outcome) => {
    const { admin } = await connectCodex({
      onConsume: () => json({ code, windows_reset: code === "reset" ? 2 : 0 }),
    });
    await expect(admin.consumeCodexResetCredit?.({ account: "default" })).resolves.toMatchObject({
      code,
      outcome,
    });
  });

  it.each([
    "nothing_to_reset",
    "no_credit",
  ] as const)("does not audit %s as a consumed reset credit", async (code) => {
    const { admin, logs } = await connectCodex({
      onConsume: () => json({ code, windows_reset: 0 }),
    });

    await admin.consumeCodexResetCredit?.({ account: "default" });

    expect(logs.some((entry) => entry.message === "oauth.reset_credit.consumed")).toBe(false);
    expect(logs).toContainEqual(
      expect.objectContaining({
        level: "info",
        message: "oauth.reset_credit.not_consumed",
        fields: expect.objectContaining({ code }),
      }),
    );
  });

  it("rejects an unknown successful consume body", async () => {
    const { admin } = await connectCodex({
      onConsume: () => json({ code: "future_code", windows_reset: 0 }),
    });

    await expect(admin.consumeCodexResetCredit?.({ account: "default" })).rejects.toThrow(
      /unrecognized response/,
    );
  });

  it("rejects a streamed reset response once it crosses the operator limit", async () => {
    const payload = new TextEncoder().encode(
      JSON.stringify({
        code: "reset",
        windows_reset: 2,
        padding: "x".repeat(1024 * 1024 + 1),
      }),
    );
    let offset = 0;
    const { admin } = await connectCodex({
      onConsume: () =>
        new Response(
          new ReadableStream({
            pull(controller) {
              if (offset >= payload.byteLength) return controller.close();
              const end = Math.min(offset + 600 * 1024, payload.byteLength);
              controller.enqueue(payload.slice(offset, end));
              offset = end;
            },
          }),
        ),
    });

    await expect(admin.consumeCodexResetCredit?.({ account: "default" })).rejects.toThrow(
      /unrecognized response/,
    );
  });

  it("consumeCodexResetCredit busts the quota cache so the next PULL re-fetches", async () => {
    const { admin, usageHits } = await connectCodex({
      onUsage: () => json({ rate_limit: { primary_window: { used_percent: 1 } } }),
    });
    await admin.fetchCodexQuota?.({ account: "default" }); // PULL #1 (cached)
    expect(usageHits()).toBe(1);
    await admin.consumeCodexResetCredit?.({ account: "default" }); // busts the cache
    await admin.fetchCodexQuota?.({ account: "default" }); // PULL #2 (cache was cleared)
    expect(usageHits()).toBe(2);
  });

  it("consumeCodexResetCredit busts SIBLING codex caches too (one ChatGPT grant, many labels)", async () => {
    // The reset credit is scoped to the upstream ChatGPT account, which can back
    // several connected helm accounts — consuming one restores ALL of them. So the
    // consume must drop every sibling's cached snapshot, not just the clicked account's,
    // or a sibling would keep showing a stale saturated bar until its TTL lapsed.
    const { admin, usageHits } = await connectCodex({
      onUsage: () => json({ rate_limit: { primary_window: { used_percent: 1 } } }),
    });
    // Bind a second codex account on the same admin (same upstream ChatGPT login).
    const { sessionId, authorizeUrl } = await admin.startManualPaste({
      providerId: "openai-codex",
    });
    const state = new URL(authorizeUrl).searchParams.get("state");
    await admin.completeManualPaste({
      sessionId,
      redirectInput: `https://x/cb?code=C&state=${state}`,
      account: "sibling",
    });
    // Warm BOTH accounts' quota caches.
    await admin.fetchCodexQuota?.({ account: "default" }); // PULL #1
    await admin.fetchCodexQuota?.({ account: "sibling" }); // PULL #2
    expect(usageHits()).toBe(2);
    // Consume for ONE account — the shared grant means BOTH caches must drop.
    await admin.consumeCodexResetCredit?.({ account: "default" });
    await admin.fetchCodexQuota?.({ account: "default" }); // PULL #3 (re-fetch)
    await admin.fetchCodexQuota?.({ account: "sibling" }); // PULL #4 (busted → re-fetch)
    expect(usageHits()).toBe(4);
  });

  it("consumeCodexResetCredit THROWS on an upstream failure (fail-closed) + logs it", async () => {
    const { admin, logs } = await connectCodex({
      onConsume: () => new Response("nope", { status: 402 }),
    });
    await expect(admin.consumeCodexResetCredit?.({ account: "default" })).rejects.toThrow(
      /status 402/,
    );
    expect(logs).toContainEqual(
      expect.objectContaining({
        level: "warn",
        message: "oauth.reset_credit.failed",
        fields: expect.objectContaining({
          provider_id: "openai-codex",
          account: "default",
          status: 402,
          redeem_request_id: expect.any(String),
        }),
      }),
    );
  });
});
