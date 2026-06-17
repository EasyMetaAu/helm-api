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
export { anthropicUsageToWindows, parseAnthropicUsageBody } from "./anthropic-quota.js";
export { codexUsageToWindows, parseCodexQuotaHeaders, parseCodexUsageBody } from "./codex-quota.js";
export {
  beginCopilotDeviceLogin,
  COPILOT_HEADERS,
  type CopilotDeviceStart,
  type CopilotPollResult,
  getGitHubCopilotBaseUrl,
  githubCopilotOAuthProvider,
  listGitHubCopilotModels,
  loginGitHubCopilot,
  normalizeDomain,
  pollCopilotDeviceOnce,
  refreshGitHubCopilotToken,
} from "./github-copilot.js";
export { CURATED_OAUTH_MODELS, discoverOAuthModels, hasLiveModelDiscovery } from "./models.js";
export {
  beginOpenAICodexLogin,
  type CodexLoginStart,
  completeOpenAICodexLogin,
  openaiCodexOAuthProvider,
  refreshOpenAICodexToken,
} from "./openai-codex.js";
export {
  createOAuthPoolClient,
  type OAuthPoolClient,
  type OAuthPoolDeps,
  type OAuthPoolMember,
} from "./pool.js";
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
export {
  createSerializingClient,
  QueueTimeoutError,
  type SerializeClientDeps,
} from "./serialize-client.js";
export type {
  OAuthAuthInfo,
  OAuthCredentials,
  OAuthLoginCallbacks,
  OAuthPrompt,
  OAuthProviderId,
  OAuthProviderInterface,
} from "./types.js";
export {
  DEFAULT_429_COOLDOWN_MS,
  LIMIT_THRESHOLD,
  windowsToUsageLimit,
} from "./usage-limit.js";
