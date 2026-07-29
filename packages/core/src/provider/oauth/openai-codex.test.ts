import { afterEach, describe, expect, it, vi } from "vitest";
import {
  beginOpenAICodexLogin,
  completeOpenAICodexLogin,
  isOpenAICodexWorkspacePlan,
  OpenAICodexIdentityMismatchError,
  openAICodexIdentityFingerprint,
  openaiCodexOAuthProvider,
  parseOpenAICodexIdentity,
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

describe("OpenAI Codex token request error handling", () => {
  it("throws a scrubbed HTTP error (no body echo) on a non-ok token response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ error: "invalid_grant", leak: "secret" }, 400)),
    );
    await expect(refreshOpenAICodexToken("rt")).rejects.toThrow(/OpenAI Codex OAuth HTTP 400/);
    await expect(refreshOpenAICodexToken("rt")).rejects.not.toThrow(/secret/);
  });
});

describe("parseOpenAICodexIdentity", () => {
  it("safely parses email and ChatGPT subscription claims from id_token", () => {
    const idToken = codexJwt({
      email: "top-level@example.com",
      "https://api.openai.com/profile": { email: "profile@example.com" },
      "https://api.openai.com/auth": {
        chatgpt_plan_type: "pro",
        chatgpt_user_id: "user_9",
        chatgpt_account_id: "acc_9",
        chatgpt_account_is_fedramp: true,
      },
    });

    expect(parseOpenAICodexIdentity(idToken)).toEqual({
      email: "top-level@example.com",
      chatgptPlanType: "pro",
      chatgptUserId: "user_9",
      accountId: "acc_9",
      isFedramp: true,
    });
  });

  it("uses profile email + user_id fallback and ignores unsafe claim types", () => {
    const idToken = codexJwt({
      email: 42,
      "https://api.openai.com/profile": { email: "profile@example.com" },
      "https://api.openai.com/auth": {
        chatgpt_plan_type: { unsafe: true },
        chatgpt_user_id: null,
        user_id: "legacy_user",
        chatgpt_account_id: "",
        chatgpt_account_is_fedramp: "true",
      },
    });

    expect(parseOpenAICodexIdentity(idToken)).toEqual({
      email: "profile@example.com",
      chatgptUserId: "legacy_user",
      isFedramp: false,
    });
  });

  it("returns an empty identity for opaque or malformed tokens", () => {
    expect(parseOpenAICodexIdentity("opaque-token")).toEqual({});
    expect(parseOpenAICodexIdentity("aaa.!!!notbase64json!!!.sig")).toEqual({});
  });
});

describe("OpenAI Codex identity binding", () => {
  it("normalizes the same workspace plan families as Codex CLI", () => {
    for (const plan of [
      "team",
      "self_serve_business_usage_based",
      "business",
      "enterprise_cbp_usage_based",
      "enterprise",
      "hc",
      "education",
      "edu",
    ]) {
      expect(isOpenAICodexWorkspacePlan(plan)).toBe(true);
    }
    for (const plan of ["free", "go", "plus", "pro", "prolite", "future-plan"]) {
      expect(isOpenAICodexWorkspacePlan(plan)).toBe(false);
    }
  });

  it("fingerprints workspace, account, and user identity instead of only account id", () => {
    expect(
      openAICodexIdentityFingerprint({
        accountId: "workspace-1",
        chatgptUserId: "user-1",
        chatgptPlanType: "business",
      }),
    ).not.toBe(
      openAICodexIdentityFingerprint({
        accountId: "workspace-1",
        chatgptUserId: "user-2",
        chatgptPlanType: "business",
      }),
    );
  });

  it.each([
    [
      "account",
      { accountId: "acc-old", chatgptUserId: "user-1", chatgptPlanType: "plus" },
      { accountId: "acc-new", chatgptUserId: "user-1", chatgptPlanType: "plus" },
    ],
    [
      "user",
      { accountId: "acc-1", chatgptUserId: "user-old", chatgptPlanType: "plus" },
      { accountId: "acc-1", chatgptUserId: "user-new", chatgptPlanType: "plus" },
    ],
    [
      "workspace kind",
      { accountId: "acc-1", chatgptUserId: "user-1", chatgptPlanType: "plus" },
      { accountId: "acc-1", chatgptUserId: "user-1", chatgptPlanType: "business" },
    ],
  ])("rejects refresh identity changes across the %s boundary", async (_label, oldIdentity, nextIdentity) => {
    const nextToken = codexJwt({
      "https://api.openai.com/auth": {
        chatgpt_account_id: nextIdentity.accountId,
        chatgpt_user_id: nextIdentity.chatgptUserId,
        chatgpt_plan_type: nextIdentity.chatgptPlanType,
      },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({
          id_token: nextToken,
          access_token: nextToken,
          refresh_token: "next-refresh",
          expires_in: 3600,
        }),
      ),
    );

    await expect(
      refreshOpenAICodexToken({
        access: "old-access",
        refresh: "old-refresh",
        expires: 0,
        ...oldIdentity,
      }),
    ).rejects.toBeInstanceOf(OpenAICodexIdentityMismatchError);
  });

  it("accepts plan changes that remain inside the same workspace class", async () => {
    const nextToken = codexJwt({
      "https://api.openai.com/auth": {
        chatgpt_account_id: "acc-1",
        chatgpt_user_id: "user-1",
        chatgpt_plan_type: "enterprise",
      },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({
          id_token: nextToken,
          access_token: nextToken,
          refresh_token: "next-refresh",
          expires_in: 3600,
        }),
      ),
    );

    await expect(
      refreshOpenAICodexToken({
        access: "old-access",
        refresh: "old-refresh",
        expires: 0,
        accountId: "acc-1",
        chatgptUserId: "user-1",
        chatgptPlanType: "business",
      }),
    ).resolves.toMatchObject({
      accountId: "acc-1",
      chatgptUserId: "user-1",
      chatgptPlanType: "enterprise",
    });
  });
});

