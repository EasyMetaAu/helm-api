import type { TelemetryStore } from "@helm/core";

// Result of a traceId ownership check. "not_found" deliberately collapses BOTH
// "no such trace" and "belongs to another key" into one branch so a key holder
// can never enumerate the gateway's requests or probe another key's traceIds
// (spec §4.4 / §8 R2). The route maps it to a 404 — never a 403.
export type OwnershipResult = "ok" | "not_found";

// Trace ownership gate for the payload/detail endpoints. The store addresses
// requests by traceId with ZERO ownership predicate (§4.4 / R1), so this MUST run
// at the route layer BEFORE any getByRequestId/getPayload read.
//
// FAIL-CLOSED on a missing scope (R5): if keyId is empty/undefined we throw rather
// than run a scopeless lookup — an unscoped read would compare `owner !== ""` and
// wrongly 404, but the invariant is louder than a wrong answer, so we refuse.
export async function assertOwnsTrace(
  telemetry: Pick<TelemetryStore, "getApiKeyId">,
  keyId: string,
  traceId: string,
): Promise<OwnershipResult> {
  if (!keyId) {
    throw new Error("assertOwnsTrace: missing identity.keyId (refusing scopeless read)");
  }
  const owner = await telemetry.getApiKeyId(traceId);
  // miss (null) and "someone else's" (!==) share ONE branch — see §8 R2.
  if (owner === null || owner !== keyId) return "not_found";
  return "ok";
}
