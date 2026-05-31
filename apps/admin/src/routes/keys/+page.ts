import { listKeys } from '$lib/api/keys.js';
import { listLanes } from '$lib/api/lanes.js';
import type { PageLoad } from './$types.js';

// SPA load: fetch the redacted key list (prefix only — never plaintext) plus the
// lane names (for the create-form caps dropdown) from the gateway admin API.
export const load: PageLoad = async () => {
  const [keys, lanes] = await Promise.all([listKeys(), listLanes()]);
  return { keys, lanes: lanes.map((l) => l.name) };
};
