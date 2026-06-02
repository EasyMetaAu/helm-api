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

// Curated FALLBACK model ids — used when live discovery is unavailable or fails.
// anthropic is normally live (GET /v1/models); these are only its safety net.
// openai-codex has NO list-models endpoint (the ChatGPT Codex backend doesn't
// expose one — confirmed against openclaw, whose Codex catalog is literally
// `models: []`, and claude-relay-service, which only tracks usage). So Codex is
// ALWAYS this curated set — the known Codex subscription models. Operators can
// override via an explicit providers.yaml entry.
export const CURATED_OAUTH_MODELS: Record<string, string[]> = {
  anthropic: ["claude-opus-4-6", "claude-sonnet-4-6", "claude-haiku-4-5"],
  // ChatGPT / Codex set, mirrored from claude-relay-service config/models.js (its
  // OpenAI account model list) — the closest authoritative source since there is
  // no list-models API for the Codex OAuth.
  "openai-codex": [
    "gpt-5",
    "gpt-5-mini",
    "gpt-5-nano",
    "gpt-5-codex",
    "gpt-5.1",
    "gpt-5.1-codex",
    "gpt-5.1-codex-max",
    "gpt-5.1-codex-mini",
    "gpt-5.2",
    "gpt-5.2-codex",
    "gpt-5.3-codex",
    "gpt-5.3-codex-spark",
    "gpt-5.4",
    "gpt-5.4-pro",
    "gpt-5.5",
    "gpt-5.5-pro",
    "codex-mini",
  ],
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
