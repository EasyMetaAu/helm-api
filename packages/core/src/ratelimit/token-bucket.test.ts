import { describe, expect, it } from "vitest";
import { type BucketState, refill, tryConsume } from "./token-bucket.js";

const MIN = 60_000;

describe("token-bucket refill", () => {
  it("starts full when state is fresh (caller seeds full bucket)", () => {
    const s: BucketState = { tokens: 2, lastRefillMs: 0 };
    const r = refill(s, 2, 0);
    expect(r.tokens).toBe(2);
  });

  it("refills linearly: capacity/60s per ms, never above capacity", () => {
    // capacity 2/min => 1 token per 30s.
    const empty: BucketState = { tokens: 0, lastRefillMs: 0 };
    const after30s = refill(empty, 2, 30_000);
    expect(after30s.tokens).toBeCloseTo(1, 5);
    // Past a full minute it caps at capacity, not beyond.
    const afterFar = refill(empty, 2, 10 * MIN);
    expect(afterFar.tokens).toBe(2);
  });
});

describe("token-bucket tryConsume", () => {
  it("consumes when enough tokens; remaining floors down", () => {
    const full: BucketState = { tokens: 2, lastRefillMs: 0 };
    const r = tryConsume(full, 2, 1, 0);
    expect(r.ok).toBe(true);
    expect(r.state.tokens).toBeCloseTo(1, 5);
    expect(r.remaining).toBe(1);
  });

  it("rejects without mutating tokens when insufficient", () => {
    const empty: BucketState = { tokens: 0, lastRefillMs: 0 };
    const r = tryConsume(empty, 100, 150, 0); // cost 150 > capacity 100
    expect(r.ok).toBe(false);
    expect(r.state.tokens).toBe(0);
    expect(r.remaining).toBe(0);
  });

  it("refills then succeeds after advancing the clock", () => {
    // rpm:2 bucket emptied at t=0, advance 30s => 1 token back => consume ok.
    const empty: BucketState = { tokens: 0, lastRefillMs: 0 };
    const r = tryConsume(empty, 2, 1, 30_000);
    expect(r.ok).toBe(true);
    expect(r.remaining).toBe(0); // exactly one refilled and consumed
  });

  it("resetSeconds is the time to regain one whole unit", () => {
    // capacity 2/min => 1 unit per 30s. From empty, reset ~= 30s.
    const empty: BucketState = { tokens: 0, lastRefillMs: 0 };
    const r = tryConsume(empty, 2, 1, 0);
    expect(r.ok).toBe(false);
    expect(r.resetSeconds).toBeGreaterThan(0);
    expect(r.resetSeconds).toBeLessThanOrEqual(30);
  });
});
