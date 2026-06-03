import {
  getOAuthQuota,
  getOAuthUsage,
  listOAuthStatus,
  type OAuthProviderStatus,
  type OAuthQuotaSnapshot,
  type OAuthUsageRow,
} from '$lib/api/oauth.js';
import type { PageLoad } from './$types.js';

// SPA load: fetch the OAuth provider catalog + logged-in accounts, plus today's
// per-account usage and the latest quota window snapshots — all in PARALLEL. Never
// throws; the status load drives the error state (the page never white-screens),
// while usage/quota are pure observability and FAIL-OPEN to [] (a slow/down stats
// endpoint must never block or break the page).
export const load: PageLoad = async (): Promise<{
  configured: boolean;
  providers: OAuthProviderStatus[];
  usage: OAuthUsageRow[];
  quota: OAuthQuotaSnapshot[];
  loadError?: string;
}> => {
  const [statusRes, usage, quota] = await Promise.all([
    listOAuthStatus().then(
      (r) => ({ ok: true as const, ...r }),
      (e) => ({ ok: false as const, error: e as unknown }),
    ),
    getOAuthUsage(), // already fail-open to []
    getOAuthQuota(), // already fail-open to []
  ]);
  if (!statusRes.ok) {
    return {
      configured: false,
      providers: [],
      usage,
      quota,
      loadError:
        statusRes.error instanceof Error
          ? statusRes.error.message
          : 'Failed to load OAuth providers',
    };
  }
  return { configured: statusRes.configured, providers: statusRes.providers, usage, quota };
};
