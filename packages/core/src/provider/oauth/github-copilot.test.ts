import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getGitHubCopilotBaseUrl,
  githubCopilotOAuthProvider,
  loginGitHubCopilot,
  normalizeDomain,
  refreshGitHubCopilotToken,
} from "./github-copilot.js";
import type { OAuthAuthInfo, OAuthLoginCallbacks } from "./types.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("normalizeDomain", () => {
  it("extracts the hostname from bare domains and full URLs", () => {
    expect(normalizeDomain("company.ghe.com")).toBe("company.ghe.com");
    expect(normalizeDomain("https://company.ghe.com/path")).toBe("company.ghe.com");
  });
  it("returns null for blank or unparseable input", () => {
    expect(normalizeDomain("   ")).toBeNull();
    expect(normalizeDomain("http://")).toBeNull();
  });
});

describe("getGitHubCopilotBaseUrl proxy-ep parsing", () => {
  it("leaves a proxy host that lacks the 'proxy.' prefix unchanged (api. only when prefixed)", () => {
    // proxy-ep without the leading "proxy." → replace is a no-op → host kept verbatim.
    expect(getGitHubCopilotBaseUrl("x;proxy-ep=edge.githubcopilot.com;y")).toBe(
      "https://edge.githubcopilot.com",
    );
  });
  it("falls back to the individual base when the token has no proxy-ep", () => {
    expect(getGitHubCopilotBaseUrl("no-proxy-ep-here")).toBe(
      "https://api.individual.githubcopilot.com",
    );
  });
});

describe("fetchJson error path (non-ok)", () => {
  it("throws a scrubbed HTTP error and swallows the body when refresh fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ error: "bad", leak: "secret" }, 403)),
    );
    await expect(refreshGitHubCopilotToken("gh")).rejects.toThrow(/GitHub Copilot HTTP 403/);
    await expect(refreshGitHubCopilotToken("gh")).rejects.not.toThrow(/secret/);
  });
});

describe("refreshGitHubCopilotToken validation", () => {
  it("rejects a Copilot token response missing token/expires_at", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ token: "tk" })), // no expires_at
    );
    await expect(refreshGitHubCopilotToken("gh")).rejects.toThrow(/Invalid Copilot token response/);
  });

  it("threads an enterprise domain into the copilot token URL + stored enterpriseUrl", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      expect(url).toBe("https://api.ghe.acme.com/copilot_internal/v2/token");
      return jsonResponse({
        token: "tid=x;proxy-ep=proxy.acme.com;",
        expires_at: Math.floor(Date.now() / 1000) + 3600,
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const creds = await refreshGitHubCopilotToken("gh", "ghe.acme.com");
    expect((creds as { enterpriseUrl?: string }).enterpriseUrl).toBe("ghe.acme.com");
  });
});

describe("provider.refreshToken", () => {
  it("re-mints the Copilot token from creds.refresh + creds.enterpriseUrl", async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toContain("api.corp.example.com/copilot_internal/v2/token");
      expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer ghtok");
      return jsonResponse({
        token: "tid=y;proxy-ep=proxy.corp.example.com;",
        expires_at: Math.floor(Date.now() / 1000) + 3600,
      });
    });
    const creds = await githubCopilotOAuthProvider.refreshToken(
      { refresh: "ghtok", access: "old", expires: 0, enterpriseUrl: "corp.example.com" },
      fetchMock as unknown as typeof globalThis.fetch,
    );
    expect(creds.access).toContain("proxy-ep=");
    expect(githubCopilotOAuthProvider.getApiKey(creds)).toBe(creds.access);
    expect(githubCopilotOAuthProvider.usesCallbackServer).toBe(false);
  });
});

describe("startDeviceFlow validation (via loginGitHubCopilot)", () => {
  it("throws when the device-code response is missing required fields", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ device_code: "d" })), // missing user_code/uri/expires
    );
    const callbacks: OAuthLoginCallbacks = {
      onAuth: () => {},
      onPrompt: async () => "", // blank → github.com
    };
    await expect(loginGitHubCopilot(callbacks)).rejects.toThrow(/Invalid device code response/);
  });

  it("rejects an invalid enterprise URL entered at the prompt", async () => {
    const callbacks: OAuthLoginCallbacks = {
      onAuth: () => {},
      onPrompt: async () => "http://", // non-empty but unparseable
    };
    await expect(loginGitHubCopilot(callbacks)).rejects.toThrow(/Invalid GitHub Enterprise/);
  });

  it("aborts after the prompt when the signal is already set", async () => {
    const c = new AbortController();
    c.abort();
    const callbacks: OAuthLoginCallbacks = {
      onAuth: () => {},
      onPrompt: async () => "",
      signal: c.signal,
    };
    await expect(loginGitHubCopilot(callbacks)).rejects.toThrow(/Login cancelled/);
  });
});

