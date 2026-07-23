import { afterEach, describe, expect, it, vi } from "vitest";
import * as coreExports from "../index.js";

interface LeaseStore {
  tryAcquire(input: {
    keyId: string;
    leaseId: string;
    ownerId: string;
    limit: number;
    ttlMs: number;
  }): Promise<{ acquired: boolean; expiresAtMs: number }>;
  renew(input: {
    keyId: string;
    leaseId: string;
    ownerId: string;
    ttlMs: number;
  }): Promise<{ renewed: boolean; expiresAtMs: number }>;
  release(input: { keyId: string; leaseId: string; ownerId: string }): Promise<void>;
}

type AcquireResult =
  | { ok: true; signal: AbortSignal; release: () => Promise<void> }
  | { ok: false; reason: "queue_full" | "timeout" | "aborted" | "unavailable" };

interface DistributedSemaphore {
  acquire(input: {
    key: string;
    limit: number | null;
    maxQueue: number;
    timeoutMs: number;
    signal?: AbortSignal;
  }): Promise<AcquireResult>;
  shutdown(): Promise<void>;
}

interface FactoryOptions {
  store: LeaseStore;
  ownerId: string;
  leaseTtlMs: number;
  heartbeatIntervalMs: number;
  pollIntervalMs: number;
  createLeaseId: () => string;
  random?: () => number;
}

type DistributedSemaphoreFactory = (options: FactoryOptions) => DistributedSemaphore;

function distributedSemaphore(options: FactoryOptions): DistributedSemaphore {
  const factory = Reflect.get(coreExports, "createDistributedKeyedSemaphore");
  expect(factory, "core must expose the distributed keyed semaphore manager").toBeTypeOf(
    "function",
  );
  return (factory as DistributedSemaphoreFactory)(options);
}

class FakeLeaseStore implements LeaseStore {
  readonly tryAcquireCalls: Array<Parameters<LeaseStore["tryAcquire"]>[0]> = [];
  readonly renewCalls: Array<Parameters<LeaseStore["renew"]>[0]> = [];
  readonly releaseCalls: Array<Parameters<LeaseStore["release"]>[0]> = [];
  readonly active = new Map<string, Set<string>>();
  throwAcquire = false;
  renews = true;
  hangRenew = false;
  releaseDelayMs = 0;
  releaseThrows = false;
  acquireDelayMs = 0;
  acquireResponseDelayMs = 0;

  async tryAcquire(input: Parameters<LeaseStore["tryAcquire"]>[0]) {
    this.tryAcquireCalls.push(input);
    if (this.acquireDelayMs > 0) await delay(this.acquireDelayMs);
    if (this.throwAcquire) throw new Error("database unavailable");
    const active = this.active.get(input.keyId) ?? new Set<string>();
    this.active.set(input.keyId, active);
    if (active.size >= input.limit) return { acquired: false, expiresAtMs: Date.now() };
    active.add(input.leaseId);
    const result = { acquired: true, expiresAtMs: Date.now() + input.ttlMs };
    if (this.acquireResponseDelayMs > 0) await delay(this.acquireResponseDelayMs);
    return result;
  }

  async renew(input: Parameters<LeaseStore["renew"]>[0]) {
    this.renewCalls.push(input);
    if (this.hangRenew) await new Promise<never>(() => {});
    return { renewed: this.renews, expiresAtMs: Date.now() + input.ttlMs };
  }

  async release(input: Parameters<LeaseStore["release"]>[0]): Promise<void> {
    this.releaseCalls.push(input);
    if (this.releaseDelayMs > 0) await delay(this.releaseDelayMs);
    if (this.releaseThrows) throw new Error("release unavailable");
    this.active.get(input.keyId)?.delete(input.leaseId);
  }
}

const openManagers: DistributedSemaphore[] = [];
let nextLeaseId = 0;

