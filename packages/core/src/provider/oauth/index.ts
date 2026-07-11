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
export {
  type CodexModelInfo,
  CodexModelInfoSchema,
  type CodexModelsResponse,
  CodexModelsResponseSchema,
  type CodexReasoningEffortPreset,
  CodexReasoningEffortPresetSchema,
  type ReasoningEffort,
  ReasoningEffortSchema,
} from "./codex-model-info.js";
export {
  type CodexCreditsSnapshot,
  type CodexQuotaDetails,
  type CodexRateLimitReachedType,
  codexActiveLimitIdFromProviderRaw,
  codexResetCreditsFromUsage,
  codexUsageToWindows,
  parseCodexQuotaDetails,
  parseCodexQuotaHeaderDetails,
  parseCodexQuotaHeaders,
  parseCodexResetCredits,
  parseCodexResetResult,
  parseCodexUsageBody,
  selectCodexActiveLimitWindows,
} from "./codex-quota.js";
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
export {
  buildOpenAICodexUserAgent,
  CURATED_OAUTH_MODELS,
  DEFAULT_OPENAI_CODEX_CLIENT_VERSION,
  type DiscoverOAuthModelsOptions,
  discoverOAuthModels,
  expandOpenAICodexModelAliases,
  filterRetiredOpenAICodexLimits,
  hasLiveModelDiscovery,
  isRetiredOpenAICodexLimit,
  isRetiredOpenAICodexModel,
  listOpenAICodexModels,
  OpenAICodexModelsError,
  type OpenAICodexModelsOptions,
  type OpenAICodexModelsResult,
  resolveOpenAICodexClientVersion,
  resolveOpenAICodexModelAlias,
} from "./models.js";
export {
  beginOpenAICodexLogin,
  type CodexLoginStart,
  completeOpenAICodexLogin,
  isOpenAICodexWorkspacePlan,
  OpenAICodexIdentityMismatchError,
  openAICodexIdentityFingerprint,
  openaiCodexOAuthProvider,
  parseOpenAICodexIdentity,
  refreshOpenAICodexToken,
} from "./openai-codex.js";
export {
  createOAuthPoolClient,
  type OAuthPoolClient,
  type OAuthPoolDeps,
  type OAuthPoolMember,
  type OAuthRateLimitParkContext,
  type OAuthSelectionStrategy,
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
  OpenAICodexIdentity,
} from "./types.js";
export {
  ACTIVE_LIMIT_RECOVERY_THRESHOLD,
  DEFAULT_429_COOLDOWN_MS,
  isAccountWideQuotaWindow,
  LIMIT_THRESHOLD,
  windowsToActiveUsageRecovery,
  windowsToUsageLimit,
} from "./usage-limit.js";
