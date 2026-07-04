// Per-key serial mutex with a minimum delay between COMPLETIONS (issue #93,
// feature B). CRS-parity semantics: at most ONE request in flight per key, and
// the next one may start only >= delayMs after the previous one fully completed
// (release() stamps the completion instant — for streaming, the caller releases
// when the stream is fully drained). FIFO promise handoff, no polling; the
// per-key entry is GC'd shortly after the delay window passes so the key space
// never accumulates. Framework-free.

export interface SerialAcquireArgs {
  key: string;
  // Minimum gap between the previous release and the next grant. Each waiter
  // carries its own value so a live settings change applies to queued requests.
  delayMs: number;
  // Max time to wait for the lock + delay before a timeout rejection.
  timeoutMs: number;
  // Client disconnect: a queued waiter is removed and resolves "aborted".
  signal?: AbortSignal;
}

export type SerialAcquireResult =
  | { ok: true; release: () => void }
  | { ok: false; reason: "timeout" | "aborted" };

export interface KeyedSerialGate {
  acquire(args: SerialAcquireArgs): Promise<SerialAcquireResult>;
  // Would a fresh acquire for this key have to wait instead of starting now?
  // Used by the OAuth account pool to prefer another eligible account before it
  // commits a session to a busy subscription account.
  wouldQueue(args: { key: string; delayMs: number }): boolean;
}

export interface KeyedSerialGateDeps {
  now?: () => number;
}

interface Waiter {
  delayMs: number;
  resolve: (r: SerialAcquireResult) => void;
  cleanup: () => void; // clear timeout timer + abort listener
}

interface Entry {
  locked: boolean;
  lastCompletionMs: number | null;
  lastDelayMs: number; // grace window for GC (how long the stamp still matters)
  waiters: Waiter[];
  pumpTimer?: ReturnType<typeof setTimeout>;
  gcTimer?: ReturnType<typeof setTimeout>;
}

export function createKeyedSerialGate(deps: KeyedSerialGateDeps = {}): KeyedSerialGate {
  const now = deps.now ?? (() => Date.now());
  const entries = new Map<string, Entry>();

  // Drop an idle entry once its completion stamp no longer matters (i.e. the
  // delay window has passed). Deleting earlier would silently skip the
  // inter-request delay for the next arrival.
  function scheduleGc(key: string, entry: Entry): void {
    if (entry.locked || entry.waiters.length > 0) return;
    if (entry.gcTimer !== undefined) clearTimeout(entry.gcTimer);
    if (entry.lastCompletionMs === null || entry.lastDelayMs <= 0) {
      entries.delete(key);
      return;
    }
    entry.gcTimer = setTimeout(() => {
      const e = entries.get(key);
      if (e && !e.locked && e.waiters.length === 0) entries.delete(key);
    }, entry.lastDelayMs);
    entry.gcTimer.unref?.();
  }

  // Advance the queue: grant the FIFO head when the lock is free AND the delay
  // since the last completion has elapsed; otherwise arm a timer for the
  // residual delay. Idempotent — safe to call after any state change.
  function pump(key: string): void {
    const entry = entries.get(key);
    if (!entry) return;
    if (entry.pumpTimer !== undefined) {
      clearTimeout(entry.pumpTimer);
      entry.pumpTimer = undefined;
    }
    if (entry.locked) return;
    const head = entry.waiters[0];
    if (!head) {
      scheduleGc(key, entry);
      return;
    }
    const residual =
      entry.lastCompletionMs === null ? 0 : entry.lastCompletionMs + head.delayMs - now();
    if (residual <= 0) {
      entry.waiters.shift();
      head.cleanup();
      entry.locked = true;
      entry.lastDelayMs = head.delayMs;
      head.resolve({ ok: true, release: makeRelease(key) });
      return;
    }
    entry.pumpTimer = setTimeout(() => {
      const e = entries.get(key);
      if (e) e.pumpTimer = undefined;
      pump(key);
    }, residual);
    entry.pumpTimer.unref?.();
  }

  // Idempotent: only the FIRST release unlocks and stamps the completion
  // instant — a stray double release never restamps (which would silently
  // extend the delay window).
  function makeRelease(key: string): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const entry = entries.get(key);
      if (!entry) return;
      entry.locked = false;
      entry.lastCompletionMs = now();
      pump(key);
    };
  }

  return {
    async acquire(args: SerialAcquireArgs): Promise<SerialAcquireResult> {
      if (args.signal?.aborted) return { ok: false, reason: "aborted" };
      let entry = entries.get(args.key);
      if (!entry) {
        entry = { locked: false, lastCompletionMs: null, lastDelayMs: 0, waiters: [] };
        entries.set(args.key, entry);
      }
      if (entry.gcTimer !== undefined) {
        clearTimeout(entry.gcTimer);
        entry.gcTimer = undefined;
      }
      return new Promise<SerialAcquireResult>((resolve) => {
        const waiter: Waiter = { delayMs: args.delayMs, resolve, cleanup: () => {} };
        const fail = (reason: "timeout" | "aborted"): void => {
          const i = entry.waiters.indexOf(waiter);
          if (i >= 0) entry.waiters.splice(i, 1);
          waiter.cleanup();
          // Re-pump: the head may have changed (different delayMs) or the
          // queue may now be empty (GC).
          pump(args.key);
          resolve({ ok: false, reason });
        };
        const timer = setTimeout(() => fail("timeout"), args.timeoutMs);
        timer.unref?.();
        const onAbort = (): void => fail("aborted");
        args.signal?.addEventListener("abort", onAbort, { once: true });
        waiter.cleanup = () => {
          clearTimeout(timer);
          args.signal?.removeEventListener("abort", onAbort);
        };
        entry.waiters.push(waiter);
        pump(args.key);
      });
    },

    wouldQueue(args: { key: string; delayMs: number }): boolean {
      const entry = entries.get(args.key);
      if (!entry) return false;
      if (entry.locked || entry.waiters.length > 0) return true;
      if (entry.lastCompletionMs === null || args.delayMs <= 0) return false;
      return entry.lastCompletionMs + args.delayMs > now();
    },
  };
}
