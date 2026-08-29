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
  GROK_OAUTH_MEDIA_MODELS,
  hasLiveModelDiscovery,
  isRetiredOpenAICodexLimit,
  isRetiredOpenAICodexModel,
  isRoutableXaiOAuthModel,
  listOpenAICodexModels,
  listXaiOAuthModels,
  OPENAI_CODEX_IMAGE_MODEL,
  OpenAICodexModelsError,
  type OpenAICodexModelsOptions,
  type OpenAICodexModelsResult,
  parseXaiOAuthModels,
  resolveOpenAICodexClientVersion,
  resolveOpenAICodexModelAlias,
  supportsOpenAICodexImageGeneration,
  type XaiApiBackend,
  type XaiOAuthModel,
  type XaiReasoningEffort,
  type XaiReasoningEffortOption,
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
  XAI_TTS_CAPABILITY,
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
export { aggregateByCalendar, type CalendarGranularity } from "./usage-calendar.js";
export {
  ACTIVE_LIMIT_RECOVERY_THRESHOLD,
  DEFAULT_429_COOLDOWN_MS,
  isAccountWideQuotaWindow,
  LIMIT_THRESHOLD,
  windowsToActiveUsageRecovery,
  windowsToUsageLimit,
} from "./usage-limit.js";
export {
  type ComputeUsagePeriodsInput,
  computeUsagePeriods,
  detectQuotaResetPeriods,
  type UsagePeriodsResult,
} from "./usage-periods.js";
export { ANTHROPIC_WINDOW_MINUTES, windowMinutesForKey } from "./window-minutes.js";
export {
  beginXaiDeviceLogin,
  isTrustedXaiOAuthEndpoint,
  loginXai,
  pollXaiDeviceOnce,
  refreshXaiOAuthToken,
  resolveXaiGrokClientVersion,
  XAI_GROK_CLIENT_VERSION,
  XAI_GROK_CLIENT_VERSION_ENV,
  XAI_GROK_OAUTH_BASE_URL,
  XAI_OAUTH_CLIENT_ID,
  XAI_OAUTH_DISCOVERY_URL,
  XAI_OAUTH_ISSUER,
  XAI_OAUTH_SCOPE,
  type XaiDevicePollResult,
  type XaiDeviceStart,
  xaiGrokCatalogHeaders,
  xaiGrokInferenceHeaders,
  xaiGrokProtocolHeaders,
  xaiGrokSubscriptionTierHint,
  xaiOAuthProvider,
} from "./xai.js";
export {
  isXaiGrokMediaEntitled,
  parseXaiGrokCreditsResponse,
  xaiGrokMediaEntitlementValidUntil,
} from "./xai-quota.js";
