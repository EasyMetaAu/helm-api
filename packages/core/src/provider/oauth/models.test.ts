import { afterEach, describe, expect, it, vi } from "vitest";
import { CURATED_OAUTH_MODELS, discoverOAuthModels, hasLiveModelDiscovery } from "./models.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

afterEach(() => vi.unstubAllGlobals());

describe("discoverOAuthModels", () => {
  it("returns the curated list for anthropic (no token) / codex", async () => {
    expect(await discoverOAuthModels("anthropic", undefined)).toEqual(
      CURATED_OAUTH_MODELS.anthropic,
    );
    expect(await discoverOAuthModels("openai-codex", undefined)).toEqual(
      CURATED_OAUTH_MODELS["openai-codex"],
    );
  });

  it("keeps the Codex curated fallback on currently verified subscription models", () => {
    expect(CURATED_OAUTH_MODELS["openai-codex"]).toEqual([
      "gpt-5.6-sol",
      "gpt-5.6-terra",
      "gpt-5.6-luna",
      "gpt-5.5",
      "gpt-5.4",
      "gpt-5.4-mini",
    ]);
  });

  it("discovers Anthropic models LIVE from /v1/models when a token is present", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        expect(url).toContain("api.anthropic.com/v1/models");
        expect(new Headers(init?.headers).get("anthropic-beta")).toContain("oauth-2025-04-20");
        return jsonResponse({
          data: [{ id: "claude-opus-4-8" }, { id: "claude-sonnet-4-6" }],
        });
      }),
    );
    expect(await discoverOAuthModels("anthropic", "at")).toEqual([
      "claude-opus-4-8",
      "claude-sonnet-4-6",
    ]);
  });

  it("falls back to curated Anthropic models when /v1/models rejects the token", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ error: "unauthorized" }, 401)),
    );
    expect(await discoverOAuthModels("anthropic", "bad")).toEqual(CURATED_OAUTH_MODELS.anthropic);
  });

  it("returns [] for an unknown provider", async () => {
    expect(await discoverOAuthModels("mystery", undefined)).toEqual([]);
  });

  it("discovers Copilot chat models live from /models (filtered + sorted)", async () => {
    const token = "tid=x;proxy-ep=proxy.indiv.githubcopilot.com;";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        expect(url).toBe("https://api.indiv.githubcopilot.com/models");
        return jsonResponse({
          data: [
            { id: "gpt-4o", object: "model", capabilities: { type: "chat" } },
            { id: "o1", object: "model", capabilities: { type: "chat" } },
            { id: "text-embedding-3", object: "model", capabilities: { type: "embeddings" } }, // dropped
            { id: "accounts/foo", object: "model" }, // router entry dropped
          ],
        });
      }),
    );
    expect(await discoverOAuthModels("github-copilot", token)).toEqual(["gpt-4o", "o1"]);
  });

  it("Copilot discovery fails open to [] on error (never throws)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ error: "nope" }, 500)),
    );
    expect(await discoverOAuthModels("github-copilot", "tok;proxy-ep=proxy.x.com;")).toEqual([]);
  });

  it("Copilot with no token yields [] (can't discover)", async () => {
    expect(await discoverOAuthModels("github-copilot", undefined)).toEqual([]);
  });
});

describe("hasLiveModelDiscovery", () => {
  it("is true for providers with a live list-models API, false otherwise", () => {
    expect(hasLiveModelDiscovery("anthropic")).toBe(true);
    expect(hasLiveModelDiscovery("github-copilot")).toBe(true);
    expect(hasLiveModelDiscovery("openai-codex")).toBe(false); // curated-only
    expect(hasLiveModelDiscovery("mystery")).toBe(false);
  });
});
