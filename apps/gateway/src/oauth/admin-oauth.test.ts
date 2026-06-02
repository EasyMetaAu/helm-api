import { createSqliteDb, decryptSecret, SqliteOAuthTokenStore } from "@helm/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createOAuthAdmin } from "./admin-oauth.js";

const KEY = Buffer.alloc(32, 4);

function makeStore(): SqliteOAuthTokenStore {
  return new SqliteOAuthTokenStore(createSqliteDb(":memory:"));
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
    const admin = createOAuthAdmin({ store: makeStore(), encKey: KEY });
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

  it("manual-paste: Codex start -> complete persists encrypted creds (form-encoded exchange)", async () => {
    const store = makeStore();
    const admin = createOAuthAdmin({ store, encKey: KEY, genSessionId: () => "cdx" });
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
    const admin = createOAuthAdmin({ store, encKey: KEY, genSessionId: () => "dev" });
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
    const admin = createOAuthAdmin({ store, encKey: KEY });
    await admin.logout({ providerId: "anthropic", account: "default" });
    expect(await store.get("anthropic", "default")).toBeNull();
  });

  it("rejects an unknown/expired session", async () => {
    const admin = createOAuthAdmin({ store: makeStore(), encKey: KEY });
    await expect(
      admin.completeManualPaste({ sessionId: "nope", redirectInput: "code=x", account: "default" }),
    ).rejects.toThrow(/session not found/);
  });

  it("rejects the wrong flow for a provider", async () => {
    const admin = createOAuthAdmin({ store: makeStore(), encKey: KEY });
    await expect(admin.startManualPaste({ providerId: "github-copilot" })).rejects.toThrow(
      /manual-paste/,
    );
    await expect(admin.startDeviceCode({ providerId: "anthropic" })).rejects.toThrow(/device-code/);
  });
});
