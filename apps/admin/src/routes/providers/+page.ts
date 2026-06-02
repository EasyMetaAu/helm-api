import { listOAuthStatus, type OAuthProviderStatus } from '$lib/api/oauth.js';
import type { PageLoad } from './$types.js';

// SPA load: fetch the OAuth provider catalog + logged-in accounts. Never throws —
// on failure resolve to an error state so the page never white-screens (DoD).
export const load: PageLoad = async (): Promise<{
  configured: boolean;
  providers: OAuthProviderStatus[];
  loadError?: string;
}> => {
  try {
    const { configured, providers } = await listOAuthStatus();
    return { configured, providers };
  } catch (e) {
    return {
      configured: false,
      providers: [],
      loadError: e instanceof Error ? e.message : 'Failed to load OAuth providers',
    };
  }
};
