import { afterEach, describe, expect, it, vi } from "vitest";
import { CURATED_OAUTH_MODELS, discoverOAuthModels } from "./models.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

afterEach(() => vi.unstubAllGlobals());

describe("discoverOAuthModels", () => {
  it("returns the curated list for anthropic / codex (no network)", async () => {
    expect(await discoverOAuthModels("anthropic", undefined)).toEqual(
      CURATED_OAUTH_MODELS.anthropic,
    );
    expect(await discoverOAuthModels("openai-codex", undefined)).toEqual(
      CURATED_OAUTH_MODELS["openai-codex"],
    );
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
