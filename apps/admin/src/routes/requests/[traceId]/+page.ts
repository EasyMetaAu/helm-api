import { base } from '$app/paths';
import {
  getRequest,
  getRequestPayload,
  type RequestDetail,
  type RequestPayloadView,
} from '$lib/api/requests.js';
import type { PageLoad } from './$types.js';

// Where the Back link returns to. The originating list (the requests list OR a key
// detail page) passes its full path+filters as `?from=`; we return there verbatim so
// the user lands back on the exact page/filter state — surviving reload / new-tab,
// since it lives in the URL, not browser history. Accept ONLY a same-app relative
// path (single leading slash, no scheme / protocol-relative / backslash) so a crafted
// `from` can never become an open redirect; anything else falls back to the list.
export function safeBackTo(from: string | null, fallback: string): string {
  if (!from || !from.startsWith('/') || from[1] === '/' || from[1] === '\\') return fallback;
  return from;
}

// SPA load: fetch the full decision trail + the captured payload for one trace.
// On failure (e.g. the trace does not exist / 404) we resolve to a friendly error
// state rather than throwing — the page must never white-screen (DoD). The payload
// fetch fails open to { captured:false } so a capture-off request still renders.
// READ-ONLY (docs/07).
export const load: PageLoad = async ({
  params,
  url,
}): Promise<{
  detail: RequestDetail | null;
  payload: RequestPayloadView;
  traceId: string;
  backTo: string;
  loadError?: string;
}> => {
  const traceId = params.traceId;
  const backTo = safeBackTo(url.searchParams.get('from'), `${base}/requests`);
  try {
    const [detail, payload] = await Promise.all([getRequest(traceId), getRequestPayload(traceId)]);
    return { detail, payload, traceId, backTo };
  } catch (e) {
    return {
      detail: null,
      payload: { captured: false },
      traceId,
      backTo,
      loadError: e instanceof Error ? e.message : 'Failed to load request',
    };
  }
};
