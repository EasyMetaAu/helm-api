import { base } from '$app/paths';
import {
  getRequest,
  getRequestPayloadMeta,
  type RequestDetail,
  type RequestPayloadView,
} from '$lib/api/requests.js';
import { safeBackTo } from '$lib/nav.js';
import type { PageLoad } from './$types.js';

// SPA load: fetch the full decision trail + a lightweight payload summary for one request.
// On failure (e.g. the request does not exist / 404) we resolve to a friendly error
// state rather than throwing — the page must never white-screen (DoD). The payload meta
// fetch fails open to { captured:false }; the heavy request/response bodies are loaded
// on demand by the page, not during navigation. READ-ONLY (docs/07).
export const load: PageLoad = async ({
  params,
  url,
}): Promise<{
  detail: RequestDetail | null;
  payload: RequestPayloadView;
  requestId: string;
  backTo: string;
  loadError?: string;
}> => {
  const requestId = params.traceId;
  const backTo = safeBackTo(url.searchParams.get('from'), `${base}/requests`);
  // Payload metadata fails open INDEPENDENTLY: a slow / failed body lookup must not
  // sink the whole page — its own `.catch` keeps `Promise.all` from rejecting, so the
  // decision trail still renders. Only a failure of the detail itself is fatal, and
  // even then we surface a friendly, retryable state (never white-screen, DoD).
  const payloadP = getRequestPayloadMeta(requestId).catch(
    (): RequestPayloadView => ({ captured: false }),
  );
  try {
    const [detail, payload] = await Promise.all([getRequest(requestId), payloadP]);
    return { detail, payload, requestId, backTo };
  } catch (e) {
    return {
      detail: null,
      payload: await payloadP,
      requestId,
      backTo,
      loadError: e instanceof Error ? e.message : 'Failed to load request',
    };
  }
};
