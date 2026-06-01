import {
  getRequest,
  getRequestPayload,
  type RequestDetail,
  type RequestPayloadView,
} from '$lib/api/requests.js';
import type { PageLoad } from './$types.js';

// SPA load: fetch the full decision trail + the captured payload for one trace.
// On failure (e.g. the trace does not exist / 404) we resolve to a friendly error
// state rather than throwing — the page must never white-screen (DoD). The payload
// fetch fails open to { captured:false } so a capture-off request still renders.
// READ-ONLY (docs/07).
export const load: PageLoad = async ({
  params,
}): Promise<{
  detail: RequestDetail | null;
  payload: RequestPayloadView;
  traceId: string;
  loadError?: string;
}> => {
  const traceId = params.traceId;
  try {
    const [detail, payload] = await Promise.all([getRequest(traceId), getRequestPayload(traceId)]);
    return { detail, payload, traceId };
  } catch (e) {
    return {
      detail: null,
      payload: { captured: false },
      traceId,
      loadError: e instanceof Error ? e.message : 'Failed to load request',
    };
  }
};
