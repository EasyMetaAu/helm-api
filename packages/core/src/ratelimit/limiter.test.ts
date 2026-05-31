import type { RateLimitConfig } from "@helm/shared";
import { describe, expect, it, vi } from "vitest";
import type { RateLimitStore } from "../store/ports.js";
import { InMemoryRateLimitStore } from "../store/sqlite/rate-limit-memory.js";
import { createRateLimiter } from "./limiter.js";

function cfg(over: Partial<RateLimitConfig> = {}): RateLimitConfig {
  return {
    enabled: true,
    default: { rpm: 0, tpm: 0 },
    overrides: {},
    ...over,
  };
}

describe("createRateLimiter — RPM", () => {
  it("blocks the 3rd request in the same minute (rpm:2)", async () => {
    const store = new InMemoryRateLimitStore();
    const limiter = createRateLimiter({ config: cfg({ default: { rpm: 2, tpm: 0 } }), store });
    const probe = { keyId: "k1", estimatedTokens: 0, now: 0 };
    expect((await limiter.check(probe)).allowed).toBe(true);
    expect((await limiter.check(probe)).allowed).toBe(true);
    const third = await limiter.check(probe);
    expect(third.allowed).toBe(false);
    expect(third.limitedBy).toBe("rpm");
    expect(third.limit).toBe(2);
    expect(third.retryAfterSeconds).toBeGreaterThan(0);
  });
});

describe("createRateLimiter — TPM", () => {
  it("rejects a single oversized request (tpm:100, est 150)", async () => {
    const store = new InMemoryRateLimitStore();
    const limiter = createRateLimiter({ config: cfg({ default: { rpm: 0, tpm: 100 } }), store });
    const r = await limiter.check({ keyId: "k1", estimatedTokens: 150, now: 0 });
    expect(r.allowed).toBe(false);
    expect(r.limitedBy).toBe("tpm");
  });

  it("rejects once accumulated tokens cross tpm", async () => {
    const store = new InMemoryRateLimitStore();
    const limiter = createRateLimiter({ config: cfg({ default: { rpm: 0, tpm: 100 } }), store });
    expect((await limiter.check({ keyId: "k1", estimatedTokens: 60, now: 0 })).allowed).toBe(true);
    const second = await limiter.check({ keyId: "k1", estimatedTokens: 60, now: 0 });
    expect(second.allowed).toBe(false);
    expect(second.limitedBy).toBe("tpm");
  });
});

describe("createRateLimiter — per-key overrides", () => {
  it("applies override only to the target key; others fall back to default", async () => {
    const store = new InMemoryRateLimitStore();
    const limiter = createRateLimiter({
      config: cfg({ default: { rpm: 1, tpm: 0 }, overrides: { k_app1: { rpm: 100 } } }),
      store,
    });
    for (let i = 0; i < 50; i++) {
      expect((await limiter.check({ keyId: "k_app1", estimatedTokens: 0, now: 0 })).allowed).toBe(
        true,
      );
    }
    expect((await limiter.check({ keyId: "k_other", estimatedTokens: 0, now: 0 })).allowed).toBe(
      true,
    );
    expect((await limiter.check({ keyId: "k_other", estimatedTokens: 0, now: 0 })).allowed).toBe(
      false,
    );
  });
});

describe("createRateLimiter — headers / fields", () => {
  it("remaining decreases with consumption", async () => {
    const store = new InMemoryRateLimitStore();
    const limiter = createRateLimiter({ config: cfg({ default: { rpm: 3, tpm: 0 } }), store });
    const probe = { keyId: "k1", estimatedTokens: 0, now: 0 };
    expect((await limiter.check(probe)).remaining).toBe(2);
    expect((await limiter.check(probe)).remaining).toBe(1);
    expect((await limiter.check(probe)).remaining).toBe(0);
  });
});

describe("createRateLimiter — token bucket refill via injected clock", () => {
  it("recovers after the clock advances", async () => {
    const store = new InMemoryRateLimitStore();
    const limiter = createRateLimiter({ config: cfg({ default: { rpm: 2, tpm: 0 } }), store });
    await limiter.check({ keyId: "k1", estimatedTokens: 0, now: 0 });
    await limiter.check({ keyId: "k1", estimatedTokens: 0, now: 0 });
    expect((await limiter.check({ keyId: "k1", estimatedTokens: 0, now: 0 })).allowed).toBe(false);
    // advance 30s => rpm:2 refills 1 token
    expect((await limiter.check({ keyId: "k1", estimatedTokens: 0, now: 30_000 })).allowed).toBe(
      true,
    );
  });
});

describe("createRateLimiter — disabled / unlimited fast path", () => {
  it("never touches the store when disabled", async () => {
    const consume = vi.fn();
    const store: RateLimitStore = { consume };
    const limiter = createRateLimiter({
      config: cfg({ enabled: false, default: { rpm: 5, tpm: 5 } }),
      store,
    });
    const r = await limiter.check({ keyId: "k1", estimatedTokens: 999, now: 0 });
    expect(r.allowed).toBe(true);
    expect(consume).not.toHaveBeenCalled();
  });

  it("never touches the store when both dimensions are unlimited (0/0)", async () => {
    const consume = vi.fn();
    const store: RateLimitStore = { consume };
    const limiter = createRateLimiter({ config: cfg({ default: { rpm: 0, tpm: 0 } }), store });
    const r = await limiter.check({ keyId: "k1", estimatedTokens: 999, now: 0 });
    expect(r.allowed).toBe(true);
    expect(consume).not.toHaveBeenCalled();
  });
});
