import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createKeyedSerialGate } from "./keyed-serial-gate.js";

// Per-key serial mutex with a minimum delay between COMPLETIONS (issue #93
// feature B, CRS parity: at most 1 in flight per key; the next request starts
// >= delayMs after the previous one fully completed). FIFO, promise handoff.

describe("createKeyedSerialGate", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const args = (over: Record<string, unknown> = {}) => ({
    key: "acct1",
    delayMs: 200,
    timeoutMs: 5_000,
    ...over,
  });

  it("grants the first acquire immediately (cold key, no delay)", async () => {
    const gate = createKeyedSerialGate();
    const res = await gate.acquire(args());
    expect(res.ok).toBe(true);
    if (res.ok) res.release();
  });

  it("serializes: the second acquire waits until the first releases", async () => {
    const gate = createKeyedSerialGate();
    const first = await gate.acquire(args({ delayMs: 0 }));
    let secondDone = false;
    const second = gate.acquire(args({ delayMs: 0 })).then((r) => {
      secondDone = true;
      return r;
    });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(secondDone).toBe(false); // still locked
    if (first.ok) first.release();
    const res = await second;
    expect(res.ok).toBe(true);
    if (res.ok) res.release();
  });

  it("enforces delayMs measured from the previous COMPLETION", async () => {
    const gate = createKeyedSerialGate();
    const first = await gate.acquire(args());
    let granted = false;
    const second = gate.acquire(args()).then((r) => {
      granted = true;
      return r;
    });
    if (first.ok) first.release(); // completion stamp at t0
    // Within the 200ms window the second must still be held back.
    await vi.advanceTimersByTimeAsync(199);
    expect(granted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const res = await second;
    expect(res.ok).toBe(true);
    if (res.ok) res.release();
  });

  it("a fresh acquire arriving inside the delay window also waits the residual", async () => {
    const gate = createKeyedSerialGate();
    const first = await gate.acquire(args());
    if (first.ok) first.release(); // completion at t0
    await vi.advanceTimersByTimeAsync(120); // t0+120 < 200
    let granted = false;
    const second = gate.acquire(args()).then((r) => {
      granted = true;
      return r;
    });
    await vi.advanceTimersByTimeAsync(79);
    expect(granted).toBe(false);
    await vi.advanceTimersByTimeAsync(1); // t0+200 reached
    const res = await second;
    expect(res.ok).toBe(true);
    if (res.ok) res.release();
  });

  it("FIFO across multiple waiters, one at a time, delay between each", async () => {
    const gate = createKeyedSerialGate();
    const order: number[] = [];
    const first = await gate.acquire(args());
    const second = gate.acquire(args()).then((r) => {
      order.push(2);
      return r;
    });
    const third = gate.acquire(args()).then((r) => {
      order.push(3);
      return r;
    });
    if (first.ok) first.release();
    await vi.advanceTimersByTimeAsync(200);
    const r2 = await second;
    expect(order).toEqual([2]); // third still waiting on the lock
    if (r2.ok) r2.release();
    await vi.advanceTimersByTimeAsync(200);
    const r3 = await third;
    expect(order).toEqual([2, 3]);
    if (r3.ok) r3.release();
  });

  it("times out a waiter (lock held too long) and frees its place", async () => {
    const gate = createKeyedSerialGate();
    const holder = await gate.acquire(args({ timeoutMs: 1_000 }));
    const waiting = gate.acquire(args({ timeoutMs: 1_000 }));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await waiting).toEqual({ ok: false, reason: "timeout" });
    // Holder unaffected; a later release works and a new acquire proceeds.
    if (holder.ok) holder.release();
    await vi.advanceTimersByTimeAsync(200);
    const next = await gate.acquire(args());
    expect(next.ok).toBe(true);
    if (next.ok) next.release();
  });

  it("aborts a waiter via AbortSignal (including pre-aborted)", async () => {
    const gate = createKeyedSerialGate();
    const holder = await gate.acquire(args());
    const ac = new AbortController();
    const waiting = gate.acquire(args({ signal: ac.signal }));
    ac.abort();
    expect(await waiting).toEqual({ ok: false, reason: "aborted" });
    const pre = new AbortController();
    pre.abort();
    expect(await gate.acquire(args({ signal: pre.signal }))).toEqual({
      ok: false,
      reason: "aborted",
    });
    if (holder.ok) holder.release();
  });

  it("an aborted waiter does not block the next one (queue advances)", async () => {
    const gate = createKeyedSerialGate();
    const holder = await gate.acquire(args({ delayMs: 0 }));
    const ac = new AbortController();
    const aborted = gate.acquire(args({ delayMs: 0, signal: ac.signal }));
    const healthy = gate.acquire(args({ delayMs: 0 }));
    ac.abort();
    await aborted;
    if (holder.ok) holder.release();
    const res = await healthy;
    expect(res.ok).toBe(true);
    if (res.ok) res.release();
  });

  it("release is idempotent (double release does not unlock twice / restamp)", async () => {
    const gate = createKeyedSerialGate();
    const first = await gate.acquire(args());
    if (first.ok) {
      first.release(); // completion at t0
    }
    await vi.advanceTimersByTimeAsync(150);
    if (first.ok) first.release(); // must NOT restamp lastCompletion to t0+150
    let granted = false;
    const second = gate.acquire(args()).then((r) => {
      granted = true;
      return r;
    });
    await vi.advanceTimersByTimeAsync(50); // t0+200 — original stamp satisfied
    expect(granted).toBe(true);
    const res = await second;
    if (res.ok) res.release();
  });

  it("keys are independent (two accounts run concurrently)", async () => {
    const gate = createKeyedSerialGate();
    const a = await gate.acquire(args({ key: "acctA" }));
    const b = await gate.acquire(args({ key: "acctB" }));
    expect(a.ok && b.ok).toBe(true);
    if (a.ok) a.release();
    if (b.ok) b.release();
  });
});
