import { listLanes } from '$lib/api/lanes.js';
import { listModels } from '$lib/api/models.js';
import { getSettings } from '$lib/api/settings.js';
import type { PageLoad } from './$types.js';

// SPA load: fetch the lane list AND the routable-alias catalog (for the combobox
// suggestions) from the gateway admin API on the client, in parallel. `listModels`
// never throws (degrades to []), so a missing catalog never blocks the page.
export const load: PageLoad = async () => {
  const [lanes, models, settings] = await Promise.all([listLanes(), listModels(), getSettings()]);
  return { lanes, models, defaultLane: settings.default_lane };
};
