import type { CircuitBreaker, ProviderClient } from "@helm/core";
import { ERROR_CLASS_HTTP_STATUS, type ProviderAttempt } from "@helm/shared";
import {
  CONCURRENCY_LEASE_LOST_REASON,
  requestCancellationReason,
} from "../request-cancellation.js";
import {
  errorClassOf,
  errorDetailOf,
  isAbort,
  isUpstreamRequestRejection,
  upstreamErrorMessage,
} from "./execute.js";

// Image-generation candidate-chain executor. The model-pinned image routes
// (/v1/images/generations, /v1beta/interactions) may resolve a lane containing
// multiple provider aliases. Local breaker skips can advance before any write, but
// once one paid create call starts this executor terminates on every failure instead
// of replaying the POST through another provider.
//
// The terminal-vs-fallback classification REUSES execute.ts's exported helpers
// (isAbort / isUpstreamRequestRejection / errorClassOf / errorDetailOf) — the breaker
// semantics MUST stay identical to the text path, so they share one definition.

// One resolved, attemptable image target: a single alias on a single provider.
export interface ImageChainTarget {
  alias: string;
  providerModel: string;
  kind: "openai" | "gemini";
  client: ProviderClient;
}

// A successful attempt's result — everything the route needs from the SERVED provider.
// The route-supplied `attempt` closure owns ALL protocol mapping + cost for one target
// (build the upstream request, call it with the signal + a capture sink, map the
// response to the client body, price it); runImageChain only sequences attempts and
// gates them on the breaker.
export interface ImageAttemptResult {
  // Returned verbatim to the client AND captured for telemetry. The base64 image is
  // NOT stripped here: the store's externalizeImages (payload-blobs.ts) content-
  // addresses it into payload_blobs (deduped, retention-pruned) and rehydrates it for
  // the admin detail view — so request_payloads stays lean AND the image is viewable.
  clientBody: Record<string, unknown>;
  usage: Record<string, unknown> | null; // for budget-settle tokens + decision usage
  cost: number | null; // costOf(servedAlias, body)
  upstreamRequestJson: string | null; // exact bytes forwarded upstream (capture)
  servingAccount?: { providerId: string; account: string } | null;
}

export type ImageAttempt = (target: ImageChainTarget) => Promise<ImageAttemptResult>;

// Resolve a client-sent id (a bare image model OR an image lane name) → the ordered
// chain of usable image targets (one per provider alias, BOTH kinds; the gemini-only
// interactions route filters kinds itself). Built in server.ts over the registry +
// catalog + lanes; returns a 404/503 marker when nothing resolves to an image model.
export type ResolveImageChain = (model: string) =>
  | { ok: true; laneName: string; candidateChain: string[]; targets: ImageChainTarget[] }
  // 404 → nothing resolved to a configured image model; 503 → resolved an image
  // model but its provider credential/client is missing (a server-config problem).
  | { ok: false; status: 404 | 503 };

export interface ImageChainServed {
  ok: true;
  served: ImageChainTarget;
  result: ImageAttemptResult;
  attempts: ProviderAttempt[];
}
export interface ImageChainTerminal {
  ok: false;
  errorClass: string;
  httpStatus: number;
  message: string;
  providerRaw: unknown | null;
  // true → a client disconnect (non-provider fault); the route records NO telemetry
  // and surfaces its own "client disconnected" shape (mirrors the pre-chain behavior).
  aborted: boolean;
  attempts: ProviderAttempt[];
}
export type ImageChainResult = ImageChainServed | ImageChainTerminal;

// Image attempt rows omit the chat passthrough telemetry fields (all optional in
// ProviderAttemptSchema) — image gen has no native-passthrough mutation ledger.
function skipRow(alias: string, reason: string): ProviderAttempt {
  return {
    alias,
    skipped: true,
    skip_reason: reason,
    status: "error",
    error_class: null,
    latency_ms: 0,
    cost_usd: null,
    error_detail: null,
  };
}

