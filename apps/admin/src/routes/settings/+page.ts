import { getSettings, type RuntimeSettings } from '$lib/api/settings.js';
import type { PageLoad } from './$types.js';

// SPA load: fetch the live runtime settings. On failure resolve to an error state
// rather than throwing — the page must never white-screen (DoD). READ-ONLY load;
// the page mutates a local working copy and PUTs on Save.
export const load: PageLoad = async (): Promise<{
  settings: RuntimeSettings | null;
  loadError?: string;
}> => {
  try {
    return { settings: await getSettings() };
  } catch (e) {
    return { settings: null, loadError: e instanceof Error ? e.message : 'Failed to load settings' };
  }
};
