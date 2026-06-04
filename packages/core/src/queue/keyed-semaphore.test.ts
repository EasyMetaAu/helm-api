import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createKeyedSemaphore } from "./keyed-semaphore.js";

// Per-key counting semaphore with FIFO overflow queue (issue #93 feature A).
// In-memory, promise-based direct handoff — no polling. Tests drive time with
// vitest fake timers (setTimeout + Date are both faked).

describe("createKeyedSemaphore", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const args = (over: Record<string, unknown> = {}) => ({
    key: "k1",
    limit: 1 as number | null,
    maxQueue: 5,
    timeoutMs: 10_000,
    ...over,
  });

  it("null / non-positive limit => immediate noop lease (unlimited)", async () => {
    const sem = createKeyedSemaphore();
    for (const limit of [null, 0, -1]) {
      const res = await sem.acquire(args({ limit }));
      expect(res.ok).toBe(true);
      if (res.ok) res.release();
    }
    expect(sem.inFlight("k1")).toBe(0);
  });

  it("grants immediately under the limit and counts in-flight", async () => {
    const sem = createKeyedSemaphore();
    const a = await sem.acquire(args({ limit: 2 }));
    const b = await sem.acquire(args({ limit: 2 }));
    expect(a.ok && b.ok).toBe(true);
    expect(sem.inFlight("k1")).toBe(2);
    if (a.ok) a.release();
    expect(sem.inFlight("k1")).toBe(1);
    if (b.ok) b.release();
    expect(sem.inFlight("k1")).toBe(0);
  });

  it("queues at the limit and hands the slot to the FIFO head on release", async () => {
    const sem = createKeyedSemaphore();
    const first = await sem.acquire(args());
    expect(first.ok).toBe(true);
    const order: string[] = [];
    const second = sem.acquire(args()).then((r) => {
      order.push("second");
      return r;
    });
    const third = sem.acquire(args()).then((r) => {
      order.push("third");
      return r;
    });
    expect(sem.queued("k1")).toBe(2);
    if (first.ok) first.release();
    const secondRes = await second;
    expect(secondRes.ok).toBe(true);
    expect(order).toEqual(["second"]);
    expect(sem.inFlight("k1")).toBe(1); // slot transferred, never dropped to 0
    if (secondRes.ok) secondRes.release();
    const thirdRes = await third;
    expect(thirdRes.ok).toBe(true);
    expect(order).toEqual(["second", "third"]);
    if (thirdRes.ok) thirdRes.release();
  });

  it("rejects queue_full immediately when waiters >= maxQueue (no enqueue)", async () => {
    const sem = createKeyedSemaphore();
    const lease = await sem.acquire(args({ maxQueue: 1 }));
    expect(lease.ok).toBe(true);
    const queued = sem.acquire(args({ maxQueue: 1 }));
    const overflow = await sem.acquire(args({ maxQueue: 1 }));
    expect(overflow).toEqual({ ok: false, reason: "queue_full" });
    if (lease.ok) lease.release();
    expect((await queued).ok).toBe(true);
  });

  it("times out a queued waiter and frees its queue spot", async () => {
    const sem = createKeyedSemaphore();
    const lease = await sem.acquire(args());
    const waiting = sem.acquire(args({ timeoutMs: 3_000 }));
    await vi.advanceTimersByTimeAsync(3_000);
    expect(await waiting).toEqual({ ok: false, reason: "timeout" });
    expect(sem.queued("k1")).toBe(0);
    // The holder is untouched; a later release still works.
    if (lease.ok) lease.release();
    expect(sem.inFlight("k1")).toBe(0);
  });

  it("aborts a queued waiter via AbortSignal", async () => {
    const sem = createKeyedSemaphore();
    const lease = await sem.acquire(args());
    const ac = new AbortController();
    const waiting = sem.acquire(args({ signal: ac.signal }));
    ac.abort();
    expect(await waiting).toEqual({ ok: false, reason: "aborted" });
    expect(sem.queued("k1")).toBe(0);
    if (lease.ok) lease.release();
  });

  it("resolves aborted immediately when the signal is already aborted", async () => {
    const sem = createKeyedSemaphore();
    const lease = await sem.acquire(args());
    const ac = new AbortController();
    ac.abort();
    expect(await sem.acquire(args({ signal: ac.signal }))).toEqual({
      ok: false,
      reason: "aborted",
    });
    if (lease.ok) lease.release();
  });

  it("release is idempotent (double release never frees two slots)", async () => {
    const sem = createKeyedSemaphore();
    const a = await sem.acquire(args({ limit: 1 }));
    const b = sem.acquire(args({ limit: 1 }));
    const c = sem.acquire(args({ limit: 1 }));
    if (a.ok) {
      a.release();
      a.release(); // second call must be a no-op
    }
    const bRes = await b;
    expect(bRes.ok).toBe(true);
    // c must still be waiting: a's double-release must NOT have freed a 2nd slot.
    expect(sem.queued("k1")).toBe(1);
    if (bRes.ok) bRes.release();
    expect((await c).ok).toBe(true);
  });

  it("keys are independent", async () => {
    const sem = createKeyedSemaphore();
    const a = await sem.acquire(args({ key: "ka" }));
    const b = await sem.acquire(args({ key: "kb" }));
    expect(a.ok && b.ok).toBe(true);
    expect(sem.inFlight("ka")).toBe(1);
    expect(sem.inFlight("kb")).toBe(1);
    if (a.ok) a.release();
    if (b.ok) b.release();
  });

  it("GCs the per-key entry when idle (no leak)", async () => {
    const sem = createKeyedSemaphore();
    const a = await sem.acquire(args());
    if (a.ok) a.release();
    expect(sem.inFlight("k1")).toBe(0);
    expect(sem.queued("k1")).toBe(0);
    // Internal map entry is gone — a fresh acquire behaves like a cold key.
    const b = await sem.acquire(args());
    expect(b.ok).toBe(true);
    if (b.ok) b.release();
  });

  it("watchdog force-releases a stuck lease after maxHoldMs (with warn)", async () => {
    const warnings: string[] = [];
    const sem = createKeyedSemaphore({ log: (_lvl, msg) => warnings.push(msg) });
    const stuck = await sem.acquire(args({ maxHoldMs: 60_000 }));
    expect(stuck.ok).toBe(true);
    // Waiter timeout longer than the watchdog so the handoff (not the waiter's
    // own timeout) is what resolves it.
    const waiting = sem.acquire(args({ timeoutMs: 120_000 }));
    await vi.advanceTimersByTimeAsync(60_000);
    expect((await waiting).ok).toBe(true); // slot handed over by the watchdog
    expect(warnings.some((m) => m.includes("watchdog"))).toBe(true);
    // The original lease's late release must now be a no-op.
    if (stuck.ok) stuck.release();
    expect(sem.inFlight("k1")).toBe(1);
  });
});
