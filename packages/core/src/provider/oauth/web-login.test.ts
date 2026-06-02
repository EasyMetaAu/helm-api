import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type AnthropicLoginStart,
  beginAnthropicLogin,
  completeAnthropicLogin,
} from "./anthropic.js";
import { beginCopilotDeviceLogin, pollCopilotDeviceOnce } from "./github-copilot.js";
import { beginOpenAICodexLogin, completeOpenAICodexLogin } from "./openai-codex.js";

// Build a fake Codex access-token JWT carrying a chatgpt_account_id claim.
function fakeCodexJwt(accountId: string): string {
  const seg = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${seg({ alg: "none" })}.${seg({
    "https://api.openai.com/auth": { chatgpt_account_id: accountId },
  })}.sig`;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

afterEach(() => vi.unstubAllGlobals());

describe("Anthropic web login (begin/complete)", () => {
  it("begin returns an authorize URL carrying the PKCE challenge + state", () => {
    const start: AnthropicLoginStart = beginAnthropicLogin();
    const url = new URL(start.authorizeUrl);
    expect(url.origin + url.pathname).toBe("https://claude.ai/oauth/authorize");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("state")).toBe(start.state);
    expect(url.searchParams.get("code_challenge")).toBeTruthy();
    expect(start.verifier).toBeTruthy();
  });

  it("complete exchanges a pasted redirect URL for credentials", async () => {
    const start = beginAnthropicLogin();
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(body.grant_type).toBe("authorization_code");
      expect(body.code).toBe("the-code");
      expect(body.code_verifier).toBe(start.verifier);
      return jsonResponse({ access_token: "at", refresh_token: "rt", expires_in: 3600 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const creds = await completeAnthropicLogin({
      redirectInput: `http://localhost:53692/callback?code=the-code&state=${start.state}`,
      verifier: start.verifier,
      state: start.state,
    });
    expect(creds.access).toBe("at");
    expect(creds.refresh).toBe("rt");
  });

  it("complete rejects a state mismatch (CSRF guard)", async () => {
    const start = beginAnthropicLogin();
    await expect(
      completeAnthropicLogin({
        redirectInput: "code=x&state=WRONG",
        verifier: start.verifier,
        state: start.state,
      }),
    ).rejects.toThrow(/state mismatch/i);
  });

  it("complete rejects input with no code", async () => {
    const start = beginAnthropicLogin();
    await expect(
      completeAnthropicLogin({
        redirectInput: "   ",
        verifier: start.verifier,
        state: start.state,
      }),
    ).rejects.toThrow(/Missing authorization code/);
  });
});

describe("Copilot device login (begin/poll-once)", () => {
  it("begin starts the device flow and returns the user code", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({
          device_code: "dev-1",
          user_code: "ABCD-1234",
          verification_uri: "https://github.com/login/device",
          interval: 5,
          expires_in: 900,
        }),
      ),
    );
    const start = await beginCopilotDeviceLogin();
    expect(start.userCode).toBe("ABCD-1234");
    expect(start.deviceCode).toBe("dev-1");
    expect(start.domain).toBe("github.com");
  });

  it("poll-once maps pending / slow_down / done", async () => {
    const responses = [
      { error: "authorization_pending" },
      { error: "slow_down" },
      { access_token: "gho_token" },
    ];
    let i = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(responses[i++])),
    );
    expect(await pollCopilotDeviceOnce({ domain: "github.com", deviceCode: "d" })).toEqual({
      status: "pending",
    });
    expect(await pollCopilotDeviceOnce({ domain: "github.com", deviceCode: "d" })).toEqual({
      status: "slow_down",
    });
    expect(await pollCopilotDeviceOnce({ domain: "github.com", deviceCode: "d" })).toEqual({
      status: "done",
      githubToken: "gho_token",
    });
  });

  it("rejects an invalid enterprise domain", async () => {
    await expect(beginCopilotDeviceLogin("http://")).rejects.toThrow(/Invalid GitHub Enterprise/);
  });
});

describe("ChatGPT Codex web login (begin/complete)", () => {
  it("begin returns the OpenAI authorize URL with Codex flow params + PKCE", () => {
    const start = beginOpenAICodexLogin();
    const url = new URL(start.authorizeUrl);
    expect(url.origin + url.pathname).toBe("https://auth.openai.com/oauth/authorize");
    expect(url.searchParams.get("client_id")).toBe("app_EMoamEEZ73f0CkXaXp7hrann");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("codex_cli_simplified_flow")).toBe("true");
    expect(url.searchParams.get("scope")).toContain("offline_access");
    expect(url.searchParams.get("state")).toBe(start.state);
  });

  it("complete posts a FORM-encoded auth_code exchange and extracts accountId from the JWT", async () => {
    const start = beginOpenAICodexLogin();
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      // OpenAI token endpoint is form-encoded, NOT JSON.
      expect(new Headers(init?.headers).get("Content-Type")).toBe(
        "application/x-www-form-urlencoded",
      );
      const body = new URLSearchParams(String(init?.body));
      expect(body.get("grant_type")).toBe("authorization_code");
      expect(body.get("code")).toBe("the-code");
      expect(body.get("code_verifier")).toBe(start.verifier);
      expect(body.get("client_secret")).toBeNull(); // public client
      return jsonResponse({
        access_token: fakeCodexJwt("acc_123"),
        refresh_token: "rt",
        expires_in: 3600,
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const creds = await completeOpenAICodexLogin({
      redirectInput: `http://localhost:1455/auth/callback?code=the-code&state=${start.state}`,
      verifier: start.verifier,
      state: start.state,
    });
    expect(creds.refresh).toBe("rt");
    expect((creds as { accountId?: string }).accountId).toBe("acc_123");
  });

  it("complete rejects a state mismatch", async () => {
    const start = beginOpenAICodexLogin();
    await expect(
      completeOpenAICodexLogin({
        redirectInput: "code=x&state=WRONG",
        verifier: start.verifier,
        state: start.state,
      }),
    ).rejects.toThrow(/state mismatch/i);
  });
});
