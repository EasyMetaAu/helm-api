import { listLanes } from '$lib/api/lanes.js';
import { listPolicies } from '$lib/api/policies.js';
import type { PageLoad } from './$types.js';

// SPA load: fetch the ordered policy list (and lane names for the action
// dropdowns) from the gateway admin API on the client. Lane fetch is best-effort
// — if it fails the page falls back to the well-known lane set.
export const load: PageLoad = async () => {
  const policies = await listPolicies();
  let lanes: string[] | undefined;
  try {
    lanes = (await listLanes()).map((l) => l.name);
  } catch {
    lanes = undefined;
  }
  return { policies, lanes };
};
