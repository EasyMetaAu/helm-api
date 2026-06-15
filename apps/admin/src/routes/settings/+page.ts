import { listLanes } from '$lib/api/lanes.js';
import { getSettings, type RuntimeSettings } from '$lib/api/settings.js';
import type { PageLoad } from './$types.js';

// SPA load: fetch the live runtime settings + the lane names (for the default-lane
// dropdown). On failure resolve to an error state rather than throwing — the page
// must never white-screen (DoD). READ-ONLY load; the page mutates a local working
// copy and PUTs on Save. The lanes fetch is best-effort (its own catch) so a lanes
// hiccup never blanks the whole settings page.
export const load: PageLoad = async (): Promise<{
  settings: RuntimeSettings | null;
  lanes: string[];
  loadError?: string;
}> => {
  try {
    const [settings, lanes] = await Promise.all([
      getSettings(),
      listLanes()
        .then((ls) => ls.map((l) => l.name))
        .catch(() => [] as string[]),
    ]);
    return { settings, lanes };
  } catch (e) {
    return {
      settings: null,
      lanes: [],
      loadError: e instanceof Error ? e.message : 'Failed to load settings',
    };
  }
};
