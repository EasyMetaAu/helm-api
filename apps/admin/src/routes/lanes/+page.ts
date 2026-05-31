import { listLanes } from '$lib/api/lanes.js';
import type { PageLoad } from './$types.js';

// SPA load: fetch the lane list from the gateway admin API on the client.
export const load: PageLoad = async () => {
  const lanes = await listLanes();
  return { lanes };
};
