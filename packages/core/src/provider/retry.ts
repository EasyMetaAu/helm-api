// Idempotent retry for TRANSIENT upstream connection failures, applied at the
// provider's fetch boundary — BEFORE any response byte has reached the client, so
// re-issuing the request is safe (no duplicated/half-emitted output, principle 8).
//
// This is NOT the execution fallback (the chain loop in apps/gateway execute.ts
// swaps to the NEXT model): this retries the SAME upstream a couple of times to absorb a
// transient blip — a keepalive connection-reuse race, an ECONNRESET, a peer that
// closed the socket — which otherwise burns a candidate (or 502s a single-candidate
// chain) for a hiccup that a 200 ms retry would have survived.
//
// The classifier is a STRICT allowlist: only raw socket/connection signatures match.
// An already-classified UpstreamError("timeout") (slow connect — retrying only adds
// latency; the chain falls back instead) and a client AbortError both fall through
// to non-transient and are never retried.

const TRANSIENT_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ECANCELED",
  "EPIPE",
  "ETIMEDOUT",
  "UND_ERR_SOCKET",
]);

// Lowercased message substrings of transient connection failures across runtimes:
// undici ("terminated", "other side closed"), Node ("socket hang up"), Bun ("The
// socket connection was closed unexpectedly…"), and stream prematurely-closed errors.
const TRANSIENT_MESSAGE_PATTERNS = [
  "econnreset",
  "econnrefused",
  "epipe",
  "etimedout",
  "other side closed",
  "terminated",
  "socket hang up",
  "codex responses websocket is closed",
  "socket connection was closed",
  "premature close",
];

/**
 * True iff `err` (or a `cause` in its chain) is a transient connection failure
 * safe to retry pre-first-byte. A client abort (`name === "AbortError"`) is never
 * transient — the name check wins even over a socket-ish message.
 */
export function isTransientConnectionError(err: unknown): boolean {
  let cur: unknown = err;
  for (let depth = 0; depth < 5 && cur != null; depth += 1) {
    if (typeof cur !== "object") break;
    const e = cur as { name?: unknown; code?: unknown; message?: unknown; cause?: unknown };
    // Client abort short-circuits: never retry a cancellation.
    if (e.name === "AbortError") return false;
    if (typeof e.code === "string" && TRANSIENT_CODES.has(e.code)) return true;
    if (typeof e.message === "string") {
      const msg = e.message.toLowerCase();
      if (TRANSIENT_MESSAGE_PATTERNS.some((p) => msg.includes(p))) return true;
    }
    cur = e.cause;
  }
  return false;
}

/**
 * True when a raw fetch-boundary failure should be surfaced as a status-less
 * upstream transport error after same-account connection retries are exhausted.
 *
 * This is intentionally broader than `isTransientConnectionError`: undici can
 * report DNS, TLS, connect-timeout, and socket failures as an opaque
 * `TypeError("fetch failed")` whose nested code is not in the short-retry
 * allowlist. Those errors should still reach the OAuth pool as transport faults
 * so a stateless request can try a sibling account. Abort always wins.
 */
export function isFetchTransportError(err: unknown): boolean {
  let cur: unknown = err;
  for (let depth = 0; depth < 5 && cur != null; depth += 1) {
    if (typeof cur !== "object") break;
    const e = cur as { name?: unknown; cause?: unknown };
    if (e.name === "AbortError") return false;
    cur = e.cause;
  }
  if (isTransientConnectionError(err)) return true;
  if (typeof err !== "object" || err === null) return false;
  const e = err as { name?: unknown; message?: unknown };
  return (
    e.name === "TypeError" && typeof e.message === "string" && e.message.startsWith("fetch failed")
  );
}

// ── Upstream overload (529 / 503) ────────────────────────────────────────────
// A 529 "Overloaded" (Anthropic) or 503 "Service Unavailable" is TRANSIENT capacity
// pressure at the upstream, not a fault in the request: the identical body sent a
// moment later usually succeeds. Surfacing it immediately makes the executor burn its
// whole fallback chain — or, on a single-candidate chain, 502 the client — for a blip
// a short sleep would have absorbed. So the fetch boundary re-issues the SAME request
// after a real pause before anyone else sees the failure.
//
// Deliberately NARROW: only 529/503. A 500/502 is an unspecified server fault that
// says nothing about capacity (retrying just delays a real failure), and 429 is
// genuine rate limiting — the OAuth pool parks that account and the chain moves on.
// Retrying pre-first-byte is idempotent (no response consumed, nothing on the wire).
const OVERLOAD_STATUSES = new Set([503, 529]);
const OVERLOAD_BACKOFF_MS = [1_000, 3_000] as const;
// Upper bound on an upstream-supplied Retry-After. A provider asking for 10 minutes
// must not hold the client's socket open — past this we give up and let the executor
// fall back to another candidate, which is the faster path to an answer.
const OVERLOAD_MAX_DELAY_MS = 10_000;
const MAX_NUMERIC_RETRY_AFTER_MS = 24 * 60 * 60_000;

export function numericRetryAfterMs(value: string | null | undefined): number | null {
  const raw = value?.trim();
  if (raw === undefined || !/^\d+$/.test(raw)) return null;
  const seconds = Number(raw);
  if (seconds <= 0) return null;
  return Number.isFinite(seconds)
    ? Math.min(seconds * 1_000, MAX_NUMERIC_RETRY_AFTER_MS)
    : MAX_NUMERIC_RETRY_AFTER_MS;
}

/**
 * Backoff (ms) before re-issuing an overloaded upstream request, or null when this
 * status/attempt is not retryable. `attempt` is 0-based (0 = the delay before the
 * FIRST retry); beyond the budget it returns null so the caller stops. A numeric
 * `Retry-After` header (seconds) wins over the default schedule, clamped to
 * `OVERLOAD_MAX_DELAY_MS`; an HTTP-date or garbage value is ignored.
 */
