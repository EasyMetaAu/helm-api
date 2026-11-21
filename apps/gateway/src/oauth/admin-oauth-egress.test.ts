import {
  type ConfigStore,
  encryptSecret,
  type OAuthTokenRecord,
  type OAuthTokenStore,
  type ProxyConfig,
} from "@helm/core";
import { describe, expect, it, vi } from "vitest";
import { setAccountSettings } from "./account-settings.js";
import { createOAuthAdmin } from "./admin-oauth.js";

const KEY = Buffer.alloc(32, 4);
const A = { type: "http" as const, host: "proxy-a.invalid", port: 8080 };
const B = { ...A, host: "proxy-b.invalid" };
const json = (body: unknown) =>
  new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
function fixture() {
  const values = new Map<string, string>();
  const rows = new Map<string, OAuthTokenRecord>();
  const config: ConfigStore = {
    get: async (k) => values.get(k) ?? null,
    set: async (k, v) => {
      values.set(k, v);
    },
  };
  const store: OAuthTokenStore = {
    get: async (p, a) => rows.get(`${p}/${a}`) ?? null,
    upsert: async (r) => {
      rows.set(`${r.providerId}/${r.account}`, r);
    },
    delete: async (p, a) => {
      rows.delete(`${p}/${a}`);
    },
    list: async () =>
      [...rows.values()].map(({ providerId, account, expiresAt, updatedAt }) => ({
        providerId,
        account,
        expiresAt,
        updatedAt,
      })),
  };
  const calls: Array<{ proxy?: ProxyConfig; url: string }> = [];
  let delay: (() => Promise<void>) | undefined;
  const makeFetch =
    (proxy?: ProxyConfig): typeof fetch =>
    async (url) => {
      const u = String(url);
      calls.push({ proxy, url: u });
      if (u.endsWith("/login/device/code"))
        return json({
          device_code: "d",
          user_code: "u",
          verification_uri: "https://github.com/login/device",
          interval: 5,
          expires_in: 900,
        });
      if (u.endsWith("/login/oauth/access_token")) {
        await delay?.();
        return json({ access_token: "new-gh" });
      }
      if (u.endsWith("/copilot_internal/v2/token"))
        return json({
          token: "tid=new;proxy-ep=proxy.individual.githubcopilot.com;",
          expires_at: Date.now() / 1000 + 3600,
        });
      throw new Error("unexpected mocked endpoint");
    };
  const seed = async (account = "default") => {
    await store.upsert({
      providerId: "github-copilot",
      account,
      accessEnc: encryptSecret("old-access", KEY),
      refreshEnc: encryptSecret("old-refresh", KEY),
      expiresAt: Date.now() + 3600000,
      meta: null,
      updatedAt: 1,
    });
    await setAccountSettings(config, KEY, "github-copilot", account, { proxy: A });
  };
  return {
    config,
    store,
    calls,
    seed,
    setDelay: (f: () => Promise<void>) => {
      delay = f;
    },
    admin: createOAuthAdmin({ config, store, encKey: KEY, makeFetch }),
  };
}
function gate() {
  let release!: () => void;
  const promise = new Promise<void>((r) => {
    release = r;
  });
  return { promise, release };
}
describe("OAuth authorization egress", () => {
  it("binds omitted account to default before the first request and refuses a later rename", async () => {
    const f = fixture();
    await f.seed();
    const start = await f.admin.startDeviceCode({ providerId: "github-copilot" });
    expect(f.calls[0]?.proxy).toEqual(A);
    await expect(
      f.admin.pollDeviceCode({ sessionId: start.sessionId, account: "other" }),
    ).rejects.toThrow(/account mismatch/);
    expect(f.calls).toHaveLength(1);
  });
  it("rejects an explicit new-account collision before any upstream request", async () => {
    const f = fixture();
    await f.seed("work");
    await expect(
      f.admin.startDeviceCode({ providerId: "github-copilot", account: "work", createOnly: true }),
    ).rejects.toThrow(/already exists/);
    expect(f.calls).toHaveLength(0);
  });
  it("does not mint a token or overwrite B when proxy changes during a device poll", async () => {
    const f = fixture();
    await f.seed();
    const entered = gate();
    const pending = gate();
    f.setDelay(async () => {
      entered.release();
      await pending.promise;
    });
    const start = await f.admin.startDeviceCode({
      providerId: "github-copilot",
      account: "default",
    });
    const poll = f.admin.pollDeviceCode({ sessionId: start.sessionId, account: "default" });
    const rejected = expect(poll).rejects.toThrow(/proxy.*changed/i);
    await entered.promise;
    await f.admin.setAccountProxy({ providerId: "github-copilot", account: "default", proxy: B });
    pending.release();
    await rejected;
    expect(f.calls.some((c) => c.url.includes("copilot_internal"))).toBe(false);
    expect(
      (await f.admin.getAccountProxy({ providerId: "github-copilot", account: "default" }))?.host,
    ).toBe(B.host);
    expect((await f.store.get("github-copilot", "default"))?.updatedAt).toBe(1);
  });
  it("invalidates a pending authorization when the account is disconnected", async () => {
    const f = fixture();
    await f.seed();
    const start = await f.admin.startDeviceCode({
      providerId: "github-copilot",
      account: "default",
    });
    await f.admin.logout({ providerId: "github-copilot", account: "default" });
    await expect(
      f.admin.pollDeviceCode({ sessionId: start.sessionId, account: "default" }),
    ).rejects.toThrow();
    expect(f.calls).toHaveLength(1);
    expect(await f.store.get("github-copilot", "default")).toBeNull();
  });
  it("does not send quota requests when only settings reads fail", async () => {
    const f = fixture();
    await f.seed();
    const row = await f.store.get("github-copilot", "default");
    await f.store.upsert({ ...row!, providerId: "anthropic" });
    vi.spyOn(f.config, "get").mockRejectedValue(new Error("storage unavailable"));
    await f.admin.fetchAnthropicQuota!({ account: "default", force: true });
    expect(f.calls).toHaveLength(0);
  });
});

