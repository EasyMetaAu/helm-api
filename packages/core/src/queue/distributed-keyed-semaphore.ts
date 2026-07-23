import { randomUUID } from "node:crypto";
import type { ConcurrencyLeaseStore } from "../store/ports.js";

export type DistributedAcquireResult =
  | { ok: true; signal: AbortSignal; release: () => Promise<void> }
  | { ok: false; reason: "queue_full" | "timeout" | "aborted" | "unavailable" };

export interface DistributedAcquireArgs {
  key: string;
  limit: number | null;
  maxQueue: number;
  timeoutMs: number;
  signal?: AbortSignal;
}

export interface DistributedKeyedSemaphore {
  acquire(args: DistributedAcquireArgs): Promise<DistributedAcquireResult>;
  shutdown(): Promise<void>;
}

export interface DistributedKeyedSemaphoreOptions {
  store: ConcurrencyLeaseStore;
  ownerId: string;
  leaseTtlMs?: number;
  heartbeatIntervalMs?: number;
  /** @deprecated Poll delay uses bounded jitter; retained for source compatibility. */
  pollIntervalMs?: number;
  /** Bounded 100–250ms random backoff for unsuccessful distributed polls. */
  random?: () => number;
  createLeaseId?: () => string;
  log?: (level: "warn" | "info", message: string, fields: Record<string, unknown>) => void;
}

interface Waiter {
  args: DistributedAcquireArgs;
  leaseId: string;
  resolve: (result: DistributedAcquireResult) => void;
  cleanup: () => void;
}

interface Holder {
  release: () => Promise<void>;
}

const DEFAULT_TTL_MS = 30_000;
const DEFAULT_HEARTBEAT_MS = 10_000;

