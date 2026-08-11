// SSE keep-alive heartbeat for STREAMING responses. While the upstream idles
// between chunks, a long-but-healthy stream (slow generation, tool pauses) can be
// severed by a front proxy or client idle-timeout that sees no bytes. We interleave
// an SSE comment (`:\n\n`) — ignored by every compliant SSE parser (OpenAI/Anthropic
// SDKs included) — so the connection stays warm.
//
// Scope (the low-risk variant, issue: upstream transient retry + SSE heartbeat): this
// covers ONLY the inter-chunk gap. The first chunk is peeked inside execute() BEFORE
// the response commits (so pre-first-chunk fallback is preserved); by the time a route
// reaches this loop the first chunk is already in hand. We never emit a heartbeat before
// the first chunk, and never after the stream ends.
//
// `withHeartbeat` decides chunk-vs-beat purely by TIMING and is element-type agnostic.
// EVENT-BOUNDARY SAFETY is the caller's job: a raw byte-relay chunk may split an SSE
// frame across network reads, and injecting `:\n\n` mid-frame would corrupt it — so a
// route that forwards raw bytes must gate the beat on `atEventBoundary(lastWrite)`.
// Routes that write whole frames (writeSSE) are always at a boundary.

/** The keep-alive comment frame. A leading `:` marks an SSE comment line (ignored). */
export const HEARTBEAT_COMMENT = ":\n\n";

export type HeartbeatItem<T> = { type: "chunk"; value: T } | { type: "beat" };

/** A route-owned abort signal for an SSE body, composed with the HTTP request. */
export interface StreamAbort {
  signal: AbortSignal;
  abort: () => void;
}

/**
 * `streamSSE()` learns about response-body cancellation after the HTTP request has
 * already completed. Keep a route-owned controller so that cancellation still
 * reaches a pending provider read and the stream iterator can unwind.
 */
export function createStreamAbort(requestSignal: AbortSignal): StreamAbort {
  const controller = new AbortController();
  return {
    signal: AbortSignal.any([requestSignal, controller.signal]),
    abort: () => controller.abort(),
  };
}

/** Make a release callback safe to invoke from both stream abort and finalization. */
export function onceAsync(release: (() => void | Promise<void>) | undefined): () => Promise<void> {
  let task: Promise<void> | undefined;
  return () => {
    task ??= Promise.resolve().then(async () => {
      await release?.();
    });
    return task;
  };
}

/** Schedule `cb` after `ms`; the returned canceller clears it. Cancels on abort. */
export type ScheduleTimer = (cb: () => void, ms: number, signal?: AbortSignal) => () => void;

export interface HeartbeatOptions {
  /** Beat cadence in ms. <= 0 disables (chunks pass straight through). */
  heartbeatMs: number;
  /** Client-disconnect signal — when aborted the pending timer is cancelled. */
  signal?: AbortSignal;
  /** Injected for tests; defaults to setTimeout. */
  scheduleTimer?: ScheduleTimer;
}

const defaultScheduleTimer: ScheduleTimer = (cb, ms, signal) => {
  if (signal?.aborted) return () => {};
  const timer = setTimeout(cb, ms);
  const onAbort = () => clearTimeout(timer);
  signal?.addEventListener("abort", onAbort, { once: true });
  return () => {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  };
};

function abortWait(signal: AbortSignal | undefined): {
  promise: Promise<{ kind: "abort" }>;
  dispose: () => void;
} {
  let onAbort: (() => void) | undefined;
  const promise = new Promise<{ kind: "abort" }>((resolve) => {
    if (signal?.aborted) {
      resolve({ kind: "abort" });
      return;
    }
    onAbort = () => resolve({ kind: "abort" });
    signal?.addEventListener("abort", onAbort, { once: true });
  });
  return {
    promise,
    dispose: () => {
      if (onAbort !== undefined) signal?.removeEventListener("abort", onAbort);
    },
  };
}

function throwAbortReason(signal: AbortSignal | undefined): never {
  throw signal?.reason ?? new DOMException("The stream was aborted", "AbortError");
}

/**
 * Wrap an async iterable, yielding `{type:"beat"}` whenever it stays silent for
 * `heartbeatMs`, otherwise `{type:"chunk", value}`. The SAME pending `next()` is
 * re-raced across successive beats — it is never called twice for one element, so no
 * upstream chunk is dropped. A source error propagates; on early return the pending
 * timer is cancelled and the source's `return()` is invoked for cleanup.
 */
export async function* withHeartbeat<T>(
  source: AsyncIterable<T>,
  opts: HeartbeatOptions,
): AsyncGenerator<HeartbeatItem<T>> {
  const { heartbeatMs } = opts;
  const schedule = opts.scheduleTimer ?? defaultScheduleTimer;
  const iterator = source[Symbol.asyncIterator]();
  let cancelTimer: () => void = () => {};
  try {
    while (true) {
      const nextPromise = iterator.next();
      if (heartbeatMs <= 0) {
        const abort = abortWait(opts.signal);
        const outcome = await Promise.race([
          nextPromise.then(
            (r) => ({ kind: "next" as const, r }),
            (e) => ({ kind: "error" as const, e }),
          ),
          abort.promise,
        ]);
        abort.dispose();
        if (outcome.kind === "abort") throwAbortReason(opts.signal);
        if (outcome.kind === "error") throw outcome.e;
        const { r } = outcome;
        if (r.done) return;
        yield { type: "chunk", value: r.value };
        continue;
      }
      // Re-race the SAME next() against fresh heartbeat timers until it settles.
      for (;;) {
        let fireBeat!: () => void;
        const beat = new Promise<void>((resolve) => {
          fireBeat = resolve;
        });
        cancelTimer = schedule(fireBeat, heartbeatMs, opts.signal);
        const abort = abortWait(opts.signal);
        const outcome = await Promise.race([
          nextPromise.then(
            (r) => ({ kind: "next" as const, r }),
            (e) => ({ kind: "error" as const, e }),
          ),
          beat.then(() => ({ kind: "beat" as const })),
          abort.promise,
        ]);
        abort.dispose();
        cancelTimer();
        cancelTimer = () => {};
        if (outcome.kind === "abort") throwAbortReason(opts.signal);
        if (outcome.kind === "beat") {
          yield { type: "beat" };
          continue;
        }
        if (outcome.kind === "error") throw outcome.e;
        if (outcome.r.done) return;
        yield { type: "chunk", value: outcome.r.value };
        break;
      }
    }
  } finally {
    cancelTimer();
    const returned = iterator.return?.();
    if (opts.signal?.aborted) {
      // A non-cooperative upstream may remain blocked in `next()` even after the
      // client has gone away. We already delivered the abort signal; do not retain
      // the route's capture buffers and bookkeeping while waiting for it to comply.
      void returned?.catch(() => {});
    } else {
      await returned;
    }
  }
}

/**
 * True when the wire is at an SSE event boundary — safe to inject a heartbeat. The
 * initial state (nothing written yet) and any chunk ending in a blank line (`\n\n`)
 * are boundaries; a chunk that ended mid-frame is not.
 */
export function atEventBoundary(lastRawWrite: string | null): boolean {
  return lastRawWrite === null || lastRawWrite.endsWith("\n\n");
}
