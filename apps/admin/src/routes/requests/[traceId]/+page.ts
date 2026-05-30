import { getRequest, type RequestDetail } from '$lib/api/requests.js';
import type { PageLoad } from './$types.js';

// SPA load: fetch the full decision trail for one trace. On failure (e.g. the
// trace does not exist / 404) we resolve to a friendly error state rather than
// throwing — the page must never white-screen (DoD). READ-ONLY (docs/07).
export const load: PageLoad = async ({
  params,
}): Promise<{ detail: RequestDetail | null; traceId: string; loadError?: string }> => {
  const traceId = params.traceId;
  try {
    const detail = await getRequest(traceId);
    return { detail, traceId };
  } catch (e) {
    return {
      detail: null,
      traceId,
      loadError: e instanceof Error ? e.message : 'Failed to load request',
    };
  }
};
