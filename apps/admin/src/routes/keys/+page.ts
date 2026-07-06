import { getKeysUsage, type KeyUsage, listKeys } from '$lib/api/keys.js';
import { listLanes } from '$lib/api/lanes.js';
import { resolveWindow } from '$lib/requests-filters.js';
import type { PageLoad } from './$types.js';

// SPA load: fetch the redacted key list (prefix only — never plaintext) plus the
// lane names (for the create-form caps dropdown) and today's per-key usage rollup
// (the list "Usage" column). Usage is SUPPLEMENTARY observability — it fails soft
// to [] so an aggregate hiccup never blanks the whole key list.
export const load: PageLoad = async () => {
  const { start } = resolveWindow('today', Date.now());
  const [keys, lanes, usage] = await Promise.all([
    listKeys(),
    listLanes(),
    getKeysUsage({ start }).catch(() => [] as KeyUsage[]),
  ]);
  return { keys, lanes: lanes.map((l) => l.name), usage };
};