function manager(store = new FakeLeaseStore(), overrides: Partial<FactoryOptions> = {}) {
  const semaphore = distributedSemaphore({
    store,
    ownerId: "replica-a",
    leaseTtlMs: 60,
    heartbeatIntervalMs: 15,
    pollIntervalMs: 5,
    createLeaseId: () => `lease-${++nextLeaseId}`,
    ...overrides,
  });
  openManagers.push(semaphore);
  return { semaphore, store };
}

const args = (overrides: Partial<Parameters<DistributedSemaphore["acquire"]>[0]> = {}) => ({
  key: "key-one",
  limit: 1 as number | null,
  maxQueue: 5,
  timeoutMs: 200,
  ...overrides,
});

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

describe("createDistributedKeyedSemaphore", () => {
  afterEach(async () => {
    await Promise.all(openManagers.splice(0).map((semaphore) => semaphore.shutdown()));
  });

  it("does not touch the lease store when disabled by an unlimited limit", async () => {
    const { semaphore, store } = manager();
    for (const limit of [null, 0, -1]) {
      const acquired = await semaphore.acquire(args({ limit }));
      expect(acquired.ok).toBe(true);
      if (acquired.ok) await acquired.release();
    }
    expect(store.tryAcquireCalls).toEqual([]);
    expect(store.renewCalls).toEqual([]);
    expect(store.releaseCalls).toEqual([]);
  });

  it("keeps a per-replica FIFO and lets only its queue head poll the database", async () => {
    const { semaphore, store } = manager();
    const held = await semaphore.acquire(args());
    expect(held.ok).toBe(true);

    const order: string[] = [];
    const second = semaphore.acquire(args()).then((result) => {
      order.push("second");
      return result;
    });
    const third = semaphore.acquire(args()).then((result) => {
      order.push("third");
      return result;
    });
    await delay(20);

    const waitingLeaseIds = new Set(store.tryAcquireCalls.slice(1).map((call) => call.leaseId));
    expect(waitingLeaseIds.size).toBe(1);
    if (held.ok) await held.release();

    const secondLease = await second;
    expect(order).toEqual(["second"]);
    if (secondLease.ok) await secondLease.release();
    const thirdLease = await third;
    expect(order).toEqual(["second", "third"]);
    if (thirdLease.ok) await thirdLease.release();
  });

  it("removes a timed-out or aborted waiter without disturbing the holder", async () => {
    const { semaphore } = manager();
    const held = await semaphore.acquire(args());
    const timedOut = semaphore.acquire(args({ timeoutMs: 15 }));
    expect(await timedOut).toEqual({ ok: false, reason: "timeout" });

    const controller = new AbortController();
    const aborted = semaphore.acquire(args({ signal: controller.signal }));
    controller.abort();
    expect(await aborted).toEqual({ ok: false, reason: "aborted" });
    if (held.ok) await held.release();
  });

  it("releases an orphan lease acquired after its waiter timed out", async () => {
    const store = new FakeLeaseStore();
    store.acquireDelayMs = 25;
    const { semaphore } = manager(store);

    expect(await semaphore.acquire(args({ timeoutMs: 5 }))).toEqual({
      ok: false,
      reason: "timeout",
    });
    await delay(35);

    expect(store.releaseCalls).toHaveLength(1);
    expect(store.active.get("key-one")?.size ?? 0).toBe(0);
  });

  it("heartbeats a holder and aborts its unified signal when ownership is lost", async () => {
    const { semaphore, store } = manager();
    const held = await semaphore.acquire(args());
    expect(held.ok).toBe(true);
    if (!held.ok) return;

    store.renews = false;
    await delay(25);

    expect(store.renewCalls.length).toBeGreaterThan(0);
    expect(held.signal.aborted).toBe(true);
    expect(String(held.signal.reason)).toContain("lease_lost");
    await held.release();
  });

  it("aborts before expiry when a heartbeat never proves continued ownership", async () => {
    const { semaphore, store } = manager();
    const held = await semaphore.acquire(args());
    expect(held.ok).toBe(true);
    if (!held.ok) return;

    store.hangRenew = true;
    await delay(70);

    expect(held.signal.aborted).toBe(true);
    expect(String(held.signal.reason)).toContain("lease_lost");
  });

  it("returns unavailable before admission when the lease database fails", async () => {
    const store = new FakeLeaseStore();
    store.throwAcquire = true;
    const { semaphore } = manager(store);
    expect(await semaphore.acquire(args())).toEqual({ ok: false, reason: "unavailable" });
  });

  it("makes concurrent release callers await the same asynchronous DB release", async () => {
    const store = new FakeLeaseStore();
    store.releaseDelayMs = 25;
    const { semaphore } = manager(store);
    const held = await semaphore.acquire(args());
    expect(held.ok).toBe(true);
    if (!held.ok) return;

    let secondDone = false;
    const first = held.release();
    const second = held.release().then(() => {
      secondDone = true;
    });
    await delay(5);
    expect(secondDone).toBe(false);
    await Promise.all([first, second]);
    expect(store.releaseCalls).toHaveLength(1);
  });

  it("uses DB expiry minus response latency as ownership deadline", async () => {
    const store = new FakeLeaseStore();
    store.acquireResponseDelayMs = 35;
    const { semaphore } = manager(store, { leaseTtlMs: 60, heartbeatIntervalMs: 1_000 });
    const held = await semaphore.acquire(args());
    expect(held.ok).toBe(true);
    if (!held.ok) return;

    await delay(30);
    expect(held.signal.aborted).toBe(true);
  });

  it("allows only one in-flight poll per key and cancels stale poll timers", async () => {
    const store = new FakeLeaseStore();
    store.acquireDelayMs = 20;
    const { semaphore } = manager(store, { pollIntervalMs: 1 });
    const held = await semaphore.acquire(args());
    expect(held.ok).toBe(true);
    const waiting = semaphore.acquire(args({ timeoutMs: 8 }));
    expect(await waiting).toEqual({ ok: false, reason: "timeout" });
    await delay(35);

    const waitingCalls = store.tryAcquireCalls.slice(1);
    expect(waitingCalls).toHaveLength(1);
    if (held.ok) await held.release();
  });

  it("drains an in-flight acquire orphan before shutdown resolves", async () => {
    const store = new FakeLeaseStore();
    store.acquireDelayMs = 25;
    const { semaphore } = manager(store);
    const pending = semaphore.acquire(args());
    await delay(2);
    await semaphore.shutdown();

    expect(await pending).toEqual({ ok: false, reason: "unavailable" });
    expect(store.releaseCalls).toHaveLength(1);
  });

  it("adds injectable jitter to unsuccessful polls", async () => {
    const store = new FakeLeaseStore();
    const random = vi.fn(() => 0.5);
    const { semaphore } = manager(store, { random, pollIntervalMs: 10 });
    const held = await semaphore.acquire(args());
    const waiting = semaphore.acquire(args({ timeoutMs: 30 }));
    await delay(15);

    expect(random).toHaveBeenCalled();
    if (held.ok) await held.release();
    const next = await waiting;
    if (next.ok) await next.release();
  });

  it("shutdown waits for a release already in flight", async () => {
    const store = new FakeLeaseStore();
    store.releaseDelayMs = 25;
    const { semaphore } = manager(store);
    const held = await semaphore.acquire(args());
    expect(held.ok).toBe(true);
    if (!held.ok) return;

    void held.release();
    let shutdownDone = false;
    const shutdown = semaphore.shutdown().then(() => {
      shutdownDone = true;
    });
    await delay(5);
    expect(shutdownDone).toBe(false);
    await shutdown;
  });

  it("makes async release idempotent and shutdown best-effort releases every holder", async () => {
    const { semaphore, store } = manager();
    const first = await semaphore.acquire(args({ key: "key-a" }));
    const second = await semaphore.acquire(args({ key: "key-b" }));
    expect(first.ok && second.ok).toBe(true);

    if (first.ok) await Promise.all([first.release(), first.release()]);
    expect(store.releaseCalls.filter((call) => call.keyId === "key-a")).toHaveLength(1);

    await semaphore.shutdown();
    expect(store.releaseCalls.filter((call) => call.keyId === "key-b")).toHaveLength(1);
  });
});
