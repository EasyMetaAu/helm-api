import { afterEach, describe, expect, it, vi } from "vitest";
import { refreshAnthropicToken } from "./anthropic.js";
import { getGitHubCopilotBaseUrl, refreshGitHubCopilotToken } from "./github-copilot.js";
import { getOAuthProvider, getOAuthProviders, listOAuthProviderIds } from "./registry.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("registry", () => {
  it("exposes the built-in subscription providers", () => {
    expect(listOAuthProviderIds().sort()).toEqual([
      "anthropic",
      "github-copilot",
      "openai-codex",
      "xai",
    ]);
    expect(getOAuthProvider("anthropic")?.name).toContain("Claude");
    expect(getOAuthProvider("openai-codex")?.name).toContain("ChatGPT");
    expect(getOAuthProvider("xai")?.name).toContain("Grok");
    expect(getOAuthProvider("unknown-provider")).toBeUndefined();
    expect(getOAuthProviders()).toHaveLength(4);
  });
});

describe("refreshAnthropicToken (public PKCE client)", () => {
  it("sends client_id + refresh_token but NO client_secret, and parses creds", async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(body.grant_type).toBe("refresh_token");
      expect(body.client_id).toBeTypeOf("string");
      expect(body.refresh_token).toBe("rtok-1");
      expect(body.client_secret).toBeUndefined();
      return jsonResponse({ access_token: "at-2", refresh_token: "rtok-2", expires_in: 3600 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const creds = await refreshAnthropicToken("rtok-1");
    expect(creds.access).toBe("at-2");
    expect(creds.refresh).toBe("rtok-2");
    expect(creds.expires).toBeGreaterThan(Date.now());
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("rejects a token response missing required fields", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ access_token: "at" })), // no refresh/expires
    );
    await expect(refreshAnthropicToken("rtok")).rejects.toThrow(/missing required fields/);
  });

  it("throws a scrubbed error on an HTTP failure (no body echo)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ error: "invalid_grant", secret: "leak" }, 400)),
    );
    await expect(refreshAnthropicToken("rtok")).rejects.toThrow(/HTTP 400/);
    await expect(refreshAnthropicToken("rtok")).rejects.not.toThrow(/leak/);
  });
});

describe("refreshGitHubCopilotToken (two-level token)", () => {
  it("mints a Copilot token from the GitHub token with editor headers", async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toContain("/copilot_internal/v2/token");
      const headers = new Headers(init?.headers);
      expect(headers.get("Authorization")).toBe("Bearer gh-token");
      expect(headers.get("Copilot-Integration-Id")).toBe("vscode-chat");
      return jsonResponse({
        token: "tid=x;proxy-ep=proxy.individual.githubcopilot.com;",
        expires_at: Math.floor(Date.now() / 1000) + 3600,
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const creds = await refreshGitHubCopilotToken("gh-token");
    expect(creds.access).toContain("proxy-ep=");
    expect(creds.refresh).toBe("gh-token");
    expect(getGitHubCopilotBaseUrl(creds.access)).toBe("https://api.individual.githubcopilot.com");
  });
});

describe("getGitHubCopilotBaseUrl", () => {
  it("derives api.* from the token proxy-ep, else falls back", () => {
    expect(getGitHubCopilotBaseUrl("a;proxy-ep=proxy.foo.com;b")).toBe("https://api.foo.com");
    expect(getGitHubCopilotBaseUrl(undefined, "ghe.acme.com")).toBe(
      "https://copilot-api.ghe.acme.com",
    );
    expect(getGitHubCopilotBaseUrl()).toBe("https://api.individual.githubcopilot.com");
  });
});