export function createDistributedKeyedSemaphore(
  options: DistributedKeyedSemaphoreOptions,
): DistributedKeyedSemaphore {
  const ttlMs = options.leaseTtlMs ?? DEFAULT_TTL_MS;
  const heartbeatMs = options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_MS;
  const queues = new Map<string, Waiter[]>();
  const holders = new Set<Holder>();
  const polls = new Map<string, Promise<void>>();
  const pollTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const inFlightAcquires = new Set<Promise<void>>();
  let stopped = false;

  const removeWaiter = (key: string, waiter: Waiter): void => {
    const queue = queues.get(key);
    if (!queue) return;
    const index = queue.indexOf(waiter);
    if (index >= 0) queue.splice(index, 1);
    if (queue.length === 0) queues.delete(key);
  };

  const processHead = async (key: string): Promise<void> => {
    if (polls.has(key)) return;
    const staleTimer = pollTimers.get(key);
    if (staleTimer) {
      clearTimeout(staleTimer);
      pollTimers.delete(key);
    }
    let retry = false;
    const run = (async () => {
      const queue = queues.get(key);
      const waiter = queue?.[0];
      if (!waiter || stopped) return;
      const { args } = waiter;
      if (args.signal?.aborted) {
        removeWaiter(key, waiter);
        waiter.cleanup();
        waiter.resolve({ ok: false, reason: "aborted" });
        return;
      }
      const leaseId = waiter.leaseId;
      let acquired: { acquired: boolean; expiresAtMs: number };
      const acquireStartedAt = Date.now();
      try {
        acquired = await options.store.tryAcquire({
          keyId: key,
          leaseId,
          ownerId: options.ownerId,
          limit: args.limit as number,
          ttlMs,
        });
      } catch {
        if (queues.get(key)?.[0] === waiter) {
          removeWaiter(key, waiter);
          waiter.cleanup();
          waiter.resolve({ ok: false, reason: "unavailable" });
        }
        return;
      }
      // Timeout, abort, or shutdown may remove this waiter while DB transaction is
      // in flight. If it acquired anyway, delete orphan immediately; never create a
      // holder/heartbeat for caller whose promise already resolved.
      if (queues.get(key)?.[0] !== waiter || stopped) {
        if (acquired.acquired) {
          try {
            await options.store.release({ keyId: key, leaseId, ownerId: options.ownerId });
          } catch {
            options.log?.("warn", "concurrency.lease.release_failed", {
              key_id: key,
              lease_id: leaseId,
              owner_id: options.ownerId,
              reason: "release_failed",
            });
          }
        }
        return;
      }
      if (!acquired.acquired) {
        retry = true;
        return;
      }
      removeWaiter(key, waiter);
      waiter.cleanup();
      const controller = new AbortController();
      let released = false;
      let releasePromise: Promise<void> | undefined;
      let heartbeat: ReturnType<typeof setInterval> | undefined;
      let ownershipDeadline: ReturnType<typeof setTimeout> | undefined;
      let renewInFlight = false;
      const holder: Holder = {
        release: () => {
          if (releasePromise) return releasePromise;
          released = true;
          if (heartbeat) clearInterval(heartbeat);
          if (ownershipDeadline) clearTimeout(ownershipDeadline);
          releasePromise = (async () => {
            try {
              await options.store.release({ keyId: key, leaseId, ownerId: options.ownerId });
            } catch {
              options.log?.("warn", "concurrency.lease.release_failed", {
                key_id: key,
                lease_id: leaseId,
                owner_id: options.ownerId,
                reason: "release_failed",
              });
            } finally {
              holders.delete(holder);
            }
            void processHead(key);
          })();
          return releasePromise;
        },
      };
      holders.add(holder);
      const loseOwnership = (): void => {
        if (released) return;
        controller.abort("lease_lost");
        void holder.release();
      };
      const armOwnershipDeadline = (expiresAtMs: number): void => {
        if (ownershipDeadline) clearTimeout(ownershipDeadline);
        const remainingMs = expiresAtMs - Date.now();
        if (remainingMs <= 0) {
          loseOwnership();
          return;
        }
        ownershipDeadline = setTimeout(loseOwnership, remainingMs);
        ownershipDeadline.unref?.();
      };
      // DB timestamp is authoritative, but replica/DB clocks may differ. Never trust
      // more than one local TTL from request start; response latency consumes TTL.
      armOwnershipDeadline(Math.min(acquired.expiresAtMs, acquireStartedAt + ttlMs));
      heartbeat = setInterval(() => {
        if (renewInFlight || released) return;
        renewInFlight = true;
        const renewStartedAt = Date.now();
        void options.store
          .renew({ keyId: key, leaseId, ownerId: options.ownerId, ttlMs })
          .then((renewed) => {
            renewInFlight = false;
            if (released) return;
            if (!renewed.renewed) {
              loseOwnership();
              return;
            }
            armOwnershipDeadline(Math.min(renewed.expiresAtMs, renewStartedAt + ttlMs));
          })
          .catch(() => {
            renewInFlight = false;
            loseOwnership();
          });
      }, heartbeatMs);
      heartbeat.unref?.();
      waiter.resolve({ ok: true, signal: controller.signal, release: holder.release });
    })();
    polls.set(key, run);
    inFlightAcquires.add(run);
    void run.finally(() => {
      polls.delete(key);
      inFlightAcquires.delete(run);
      if (retry) schedulePoll(key);
      else if (!stopped && queues.get(key)?.length) void processHead(key);
    });
  };

  const schedulePoll = (key: string): void => {
    // A replica may have many FIFO waiters behind its queue head. Only the head
    // talks to PostgreSQL, but it must keep polling while any waiter remains;
    // requiring exactly one waiter strands a loaded replica after its first
    // failed acquire and eventually times out the entire local queue.
    if (stopped || polls.has(key) || pollTimers.has(key) || !queues.get(key)?.length) return;
    const delay = 100 + Math.floor((options.random?.() ?? Math.random()) * 151);
    const timer = setTimeout(() => {
      pollTimers.delete(key);
      void processHead(key);
    }, delay);
    timer.unref?.();
    pollTimers.set(key, timer);
  };

  return {
    async acquire(args): Promise<DistributedAcquireResult> {
      if (args.limit === null || args.limit <= 0) {
        return {
          ok: true,
          signal: args.signal ?? new AbortController().signal,
          release: async () => {},
        };
      }
      if (stopped) return { ok: false, reason: "unavailable" };
      if (args.signal?.aborted) return { ok: false, reason: "aborted" };
      const queue = queues.get(args.key) ?? [];
      queues.set(args.key, queue);
      if (queue.length >= args.maxQueue) return { ok: false, reason: "queue_full" };
      return new Promise<DistributedAcquireResult>((resolve) => {
        const waiter: Waiter = {
          args,
          leaseId: (options.createLeaseId ?? randomUUID)(),
          resolve,
          cleanup: () => {},
        };
        const fail = (reason: "timeout" | "aborted"): void => {
          removeWaiter(args.key, waiter);
          waiter.cleanup();
          resolve({ ok: false, reason });
          void processHead(args.key);
        };
        const timeout = setTimeout(() => fail("timeout"), args.timeoutMs);
        timeout.unref?.();
        const abort = () => fail("aborted");
        args.signal?.addEventListener("abort", abort, { once: true });
        waiter.cleanup = () => {
          clearTimeout(timeout);
          args.signal?.removeEventListener("abort", abort);
        };
        queue.push(waiter);
        if (queue.length === 1) void processHead(args.key);
      });
    },

    async shutdown(): Promise<void> {
      stopped = true;
      for (const timer of pollTimers.values()) clearTimeout(timer);
      pollTimers.clear();
      for (const queue of queues.values()) {
        for (const waiter of queue.splice(0)) {
          waiter.cleanup();
          waiter.resolve({ ok: false, reason: "unavailable" });
        }
      }
      queues.clear();
      await Promise.all([...inFlightAcquires]);
      await Promise.all([...holders].map((holder) => holder.release()));
    },
  };
}