it("blocks the xAI device request if proxy changes during discovery", async () => {
  const f = fixture();
  const entered = gate();
  const pending = gate();
  await setAccountSettings(f.config, KEY, "xai", "work", { proxy: A });
  const fetchImpl = vi.fn<typeof fetch>(async () => {
    entered.release();
    await pending.promise;
    return json({
      token_endpoint: "https://auth.x.ai/oauth2/token",
      device_authorization_endpoint: "https://auth.x.ai/oauth2/device/code",
    });
  });
  const admin = createOAuthAdmin({
    config: f.config,
    store: f.store,
    encKey: KEY,
    makeFetch: () => fetchImpl,
  });
  const start = admin.startDeviceCode({ providerId: "xai", account: "work" });
  const rejected = expect(start).rejects.toThrow(/proxy.*changed/i);
  await entered.promise;
  await admin.setAccountProxy({ providerId: "xai", account: "work", proxy: B });
  pending.release();
  await rejected;
  expect(fetchImpl).toHaveBeenCalledTimes(1);
});

it("rejects a manual token response after proxy changes without overwriting credentials", async () => {
  const f = fixture();
  const entered = gate();
  const pending = gate();
  await setAccountSettings(f.config, KEY, "anthropic", "work", { proxy: A });
  const fetchImpl = vi.fn<typeof fetch>(async () => {
    entered.release();
    await pending.promise;
    return json({ access_token: "new", refresh_token: "new-refresh", expires_in: 3600 });
  });
  const admin = createOAuthAdmin({
    config: f.config,
    store: f.store,
    encKey: KEY,
    makeFetch: () => fetchImpl,
  });
  const start = await admin.startManualPaste({ providerId: "anthropic", account: "work" });
  const complete = admin.completeManualPaste({
    sessionId: start.sessionId,
    account: "work",
    redirectInput: `https://example.test/cb?code=C&state=${new URL(start.authorizeUrl).searchParams.get("state")}`,
  });
  const rejected = expect(complete).rejects.toThrow(/proxy.*changed/i);
  await entered.promise;
  await admin.setAccountProxy({ providerId: "anthropic", account: "work", proxy: B });
  pending.release();
  await rejected;
  expect(await f.store.get("anthropic", "work")).toBeNull();
  expect((await admin.getAccountProxy({ providerId: "anthropic", account: "work" }))?.host).toBe(
    B.host,
  );
});

it("allows only one of two new-account sessions to commit the same label", async () => {
  const f = fixture();
  const a = await f.admin.startDeviceCode({
    providerId: "github-copilot",
    account: "new",
    createOnly: true,
  });
  const b = await f.admin.startDeviceCode({
    providerId: "github-copilot",
    account: "new",
    createOnly: true,
  });
  const results = await Promise.allSettled(
    [a, b].map((s) => f.admin.pollDeviceCode({ sessionId: s.sessionId, account: "new" })),
  );
  expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
  expect(await f.store.list()).toHaveLength(1);
});
