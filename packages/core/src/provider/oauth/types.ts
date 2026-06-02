// OAuth subscription-provider contract (issue #38). Framework-agnostic
// (packages/core, principle 1).
//
// PORTED from openclaw (MIT, © 2026 OpenClaw Foundation):
// src/plugin-sdk/provider-oauth-runtime.ts + src/llm/utils/oauth/*. Adapted to
// Helm: openclaw's plugin-SDK / wizard / Model coupling is dropped; the kit is
// self-contained (no openclaw imports) and the credential store is Helm's
// OAuthTokenStore rather than openclaw's on-disk JSON.

// Already-resolved OAuth credentials (NOT env names). `access` is the short-lived
// bearer; `refresh` is the long-lived credential replayed to mint new access
// tokens; `expires` is the access-token expiry (ms epoch). Providers may attach
// extra fields (e.g. copilot `enterpriseUrl`) via the index signature.
export interface OAuthCredentials {
  refresh: string;
  access: string;
  expires: number;
  [key: string]: unknown;
}

export type OAuthProviderId = string;

export interface OAuthPrompt {
  message: string;
  placeholder?: string;
  allowEmpty?: boolean;
}

export interface OAuthAuthInfo {
  url: string;
  instructions?: string;
}

export interface OAuthAuthorizationInput {
  code?: string;
  state?: string;
}

// Callbacks the login driver (the CLI) supplies so the provider flow stays UI
// agnostic: show a URL, prompt for input, report progress, and abort on SIGINT.
export interface OAuthLoginCallbacks {
  onAuth: (info: OAuthAuthInfo) => void;
  onPrompt: (prompt: OAuthPrompt) => Promise<string>;
  onProgress?: (message: string) => void;
  onManualCodeInput?: () => Promise<string>;
  signal?: AbortSignal;
}

// A built-in OAuth subscription provider. `login` runs the interactive flow and
// returns credentials to persist; `refreshToken` mints a fresh access token from
// the stored credentials; `getApiKey` extracts the bearer the gateway sends
// upstream. `usesCallbackServer` documents whether login spins a localhost
// redirect listener (anthropic/codex) vs a device-code flow (copilot).
export interface OAuthProviderInterface {
  readonly id: OAuthProviderId;
  readonly name: string;
  readonly usesCallbackServer?: boolean;
  login(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials>;
  refreshToken(credentials: OAuthCredentials): Promise<OAuthCredentials>;
  getApiKey(credentials: OAuthCredentials): string;
}
