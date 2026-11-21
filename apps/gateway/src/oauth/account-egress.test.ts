import {
  type ConfigStore,
  createTokenManager,
  decryptSecret,
  encryptSecret,
  getOAuthProvider,
  type OAuthTokenRecord,
  type OAuthTokenStore,
  replaceOAuthCredential,
} from "@helm/core";
import { describe, expect, it } from "vitest";
import {
  captureAccountEgress,
  guardAccountFetch,
  loadAccountSettings,
  setAccountSettings,
} from "./account-settings.js";

const KEY = Buffer.alloc(32, 9);
const A = { type: "http" as const, host: "proxy-a.invalid", port: 8080 };
const B = { ...A, host: "proxy-b.invalid" };
function configStore() {
  const values = new Map<string, string>();
  let failed = false;
  const config: ConfigStore = {
    get: async (key) => {
      if (failed) throw new Error("unavailable");
      return values.get(key) ?? null;
    },
    set: async (key, value) => {
      values.set(key, value);
    },
  };
  return {
    config,
    fail: () => {
      failed = true;
    },
    recover: () => {
      failed = false;
    },
  };
}

describe("account egress boundary", () => {
  it("blocks existing transports when settings cannot be read, and recovers only on a trusted read", async () => {
    const s = configStore();
    await setAccountSettings(s.config, KEY, "anthropic", "a", { proxy: A });
    const guard = captureAccountEgress(s.config, "anthropic", "a", A);
    guard();
    s.fail();
    await expect(loadAccountSettings(s.config, KEY)).rejects.toThrow();
    expect(guard).toThrow();
    s.recover();
    await loadAccountSettings(s.config, KEY);
    expect(guard).not.toThrow();
  });
  it("invalidates old transports even after A to B to A, without invalidating another account", async () => {
    const { config } = configStore();
    await setAccountSettings(config, KEY, "anthropic", "a", { proxy: A });
    const old = captureAccountEgress(config, "anthropic", "a", A);
    const other = captureAccountEgress(config, "anthropic", "b");
    await setAccountSettings(config, KEY, "anthropic", "a", { proxy: B });
    expect(old).toThrow();
    await setAccountSettings(config, KEY, "anthropic", "a", { proxy: A });
    expect(old).toThrow();
    expect(other).not.toThrow();
    expect(captureAccountEgress(config, "anthropic", "a", A)).not.toThrow();
  });
  it("keeps transports valid for unrelated settings and rejects a stale construction snapshot", async () => {
    const { config } = configStore();
    await setAccountSettings(config, KEY, "anthropic", "a", { proxy: A });
    const guard = captureAccountEgress(config, "anthropic", "a", A);
    await setAccountSettings(config, KEY, "anthropic", "a", { priority: 12 });
    expect(guard).not.toThrow();
    expect(() => captureAccountEgress(config, "anthropic", "a", B)).toThrow();
  });
  it.each([
    null,
    [],
    { proxy: false },
    { proxy: { ...A, port: 0 } },
  ])("rejects a corrupt account entry instead of treating it as direct: %j", async (entry) => {
    const { config } = configStore();
    await config.set(
      "oauth.account_settings",
      encryptSecret(JSON.stringify({ "anthropic\u0000a": entry }), KEY),
    );
    await expect(loadAccountSettings(config, KEY)).rejects.toThrow();
  });
});

it("preserves an already-issued rotating refresh token when the proxy changes in flight", async () => {
  const { config } = configStore();
  await setAccountSettings(config, KEY, "openai-codex", "a", { proxy: A });
  let row: OAuthTokenRecord = {
    providerId: "openai-codex",
    account: "a",
    accessEnc: encryptSecret("old", KEY),
    refreshEnc: encryptSecret("old-refresh", KEY),
    expiresAt: 0,
    meta: null,
    updatedAt: 1,
  };
  const store: OAuthTokenStore = {
    get: async () => row,
    upsert: async (r) => {
      row = r;
    },
    delete: async () => {},
    list: async () => [],
  };
  let release!: () => void;
  let entered!: () => void;
  const pending = new Promise<void>((r) => {
    release = r;
  });
  const started = new Promise<void>((r) => {
    entered = r;
  });
  const fetchImpl: typeof fetch = async () => {
    entered();
    await pending;
    return Response.json({
      access_token: "new-access",
      refresh_token: "new-refresh",
      expires_in: 3600,
    });
  };
  const tm = createTokenManager({
    oauth: { kind: "preset", providerId: "openai-codex", account: "a" },
    tokenStore: store,
    encKey: KEY,
    oauthProvider: getOAuthProvider("openai-codex")!,
    fetch: guardAccountFetch(fetchImpl, captureAccountEgress(config, "openai-codex", "a", A)),
  });
  const refresh = tm.getAuthHeader();
  const result = expect(refresh).resolves.toBe("Bearer new-access");
  await started;
  await setAccountSettings(config, KEY, "openai-codex", "a", { proxy: B });
  release();
  await result;
  expect(decryptSecret(row.refreshEnc!, KEY)).toBe("new-refresh");
});

it("serializes reconnect after an in-flight rotating refresh and revokes old managers", async () => {
  let row: OAuthTokenRecord = {
    providerId: "openai-codex",
    account: "a",
    accessEnc: encryptSecret("old", KEY),
    refreshEnc: encryptSecret("old-refresh", KEY),
    expiresAt: 0,
    meta: null,
    updatedAt: 1,
  };
  const store: OAuthTokenStore = {
    get: async () => row,
    upsert: async (r) => {
      row = r;
    },
    delete: async () => {},
    list: async () => [],
  };
  let release!: () => void;
  let entered!: () => void;
  const pending = new Promise<void>((r) => {
    release = r;
  });
  const started = new Promise<void>((r) => {
    entered = r;
  });
  const fetchImpl: typeof fetch = async () => {
    entered();
    await pending;
    return Response.json({
      access_token: "rotated",
      refresh_token: "rotated-refresh",
      expires_in: 3600,
    });
  };
  const tm = createTokenManager({
    oauth: { kind: "preset", providerId: "openai-codex", account: "a" },
    tokenStore: store,
    encKey: KEY,
    oauthProvider: getOAuthProvider("openai-codex")!,
    fetch: fetchImpl,
  });
  const refresh = tm.getAuthHeader();
  await started;
  const replacement = replaceOAuthCredential(store, {
    ...row,
    accessEnc: encryptSecret("reconnected", KEY),
    refreshEnc: encryptSecret("reconnected-refresh", KEY),
    expiresAt: Date.now() + 3600000,
  });
  const retired = expect(refresh).rejects.toThrow(/disconnect|revoked/i);
  release();
  await retired;
  await replacement;
  expect(decryptSecret(row.refreshEnc!, KEY)).toBe("reconnected-refresh");
  await expect(tm.getAuthHeader()).rejects.toThrow(/disconnect|revoked/i);
});
