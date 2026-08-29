// stream-idle — inter-chunk liveness guard for the provider SSE readers.
//
// WHY: the provider clients clear their connect/TTFB timeout the moment response
// headers arrive (see `withTimeout` in openai/anthropic/openai-responses), so the
// chunk-reading loop afterwards runs with NO deadline. That is correct for a
// healthy long stream (it keeps emitting tokens), but a wedged upstream that goes
// silent MID-stream would otherwise hang the request indefinitely — there is no
// total-request wall-clock on the streaming path either (the gateway timeout
// middleware resolves once the SSE Response is returned). This guard closes that
// gap: each `reader.read()` is raced against an idle deadline. A chunk in time
// passes through untouched; silence past the deadline cancels the reader (so the
// undici connection is reclaimed and stops billing) and throws StreamStalledError.
//
// The deadline is PER-CHUNK silence, never a total-stream cap: every call owns a
// fresh timer, so a stream that keeps producing — however long in total — never
// trips it. Only a gap of `idleMs` with no data does. The client converts the
// thrown StreamStalledError into UpstreamError("timeout"); thrown BEFORE the first
// chunk it is a normal pre-first-chunk failure (executor may fall back), thrown
// AFTER it terminates an already-streaming response (no fallback possible). A
// non-positive `idleMs` disables the guard entirely (a plain read).

/** Marker the idle deadline resolves with; a distinct object so it can never
 *  collide with a legitimate read result. */
const STALLED = Symbol("stream_stalled");

/** Thrown by readChunkWithIdle when the upstream produced no chunk within the
 *  idle deadline. The provider client maps it to UpstreamError("timeout"). */
export class StreamStalledError extends Error {
  override readonly name = "StreamStalledError";
  readonly idleMs: number;
  constructor(idleMs: number) {
    super(`upstream stream produced no data for ${idleMs}ms`);
    this.idleMs = idleMs;
  }
}

/** The result of one read: `{done:false, value:T}` for a chunk, `{done:true}` at
 *  end of stream. Defined locally so the guard needs no DOM/stream lib types; a
 *  real `ReadableStreamDefaultReader`'s read result is structurally assignable. */
export interface IdleReadResult<T> {
  done: boolean;
  value?: T;
}

/** Minimal reader shape (a `ReadableStreamDefaultReader` satisfies it). Kept loose
 *  so the readers' own `read`/`cancel` plug in directly and tests can fake them. */
export interface IdleReader<T> {
  read(): Promise<IdleReadResult<T>>;
  cancel(reason?: unknown): Promise<void>;
}

/**
 * One `reader.read()` with an idle deadline. Resolves with the read result when a
 * chunk (or terminal `done`) arrives within `idleMs`; on a deadline win, cancels
 * the reader and throws StreamStalledError. `idleMs <= 0` skips the race entirely.
 */
export async function readChunkWithIdle<T>(
  reader: IdleReader<T>,
  idleMs: number,
  signal?: AbortSignal,
): Promise<IdleReadResult<T>> {
  if (signal?.aborted)
    throw signal.reason ?? new DOMException("The operation was aborted", "AbortError");
  if (!(idleMs > 0) && signal === undefined) return reader.read();

  let timer: ReturnType<typeof setTimeout> | undefined;
  const idle =
    idleMs > 0
      ? new Promise<typeof STALLED>((resolve) => {
          timer = setTimeout(() => resolve(STALLED), idleMs);
        })
      : null;
  let abort: Promise<never> | null = null;
  let onAbort: (() => void) | undefined;
  if (signal !== undefined) {
    abort = new Promise<never>((_, reject) => {
      onAbort = () =>
        reject(signal.reason ?? new DOMException("The operation was aborted", "AbortError"));
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }

  const read = reader.read();
  // If the deadline wins, `read` is still pending; swallow any later rejection so
  // it never surfaces as an unhandled rejection after we have already thrown.
  read.catch(() => {});

  try {
    const raced = await Promise.race([read, ...(idle ? [idle] : []), ...(abort ? [abort] : [])]);
    if (raced === STALLED) {
      const err = new StreamStalledError(idleMs);
      // Fire-and-forget: a slow or never-resolving cancel must NOT delay the
      // timeout — awaiting it would defeat the very liveness guarantee this guard
      // exists for. Reclaim the connection best-effort and throw immediately.
      void reader.cancel(err).catch(() => {});
      throw err;
    }
    return raced;
  } catch (error) {
    if (signal?.aborted) void reader.cancel(error).catch(() => {});
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
    if (signal !== undefined && onAbort !== undefined) signal.removeEventListener("abort", onAbort);
  }
}