export async function runImageChain(
  targets: ImageChainTarget[],
  breaker: CircuitBreaker,
  attempt: ImageAttempt,
  signal: AbortSignal,
): Promise<ImageChainResult> {
  const attempts: ProviderAttempt[] = [];

  for (const target of targets) {
    // 1) Circuit-breaker gate (keyed by alias — the routing unit, shared with chat).
    const gate = breaker.canAttempt(target.alias);
    if (!gate.allow) {
      attempts.push(skipRow(target.alias, gate.reason ?? "circuit_open"));
      continue;
    }
    // Mirror execute.ts: canAttempt may hold a HALF_OPEN probe lock. Paths that
    // exit without recordSuccess/recordFailure must release its matching token or the
    // alias stays permanently circuit_open until process restart.
    const releaseProbeLock = (): void => {
      if (gate.probeToken !== undefined) {
        breaker.recordAbort(target.alias, gate.probeToken);
      } else {
        breaker.recordAbort(target.alias);
      }
    };

    const started = Date.now();
    try {
      const result = await attempt(target);
      breaker.recordSuccess(target.alias);
      attempts.push({
        alias: target.alias,
        skipped: false,
        skip_reason: null,
        status: "ok",
        error_class: null,
        latency_ms: Date.now() - started,
        cost_usd: result.cost,
        error_detail: null,
      });
      return { ok: true, served: target, result, attempts };
    } catch (err) {
      const cancellation = requestCancellationReason(signal);
      if (cancellation === CONCURRENCY_LEASE_LOST_REASON || cancellation === "request_timeout") {
        releaseProbeLock();
        attempts.push({
          alias: target.alias,
          skipped: false,
          skip_reason: cancellation,
          status: "error",
          error_class: "outcome_unknown",
          latency_ms: Date.now() - started,
          cost_usd: null,
          error_detail: null,
        });
        return {
          ok: false,
          errorClass: "outcome_unknown",
          httpStatus: 503,
          message: "image create outcome is unknown",
          providerRaw: null,
          aborted: false,
          attempts,
        };
      }
      // Client abort: NON-provider fault — terminate WITHOUT a breaker failure and
      // WITHOUT recording it as a provider error (mirrors execute.ts's recordAbort).
      if (isAbort(err, signal)) {
        releaseProbeLock();
        attempts.push({
          alias: target.alias,
          skipped: false,
          skip_reason: "client_abort",
          status: "error",
          error_class: "outcome_unknown",
          latency_ms: Date.now() - started,
          cost_usd: null,
          error_detail: null,
        });
        return {
          ok: false,
          errorClass: "outcome_unknown",
          httpStatus: 503,
          message: "image create outcome is unknown",
          providerRaw: null,
          aborted: false,
          attempts,
        };
      }
      // Deterministic request-shape rejection (oversized image, bad param): the body
      // is invalid for EVERY candidate, so do NOT advance the chain and do NOT fault
      // the breaker (the upstream is healthy — the request is what's wrong). Surface
      // the upstream's structured error verbatim as a 400 invalid_request.
      if (isUpstreamRequestRejection(err)) {
        const detail = errorDetailOf(err);
        releaseProbeLock();
        attempts.push({
          alias: target.alias,
          skipped: false,
          skip_reason: null,
          status: "error",
          error_class: "invalid_request",
          latency_ms: Date.now() - started,
          cost_usd: null,
          error_detail: detail,
        });
        return {
          ok: false,
          errorClass: "invalid_request",
          httpStatus: ERROR_CLASS_HTTP_STATUS.invalid_request,
          message: upstreamErrorMessage(detail.provider_raw) ?? detail.message,
          providerRaw: detail.provider_raw,
          aborted: false,
          attempts,
        };
      }
      // The paid write may already have been accepted. Fault the breaker, but never
      // advance to another provider: doing so could create and bill a duplicate.
      breaker.recordFailure(target.alias);
      const detail = errorDetailOf(err);
      attempts.push({
        alias: target.alias,
        skipped: false,
        skip_reason: null,
        status: "error",
        error_class: errorClassOf(err),
        latency_ms: Date.now() - started,
        cost_usd: null,
        error_detail: detail,
      });
      return {
        ok: false,
        errorClass: "outcome_unknown",
        httpStatus: 503,
        message: "image create outcome is unknown",
        providerRaw: detail.provider_raw,
        aborted: false,
        attempts,
      };
    }
  }

  // Chain exhausted (or empty): empty → lane_unavailable (503); otherwise at least one
  // candidate was attempted/skipped and none served → all_providers_failed (502).
  const errorClass = targets.length === 0 ? "lane_unavailable" : "all_providers_failed";
  return {
    ok: false,
    errorClass,
    httpStatus: ERROR_CLASS_HTTP_STATUS[errorClass],
    message:
      targets.length === 0
        ? "image lane has no available providers"
        : "all image providers in the chain failed",
    providerRaw: null,
    aborted: false,
    attempts,
  };
}
