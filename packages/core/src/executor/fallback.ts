import {
  type AttemptErrorDetail,
  type HelmError,
  type InternalRequest,
  makeHelmError,
} from "@helm/shared";
import type { CircuitBreaker } from "../circuit/breaker.js";

// executor.fallback — traverse the ordered candidate chain (primary →
// fallback[]) and try each in turn. Framework-agnostic (CLAUDE.md principle 1):
// the breaker, capability check and provider invoke are all dependency-injected.
//
// Two fallbacks, never conflated (principle 5): this is EXECUTION fallback — it
// only swaps the model WITHIN the chain, it never rewrites the lane (that is
// CLASSIFICATION fallback → balanced, a separate mechanism with separate log
// fields). This module is ALSO the single anchor for principle 3's fail-open
// exception: a structured error (`all_providers_failed`) is produced ONLY when
// the entire chain is exhausted; every auxiliary failure (breaker read,
// capability check) degrades to skipping/allowing the candidate, never a 5xx
// mid-chain.
//
// Ports llm-router semantics WITHOUT importing it (implementation-notes,
// execution-layer entry): explicit skip reasons; `:free` candidate 429 → skip;
// client abort = non-provider fault (records neither failure nor success and
// terminates the whole chain, NOT counted as all_providers_failed); failures
// recorded only BEFORE the first valid chunk.

export interface Candidate {
  /** Lane-internal candidate alias — declaration order is preserved. */
  alias: string;
  /** The resolved provider-native model id (the breaker keys on this). */
  providerModel: string;
}

// Result of one successful provider call (first valid chunk emitted). Kept
// minimal here — the executor only needs the bookkeeping fields it threads into
// the decision record; the full streamed body is the caller's concern.
export interface ProviderResult {
  /** null on success; mirrors docs/07 error_class when a soft-error surfaces. */
  error_class: string | null;
  /** Resolved cost for this attempt, or null when not yet priced. */
  cost_usd: number | null;
}

// Structured failure thrown by `invoke` BEFORE the first valid chunk. Carries
// the classification the executor needs to decide failure vs. skip vs. abort
// without re-parsing provider internals (principle 1: no framework/IO here).
export interface InvokeFailureInit {
  error_class: string; // docs/07 error_class for the decision record
  status?: number; // upstream HTTP status, if any (e.g. 429)
  aborted?: boolean; // client abort — non-provider fault, terminates the chain
  // Optional redacted upstream detail for the per-attempt error_detail row
  // (admin-debug-error-detail). `detail_message` overrides the default class
  // string; `provider_raw` is the already key-scrubbed upstream error body.
  detail_message?: string;
  provider_raw?: Record<string, unknown> | null;
}

export class InvokeFailure extends Error {
  readonly error_class: string;
  readonly status: number | null;
  readonly aborted: boolean;
  readonly detail_message: string;
  readonly provider_raw: Record<string, unknown> | null;
  constructor(init: InvokeFailureInit) {
    super(init.error_class);
    this.name = "InvokeFailure";
    this.error_class = init.error_class;
    this.status = init.status ?? null;
    this.aborted = init.aborted ?? false;
    this.detail_message = init.detail_message ?? init.error_class;
    this.provider_raw = init.provider_raw ?? null;
  }
}

// One row of the decision record's `provider_attempts` (docs/02). Field-for-field
// aligned with shared `ProviderAttemptSchema` so this array feeds it directly.
export interface AttemptRecord {
  alias: string;
  skipped: boolean;
  skip_reason: string | null; // circuit_open | capability:<reason> | free_429 | ...
  status: "ok" | "error";
  error_class: string | null;
  latency_ms: number;
  cost_usd: number | null;
  // Upstream failure detail for THIS attempt (admin-debug-error-detail). Non-null
  // only for a genuine pre-first-chunk provider failure; null for ok/skipped rows.
  error_detail: AttemptErrorDetail | null;
}

export interface CapabilityVerdict {
  ok: boolean;
  skipReason?: string; // present iff ok=false (e.g. "capability:json")
}

export interface FallbackDeps {
  breaker: CircuitBreaker;
  /** Capability gate for one candidate — pure, from capability.filter. */
  checkCapability: (c: Candidate, req: InternalRequest) => CapabilityVerdict;
  /** Single provider call (stream/non-stream); resolves once the first valid
   *  chunk is seen, rejects with InvokeFailure before it. From provider.registry. */
  invoke: (c: Candidate, req: InternalRequest, signal: AbortSignal) => Promise<ProviderResult>;
  /** Injected clock for deterministic latency in tests. */
  now: () => number;
}

export type FallbackOutcome = {
  /** One row per candidate (including skipped) — feeds decision.provider_attempts. */
  attempts: AttemptRecord[];
  final:
    | { status: "ok"; alias: string; providerModel: string; result: ProviderResult }
    | { status: "error"; error: HelmError };
};

function isFreeAlias(alias: string): boolean {
  return alias.endsWith(":free");
}

// Abort can surface either as our structured InvokeFailure{aborted} or as a
// DOMException/AbortError from the underlying fetch — treat both as abort.
function isAbort(err: unknown, signal: AbortSignal): boolean {
  if (err instanceof InvokeFailure) return err.aborted;
  if (signal.aborted) return true;
  return err instanceof Error && err.name === "AbortError";
}

function errorClassOf(err: unknown): string {
  if (err instanceof InvokeFailure) return err.error_class;
  return "upstream_error";
}

function statusOf(err: unknown): number | null {
  return err instanceof InvokeFailure ? err.status : null;
}

