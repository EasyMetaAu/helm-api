// Model discovery for OAuth subscription providers (issue #38). Answers "which
// models can this bound subscription use?" so they become routable aliases +
// show up in the Lanes picker.
//
// Strategy (maintainer decision): discover live where an API exists, else fall
// back to a curated list. GitHub Copilot exposes GET /models and Anthropic exposes
// GET /v1/models — both are queried LIVE with the account's token. ChatGPT Codex
// has no convenient list endpoint (and its execution isn't wired), so it uses a
// curated set. Any list is OVERRIDABLE by declaring the provider with its own
// models[] in providers.yaml (that wins).

import { listGitHubCopilotModels } from "./github-copilot.js";

// Curated FALLBACK model ids — used only when live discovery is unavailable or
// fails (e.g. the endpoint rejects the OAuth token). Operators can also override
// via an explicit providers.yaml entry.
export const CURATED_OAUTH_MODELS: Record<string, string[]> = {
  anthropic: ["claude-opus-4-6", "claude-sonnet-4-6", "claude-haiku-4-5"],
  "openai-codex": ["gpt-5-codex"],
};

// Live-list Anthropic (Claude Pro/Max) models via GET /v1/models with the OAuth
// subscription identity (same Claude-Code headers the executor uses). Throws on a
// non-2xx / bad shape so the caller can fall back to the curated set.
export async function listAnthropicModels(accessToken: string): Promise<string[]> {
  const res = await fetch("https://api.anthropic.com/v1/models?limit=1000", {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "anthropic-version": "2023-06-01",
      "anthropic-beta": "claude-code-20250219,oauth-2025-04-20",
      "user-agent": "claude-cli/1.0.0",
      "x-app": "cli",
    },
  });
  if (!res.ok) throw new Error(`anthropic /v1/models HTTP ${res.status}`);
  const body = (await res.json()) as { data?: Array<{ id?: unknown }> };
  const ids = (body.data ?? [])
    .map((m) => (typeof m.id === "string" ? m.id.trim() : ""))
    .filter((id) => id.length > 0);
  return [...new Set(ids)].sort();
}

// Resolve the routable model ids for a bound provider. `accessToken` drives live
// discovery (Copilot + Anthropic). Never throws — a discovery failure falls back
// to the curated list (or [] when none), so the composition root stays fail-open.
export async function discoverOAuthModels(
  providerId: string,
  accessToken: string | undefined,
): Promise<string[]> {
  if (providerId === "github-copilot") {
    if (!accessToken) return [];
    try {
      return await listGitHubCopilotModels(accessToken);
    } catch {
      return [];
    }
  }
  if (providerId === "anthropic") {
    if (accessToken) {
      try {
        const live = await listAnthropicModels(accessToken);
        if (live.length > 0) return live;
      } catch {
        // fall through to curated
      }
    }
    return CURATED_OAUTH_MODELS.anthropic ?? [];
  }
  return CURATED_OAUTH_MODELS[providerId] ?? [];
}
