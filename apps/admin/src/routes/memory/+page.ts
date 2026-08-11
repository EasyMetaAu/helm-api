import { getMemoryStats, listScopes } from '$lib/api/memory.js';
import type { PageLoad } from './$types.js';

// SPA load: fetch only the first memory-scope page plus status. The redacted key
// list stays lazy until the operator opens "By Key" so this route never starts
// two potentially large reads together.
export const load: PageLoad = async ({ url }) => {
  const [scopePage, initialStats] = await Promise.all([
    listScopes({ limit: 50, offset: 0 }),
    getMemoryStats(),
  ]);
  // Deep link from a key's detail page (/memory?key=<keyId>): the page opens on the
  // "By Key" tab pre-selected to that key. null when navigated to directly.
  return { scopePage, initialStats, initialKeyId: url.searchParams.get('key') };
};
