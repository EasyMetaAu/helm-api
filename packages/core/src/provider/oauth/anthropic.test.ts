import { afterEach, describe, expect, it, vi } from "vitest";
import { anthropicOAuthProvider, loginAnthropic, refreshAnthropicToken } from "./anthropic.js";
import type { OAuthAuthInfo, OAuthLoginCallbacks, OAuthPrompt } from "./types.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// The login callback server binds localhost:53692; drive it by hitting that URL.
const CALLBACK_BASE = "http://127.0.0.1:53692/callback";

// Pull the redirect_uri/state out of the authorize URL handed to onAuth so a test
// can craft a matching callback hit.
function captureAuth(): {
  onAuth: (info: OAuthAuthInfo) => void;
  authUrl: () => URL;
} {
  let url: URL | undefined;
  return {
    onAuth: (info) => {
      url = new URL(info.url);
    },
    authUrl: () => {
      if (!url) throw new Error("onAuth not called");
      return url;
    },
  };
}

afterEach(() => vi.unstubAllGlobals());

describe("refreshAnthropicToken — invalid JSON token body", () => {
  it("stores the provider's real expiry without a provider-local skew", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ access_token: "a", refresh_token: "r", expires_in: 3600 })),
    );

    const creds = await refreshAnthropicToken("rtok");
    expect(creds.expires).toBe(4_600_000);
    vi.useRealTimers();
  });

  it("throws a JSON-parse error when the token endpoint returns non-JSON", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("not-json", { status: 200 })),
    );
    await expect(refreshAnthropicToken("rtok")).rejects.toThrow(/not valid JSON/i);
  });

  it("provider.refreshToken delegates to refreshAnthropicToken with the refresh cred", async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(body.grant_type).toBe("refresh_token");
      expect(body.refresh_token).toBe("the-refresh");
      return jsonResponse({ access_token: "a", refresh_token: "r", expires_in: 3600 });
    });
    const creds = await anthropicOAuthProvider.refreshToken(
      { refresh: "the-refresh", access: "old", expires: 0 },
      fetchMock as unknown as typeof globalThis.fetch,
    );
    expect(creds.access).toBe("a");
    expect(anthropicOAuthProvider.getApiKey(creds)).toBe("a");
    expect(anthropicOAuthProvider.usesCallbackServer).toBe(true);
  });
});

