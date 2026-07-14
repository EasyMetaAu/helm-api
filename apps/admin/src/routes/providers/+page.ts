import {
  getOAuthOverview,
  type OAuthAdminRefreshStatus,
  type OAuthOverview,
} from '$lib/api/oauth.js';
import type { PageLoad } from './$types.js';

const IDLE_REFRESH: OAuthAdminRefreshStatus = {
  state: 'idle',
  jobId: null,
  requestedAt: null,
  startedAt: null,
  finishedAt: null,
  lastSuccessAt: null,
  nextAllowedAt: null,
  error: null,
};

export type ProvidersPageData = OAuthOverview & { loadError?: string };

// The initial render is one cache-only gateway read. Provider discovery, token
// renewal, and quota pulls only run behind POST /oauth/refresh.
export const load: PageLoad = async (): Promise<ProvidersPageData> => {
  try {
    return await getOAuthOverview();
  } catch (error) {
    return {
      configured: false,
      selectionStrategy: 'balanced',
      providers: [],
      usage: [],
      quota: [],
      refresh: IDLE_REFRESH,
      loadError: error instanceof Error ? error.message : 'Failed to load OAuth providers',
    };
  }
};
