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
