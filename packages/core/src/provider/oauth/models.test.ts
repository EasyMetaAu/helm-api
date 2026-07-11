import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CURATED_OAUTH_MODELS,
  DEFAULT_OPENAI_CODEX_CLIENT_VERSION,
  discoverOAuthModels,
  expandOpenAICodexModelAliases,
  hasLiveModelDiscovery,
  listOpenAICodexModels,
  OpenAICodexModelsError,
  resolveOpenAICodexClientVersion,
} from "./models.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function codexJwt(payload: Record<string, unknown>): string {
  const seg = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${seg({ alg: "none" })}.${seg(payload)}.sig`;
}

function codexModel(
  slug: string,
  priority: number,
  visibility: "list" | "hide" | "none" = "list",
): Record<string, unknown> {
  return {
    slug,
    display_name: slug,
    description: null,
    default_reasoning_level: "medium",
    supported_reasoning_levels: [{ effort: "medium", description: "Balanced" }],
    shell_type: "shell_command",
    visibility,
    supported_in_api: true,
    priority,
    availability_nux: null,
    upgrade: null,
    base_instructions: "You are Codex.",
    model_messages: null,
    supports_reasoning_summaries: false,
    default_reasoning_summary: "none",
    support_verbosity: false,
    default_verbosity: null,
    apply_patch_tool_type: null,
    truncation_policy: { mode: "tokens", limit: 10_000 },
    supports_parallel_tool_calls: false,
    context_window: 372_000,
    experimental_supported_tools: [],
    use_responses_lite: true,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("discoverOAuthModels", () => {
  it("returns the curated list for anthropic but no Codex entitlement without a token", async () => {
    expect(await discoverOAuthModels("anthropic", undefined)).toEqual(
      CURATED_OAUTH_MODELS.anthropic,
    );
    expect(await discoverOAuthModels("openai-codex", undefined)).toEqual([]);
  });

  it("keeps the Codex curated fallback on currently verified subscription models", () => {
    expect(CURATED_OAUTH_MODELS["openai-codex"]).toEqual([
      "gpt-5.6",
      "gpt-5.6-sol",
      "gpt-5.6-terra",
      "gpt-5.6-luna",
      "gpt-5.5",
      "gpt-5.4",
      "gpt-5.4-mini",
    ]);
  });

  it("derives the public GPT-5.6 family alias only when Sol is entitled", () => {
    expect(expandOpenAICodexModelAliases(["gpt-5.6-terra"])).toEqual(["gpt-5.6-terra"]);
    expect(expandOpenAICodexModelAliases(["gpt-5.6-sol", "gpt-5.6-terra"])).toEqual([
      "gpt-5.6-sol",
      "gpt-5.6-terra",
      "gpt-5.6",
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

  it("can preserve exact account discovery without curated fallback", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ error: "unavailable" }, 503)),
    );
    expect(
      await discoverOAuthModels("anthropic", "bad", fetch, {
        fallbackToCurated: false,
      }),
    ).toEqual([]);
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

  it("discovers visible Codex models live in provider priority order", async () => {
    const token = codexJwt({
      "https://api.openai.com/auth": {
        chatgpt_account_id: "acc_from_access",
        chatgpt_account_is_fedramp: false,
      },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({
          models: [
            codexModel("gpt-hidden", 0, "hide"),
            codexModel("gpt-5.6-terra", 2),
            codexModel("gpt-5.6-sol", 1),
          ],
        }),
      ),
    );

    expect(await discoverOAuthModels("openai-codex", token)).toEqual([
      "gpt-5.6-sol",
      "gpt-5.6-terra",
    ]);
  });

  it("does not grant curated Codex models when account discovery fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ error: "unavailable" }, 503)),
    );

    expect(await discoverOAuthModels("openai-codex", "token")).toEqual([]);
  });
});

describe("hasLiveModelDiscovery", () => {
  it("is true for providers with a live list-models API, false otherwise", () => {
    expect(hasLiveModelDiscovery("anthropic")).toBe(true);
    expect(hasLiveModelDiscovery("github-copilot")).toBe(true);
    expect(hasLiveModelDiscovery("openai-codex")).toBe(true);
    expect(hasLiveModelDiscovery("mystery")).toBe(false);
  });
});

describe("listOpenAICodexModels", () => {
  it("uses the current Codex whole client version and permits an environment override", () => {
    expect(DEFAULT_OPENAI_CODEX_CLIENT_VERSION).toBe("0.145.0");
    expect(resolveOpenAICodexClientVersion({})).toBe("0.145.0");
    expect(
      resolveOpenAICodexClientVersion({
        HELM_OPENAI_CODEX_CLIENT_VERSION: "0.146.2",
      }),
    ).toBe("0.146.2");
    expect(() =>
      resolveOpenAICodexClientVersion({
        HELM_OPENAI_CODEX_CLIENT_VERSION: "latest",
      }),
    ).toThrow(/semantic version/i);
  });

  it("sends the Codex identity headers, semantic client version, and returns models + ETag", async () => {
    vi.stubEnv("TERM_PROGRAM", "Apple_Terminal");
    vi.stubEnv("TERM_PROGRAM_VERSION", "455");
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe(
        `https://chatgpt.com/backend-api/codex/models?client_version=${DEFAULT_OPENAI_CODEX_CLIENT_VERSION}`,
      );
      const headers = new Headers(init?.headers);
      expect(headers.get("authorization")).toBe("Bearer access-token");
      expect(headers.get("chatgpt-account-id")).toBe("acc_9");
      expect(headers.get("originator")).toBe("codex_cli_rs");
      expect(headers.get("version")).toBe(DEFAULT_OPENAI_CODEX_CLIENT_VERSION);
      expect(headers.get("user-agent")).toMatch(
        new RegExp(
          `^codex_cli_rs/${DEFAULT_OPENAI_CODEX_CLIENT_VERSION.replaceAll(".", "\\.")} \\(.+ .+; .+\\) Apple_Terminal/455$`,
        ),
      );
      expect(headers.get("user-agent")).not.toContain("node/");
      expect(headers.get("x-openai-fedramp")).toBe("true");
      return new Response(JSON.stringify({ models: [codexModel("gpt-5.6-sol", 1)] }), {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          ETag: '"models-v2"',
          "x-reasoning-included": "true",
        },
      });
    });

    const result = await listOpenAICodexModels("access-token", {
      accountId: "acc_9",
      isFedramp: true,
      fetchImpl: fetchMock as unknown as typeof globalThis.fetch,
    });

    expect(result.etag).toBe('"models-v2"');
    expect(result.reasoningIncluded).toBe(true);
    expect(result.models[0]?.slug).toBe("gpt-5.6-sol");
  });

  it("derives account and FedRAMP identity from JWT claims when options omit them", async () => {
    const accessToken = codexJwt({
      "https://api.openai.com/auth": {
        chatgpt_account_id: "acc_claim",
        chatgpt_account_is_fedramp: true,
      },
    });
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      expect(headers.get("chatgpt-account-id")).toBe("acc_claim");
      expect(headers.get("x-openai-fedramp")).toBe("true");
      return jsonResponse({ models: [codexModel("gpt-5.6-luna", 3)] });
    });

    await listOpenAICodexModels(accessToken, {
      fetchImpl: fetchMock as unknown as typeof globalThis.fetch,
    });
  });

  it("rejects non-semver client versions before making a request", async () => {
    const fetchMock = vi.fn();

    await expect(
      listOpenAICodexModels("access-token", {
        clientVersion: "latest",
        fetchImpl: fetchMock as unknown as typeof globalThis.fetch,
      }),
    ).rejects.toThrow(/semantic version/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects malformed /models bodies instead of returning partial metadata", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ models: [{ slug: "broken" }] }));

    await expect(
      listOpenAICodexModels("access-token", {
        fetchImpl: fetchMock as unknown as typeof globalThis.fetch,
      }),
    ).rejects.toThrow(/invalid/i);
  });

  it("preserves the HTTP status for 401 refresh-and-retry handling", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ error: "unauthorized" }, 401));

    await expect(
      listOpenAICodexModels("expired-token", {
        fetchImpl: fetchMock as unknown as typeof globalThis.fetch,
      }),
    ).rejects.toMatchObject({
      name: "OpenAICodexModelsError",
      httpStatus: 401,
    });
    await expect(
      listOpenAICodexModels("expired-token", {
        fetchImpl: fetchMock as unknown as typeof globalThis.fetch,
      }),
    ).rejects.toBeInstanceOf(OpenAICodexModelsError);
  });
});
