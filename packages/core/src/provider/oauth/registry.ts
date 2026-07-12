// Built-in OAuth subscription-provider registry (issue #38). The server wiring +
// admin login surface look providers up by id here.
//
// SCOPE: anthropic (Claude Pro/Max), github-copilot, openai-codex (ChatGPT
// Plus/Pro), and xai (SuperGrok/X Premium). Each provider is registered by
// default; provider-specific login and execution behavior live behind this
// common interface.

import { anthropicOAuthProvider } from "./anthropic.js";
import { githubCopilotOAuthProvider } from "./github-copilot.js";
import { openaiCodexOAuthProvider } from "./openai-codex.js";
import type { OAuthProviderId, OAuthProviderInterface } from "./types.js";
import { xaiOAuthProvider } from "./xai.js";

const BUILT_IN: readonly OAuthProviderInterface[] = [
  anthropicOAuthProvider,
  githubCopilotOAuthProvider,
  openaiCodexOAuthProvider,
  xaiOAuthProvider,
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
