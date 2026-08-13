import { describe, expect, it, vi } from "vitest";
import { decryptSecret, encryptSecret } from "../store/crypto/token-cipher.js";
import type { OAuthTokenRecord, OAuthTokenStore } from "../store/ports.js";
import { OpenAICodexIdentityMismatchError } from "./oauth/openai-codex.js";
import { OAuthHttpError } from "./oauth/runtime.js";
import type { OAuthCredentials, OAuthProviderInterface } from "./oauth/types.js";
import {
  createTokenManager,
  executionTokenExpirySkewMs,
  oauthRefreshQueueDepth,
  type PresetOAuth,
  TokenRefreshError,
} from "./token-manager.js";

const KEY = Buffer.alloc(32, 1);
const PRESET: PresetOAuth = { kind: "preset", providerId: "anthropic", account: "default" };

// Minimal in-memory OAuthTokenStore for the preset path.
function memStore(seed?: OAuthTokenRecord): OAuthTokenStore {
  const rows = new Map<string, OAuthTokenRecord>();
  const k = (p: string, a: string) => `${p} ${a}`;
  if (seed) rows.set(k(seed.providerId, seed.account), seed);
  return {
    async get(p, a) {
      return rows.get(k(p, a)) ?? null;
    },
    async upsert(rec) {
      rows.set(k(rec.providerId, rec.account), rec);
    },
    async delete(p, a) {
      rows.delete(k(p, a));
    },
    async list() {
      return [...rows.values()].map((r) => ({
        providerId: r.providerId,
        account: r.account,
        expiresAt: r.expiresAt,
        updatedAt: r.updatedAt,
      }));
    },
  };
}

// Stub provider whose refreshToken returns a ROTATED credential each call.
function stubProvider(): OAuthProviderInterface & { calls: number } {
  let calls = 0;
  return {
    id: "anthropic",
    name: "stub",
    calls: 0,
    async login() {
      throw new Error("not used");
    },
    async refreshToken(_creds: OAuthCredentials): Promise<OAuthCredentials> {
      calls += 1;
      (this as { calls: number }).calls = calls;
      return { access: `at-${calls}`, refresh: `rt-${calls}`, expires: 10_000 * calls };
    },
    getApiKey: (c) => c.access,
  };
}

function seedRecord(over: Partial<OAuthTokenRecord> = {}): OAuthTokenRecord {
  return {
    providerId: "anthropic",
    account: "default",
    accessEnc: encryptSecret("at-stored", KEY),
    refreshEnc: encryptSecret("rt-stored", KEY),
    expiresAt: 5_000,
    meta: null,
    updatedAt: 1,
    ...over,
  };
}

// A rotating, SINGLE-USE refresh provider (Anthropic-shaped): every refresh CONSUMES
// the prior refresh token, so replaying a consumed one is rejected with HTTP 400 —
// exactly what two desynced managers trigger upstream (and which revokes the family).
function rotatingProvider(): OAuthProviderInterface & { calls: number } {
  let current = "rt-0"; // matches rotatingSeed below
  let n = 0;
  const provider: OAuthProviderInterface & { calls: number } = {
    id: "anthropic",
    name: "rotating",
    calls: 0,
    async login(): Promise<OAuthCredentials> {
      throw new Error("not used");
    },
    async refreshToken(creds: OAuthCredentials): Promise<OAuthCredentials> {
      provider.calls += 1;
      if (creds.refresh !== current) throw new OAuthHttpError("Anthropic", 400);
      n += 1;
      current = `rt-${n}`;
      return { access: `at-${n}`, refresh: current, expires: 9_999_999_999_999 };
    },
    getApiKey: (c) => c.access,
  };
  return provider;
}

// Seed whose refresh token (rt-0) matches rotatingProvider's first valid token.
function rotatingSeed(expiresAt: number): OAuthTokenRecord {
  return {
    providerId: "anthropic",
    account: "default",
    accessEnc: encryptSecret("at-0", KEY),
    refreshEnc: encryptSecret("rt-0", KEY),
    expiresAt,
    meta: null,
    updatedAt: 0,
  };
}