describe("credential validation + identity extraction", () => {
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

  it("extracts subscription identity without retaining the raw id_token", async () => {
    const idToken = codexJwt({
      "https://api.openai.com/profile": { email: "codex@example.com" },
      "https://api.openai.com/auth": {
        chatgpt_plan_type: "plus",
        chatgpt_user_id: "user_1",
        chatgpt_account_id: "acc_1",
        chatgpt_account_is_fedramp: true,
      },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({
          id_token: idToken,
          access_token: codexJwt({}),
          refresh_token: "rt",
          expires_in: 3600,
        }),
      ),
    );

    const creds = await refreshOpenAICodexToken("rt");
    expect(creds).toMatchObject({
      email: "codex@example.com",
      chatgptPlanType: "plus",
      chatgptUserId: "user_1",
      accountId: "acc_1",
      isFedramp: true,
    });
    expect(creds).not.toHaveProperty("idToken");
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
  it("stores the provider's real expiry without a provider-local skew", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({
          access_token: codexJwt({}),
          refresh_token: "new-rt",
          expires_in: 3600,
        }),
      ),
    );

    const creds = await refreshOpenAICodexToken("old-rt");
    expect(creds.expires).toBe(4_600_000);
    vi.useRealTimers();
  });

  it("sends a JSON refresh_token grant with NO client_secret and parses creds", async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(new Headers(init?.headers).get("Content-Type")).toBe("application/json");
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(body.grant_type).toBe("refresh_token");
      expect(body.refresh_token).toBe("old-rt");
      expect(body.client_secret).toBeUndefined();
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

  it("keeps prior refresh + identity fields when the refresh response omits them", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () => jsonResponse({ access_token: codexJwt({}), expires_in: 3600 }), // no refresh_token
      ),
    );
    const creds = await refreshOpenAICodexToken({
      access: "old-access",
      refresh: "kept-rt",
      expires: 0,
      idToken: "old-id-token",
      email: "old@example.com",
      chatgptPlanType: "business",
      chatgptUserId: "user_old",
      accountId: "acc_old",
      isFedramp: true,
      futureCredentialField: "keep-me",
    });
    expect(creds).toMatchObject({
      refresh: "kept-rt",
      email: "old@example.com",
      chatgptPlanType: "business",
      chatgptUserId: "user_old",
      accountId: "acc_old",
      isFedramp: true,
      futureCredentialField: "keep-me",
    });
    expect(creds).not.toHaveProperty("idToken");
  });
});

describe("openaiCodexOAuthProvider", () => {
  it("refreshToken delegates to refreshOpenAICodexToken via creds.refresh", async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      expect((JSON.parse(String(init?.body)) as Record<string, unknown>).refresh_token).toBe("R");
      return jsonResponse({ access_token: codexJwt({}), refresh_token: "R2", expires_in: 3600 });
    });
    const creds = await openaiCodexOAuthProvider.refreshToken(
      { refresh: "R", access: "old", expires: 0 },
      fetchMock as unknown as typeof globalThis.fetch,
    );
    expect(creds.refresh).toBe("R2");
    expect(openaiCodexOAuthProvider.getApiKey(creds)).toBe(creds.access);
  });

  it("begin includes connector scopes and the Codex CLI originator", () => {
    const start = beginOpenAICodexLogin();
    const url = new URL(start.authorizeUrl);

    expect(url.searchParams.get("scope")).toBe(
      "openid profile email offline_access api.connectors.read api.connectors.invoke",
    );
    expect(url.searchParams.get("originator")).toBe("codex_cli_rs");
  });

  it("login shows the URL then exchanges the code as form-urlencoded", async () => {
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
    const init = fetchMock.mock.calls[0]?.[1];
    expect(new Headers(init?.headers).get("Content-Type")).toBe(
      "application/x-www-form-urlencoded",
    );
    const body = new URLSearchParams(String(init?.body));
    expect(body.get("code")).toBe("cli-code");
    expect(body.get("grant_type")).toBe("authorization_code");
    expect(body.get("client_secret")).toBeNull();
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

  it("complete rejects an authorization code when OAuth state is missing", async () => {
    await expect(
      completeOpenAICodexLogin({
        redirectInput: "code=cli-code",
        verifier: "v",
        state: "expected-state",
      }),
    ).rejects.toThrow(/OAuth state mismatch/);
  });

  it("complete rejects an authorization code when OAuth state differs", async () => {
    await expect(
      completeOpenAICodexLogin({
        redirectInput: "code=cli-code&state=wrong-state",
        verifier: "v",
        state: "expected-state",
      }),
    ).rejects.toThrow(/OAuth state mismatch/);
  });
});
