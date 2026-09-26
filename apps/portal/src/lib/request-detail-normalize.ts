import type { PortalRequestDetail } from "./api/portal";

// The request-detail fields below (attempts/tps/ttfb_ms/generation_ms) were
// added to PortalRequestDetail in this same change — an older, not-yet-upgraded
// gateway simply omits the keys, which JSON.parse turns into `undefined`, not
// `null`. The page template only ever checks `!== null` / calls `.length` on
// these fields, so `undefined` slips through and throws (or renders "NaNms").
// Normalize once, right after the fetch, so the rest of the page can keep
// treating "not measured" as a single, always-present sentinel per field —
// `null` for the scalars (matches their own declared type), `[]` for attempts.
export function normalizePortalDetail(
  detail: PortalRequestDetail,
): PortalRequestDetail {
  return {
    ...detail,
    attempts: detail.attempts ?? [],
    tps: detail.tps ?? null,
    ttfb_ms: detail.ttfb_ms ?? null,
    generation_ms: detail.generation_ms ?? null,
  };
}
