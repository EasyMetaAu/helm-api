// Model discovery for OAuth subscription providers (issue #38). Answers "which
// models can this bound subscription use?" so they become routable aliases +
// show up in the Lanes picker.
//
// Strategy (maintainer decision): discover live where an API exists, else fall
// back to a curated list. GitHub Copilot exposes GET /models, so it is queried
// live. Anthropic (Claude Pro/Max) and ChatGPT Codex have no convenient
// list-my-subscription-models endpoint, so a curated set is used — OVERRIDABLE by
// declaring the provider with its own models[] in providers.yaml (that wins).

import { listGitHubCopilotModels } from "./github-copilot.js";

// Curated fallback model ids per provider. Kept deliberately small + current;
// operators override via an explicit providers.yaml entry when needed.
export const CURATED_OAUTH_MODELS: Record<string, string[]> = {
  anthropic: ["claude-opus-4-6", "claude-sonnet-4-6", "claude-haiku-4-5"],
  "openai-codex": ["gpt-5-codex"],
};

// Resolve the routable model ids for a bound provider. `accessToken` is required
// only for live discovery (Copilot); curated providers ignore it. Never throws —
// a discovery failure yields [] so the composition root can fail-open (skip).
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
  return CURATED_OAUTH_MODELS[providerId] ?? [];
}
