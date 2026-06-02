// OAuth subscription-provider kit (issue #38). Framework-agnostic; ported from
// openclaw (MIT). See ./types.ts header for the adaptation notes + ToS caveat.

export {
  type AnthropicLoginStart,
  anthropicOAuthProvider,
  beginAnthropicLogin,
  completeAnthropicLogin,
  loginAnthropic,
  refreshAnthropicToken,
} from "./anthropic.js";
export {
  beginCopilotDeviceLogin,
  COPILOT_HEADERS,
  type CopilotDeviceStart,
  type CopilotPollResult,
  getGitHubCopilotBaseUrl,
  githubCopilotOAuthProvider,
  loginGitHubCopilot,
  normalizeDomain,
  pollCopilotDeviceOnce,
  refreshGitHubCopilotToken,
} from "./github-copilot.js";
export {
  beginOpenAICodexLogin,
  type CodexLoginStart,
  completeOpenAICodexLogin,
  openaiCodexOAuthProvider,
  refreshOpenAICodexToken,
} from "./openai-codex.js";
export { getOAuthProvider, getOAuthProviders, listOAuthProviderIds } from "./registry.js";
export {
  buildOAuthRequestSignal,
  createOAuthLoginCancelledError,
  generateOAuthState,
  generatePKCE,
  oauthErrorHtml,
  oauthSuccessHtml,
  parseOAuthAuthorizationInput,
  resolveOAuthTokenExpiresAt,
  throwIfOAuthLoginAborted,
  withOAuthLoginAbort,
} from "./runtime.js";
export type {
  OAuthAuthInfo,
  OAuthCredentials,
  OAuthLoginCallbacks,
  OAuthPrompt,
  OAuthProviderId,
  OAuthProviderInterface,
} from "./types.js";
