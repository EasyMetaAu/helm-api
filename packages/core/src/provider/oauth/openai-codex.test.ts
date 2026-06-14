import { afterEach, describe, expect, it, vi } from "vitest";
import {
  completeOpenAICodexLogin,
  openaiCodexOAuthProvider,
  refreshOpenAICodexToken,
} from "./openai-codex.js";
import type { OAuthLoginCallbacks } from "./types.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// A Codex access-token JWT (header.payload.sig) carrying an optional account id.
function codexJwt(payload: Record<string, unknown>): string {
  const seg = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${seg({ alg: "none" })}.${seg(payload)}.sig`;
}

afterEach(() => vi.unstubAllGlobals());

describe("postTokenForm error handling", () => {
  it("throws a scrubbed HTTP error (no body echo) on a non-ok token response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ error: "invalid_grant", leak: "secret" }, 400)),
    );
    await expect(refreshOpenAICodexToken("rt")).rejects.toThrow(/OpenAI Codex OAuth HTTP 400/);
    await expect(refreshOpenAICodexToken("rt")).rejects.not.toThrow(/secret/);
  });
});

describe("toCredentials field validation + accountId extraction", () => {
  it("rejects a token response missing access_token", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ refresh_token: "rt", expires_in: 3600 })),
    );
    await expect(refreshOpenAICodexToken("rt")).rejects.toThrow(/missing required fields/);
  });

  it("rejects a token response with a non-positive expires_in", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({ access_token: codexJwt({}), refresh_token: "rt", expires_in: 0 }),
      ),
    );
    await expect(refreshOpenAICodexToken("rt")).rejects.toThrow(/missing required fields/);
  });

  it("omits accountId when the JWT payload carries no chatgpt_account_id", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({
          access_token: codexJwt({ sub: "u1" }), // no auth claim
          refresh_token: "rt",
          expires_in: 3600,
        }),
      ),
    );
    const creds = await refreshOpenAICodexToken("rt");
    expect((creds as { accountId?: string }).accountId).toBeUndefined();
  });

  it("omits accountId when the access token is NOT a 3-part JWT", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({ access_token: "opaque-not-a-jwt", refresh_token: "rt", expires_in: 3600 }),
      ),
    );
    const creds = await refreshOpenAICodexToken("rt");
    expect((creds as { accountId?: string }).accountId).toBeUndefined();
  });

  it("omits accountId when the JWT payload segment is not valid base64url JSON", async () => {
    // 3 segments but the middle one decodes to garbage → JSON.parse throws → catch.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({
          access_token: "aaa.!!!notbase64json!!!.sig",
          refresh_token: "rt",
          expires_in: 3600,
        }),
      ),
    );
    const creds = await refreshOpenAICodexToken("rt");
    expect((creds as { accountId?: string }).accountId).toBeUndefined();
    expect(creds.access).toBe("aaa.!!!notbase64json!!!.sig");
  });

  it("omits accountId when chatgpt_account_id is an empty string", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({
          access_token: codexJwt({ "https://api.openai.com/auth": { chatgpt_account_id: "" } }),
          refresh_token: "rt",
          expires_in: 3600,
        }),
      ),
    );
    const creds = await refreshOpenAICodexToken("rt");
    expect((creds as { accountId?: string }).accountId).toBeUndefined();
  });
});

describe("refreshOpenAICodexToken", () => {
  it("sends refresh_token grant with NO client_secret and parses creds", async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(new Headers(init?.headers).get("Content-Type")).toBe(
        "application/x-www-form-urlencoded",
      );
      const body = new URLSearchParams(String(init?.body));
      expect(body.get("grant_type")).toBe("refresh_token");
      expect(body.get("refresh_token")).toBe("old-rt");
      expect(body.get("client_secret")).toBeNull();
      return jsonResponse({
        access_token: codexJwt({ "https://api.openai.com/auth": { chatgpt_account_id: "acc_9" } }),
        refresh_token: "new-rt",
        expires_in: 3600,
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const creds = await refreshOpenAICodexToken("old-rt");
    expect(creds.refresh).toBe("new-rt");
    expect((creds as { accountId?: string }).accountId).toBe("acc_9");
    expect(creds.expires).toBeGreaterThan(Date.now());
  });

  it("keeps the prior refresh token when the server omits one (rotation off)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () => jsonResponse({ access_token: codexJwt({}), expires_in: 3600 }), // no refresh_token
      ),
    );
    const creds = await refreshOpenAICodexToken("kept-rt");
    expect(creds.refresh).toBe("kept-rt");
  });
});

describe("openaiCodexOAuthProvider", () => {
  it("refreshToken delegates to refreshOpenAICodexToken via creds.refresh", async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(new URLSearchParams(String(init?.body)).get("refresh_token")).toBe("R");
      return jsonResponse({ access_token: codexJwt({}), refresh_token: "R2", expires_in: 3600 });
    });
    const creds = await openaiCodexOAuthProvider.refreshToken(
      { refresh: "R", access: "old", expires: 0 },
      fetchMock as unknown as typeof globalThis.fetch,
    );
    expect(creds.refresh).toBe("R2");
    expect(openaiCodexOAuthProvider.getApiKey(creds)).toBe(creds.access);
  });

  it("login (manual paste via onManualCodeInput) shows the URL then exchanges the code", async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) =>
      jsonResponse({ access_token: codexJwt({}), refresh_token: "RT", expires_in: 3600 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    let shownUrl = "";
    let manualState = "";
    const callbacks: OAuthLoginCallbacks = {
      onAuth: (info) => {
        shownUrl = info.url;
        manualState = new URL(info.url).searchParams.get("state") ?? "";
      },
      onPrompt: async () => {
        throw new Error("onPrompt should not run when onManualCodeInput is present");
      },
      onManualCodeInput: async () =>
        `http://localhost:1455/auth/callback?code=cli-code&state=${manualState}`,
    };
    const creds = await openaiCodexOAuthProvider.login(callbacks);
    expect(shownUrl).toContain("auth.openai.com/oauth/authorize");
    expect(creds.refresh).toBe("RT");
    const body = new URLSearchParams(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(body.get("code")).toBe("cli-code");
    expect(body.get("grant_type")).toBe("authorization_code");
  });

  it("login falls back to onPrompt when onManualCodeInput is absent", async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) =>
      jsonResponse({ access_token: codexJwt({}), refresh_token: "RT2", expires_in: 3600 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    let promptState = "";
    const onPrompt = vi.fn(async () => `code=prompt-code&state=${promptState}`);
    const callbacks: OAuthLoginCallbacks = {
      onAuth: (info) => {
        promptState = new URL(info.url).searchParams.get("state") ?? "";
      },
      onPrompt,
    };
    const creds = await openaiCodexOAuthProvider.login(callbacks);
    expect(onPrompt).toHaveBeenCalledOnce();
    expect(creds.refresh).toBe("RT2");
    expect(new URLSearchParams(String(fetchMock.mock.calls[0]?.[1]?.body)).get("code")).toBe(
      "prompt-code",
    );
  });

  it("complete rejects redirect input with no authorization code", async () => {
    await expect(
      completeOpenAICodexLogin({ redirectInput: "   ", verifier: "v", state: "s" }),
    ).rejects.toThrow(/Missing authorization code/);
  });
});
