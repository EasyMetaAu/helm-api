import type { OAuthTokenStore } from "@helm/core";
import { type ConfigStore, CURATED_OAUTH_MODELS } from "@helm/core";
import { getAccountSettings, loadAccountSettings } from "./account-settings.js";

// THE single source of truth for "which subscription models are routable right
// now" (issue #38 follow-up). One function, computed LIVE and NETWORK-FREE, so the
// Lanes catalog (/admin/api/models), the routing registry, and the Manage dialog
// never disagree — and an operator's curation edit reflects everywhere on the next
// read WITHOUT a restart.
//
// Effective set per account = the operator's AUTHORITATIVE `enabledModels`
// (verbatim, may include ids discovery never reported) when set, else the curated
// fallback. Discovery (Copilot /models, Anthropic /v1/models) only SEEDS the Manage
// dialog's suggestions — it is deliberately NOT called here, so this stays a pure,
// instant read of saved state (no per-request network fan-out across accounts).
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
  settings: { enabledModels?: string[] },
  providerId: string,
): string[] {
  return settings.enabledModels ?? CURATED_OAUTH_MODELS[providerId] ?? [];
}

// Every routable `${providerId}/${model}` alias across all bound accounts, deduped
// and sorted. Fail-open: a missing/corrupt settings blob yields the curated
// fallback (loadAccountSettings already swallows decrypt errors to {}).
export async function effectiveOAuthAliases(
  oauthCtx: OAuthRuntimeCtxLike,
  config: ConfigStore,
  routableProviderIds: ReadonlySet<string>,
): Promise<string[]> {
  const settings = await loadAccountSettings(config, oauthCtx.encKey);
  const aliases = new Set<string>();
  for (const row of await oauthCtx.store.list()) {
    if (!routableProviderIds.has(row.providerId)) continue;
    const models = effectiveAccountModels(
      getAccountSettings(settings, row.providerId, row.account),
      row.providerId,
    );
    for (const m of models) aliases.add(`${row.providerId}/${m}`);
  }
  return [...aliases].sort();
}
