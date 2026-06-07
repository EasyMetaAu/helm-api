import {
  createSqliteDb,
  decryptSecret,
  encryptSecret,
  type ProxyConfig,
  SqliteConfigStore,
  SqliteOAuthTokenStore,
} from "@helm/core";
import type { OAuthQuotaWindow } from "@helm/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createOAuthAdmin } from "./admin-oauth.js";

const KEY = Buffer.alloc(32, 4);

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

afterEach(() => vi.unstubAllGlobals());

describe("createOAuthAdmin", () => {
  it("lists the three built-in providers with no accounts initially", async () => {
    const admin = createOAuthAdmin({ store: makeStore(), encKey: KEY, config: makeConfig() });
    const status = await admin.listStatus();
    expect(status.map((p) => p.id).sort()).toEqual(["anthropic", "github-copilot", "openai-codex"]);
    expect(status.find((p) => p.id === "anthropic")?.flow).toBe("manual_paste");
    expect(status.find((p) => p.id === "openai-codex")?.flow).toBe("manual_paste");
    expect(status.find((p) => p.id === "github-copilot")?.flow).toBe("device_code");
    expect(status.every((p) => p.accounts.length === 0)).toBe(true);
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
    expect(row?.refreshEnc).not.toContain("RT");
    expect(decryptSecret(row?.accessEnc ?? "", KEY)).toBe("AT");
    expect(decryptSecret(row?.refreshEnc ?? "", KEY)).toBe("RT");
    // Listed as a logged-in account now.
    const status = await admin.listStatus();
    expect(status.find((p) => p.id === "anthropic")?.accounts).toHaveLength(1);
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
    const anthropic = (await admin.listStatus()).find((p) => p.id === "anthropic");
    expect(anthropic?.accounts.map((a) => a.account).sort()).toEqual(["personal", "work"]);

    // Disconnecting one leaves the other intact.
    await admin.logout({ providerId: "anthropic", account: "work" });
    const after = (await admin.listStatus()).find((p) => p.id === "anthropic");
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
    const jwt = `${seg({ alg: "none" })}.${seg({ "https://api.openai.com/auth": { chatgpt_account_id: "acc_9" } })}.s`;
    vi.stubGlobal(
      "fetch",
      routeFetch([
        [
          /auth\.openai\.com\/oauth\/token/,
          () => json({ access_token: jwt, refresh_token: "RTC", expires_in: 3600 }),
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
    // accountId rides in the encrypted meta for execute-time use.
    expect(JSON.parse(row?.meta ?? "{}")).toMatchObject({ accountId: "acc_9" });
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

  it("logout deletes the stored credential", async () => {
    const store = makeStore();
    await store.upsert({
      providerId: "anthropic",
      account: "default",
      accessEnc: "v1:a",
      refreshEnc: "v1:r",
      expiresAt: 1,
      meta: null,
      updatedAt: 1,
    });
    const admin = createOAuthAdmin({ store, encKey: KEY, config: makeConfig() });
    await admin.logout({ providerId: "anthropic", account: "default" });
    expect(await store.get("anthropic", "default")).toBeNull();
  });

  it("rejects an unknown/expired session", async () => {
    const admin = createOAuthAdmin({ store: makeStore(), encKey: KEY, config: makeConfig() });
    await expect(
      admin.completeManualPaste({ sessionId: "nope", redirectInput: "code=x", account: "default" }),
    ).rejects.toThrow(/session not found/);
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
    const acct = (await admin.listStatus()).find((p) => p.id === "github-copilot")?.accounts[0];
    expect(acct?.healthy).toBe(true);
    expect(acct?.expiresAt ?? 0).toBeGreaterThan(NOW); // renewed into the future
    // The store now holds the freshly re-minted token.
    expect(
      decryptSecret((await store.get("github-copilot", "mylukin"))?.accessEnc ?? "", KEY),
    ).toContain("proxy-ep=proxy.y.com");
  });

  it("listStatus marks an account unhealthy when its refresh fails (needs reconnect)", async () => {
    const store = makeStore();
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
      config: makeConfig(),
      now: () => 10_000_000,
    });
    vi.stubGlobal(
      "fetch",
      routeFetch([[/copilot_internal\/v2\/token/, () => json({ error: "bad" }, 401)]]),
    );
    const acct = (await admin.listStatus()).find((p) => p.id === "github-copilot")?.accounts[0];
    expect(acct?.healthy).toBe(false);
  });

  it("rejects the wrong flow for a provider", async () => {
    const admin = createOAuthAdmin({ store: makeStore(), encKey: KEY, config: makeConfig() });
    await expect(admin.startManualPaste({ providerId: "github-copilot" })).rejects.toThrow(
      /manual-paste/,
    );
    await expect(admin.startDeviceCode({ providerId: "anthropic" })).rejects.toThrow(/device-code/);
  });

  // ── per-account model curation (Stage 1) ───────────────────────────────────

  it("listModels: an UNCURATED account reports enabled = all available (curated provider)", async () => {
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
    const admin = createOAuthAdmin({ store: tokens, encKey: KEY, config });
    const { available, enabled, canPull } = await admin.listModels({
      providerId: "anthropic",
      account: "default",
    });
    // Anthropic is a curated provider → available is the curated set.
    expect(available).toEqual(["claude-opus-4-6", "claude-sonnet-4-6", "claude-haiku-4-5"]);
    // Unset settings ⇒ everything is enabled.
    expect(enabled).toEqual(available);
    // Anthropic has a live list-models API → the UI may offer "pull from provider".
    expect(canPull).toBe(true);
  });

  it("listModels: a curated-only provider (Codex) reports canPull=false", async () => {
    const { tokens, config } = makeStores();
    await tokens.upsert({
      providerId: "openai-codex",
      account: "default",
      accessEnc: encryptSecret("AT", KEY),
      refreshEnc: encryptSecret("RT", KEY),
      expiresAt: Date.now() + 3_600_000,
      meta: null,
      updatedAt: 1,
    });
    const admin = createOAuthAdmin({ store: tokens, encKey: KEY, config });
    const { canPull } = await admin.listModels({ providerId: "openai-codex", account: "default" });
    // No live list-models API → the UI hides "pull from provider".
    expect(canPull).toBe(false);
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
    const admin = createOAuthAdmin({ store: tokens, encKey: KEY, config });
    await admin.setEnabledModels({
      providerId: "anthropic",
      account: "default",
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

  it("listStatus surfaces effective priority + schedulable per account (defaults + tuned)", async () => {
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
    });
    const accts = (await admin.listStatus()).find((p) => p.id === "anthropic")?.accounts ?? [];
    expect(accts.find((a) => a.account === "tuned")).toMatchObject({
      priority: 10,
      schedulable: false,
    });
    expect(accts.find((a) => a.account === "untuned")).toMatchObject({
      priority: 50,
      schedulable: true,
    });
  });

  // ── per-account pool scheduling (Stage 3) ──────────────────────────────────
  it("getAccountSchedule returns the defaults (priority 50, schedulable true)", async () => {
    const { tokens, config } = makeStores();
    const admin = createOAuthAdmin({ store: tokens, encKey: KEY, config });
    expect(await admin.getAccountSchedule({ providerId: "anthropic", account: "default" })).toEqual(
      {
        priority: 50,
        schedulable: true,
      },
    );
  });

  it("setAccountSchedule persists priority + schedulable; round-trips", async () => {
    const { tokens, config } = makeStores();
    const admin = createOAuthAdmin({ store: tokens, encKey: KEY, config });
    await admin.setAccountSchedule({
      providerId: "anthropic",
      account: "a1",
      priority: 10,
      schedulable: false,
    });
    expect(await admin.getAccountSchedule({ providerId: "anthropic", account: "a1" })).toEqual({
      priority: 10,
      schedulable: false,
    });
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
    // schedulable omitted → default; priority set; proxy untouched.
    expect(await admin.getAccountSchedule({ providerId: "anthropic", account: "default" })).toEqual(
      {
        priority: 5,
        schedulable: true,
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
        seven_day_sonnet: { utilization: 0, resets_at: "2026-06-08T12:00:00.000Z" },
      }),
    );
    const first = await fetchQuota({ account: "default" });
    const second = await fetchQuota({ account: "default" });
    expect(first?.map((w) => `${w.key}:${w.usedPercent}`)).toEqual([
      "5h:3",
      "7d:17",
      "7d-sonnet:0",
    ]);
    expect(second).toEqual(first); // served from the warm cache
    expect(usageHits()).toBe(1);
  });
});