describe("loginGitHubCopilot — full device flow with polling", () => {
  it("starts the device flow, shows the user code, polls pending→slow_down→token, then mints Copilot", async () => {
    vi.useFakeTimers();
    const now = Date.now();
    const deviceBody = {
      device_code: "DEV",
      user_code: "WXYZ-7788",
      verification_uri: "https://github.com/login/device",
      interval: 1, // 1s → clamped to 1000ms min
      expires_in: 900,
    };
    const responses: Array<{ body: unknown }> = [
      { body: deviceBody }, // startDeviceFlow
      { body: { error: "authorization_pending" } }, // poll 1
      { body: { error: "slow_down" } }, // poll 2
      { body: { access_token: "gho_live" } }, // poll 3 → done
      {
        body: {
          token: "tid=z;proxy-ep=proxy.individual.githubcopilot.com;",
          expires_at: Math.floor(now / 1000) + 3600,
        },
      }, // refreshGitHubCopilotToken
    ];
    let i = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(responses[i++]?.body)),
    );

    const auths: OAuthAuthInfo[] = [];
    const progress: string[] = [];
    const callbacks: OAuthLoginCallbacks = {
      onAuth: (info) => auths.push(info),
      onPrompt: async () => "", // github.com
      onProgress: (m) => progress.push(m),
    };

    const loginPromise = loginGitHubCopilot(callbacks);
    // Drive the abortableSleep timers in the poll loop.
    await vi.advanceTimersByTimeAsync(1000); // poll 1 (pending)
    await vi.advanceTimersByTimeAsync(1000); // poll 2 (slow_down → +5000 backoff)
    await vi.advanceTimersByTimeAsync(6000); // poll 3 (done)
    const creds = await loginPromise;

    expect(auths[0]?.instructions).toContain("WXYZ-7788");
    expect(auths[0]?.url).toBe("https://github.com/login/device");
    expect(progress.some((p) => /Exchanging GitHub token/.test(p))).toBe(true);
    expect(creds.access).toContain("proxy-ep=");
    expect(creds.refresh).toBe("gho_live");
  });

  it("throws 'Device flow failed' when the access-token poll returns an OAuth error", async () => {
    vi.useFakeTimers();
    const deviceBody = {
      device_code: "DEV",
      user_code: "AAAA-0000",
      verification_uri: "https://github.com/login/device",
      interval: 1,
      expires_in: 900,
    };
    const responses: Array<unknown> = [deviceBody, { error: "access_denied" }];
    let i = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(responses[i++])),
    );
    const loginPromise = loginGitHubCopilot({ onAuth: () => {}, onPrompt: async () => "" });
    const assertion = expect(loginPromise).rejects.toThrow(/Device flow failed: access_denied/);
    await vi.advanceTimersByTimeAsync(1000);
    await assertion;
  });

  it("times out the poll loop once the deadline passes with no token", async () => {
    vi.useFakeTimers();
    const deviceBody = {
      device_code: "DEV",
      user_code: "BBBB-1111",
      verification_uri: "https://github.com/login/device",
      interval: 1,
      expires_in: 2, // 2s deadline → loop exits quickly
    };
    let i = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(i++ === 0 ? deviceBody : { error: "authorization_pending" })),
    );
    const loginPromise = loginGitHubCopilot({ onAuth: () => {}, onPrompt: async () => "" });
    const assertion = expect(loginPromise).rejects.toThrow(/Device flow timed out/);
    await vi.advanceTimersByTimeAsync(5000);
    await assertion;
  });

  it("cancels the poll loop when the abort signal fires before the first sleep", async () => {
    vi.useFakeTimers();
    const c = new AbortController();
    const deviceBody = {
      device_code: "DEV",
      user_code: "CCCC-2222",
      verification_uri: "https://github.com/login/device",
      interval: 1,
      expires_in: 900,
    };
    let i = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(i++ === 0 ? deviceBody : { error: "authorization_pending" })),
    );
    const loginPromise = loginGitHubCopilot({
      onAuth: () => {},
      onPrompt: async () => "",
      signal: c.signal,
    });
    const assertion = expect(loginPromise).rejects.toThrow(/Login cancelled/);
    c.abort(); // abort before the loop reaches abortableSleep
    await assertion;
  });

  it("cancels via abortableSleep's listener when abort fires WHILE sleeping", async () => {
    vi.useFakeTimers();
    const c = new AbortController();
    const deviceBody = {
      device_code: "DEV",
      user_code: "DDDD-3333",
      verification_uri: "https://github.com/login/device",
      interval: 1,
      expires_in: 900,
    };
    let i = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(i++ === 0 ? deviceBody : { error: "authorization_pending" })),
    );
    const loginPromise = loginGitHubCopilot({
      onAuth: () => {},
      onPrompt: async () => "",
      signal: c.signal,
    });
    const assertion = expect(loginPromise).rejects.toThrow(/Login cancelled/);
    // Drain microtasks (startDeviceFlow + the loop's top check) WITHOUT firing the
    // 1000ms sleep timer, so the FIRST abortableSleep timer is pending when we abort
    // → exercises the abort listener (clearTimeout + reject), not the early guard.
    await vi.advanceTimersByTimeAsync(0);
    c.abort();
    await assertion;
  });

  it("threads the abort signal into fetchJson (signal-present branch) on a successful flow", async () => {
    vi.useFakeTimers();
    const c = new AbortController(); // never aborted
    const now = Date.now();
    const responses: Array<unknown> = [
      {
        device_code: "DEV",
        user_code: "EEEE-4444",
        verification_uri: "https://github.com/login/device",
        interval: 1,
        expires_in: 900,
      },
      { access_token: "gho_ok" }, // first poll → done
      {
        token: "tid=q;proxy-ep=proxy.individual.githubcopilot.com;",
        expires_at: Math.floor(now / 1000) + 3600,
      },
    ];
    let i = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(responses[i++])),
    );
    const loginPromise = loginGitHubCopilot({
      onAuth: () => {},
      onPrompt: async () => "",
      signal: c.signal,
    });
    await vi.advanceTimersByTimeAsync(1000); // first poll resolves with the token
    const creds = await loginPromise;
    expect(creds.refresh).toBe("gho_ok");
  });
});
