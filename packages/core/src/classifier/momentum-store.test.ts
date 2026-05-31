import { describe, expect, it } from "vitest";
import type { MomentumEntry } from "./momentum.js";
import { createMemoryMomentumStore } from "./momentum-store.js";

// The default in-memory MomentumStore is a process-lifetime singleton (server.ts),
// so unbounded growth is a slow leak / OOM (audit MEDIUM). Two write-time bounds
// keep it finite, mirroring the eval cache's TTL+LRU container:
//   1. each session key's array is trimmed to a hard per-key cap;
//   2. the number of session keys is LRU-bounded (oldest key evicted on overflow).
// The port signatures (get/push) stay unchanged; caps arrive via optional ctor
// options with safe defaults, so createMemoryMomentumStore() with no args works.

const entry = (rawScore: number, at = 0): MomentumEntry => ({
  complexity: "reasoning",
  rawScore,
  at,
});

describe("createMemoryMomentumStore", () => {
  it("works with no constructor args (default caps)", () => {
    const store = createMemoryMomentumStore();
    store.push("s1", entry(0.5));
    expect(store.get("s1")).toHaveLength(1);
    expect(store.get("missing")).toEqual([]);
  });

  it("trims each key's array to the per-key cap at WRITE time (keeps most recent)", () => {
    const store = createMemoryMomentumStore({ maxEntriesPerKey: 3 });
    for (let i = 0; i < 10; i++) store.push("s1", entry(i, i));
    const hist = store.get("s1");
    expect(hist).toHaveLength(3);
    // Most-recent (highest rawScore / at) survive; oldest are dropped.
    expect(hist.map((e) => e.rawScore)).toEqual([7, 8, 9]);
  });

  it("applies a safe default per-key cap so a single key cannot grow unbounded", () => {
    const store = createMemoryMomentumStore();
    for (let i = 0; i < 1000; i++) store.push("s1", entry(i, i));
    expect(store.get("s1").length).toBeLessThanOrEqual(16);
  });

  it("LRU-evicts the oldest session key past the key-count cap", () => {
    const store = createMemoryMomentumStore({ maxKeys: 2 });
    store.push("a", entry(1));
    store.push("b", entry(2));
    store.push("c", entry(3)); // overflow → "a" (least recently used) evicted
    expect(store.get("a")).toEqual([]);
    expect(store.get("b")).toHaveLength(1);
    expect(store.get("c")).toHaveLength(1);
  });

  it("refreshes key recency on push so an active key is not evicted", () => {
    const store = createMemoryMomentumStore({ maxKeys: 2 });
    store.push("a", entry(1));
    store.push("b", entry(2));
    store.push("a", entry(1.5)); // touch "a" → now most-recent
    store.push("c", entry(3)); // overflow → "b" evicted, not "a"
    expect(store.get("a")).toHaveLength(2);
    expect(store.get("b")).toEqual([]);
    expect(store.get("c")).toHaveLength(1);
  });

  it("applies a safe default key-count cap so session keys cannot grow unbounded", () => {
    const store = createMemoryMomentumStore();
    for (let i = 0; i < 100_000; i++) store.push(`s${i}`, entry(i));
    // Count distinct surviving keys by probing the very first inserted key:
    // an unbounded store would still hold "s0".
    expect(store.get("s0")).toEqual([]);
  });
});