export function overloadRetryDelayMs(args: {
  status: number;
  attempt: number;
  retryAfter?: string | null;
}): number | null {
  if (!OVERLOAD_STATUSES.has(args.status)) return null;
  const fallback = OVERLOAD_BACKOFF_MS[args.attempt];
  if (fallback === undefined) return null;
  const retryAfterMs = numericRetryAfterMs(args.retryAfter);
  if (retryAfterMs !== null) return Math.min(retryAfterMs, OVERLOAD_MAX_DELAY_MS);
  return fallback;
}

export interface ConnectionRetryOptions {
  /** Max additional attempts after the first. Default 2. */
  retries?: number;
  /** Backoff (ms) before retry i; the last value repeats if fewer than `retries`. Default [200, 500]. */
  backoffMs?: readonly number[];
  /** Injected for tests; default sleeps real time and resolves early on abort. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** Client/external signal — when aborted, stop retrying and rethrow. */
  signal?: AbortSignal;
  /** Override the retryability predicate (default isTransientConnectionError). */
  shouldRetry?: (err: unknown) => boolean;
}

const DEFAULT_RETRIES = 2;
const DEFAULT_BACKOFF_MS = [200, 500] as const;

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** Trusted per-request budget, shared across HTTP, pool and model attempts. */
export interface OverloadRetryBudget {
  attempt: number;
  exhausted?: boolean;
  onRetry?: (event: {
    reason: string;
    attempt: number;
    delay_ms: number;
    exhausted: boolean;
  }) => void;
}

export async function waitForOverloadRetry(
  budget: OverloadRetryBudget,
  opts: {
    reason: string;
    signal?: AbortSignal;
    sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
    retryAfter?: string | null;
  },
): Promise<boolean> {
  opts.signal?.throwIfAborted();
  const delay = overloadRetryDelayMs({
    status: 503,
    attempt: budget.attempt,
    retryAfter: opts.retryAfter,
  });
  if (delay === null) budget.exhausted = true;
  else budget.attempt += 1;
  try {
    budget.onRetry?.({
      reason: opts.reason,
      attempt: budget.attempt,
      delay_ms: delay ?? 0,
      exhausted: delay === null,
    });
  } catch {
    // Observability is fail-open.
  }
  if (delay === null) return false;
  await (opts.sleep ?? defaultSleep)(delay, opts.signal);
  opts.signal?.throwIfAborted();
  return true;
}

export interface OverloadRetryOptions<T> {
  budget?: OverloadRetryBudget;
  signal?: AbortSignal;
  /** Injected for tests; default sleeps real time and resolves early on abort. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** Extract the HTTP response from `fn`'s result. Default: the result IS the Response. */
  pick?: (value: T) => Response;
  /** Release a DISCARDED attempt's non-body resources (e.g. a deferred timeout timer). */
  release?: (value: T) => void;
}

/**
 * Re-issue `fn` while it answers with an overloaded status (529/503), sleeping
 * `overloadRetryDelayMs` between attempts. Returns the first non-overloaded result,
 * or the last overloaded one when the budget is exhausted / the client aborts — so
 * the caller's existing `!res.ok` path still turns it into the same UpstreamError.
 * Each discarded response's body is cancelled so no socket is leaked.
 *
 * Pre-first-byte only: the response is never consumed here, so re-sending is idempotent.
 */
export async function withOverloadRetry<T = Response>(
  fn: () => Promise<T>,
  opts: OverloadRetryOptions<T> = {},
): Promise<T> {
  const budget = opts.budget ?? { attempt: 0 };
  const pick = opts.pick ?? ((value: T) => value as unknown as Response);
  let result = await fn();
  for (;;) {
    const res = pick(result);
    if (res.ok || opts.signal?.aborted || !OVERLOAD_STATUSES.has(res.status)) return result;
    // Preserve the last response body when there is no retry left.
    if (budget.attempt < OVERLOAD_BACKOFF_MS.length) {
      await res.body?.cancel().catch(() => {});
      opts.release?.(result);
    }
    try {
      if (
        !(await waitForOverloadRetry(budget, {
          reason: `http_${res.status}`,
          signal: opts.signal,
          sleep: opts.sleep,
          retryAfter: res.headers.get("retry-after"),
        }))
      )
        return result;
    } catch (error) {
      if (opts.signal?.aborted) return result;
      throw error;
    }
    result = await fn();
  }
}

/**
 * Run `fn`, retrying ONLY on transient connection errors (per `shouldRetry`) up to
 * `retries` times with `backoffMs` spacing. Stops early — without consuming the next
 * attempt — when `signal` aborts before or during a backoff. Non-transient errors and
 * an exhausted budget rethrow the original error unchanged.
 */
export async function withConnectionRetry<T>(
  fn: () => Promise<T>,
  opts: ConnectionRetryOptions = {},
): Promise<T> {
  const retries = opts.retries ?? DEFAULT_RETRIES;
  const backoff = opts.backoffMs ?? DEFAULT_BACKOFF_MS;
  const sleep = opts.sleep ?? defaultSleep;
  const shouldRetry = opts.shouldRetry ?? isTransientConnectionError;

  let attempt = 0;
  while (true) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= retries || opts.signal?.aborted || !shouldRetry(err)) throw err;
      const delay = backoff[Math.min(attempt, backoff.length - 1)] ?? 0;
      await sleep(delay, opts.signal);
      // A disconnect during the backoff means the client is gone — don't burn
      // another upstream attempt; surface the original failure.
      if (opts.signal?.aborted) throw err;
      attempt += 1;
    }
  }
}