// Build the redacted per-attempt error_detail from a genuine upstream failure.
// Pulls the carried status/message/raw body off InvokeFailure; degrades to the
// generic error message (or string) otherwise. provider_raw is the producer's
// already key-scrubbed body — the telemetry redact gate scrubs it again.
function detailOf(err: unknown): AttemptErrorDetail {
  if (err instanceof InvokeFailure) {
    return {
      upstream_status: err.status,
      message: err.detail_message,
      provider_raw: err.provider_raw,
    };
  }
  return {
    upstream_status: null,
    message: err instanceof Error ? err.message : String(err),
    provider_raw: null,
  };
}

/**
 * Walk the chain [primary, ...fallback] in declaration order. For each
 * candidate: breaker.canAttempt (OPEN → skip) → checkCapability (incompatible →
 * skip) → invoke. First success returns final.ok; failures record an attempt and
 * continue; exhaustion → all_providers_failed (502). Empty chain →
 * lane_unavailable (503). Client abort terminates the chain as a non-fault.
 */
export async function runFallback(
  chain: Candidate[],
  req: InternalRequest,
  deps: FallbackDeps,
  signal: AbortSignal,
): Promise<FallbackOutcome> {
  const { breaker, checkCapability, invoke, now } = deps;
  const attempts: AttemptRecord[] = [];

  // Empty chain is NOT a provider fault — the lane resolved to no candidates.
  if (chain.length === 0) {
    return {
      attempts,
      final: {
        status: "error",
        error: makeHelmError({
          error_class: "lane_unavailable",
          message: "lane has no candidates",
          trace_id: req.request_id,
        }),
      },
    };
  }

  for (const c of chain) {
    const startedAt = now();
    const elapsed = () => Math.max(0, now() - startedAt);

    // 1) Circuit breaker gate. Its own faults fail-open (canAttempt already
    //    swallows + returns allow). allow=false → skip without invoking.
    const decision = breaker.canAttempt(c.providerModel);
    if (!decision.allow) {
      attempts.push({
        alias: c.alias,
        skipped: true,
        skip_reason: decision.reason ?? "circuit_open",
        status: "error",
        error_class: null,
        latency_ms: elapsed(),
        cost_usd: null,
        error_detail: null,
      });
      continue;
    }

    // 2) Capability gate. A THROWN check is an auxiliary failure → fail-open by
    //    skipping this candidate (never a mid-chain 5xx, principle 3).
    let verdict: CapabilityVerdict;
    try {
      verdict = checkCapability(c, req);
    } catch {
      attempts.push({
        alias: c.alias,
        skipped: true,
        skip_reason: "capability_check_error",
        status: "error",
        error_class: null,
        latency_ms: elapsed(),
        cost_usd: null,
        error_detail: null,
      });
      continue;
    }
    if (!verdict.ok) {
      attempts.push({
        alias: c.alias,
        skipped: true,
        skip_reason: verdict.skipReason ?? "capability",
        status: "error",
        error_class: null,
        latency_ms: elapsed(),
        cost_usd: null,
        error_detail: null,
      });
      continue;
    }

    // 3) Invoke the provider.
    try {
      const result = await invoke(c, req, signal);
      // Success = first valid chunk emitted. Heal the breaker, return.
      breaker.recordSuccess(c.providerModel);
      attempts.push({
        alias: c.alias,
        skipped: false,
        skip_reason: null,
        status: "ok",
        error_class: result.error_class,
        latency_ms: elapsed(),
        cost_usd: result.cost_usd,
        error_detail: null,
      });
      return {
        attempts,
        final: { status: "ok", alias: c.alias, providerModel: c.providerModel, result },
      };
    } catch (err) {
      // a) Client abort — non-provider fault. Record neither failure nor
      //    success; release any probe lock; terminate the WHOLE chain. This is
      //    NOT all_providers_failed.
      if (isAbort(err, signal)) {
        breaker.recordAbort(c.providerModel);
        attempts.push({
          alias: c.alias,
          skipped: false,
          skip_reason: "aborted",
          status: "error",
          error_class: "client_abort",
          latency_ms: elapsed(),
          cost_usd: null,
          error_detail: null,
        });
        return {
          attempts,
          final: {
            status: "error",
            error: makeHelmError({
              // Client disconnect — a dedicated class (499) so telemetry never
              // counts it as an upstream provider fault (docs/02, docs/07).
              error_class: "client_abort",
              message: "client aborted request",
              trace_id: req.request_id,
            }),
          },
        };
      }

      // b) `:free` candidate 429 — ported llm-router semantics: skip to the next
      //    candidate, do NOT record a breaker failure (free-tier throttling is
      //    not a provider health signal).
      if (isFreeAlias(c.alias) && statusOf(err) === 429) {
        attempts.push({
          alias: c.alias,
          skipped: true,
          skip_reason: "free_429",
          status: "error",
          error_class: "rate_limited",
          latency_ms: elapsed(),
          cost_usd: null,
          error_detail: detailOf(err),
        });
        continue;
      }

      // c) Genuine pre-first-chunk failure: record it on the breaker and move on.
      breaker.recordFailure(c.providerModel);
      attempts.push({
        alias: c.alias,
        skipped: false,
        skip_reason: null,
        status: "error",
        error_class: errorClassOf(err),
        latency_ms: elapsed(),
        cost_usd: null,
        error_detail: detailOf(err),
      });
    }
  }

  // Chain exhausted — the ONLY place all_providers_failed is produced.
  return {
    attempts,
    final: {
      status: "error",
      error: makeHelmError({
        error_class: "all_providers_failed",
        message: "all providers in the candidate chain failed",
        trace_id: req.request_id,
      }),
    },
  };
}
