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

describe("createRateLimiter — probe override (per-key quota carried by Auth)", () => {
  it("probe.override.rpm wins over both config.overrides and default", async () => {
    const store = new InMemoryRateLimitStore();
    const limiter = createRateLimiter({
      // default rpm:1 AND a config override of rpm:2 — the probe asks for rpm:5,
      // which must win (highest precedence).
      config: cfg({ default: { rpm: 1, tpm: 0 }, overrides: { k1: { rpm: 2 } } }),
      store,
    });
    const probe = { keyId: "k1", estimatedTokens: 0, now: 0, override: { rpm: 5 } };
    for (let i = 0; i < 5; i++) {
      expect((await limiter.check(probe)).allowed).toBe(true);
    }
    expect((await limiter.check(probe)).allowed).toBe(false); // 6th over rpm:5
  });

  it("an absent probe dimension falls through to the system default", async () => {
    const store = new InMemoryRateLimitStore();
    const limiter = createRateLimiter({ config: cfg({ default: { rpm: 2, tpm: 0 } }), store });
    // override names only tpm (null) -> rpm inherits default:2
    const probe = { keyId: "k1", estimatedTokens: 0, now: 0, override: { tpm: null } };
    expect((await limiter.check(probe)).allowed).toBe(true);
    expect((await limiter.check(probe)).allowed).toBe(true);
    expect((await limiter.check(probe)).allowed).toBe(false); // 3rd over default rpm:2
  });

  it("a null probe dimension inherits the system DEFAULT, bypassing a yaml config.override", async () => {
    const store = new InMemoryRateLimitStore();
    // A stale yaml override (rpm:1) exists for k1, but the key's DB override was
    // CLEARED (probe.override present, rpm:null). Clearing must return the key to
    // the system default (rpm:5), NOT silently fall back to the yaml override —
    // otherwise the admin UI's "Default" label would lie.
    const limiter = createRateLimiter({
      config: cfg({ default: { rpm: 5, tpm: 0 }, overrides: { k1: { rpm: 1 } } }),
      store,
    });
    const probe = { keyId: "k1", estimatedTokens: 0, now: 0, override: { rpm: null, tpm: null } };
    for (let i = 0; i < 5; i++) {
      expect((await limiter.check(probe)).allowed).toBe(true);
    }
    expect((await limiter.check(probe)).allowed).toBe(false); // 6th over default rpm:5
  });

  it("probe override of 0 means explicitly UNLIMITED for that dimension", async () => {
    const consume = vi.fn();
    const store: RateLimitStore = { consume };
    // default would meter rpm:1, but this key overrides rpm:0 AND tpm:0 -> the
    // unmetered fast path: store is never touched.
    const limiter = createRateLimiter({ config: cfg({ default: { rpm: 1, tpm: 5 } }), store });
    const r = await limiter.check({
      keyId: "k1",
      estimatedTokens: 999,
      now: 0,
      override: { rpm: 0, tpm: 0 },
    });
    expect(r.allowed).toBe(true);
    expect(r.limit).toBe(0);
    expect(consume).not.toHaveBeenCalled();
  });
});

describe("createRateLimiter — both dimensions active (RPM + TPM)", () => {
  it("both admit: reports the TPM dimension when it has less headroom", async () => {
    const store = new InMemoryRateLimitStore();
    // rpm:10 (1 used -> 90% left) vs tpm:100 (90 used -> 10% left). TPM is tighter,
    // so the surfaced headers must describe TPM, not RPM.
    const limiter = createRateLimiter({ config: cfg({ default: { rpm: 10, tpm: 100 } }), store });
    const r = await limiter.check({ keyId: "k1", estimatedTokens: 90, now: 0 });
    expect(r.allowed).toBe(true);
    expect(r.limitedBy).toBeNull();
    expect(r.limit).toBe(100);
    expect(r.remaining).toBe(10);
    expect(r.retryAfterSeconds).toBe(0);
  });

  it("both admit: reports the RPM dimension when it has less headroom", async () => {
    const store = new InMemoryRateLimitStore();
    // rpm:2 (1 used -> 50% left) vs tpm:1000 (10 used -> 99% left). RPM is tighter.
    const limiter = createRateLimiter({ config: cfg({ default: { rpm: 2, tpm: 1000 } }), store });
    const r = await limiter.check({ keyId: "k1", estimatedTokens: 10, now: 0 });
    expect(r.allowed).toBe(true);
    expect(r.limitedBy).toBeNull();
    expect(r.limit).toBe(2);
    expect(r.remaining).toBe(1);
  });

  it("RPM admits but TPM rejects: limitedBy tpm with a retry hint", async () => {
    const store = new InMemoryRateLimitStore();
    const limiter = createRateLimiter({ config: cfg({ default: { rpm: 10, tpm: 100 } }), store });
    const r = await limiter.check({ keyId: "k1", estimatedTokens: 150, now: 0 });
    expect(r.allowed).toBe(false);
    expect(r.limitedBy).toBe("tpm");
    expect(r.limit).toBe(100);
    expect(r.retryAfterSeconds).toBeGreaterThan(0);
  });

  it("RPM rejection short-circuits before the TPM bucket is touched", async () => {
    const consume = vi.fn<RateLimitStore["consume"]>().mockResolvedValue({
      ok: false,
      remaining: 0,
      resetSeconds: 30,
      state: { tokens: 0, lastRefillMs: 0 },
    });
    const store: RateLimitStore = { consume };
    const limiter = createRateLimiter({ config: cfg({ default: { rpm: 1, tpm: 100 } }), store });
    const r = await limiter.check({ keyId: "k1", estimatedTokens: 50, now: 0 });
    expect(r.allowed).toBe(false);
    expect(r.limitedBy).toBe("rpm");
    // Only the RPM dimension was consumed — a refused request never debits TPM.
    expect(consume).toHaveBeenCalledTimes(1);
    expect(consume).toHaveBeenCalledWith("k1", "rpm", null, 1, 1, 0);
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
