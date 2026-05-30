import { listRequests } from '$lib/api/requests.js';
import type { PageLoad } from './$types.js';

// SPA load: fetch the most-recent request-debug rows from the gateway admin API.
// Read-only — the UI renders the recorded trail and recomputes nothing (docs/07).
export const load: PageLoad = async () => {
  const { items, nextCursor } = await listRequests();
  return { items, nextCursor };
};