describe("createTokenManager (preset kind)", () => {
  it("throws at construction when preset deps are missing", () => {
    expect(() => createTokenManager({ oauth: PRESET })).toThrow(/requires tokenStore/);
  });

  it("uses one request lease and refreshes at its exact expiry boundary", async () => {
    const provider = rotatingProvider();
    const skew = executionTokenExpirySkewMs(60_000);
    expect(skew).toBe(6 * 60_000);
    const usable = createTokenManager({
      oauth: PRESET,
      tokenStore: memStore(rotatingSeed(skew + 1)),
      encKey: KEY,
      oauthProvider: provider,
      expirySkewMs: skew,
      now: () => 0,
    });
    expect(await usable.getAuthHeader()).toBe("Bearer at-0");
    expect(provider.calls).toBe(0);

    const boundaryProvider = rotatingProvider();
    const boundary = createTokenManager({
      oauth: PRESET,
      tokenStore: memStore(rotatingSeed(skew)),
      encKey: KEY,
      oauthProvider: boundaryProvider,
      expirySkewMs: skew,
      now: () => 0,
    });
    expect(await boundary.getAuthHeader()).toBe("Bearer at-1");
    expect(boundaryProvider.calls).toBe(1);
  });

  it("waits before failover without replaying an ambiguously consumed refresh token", async () => {
    vi.useFakeTimers();
    try {
      let calls = 0;
      const provider: OAuthProviderInterface = {
        id: "anthropic",
        name: "transient",
        async login() {
          throw new Error("not used");
        },
        async refreshToken() {
          calls += 1;
          throw new OAuthHttpError("Anthropic", 503);
        },
        getApiKey: (c) => c.access,
      };
      const store = memStore(seedRecord({ expiresAt: 0 }));
      const tm = createTokenManager({
        oauth: PRESET,
        tokenStore: store,
        encKey: KEY,
        oauthProvider: provider,
        now: () => 0,
      });

      let settled = false;
      const header = tm.getAuthHeader().finally(() => {
        settled = true;
      });
      const failure = expect(header).rejects.toMatchObject({
        httpStatus: 503,
        retryableAccountFailure: true,
      });
      await vi.advanceTimersByTimeAsync(999);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(10_000);

      await failure;
      expect(calls).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("adopts a credential another instance rotated while waiting after a transient failure", async () => {
    vi.useFakeTimers();
    try {
      let calls = 0;
      const provider: OAuthProviderInterface = {
        id: "anthropic",
        name: "unavailable",
        async login() {
          throw new Error("not used");
        },
        async refreshToken() {
          calls += 1;
          throw new OAuthHttpError("Anthropic", 503);
        },
        getApiKey: (c) => c.access,
      };
      const store = memStore(seedRecord({ expiresAt: 0 }));
      const tm = createTokenManager({
        oauth: PRESET,
        tokenStore: store,
        encKey: KEY,
        oauthProvider: provider,
        now: () => 0,
      });

      const header = tm.getAuthHeader();
      await vi.advanceTimersByTimeAsync(0);
      expect(calls).toBe(1);
      await store.upsert({
        ...seedRecord(),
        accessEnc: encryptSecret("at-sibling", KEY),
        refreshEnc: encryptSecret("rt-sibling", KEY),
        expiresAt: 9_999_999,
        updatedAt: 1,
      });
      await vi.advanceTimersByTimeAsync(10_000);

      await expect(header).resolves.toBe("Bearer at-sibling");
      expect(calls).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects a newly refreshed token shorter than the required request lease", async () => {
    const skew = executionTokenExpirySkewMs(60_000);
    const provider = stubProvider(); // returns expires=10_000, shorter than the 120s lease
    const store = memStore(seedRecord({ expiresAt: 0 }));
    const tm = createTokenManager({
      oauth: PRESET,
      tokenStore: store,
      encKey: KEY,
      oauthProvider: provider,
      expirySkewMs: skew,
      now: () => 0,
    });

    await expect(tm.getAuthHeader()).rejects.toThrow(/shorter than required request lease/);
    const rotated = await store.get("anthropic", "default");
    expect(rotated?.refreshEnc && decryptSecret(rotated.refreshEnc, KEY)).toBe("rt-1");
  });

  it("reuses a still-valid stored access token WITHOUT calling the provider", async () => {
    const provider = stubProvider();
    const tm = createTokenManager({
      oauth: PRESET,
      tokenStore: memStore(seedRecord({ expiresAt: 1_000_000 })),
      encKey: KEY,
      oauthProvider: provider,
      now: () => 0,
    });
    expect(await tm.getAuthHeader()).toBe("Bearer at-stored");
    expect(provider.calls).toBe(0);
  });

  it("exposes persisted non-secret identity metadata after loading the credential", async () => {
    const provider = stubProvider();
    const tm = createTokenManager({
      oauth: PRESET,
      tokenStore: memStore(
        seedRecord({
          expiresAt: 1_000_000,
          meta: JSON.stringify({
            accountId: "workspace-9",
            chatgptUserId: "user-7",
            isFedramp: true,
          }),
        }),
      ),
      encKey: KEY,
      oauthProvider: provider,
      now: () => 0,
    });

    await tm.getAuthHeader();

    expect(tm.currentMetadata()).toEqual({
      accountId: "workspace-9",
      chatgptUserId: "user-7",
      isFedramp: true,
    });
  });

  it("refreshes via the provider when the stored token is expired", async () => {
    const provider = stubProvider();
    const tm = createTokenManager({
      oauth: PRESET,
      tokenStore: memStore(seedRecord({ expiresAt: 100 })),
      encKey: KEY,
      oauthProvider: provider,
      now: () => 1_000_000, // well past expiry
    });
    expect(await tm.getAuthHeader()).toBe("Bearer at-1");
    expect(provider.calls).toBe(1);
  });

  it("persists the ROTATED credential so a fresh manager survives a restart", async () => {
    const provider = stubProvider();
    const store = memStore(seedRecord({ expiresAt: 100 }));
    const tm = createTokenManager({
      oauth: PRESET,
      tokenStore: store,
      encKey: KEY,
      oauthProvider: provider,
      now: () => 1_000_000,
    });
    await tm.getAuthHeader(); // triggers refresh + write-back (rt-1)

    // Simulate a restart: a brand-new manager backed by the SAME store. Its stored
    // access token (at-1, expires 10_000) is now expired at this clock, so it
    // refreshes — proving it picked up the ROTATED refresh token, not the seed.
    const seen: string[] = [];
    const provider2: OAuthProviderInterface = {
      id: "anthropic",
      name: "stub2",
      async login() {
        throw new Error("nope");
      },
      async refreshToken(creds) {
        seen.push(creds.refresh);
        return { access: "at-final", refresh: "rt-final", expires: 9_999_999 };
      },
      getApiKey: (c) => c.access,
    };
    const tm2 = createTokenManager({
      oauth: PRESET,
      tokenStore: store,
      encKey: KEY,
      oauthProvider: provider2,
      now: () => 2_000_000,
    });
    expect(await tm2.getAuthHeader()).toBe("Bearer at-final");
    expect(seen).toEqual(["rt-1"]); // used the rotated token, not "rt-stored"
  });

  it("coalesces N concurrent expired callers into ONE provider refresh", async () => {
    const provider = stubProvider();
    const tm = createTokenManager({
      oauth: PRESET,
      tokenStore: memStore(seedRecord({ expiresAt: 100 })),
      encKey: KEY,
      oauthProvider: provider,
      now: () => 1_000_000,
    });
    const results = await Promise.all([tm.getAuthHeader(), tm.getAuthHeader(), tm.getAuthHeader()]);
    expect(results).toEqual(["Bearer at-1", "Bearer at-1", "Bearer at-1"]);
    expect(provider.calls).toBe(1);
  });

  it("lets one caller stop waiting without cancelling the shared refresh", async () => {
    let release!: () => void;
    let started!: () => void;
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    const refreshStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    const provider = rotatingProvider();
    const refreshToken = provider.refreshToken.bind(provider);
    provider.refreshToken = async (credentials) => {
      started();
      await waiting;
      return refreshToken(credentials);
    };
    const tm = createTokenManager({
      oauth: PRESET,
      tokenStore: memStore(rotatingSeed(100)),
      encKey: KEY,
      oauthProvider: provider,
      now: () => 1_000_000,
    });
    const first = tm.getAuthHeader();
    await refreshStarted;
    const caller = new AbortController();
    const second = tm.getAuthHeader(caller.signal);

    caller.abort(new Error("caller disconnected"));
    await expect(second).rejects.toThrow("caller disconnected");
    release();
    await expect(first).resolves.toBe("Bearer at-1");
    await expect(tm.getAuthHeader()).resolves.toBe("Bearer at-1");
    expect(provider.calls).toBe(1);
  });

  it("bounds the shared preset refresh fetch after every caller disconnects", async () => {
    let refreshSignal: AbortSignal | undefined;
    let fetchStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      fetchStarted = resolve;
    });
    const provider = rotatingProvider();
    provider.refreshToken = async (_credentials, fetchImpl) => {
      await fetchImpl?.("https://oauth.example/token");
      throw new Error("unreachable");
    };
    const tm = createTokenManager({
      oauth: PRESET,
      tokenStore: memStore(rotatingSeed(100)),
      encKey: KEY,
      oauthProvider: provider,
      refreshTimeoutMs: 5,
      fetch: (_input, init) => {
        const signal = init?.signal ?? undefined;
        refreshSignal = signal;
        fetchStarted();
        return new Promise<Response>((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      },
      now: () => 1_000_000,
    });
    const caller = new AbortController();
    const waiting = tm.getAuthHeader(caller.signal);
    await started;
    caller.abort(new Error("caller disconnected"));

    await expect(waiting).rejects.toThrow("caller disconnected");
    await vi.waitFor(() => expect(refreshSignal?.aborted).toBe(true));
    await vi.waitFor(() => expect(oauthRefreshQueueDepth()).toBe(0));
  });

  it("coalesces concurrent first-use reads before deciding whether to refresh", async () => {
    let reads = 0;
    let release!: () => void;
    const ready = new Promise<void>((resolve) => {
      release = resolve;
    });
    const seed = rotatingSeed(9_999_999_999_999);
    const store = memStore(seed);
    const originalGet = store.get.bind(store);
    store.get = async (providerId, account) => {
      reads += 1;
      await ready;
      return originalGet(providerId, account);
    };
    const provider = rotatingProvider();
    const tm = createTokenManager({
      oauth: PRESET,
      tokenStore: store,
      encKey: KEY,
      oauthProvider: provider,
      now: () => 1_000_000,
    });

    const first = tm.getAuthHeader();
    const second = tm.getAuthHeader();
    await new Promise<void>((resolve) => setImmediate(resolve));
    release();

    await expect(Promise.all([first, second])).resolves.toEqual(["Bearer at-0", "Bearer at-0"]);
    expect(reads).toBe(1);
    expect(provider.calls).toBe(0);
  });

  // ── cross-instance coordination (the rotating-refresh-token race fix) ──────────
  // The composition root builds MANY managers for one (provider, account): executor,
  // model discovery, providers-page status refresh, quota scrape, connectivity test.
  // They share ONE single-use rotating refresh token in the store; without a shared
  // gate two of them refresh concurrently, the loser replays a consumed token and the
  // upstream revokes the whole family → "oauth refresh failed" until manual re-login.

  it("two sibling managers refresh a shared rotating token exactly once", async () => {
    const store = memStore(rotatingSeed(100)); // already expired → both want to refresh
    const provider = rotatingProvider();
    const mk = () =>
      createTokenManager({
        oauth: PRESET,
        tokenStore: store,
        encKey: KEY,
        oauthProvider: provider,
        now: () => 1_000_000,
      });
    const [a, b] = [mk(), mk()];
    const [ha, hb] = await Promise.all([a.getAuthHeader(), b.getAuthHeader()]);
    // The gate serializes them; the loser re-reads + adopts the rotated token instead
    // of replaying the consumed one — so exactly ONE upstream refresh, same result.
    expect(provider.calls).toBe(1);
    expect(ha).toBe("Bearer at-1");
    expect(hb).toBe("Bearer at-1");
  });

  it("reports running and waiting preset refreshes until the shared gate settles", async () => {
    let release!: () => void;
    let started!: () => void;
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    const refreshStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    const provider = rotatingProvider();
    const refreshToken = provider.refreshToken.bind(provider);
    provider.refreshToken = async (credentials) => {
      started();
      await waiting;
      return refreshToken(credentials);
    };
    const store = memStore(rotatingSeed(100));
    const manager = () =>
      createTokenManager({
        oauth: PRESET,
        tokenStore: store,
        encKey: KEY,
        oauthProvider: provider,
        now: () => 1_000_000,
      });

    const first = manager().getAuthHeader();
    const second = manager().getAuthHeader();
    await refreshStarted;
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(oauthRefreshQueueDepth()).toBe(2);
    release();
    await Promise.all([first, second]);
    expect(oauthRefreshQueueDepth()).toBe(0);
  });

  it("re-reads the store before replaying a stale in-memory rotating token", async () => {
    // The production bug: manager B caches rt-0, sibling A rotates rt-0→rt-1, then B's
    // own token expires and B must ADOPT rt-1 from the store — never replay rt-0.
    const clock = { now: 1_000_000_000_000 };
    const expiry = clock.now + 3_600_000; // valid for an hour
    const store = memStore(rotatingSeed(expiry));
    const provider = rotatingProvider();
    const mk = () =>
      createTokenManager({
        oauth: PRESET,
        tokenStore: store,
        encKey: KEY,
        oauthProvider: provider,
        now: () => clock.now,
      });
    const [a, b] = [mk(), mk()];
    // Both load and serve the still-valid token (no refresh yet).
    expect(await a.getAuthHeader()).toBe("Bearer at-0");
    expect(await b.getAuthHeader()).toBe("Bearer at-0");
    expect(provider.calls).toBe(0);
    // Time passes into the skew window; A refreshes first (rt-0→rt-1, written back).
    clock.now = expiry;
    expect(await a.getAuthHeader()).toBe("Bearer at-1");
    expect(provider.calls).toBe(1);
    // B is also expired and still holds rt-0 in memory — it must adopt rt-1, not replay.
    expect(await b.getAuthHeader()).toBe("Bearer at-1");
    expect(provider.calls).toBe(1);
  });

  it("invalidate() forces a refresh even when the stored token is unexpired", async () => {
    const store = memStore(rotatingSeed(9_999_999_999_999));
    const provider = rotatingProvider();
    const tm = createTokenManager({
      oauth: PRESET,
      tokenStore: store,
      encKey: KEY,
      oauthProvider: provider,
      now: () => 1_000_000,
    });
    expect(await tm.getAuthHeader()).toBe("Bearer at-0"); // serves the stored token
    expect(provider.calls).toBe(0);
    tm.invalidate(); // upstream 401: the stored at-0 was rejected
    expect(await tm.getAuthHeader()).toBe("Bearer at-1"); // forced refresh despite no expiry
    expect(provider.calls).toBe(1);
  });

  it("surfaces the upstream HTTP status in a scrubbed refresh failure", async () => {
    const provider: OAuthProviderInterface = {
      id: "anthropic",
      name: "failing",
      async login() {
        throw new Error("nope");
      },
      async refreshToken() {
        throw new OAuthHttpError("Anthropic", 400);
      },
      getApiKey: (c) => c.access,
    };
    const tm = createTokenManager({
      oauth: PRESET,
      tokenStore: memStore(seedRecord({ expiresAt: 100 })), // expired → refresh attempt
      encKey: KEY,
      oauthProvider: provider,
      now: () => 1_000_000,
    });
    await expect(tm.getAuthHeader()).rejects.toMatchObject({
      name: "TokenRefreshError",
      httpStatus: 400,
      permanentCredentialFailure: false,
    });
    await expect(tm.getAuthHeader()).rejects.toThrow(
      /oauth refresh failed \(anthropic, status 400\)/,
    );
    // Still scrubbed — no token material leaks into the diagnosable message.
    await expect(tm.getAuthHeader()).rejects.not.toThrow(/at-stored|rt-stored/);
  });

  it("preserves explicit credential rejection and treats a bare 403 as retryable", async () => {
    const failing = (error: OAuthHttpError) =>
      createTokenManager({
        oauth: PRESET,
        tokenStore: memStore(seedRecord({ expiresAt: 100 })),
        encKey: KEY,
        oauthProvider: {
          id: "anthropic",
          name: "failing",
          async login() {
            throw new Error("not used");
          },
          async refreshToken() {
            throw error;
          },
          getApiKey: (credentials) => credentials.access,
        },
        now: () => 1_000_000,
      });

    await expect(
      failing(new OAuthHttpError("Anthropic", 400, true)).getAuthHeader(),
    ).rejects.toMatchObject({
      permanentCredentialFailure: true,
      retryableAccountFailure: false,
    });
    await expect(
      failing(new OAuthHttpError("Anthropic", 403)).getAuthHeader(),
    ).rejects.toMatchObject({
      permanentCredentialFailure: false,
      retryableAccountFailure: true,
    });
  });

  it("preserves a permanent credential marker when Codex refresh changes account identity", async () => {
    const provider: OAuthProviderInterface = {
      id: "openai-codex",
      name: "codex",
      async login() {
        throw new Error("not used");
      },
      async refreshToken() {
        throw new OpenAICodexIdentityMismatchError();
      },
      getApiKey: (c) => c.access,
    };
    const tm = createTokenManager({
      oauth: { kind: "preset", providerId: "openai-codex", account: "default" },
      tokenStore: memStore(
        seedRecord({
          providerId: "openai-codex",
          expiresAt: 100,
          meta: JSON.stringify({
            accountId: "acc-old",
            chatgptUserId: "user-1",
            chatgptPlanType: "plus",
          }),
        }),
      ),
      encKey: KEY,
      oauthProvider: provider,
      now: () => 1_000_000,
    });

    await expect(tm.getAuthHeader()).rejects.toMatchObject({
      name: "TokenRefreshError",
      httpStatus: null,
      permanentCredentialFailure: true,
    });
  });

  it("throws a scrubbed TokenRefreshError when no credential is stored", async () => {
    const provider = stubProvider();
    const tm = createTokenManager({
      oauth: PRESET,
      tokenStore: memStore(), // empty
      encKey: KEY,
      oauthProvider: provider,
      now: () => 0,
    });
    await expect(tm.getAuthHeader()).rejects.toBeInstanceOf(TokenRefreshError);
    await expect(tm.getAuthHeader()).rejects.toThrow(/run `helm oauth login anthropic`/);
  });

  it("forwards the manager's injected fetch into provider.refreshToken (egress proxy, issue #38)", async () => {
    // A sentinel fetch standing in for the per-account egress-proxy fetch. The
    // preset refresh MUST hand THIS to the provider so the refresh leaves through
    // the same hop as execution — never the real-IP global fetch.
    const proxyFetch = vi.fn(async () => new Response("{}"));
    let receivedFetch: unknown;
    const provider: OAuthProviderInterface = {
      id: "anthropic",
      name: "stub",
      async login() {
        throw new Error("nope");
      },
      async refreshToken(creds, fetchImpl) {
        receivedFetch = fetchImpl;
        await fetchImpl?.("https://oauth.example/token");
        return { access: "at-x", refresh: creds.refresh, expires: 9_999_999 };
      },
      getApiKey: (c) => c.access,
    };
    const tm = createTokenManager({
      oauth: PRESET,
      tokenStore: memStore(seedRecord({ expiresAt: 100 })),
      encKey: KEY,
      oauthProvider: provider,
      fetch: proxyFetch,
      now: () => 1_000_000,
    });
    await tm.getAuthHeader();
    expect(receivedFetch).toBeTypeOf("function");
    expect(proxyFetch).toHaveBeenCalledOnce();
  });

  it("round-trips provider-specific meta (e.g. copilot enterpriseUrl) on refresh", async () => {
    const store = memStore(
      seedRecord({
        providerId: "github-copilot",
        expiresAt: 100,
        meta: JSON.stringify({ enterpriseUrl: "ghe.acme.com" }),
      }),
    );
    let sawEnterprise: unknown;
    const provider: OAuthProviderInterface = {
      id: "github-copilot",
      name: "copilot",
      async login() {
        throw new Error("nope");
      },
      async refreshToken(creds) {
        sawEnterprise = (creds as Record<string, unknown>).enterpriseUrl;
        return {
          access: "tok;proxy-ep=proxy.x.com;",
          refresh: creds.refresh,
          expires: 9_999_999,
          enterpriseUrl: "ghe.acme.com",
        };
      },
      getApiKey: (c) => c.access,
    };
    const tm = createTokenManager({
      oauth: { kind: "preset", providerId: "github-copilot", account: "default" },
      tokenStore: store,
      encKey: KEY,
      oauthProvider: provider,
      now: () => 1_000_000,
    });
    await tm.getAuthHeader();
    expect(sawEnterprise).toBe("ghe.acme.com");
    // meta persisted back for the next restart.
    const row = await store.get("github-copilot", "default");
    expect(JSON.parse(row?.meta ?? "{}")).toEqual({ enterpriseUrl: "ghe.acme.com" });
  });
});