describe("loginAnthropic — interactive CLI flow + callback server", () => {
  it("rejects immediately if the signal is already aborted", async () => {
    const c = new AbortController();
    c.abort();
    const cap = captureAuth();
    await expect(
      loginAnthropic({
        onAuth: cap.onAuth,
        onPrompt: async () => "",
        signal: c.signal,
      }),
    ).rejects.toThrow(/Login cancelled/);
  });

  it("completes when the localhost callback receives a valid code+state", async () => {
    const fetchMock = vi.fn(async (url: string, _init?: RequestInit) => {
      // The token exchange must reach the Anthropic token endpoint.
      expect(url).toContain("oauth/token");
      return jsonResponse({ access_token: "AT", refresh_token: "RT", expires_in: 3600 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const cap = captureAuth();
    const callbacks: OAuthLoginCallbacks = {
      onAuth: cap.onAuth,
      onPrompt: async () => {
        throw new Error("onPrompt should not be called when callback resolves");
      },
      onProgress: vi.fn(),
    };
    const loginPromise = loginAnthropic(callbacks);

    // Wait for the callback server to be listening (onAuth fires after listen).
    await vi.waitFor(() => cap.authUrl());
    const state = cap.authUrl().searchParams.get("state");
    expect(state).toBeTruthy();

    // Hit the real localhost callback the server is waiting on. global fetch is
    // stubbed, so use node:http directly (un-stubbed) to drive the callback.
    const httpGet = (await import("node:http")).get;
    await new Promise<void>((resolve, reject) => {
      const req = httpGet(`${CALLBACK_BASE}?code=server-code&state=${state}`, (res) => {
        res.on("data", () => {});
        res.on("end", () => resolve());
      });
      req.on("error", reject);
    });

    const creds = await loginPromise;
    expect(creds.access).toBe("AT");
    expect(creds.refresh).toBe("RT");
    expect(callbacks.onProgress).toHaveBeenCalledWith(
      expect.stringContaining("Exchanging authorization code"),
    );
    // Token exchange carried the code received from the callback server.
    const sentBody = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as Record<
      string,
      unknown
    >;
    expect(sentBody.grant_type).toBe("authorization_code");
    expect(sentBody.code).toBe("server-code");
    // The CLI flow keeps its localhost callback (the web flow diverges to the
    // console callback) — the exchange must echo that same localhost redirect_uri.
    expect(sentBody.redirect_uri).toBe("http://localhost:53692/callback");
  });

  it("the callback server returns 404 for a wrong path and 400 for state mismatch", async () => {
    const cap = captureAuth();
    // Never resolve the callback; we cancel via the manual-input race instead.
    let cancelManual: (() => void) | undefined;
    const manual = new Promise<string>((_res, rej) => {
      cancelManual = () => rej(new Error("aborted"));
    });
    const callbacks: OAuthLoginCallbacks = {
      onAuth: cap.onAuth,
      onPrompt: async () => "",
      onManualCodeInput: () => manual,
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ access_token: "x", refresh_token: "y", expires_in: 3600 })),
    );
    const loginPromise = loginAnthropic(callbacks);
    await vi.waitFor(() => cap.authUrl());
    const state = cap.authUrl().searchParams.get("state");

    const httpGet = (await import("node:http")).get;
    const hit = (path: string): Promise<number> =>
      new Promise((resolve, reject) => {
        const req = httpGet(`http://127.0.0.1:53692${path}`, (res) => {
          res.on("data", () => {});
          res.on("end", () => resolve(res.statusCode ?? 0));
        });
        req.on("error", reject);
      });

    expect(await hit("/wrong")).toBe(404);
    expect(await hit("/callback")).toBe(400); // missing code/state
    expect(await hit("/callback?error=access_denied")).toBe(400); // provider error
    expect(await hit(`/callback?code=c&state=WRONG`)).toBe(400); // state mismatch
    // Now satisfy the flow via a valid callback so login resolves and the server closes.
    await hit(`/callback?code=ok&state=${state}`);
    const creds = await loginPromise;
    expect(creds.access).toBe("x");
    cancelManual?.();
  });

  it("falls back to a manual paste when the callback yields no code", async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) =>
      jsonResponse({ access_token: "MAT", refresh_token: "MRT", expires_in: 3600 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const cap = captureAuth();
    // Resolve onManualCodeInput → this cancels the callback wait and supplies a code.
    let resolveManual: ((v: string) => void) | undefined;
    const manual = new Promise<string>((res) => {
      resolveManual = res;
    });
    const callbacks: OAuthLoginCallbacks = {
      onAuth: cap.onAuth,
      onPrompt: async () => "",
      onManualCodeInput: () => manual,
    };
    const loginPromise = loginAnthropic(callbacks);
    await vi.waitFor(() => cap.authUrl());
    const state = cap.authUrl().searchParams.get("state");
    resolveManual?.(`http://localhost:53692/callback?code=pasted-code&state=${state}`);

    const creds = await loginPromise;
    expect(creds.access).toBe("MAT");
    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as Record<string, unknown>;
    expect(body.code).toBe("pasted-code");
  });

  it("rejects when the manual paste carries a mismatched state", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ access_token: "x", refresh_token: "y", expires_in: 3600 })),
    );
    const cap = captureAuth();
    let resolveManual: ((v: string) => void) | undefined;
    const manual = new Promise<string>((res) => {
      resolveManual = res;
    });
    const loginPromise = loginAnthropic({
      onAuth: cap.onAuth,
      onPrompt: async () => "",
      onManualCodeInput: () => manual,
    });
    await vi.waitFor(() => cap.authUrl());
    resolveManual?.("code=pasted&state=DEFINITELY-WRONG");
    await expect(loginPromise).rejects.toThrow(/state mismatch/i);
  });

  it("uses onPrompt as the last resort when the callback is cancelled and manual input is empty", async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) =>
      jsonResponse({ access_token: "PAT", refresh_token: "PRT", expires_in: 3600 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const cap = captureAuth();
    // onManualCodeInput resolves to "" → cb.cancelWait() fires (waitForCode → null),
    // then `if (input)` is false → code stays undefined → flow reaches onPrompt.
    let resolveManual: ((v: string) => void) | undefined;
    const manual = new Promise<string>((res) => {
      resolveManual = res;
    });
    const onPrompt = vi.fn(async (_p: OAuthPrompt) => {
      const state = cap.authUrl().searchParams.get("state");
      return `http://localhost:53692/callback?code=prompt-code&state=${state}`;
    });
    const loginPromise = loginAnthropic({
      onAuth: cap.onAuth,
      onPrompt,
      onManualCodeInput: () => manual,
    });
    await vi.waitFor(() => cap.authUrl());
    resolveManual?.(""); // empty manual input → not used, callback cancelled

    const creds = await loginPromise;
    expect(creds.access).toBe("PAT");
    expect(onPrompt).toHaveBeenCalledOnce();
    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as Record<string, unknown>;
    expect(body.code).toBe("prompt-code");
  });
});
