import type { OAuthTokenStore } from "@helm/core";
import {
  type ConfigStore,
  CURATED_OAUTH_MODELS,
  DEFAULT_OPENAI_CODEX_CLIENT_VERSION,
  decryptSecret,
  expandOpenAICodexModelAliases,
  openAICodexIdentityFingerprint,
  parseOpenAICodexIdentity,
} from "@helm/core";
import {
  type AccountSettings,
  getAccountSettings,
  loadAccountSettings,
  resolveAccountModelsMode,
} from "./account-settings.js";
import type { CodexModelCacheKey } from "./codex-model-cache.js";
import type { CodexModelCatalog } from "./codex-model-catalog.js";

// THE single source of truth for "which subscription models are routable right
// now" (issue #38 follow-up). One function, computed LIVE and NETWORK-FREE, so the
// Lanes catalog (/admin/api/models), the routing registry, and the Manage dialog
// never disagree — and an operator's curation edit reflects everywhere on the next
// read WITHOUT a restart.
//
// Effective set per non-Codex account = the operator's `enabledModels` when set,
// else the provider fallback. Codex is different: its account-scoped catalog is
// the entitlement boundary, and manual mode may only narrow that catalog.
//
// `routableProviderIds` gates which providers route (the keys of server.ts's
// ROUTABLE_OAUTH) — a provider with no wired executor never appears, so the catalog
// can never offer a model that 500s at execution.

export interface OAuthRuntimeCtxLike {
  store: OAuthTokenStore;
  encKey: Buffer;
}

// The effective enabled models for ONE account (no network): the saved
// `enabledModels` verbatim, else the provider's curated fallback (else []).
export function effectiveAccountModels(
  settings: Pick<AccountSettings, "modelsMode" | "enabledModels">,
  providerId: string,
): string[] {
  if (providerId === "openai-codex") return [];
  return resolveAccountModelsMode(providerId, settings) === "manual"
    ? (settings.enabledModels ?? [])
    : (CURATED_OAUTH_MODELS[providerId] ?? []);
}

// Every routable `${providerId}/${model}` alias across all bound accounts, deduped
// and sorted. Fail-open: a missing/corrupt settings blob yields the curated
// fallback (loadAccountSettings already swallows decrypt errors to {}).

// One routable model alias + which subscription account(s) currently expose it.
// `accounts` lets the Lanes picker show, under each model, the bound account(s)
// that back it (a model may be exposed by several accounts of the same provider —
// the pool rotates across them). Configured (non-OAuth) providers carry no account.
export interface ModelOption {
  alias: string;
  accounts: string[];
}

export interface EffectiveOAuthModelOptions {
  codexCatalog?: CodexModelCatalog;
  codexClientVersion?: string;
}

function identityString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function parseMetadata(raw: string | null): Readonly<Record<string, unknown>> {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

async function automaticCodexModels(
  oauthCtx: OAuthRuntimeCtxLike,
  providerId: string,
  account: string,
  options: EffectiveOAuthModelOptions,
): Promise<string[] | undefined> {
  if (!options.codexCatalog) return undefined;
  const record = await oauthCtx.store.get(providerId, account);
  if (!record?.accessEnc) return undefined;
  try {
    const accessToken = decryptSecret(record.accessEnc, oauthCtx.encKey);
    const metadata = parseMetadata(record.meta);
    const tokenIdentity = parseOpenAICodexIdentity(accessToken);
    const accountId = identityString(metadata.accountId) ?? tokenIdentity.accountId;
    const chatgptUserId = identityString(metadata.chatgptUserId) ?? tokenIdentity.chatgptUserId;
    const email = identityString(metadata.email) ?? tokenIdentity.email;
    const chatgptPlanType =
      identityString(metadata.chatgptPlanType) ?? tokenIdentity.chatgptPlanType;
    const key: CodexModelCacheKey = {
      providerId,
      account,
      accountIdentity: openAICodexIdentityFingerprint({
        ...(accountId ? { accountId } : {}),
        ...(chatgptUserId ? { chatgptUserId } : {}),
        ...(chatgptPlanType ? { chatgptPlanType } : {}),
        ...(email ? { email } : {}),
      }),
      clientVersion: options.codexClientVersion ?? DEFAULT_OPENAI_CODEX_CLIENT_VERSION,
    };
    const snapshot = options.codexCatalog.snapshot(key);
    if (!snapshot) return undefined;
    return expandOpenAICodexModelAliases(
      snapshot.models
        .sort((left, right) => left.priority - right.priority)
        .map((model) => model.slug),
    );
  } catch {
    return undefined;
  }
}

// Every routable `${providerId}/${model}` alias WITH the set of accounts exposing
// it, deduped + sorted by alias. The single source the catalog endpoint serves.
export async function effectiveOAuthModelOptions(
  oauthCtx: OAuthRuntimeCtxLike,
  config: ConfigStore,
  routableProviderIds: ReadonlySet<string>,
  options: EffectiveOAuthModelOptions = {},
): Promise<ModelOption[]> {
  const settings = await loadAccountSettings(config, oauthCtx.encKey);
  const aliasToAccounts = new Map<string, Set<string>>();
  for (const row of await oauthCtx.store.list()) {
    if (!routableProviderIds.has(row.providerId)) continue;
    const accountSettings = getAccountSettings(settings, row.providerId, row.account);
    let models: string[];
    if (row.providerId === "openai-codex") {
      const entitled =
        (await automaticCodexModels(oauthCtx, row.providerId, row.account, options)) ?? [];
      if (resolveAccountModelsMode(row.providerId, accountSettings) === "manual") {
        const allowed = new Set(accountSettings.enabledModels ?? []);
        models = entitled.filter((model) => allowed.has(model));
      } else {
        models = entitled;
      }
    } else {
      models = effectiveAccountModels(accountSettings, row.providerId);
    }
    for (const m of models) {
      const alias = `${row.providerId}/${m}`;
      const accounts = aliasToAccounts.get(alias) ?? new Set<string>();
      accounts.add(row.account);
      aliasToAccounts.set(alias, accounts);
    }
  }
  return [...aliasToAccounts.entries()]
    .map(([alias, accounts]) => ({ alias, accounts: [...accounts].sort() }))
    .sort((a, b) => a.alias.localeCompare(b.alias));
}

// Alias-only view (back-compat / routing): the sorted alias list, dropping accounts.
export async function effectiveOAuthAliases(
  oauthCtx: OAuthRuntimeCtxLike,
  config: ConfigStore,
  routableProviderIds: ReadonlySet<string>,
  options: EffectiveOAuthModelOptions = {},
): Promise<string[]> {
  const models = await effectiveOAuthModelOptions(oauthCtx, config, routableProviderIds, options);
  return models.map((o) => o.alias);
}
