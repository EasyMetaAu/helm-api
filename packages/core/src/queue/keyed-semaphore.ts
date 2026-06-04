// Per-key counting semaphore with FIFO overflow queue (issue #93, feature A).
// In-memory and promise-based: a release hands its slot DIRECTLY to the queue
// head (no polling, no lost wakeups), unlike the Redis poll-with-backoff the
// reference implementation (claude-relay-service) needs for multi-process.
// Single-process by design — see implementation-notes.md for the multi-instance
// caveat. Framework-free: the gateway wires it behind a middleware/port.

export interface AcquireArgs {
  key: string;
  // Max in-flight for this key. null / <= 0 => unlimited: an immediate no-op
  // lease is returned and nothing is tracked.
  limit: number | null;
  // Max queued waiters; at-limit acquires beyond this reject queue_full
  // immediately (caller computes MAX(multiplier × limit, min_size)).
  maxQueue: number;
  // Max time a waiter may sit in the queue before a timeout rejection.
  timeoutMs: number;
  // Client disconnect: a queued waiter is removed and resolves "aborted".
  signal?: AbortSignal;
  // Watchdog: force-release a lease still held after this long (leak guard for
  // a release path that never ran). Releases are idempotent, so a late "real"
  // release after the watchdog fired is a harmless no-op.
  maxHoldMs?: number;
}

export type AcquireResult =
  | { ok: true; release: () => void }
  | { ok: false; reason: "queue_full" | "timeout" | "aborted" };

export interface KeyedSemaphore {
  acquire(args: AcquireArgs): Promise<AcquireResult>;
  // Observability/test hooks: current holders / queued waiters for a key.
  inFlight(key: string): number;
  queued(key: string): number;
}

export interface KeyedSemaphoreDeps {
  log?: (level: "warn" | "info", msg: string, fields?: Record<string, unknown>) => void;
}

// A stream can legitimately run for minutes; the watchdog exists only to catch
// a leaked lease (release path never reached), so it sits well above any sane
// request duration.
const DEFAULT_MAX_HOLD_MS = 300_000;

interface Waiter {
  resolve: (r: AcquireResult) => void;
  maxHoldMs: number;
  cleanup: () => void; // clear timeout timer + abort listener
}

interface Entry {
  active: number;
  waiters: Waiter[];
}

export function createKeyedSemaphore(deps: KeyedSemaphoreDeps = {}): KeyedSemaphore {
  const entries = new Map<string, Entry>();

  // Drop the map entry once nothing references it — per-key state must never
  // accumulate across the key space.
  function gcIfIdle(key: string): void {
    const entry = entries.get(key);
    if (entry && entry.active <= 0 && entry.waiters.length === 0) entries.delete(key);
  }

  // Mint a lease for a slot the caller now owns. Idempotent: only the first
  // release (or the watchdog, whichever comes first) frees the slot.
  function grantLease(key: string, maxHoldMs: number): () => void {
    let released = false;
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    const release = (): void => {
      if (released) return;
      released = true;
      if (watchdog !== undefined) clearTimeout(watchdog);
      handoff(key);
    };
    if (maxHoldMs > 0) {
      watchdog = setTimeout(() => {
        deps.log?.("warn", "queue.semaphore.watchdog_release", { key, max_hold_ms: maxHoldMs });
        release();
      }, maxHoldMs);
      watchdog.unref?.();
    }
    return release;
  }

  // Free one slot: transfer it to the FIFO head if anyone is waiting (active
  // count unchanged — the slot never visibly drops), else decrement and GC.
  function handoff(key: string): void {
    const entry = entries.get(key);
    if (!entry) return;
    const next = entry.waiters.shift();
    if (next) {
      next.cleanup();
      next.resolve({ ok: true, release: grantLease(key, next.maxHoldMs) });
      return;
    }
    entry.active -= 1;
    gcIfIdle(key);
  }

  return {
    async acquire(args: AcquireArgs): Promise<AcquireResult> {
      if (args.limit === null || args.limit <= 0) {
        // Unlimited: nothing to count, nothing to release.
        return { ok: true, release: () => {} };
      }
      if (args.signal?.aborted) return { ok: false, reason: "aborted" };
      const maxHoldMs = args.maxHoldMs ?? DEFAULT_MAX_HOLD_MS;
      let entry = entries.get(args.key);
      if (!entry) {
        entry = { active: 0, waiters: [] };
        entries.set(args.key, entry);
      }
      if (entry.active < args.limit) {
        entry.active += 1;
        return { ok: true, release: grantLease(args.key, maxHoldMs) };
      }
      if (entry.waiters.length >= args.maxQueue) {
        // Entry cannot be idle here (active >= limit > 0) — no GC needed.
        return { ok: false, reason: "queue_full" };
      }
      return new Promise<AcquireResult>((resolve) => {
        const waiter: Waiter = { resolve, maxHoldMs, cleanup: () => {} };
        const fail = (reason: "timeout" | "aborted"): void => {
          const i = entry.waiters.indexOf(waiter);
          if (i >= 0) entry.waiters.splice(i, 1);
          waiter.cleanup();
          gcIfIdle(args.key);
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
      });
    },

    inFlight(key: string): number {
      return entries.get(key)?.active ?? 0;
    },

    queued(key: string): number {
      return entries.get(key)?.waiters.length ?? 0;
    },
  };
}
