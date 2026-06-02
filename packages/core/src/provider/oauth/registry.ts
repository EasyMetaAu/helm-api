// Built-in OAuth subscription-provider registry (issue #38). The server wiring +
// admin login surface look providers up by id here.
//
// SCOPE: anthropic (Claude Pro/Max), github-copilot, and openai-codex (ChatGPT
// Plus/Pro). NOTE: a provider's interactive LOGIN ships for all three; routing
// REQUESTS through Codex (OpenAI Responses API) and Copilot (proxy-ep base + editor
// headers) are documented execute-time follow-ups (see implementation-notes).

import { anthropicOAuthProvider } from "./anthropic.js";
import { githubCopilotOAuthProvider } from "./github-copilot.js";
import { openaiCodexOAuthProvider } from "./openai-codex.js";
import type { OAuthProviderId, OAuthProviderInterface } from "./types.js";

const BUILT_IN: readonly OAuthProviderInterface[] = [
  anthropicOAuthProvider,
  githubCopilotOAuthProvider,
  openaiCodexOAuthProvider,
];

const registry = new Map<string, OAuthProviderInterface>(BUILT_IN.map((p) => [p.id, p]));

export function getOAuthProvider(id: OAuthProviderId): OAuthProviderInterface | undefined {
  return registry.get(id);
}

export function getOAuthProviders(): OAuthProviderInterface[] {
  return [...registry.values()];
}

export function listOAuthProviderIds(): string[] {
  return [...registry.keys()];
}
