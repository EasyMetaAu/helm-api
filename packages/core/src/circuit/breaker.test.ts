import { describe, expect, it } from "vitest";
import { type BreakerDeps, type CircuitConfig, createCircuitBreaker } from "./breaker.js";

// Per-model circuit breaker — CLOSED / OPEN / HALF_OPEN with a single-probe
// lock. Ports llm-router semantics (NOT an import): failures recorded only
// BEFORE the first valid chunk; success only AFTER it; client abort is a
// non-provider fault (records neither, but releases any held probe lock).
// State read/write faults must fail-open (treat as CLOSED, allow). See task
// circuit.breaker, docs/02, CLAUDE.md principle 3.

const config: CircuitConfig = { failureThreshold: 5, cooldownMs: 30_000 };

// A controllable injected clock so cooldown windows are deterministic.
function makeClock(start = 0) {
  let t = start;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

function makeBreaker(overrides: Partial<BreakerDeps> = {}) {
  const clock = makeClock();
  const deps: BreakerDeps = {
    config,
    now: clock.now,
    ...overrides,
  };
  return { breaker: createCircuitBreaker(deps), clock };
}

function fail(breaker: ReturnType<typeof createCircuitBreaker>, model: string, n: number) {
  for (let i = 0; i < n; i++) breaker.recordFailure(model);
}

describe("createCircuitBreaker", () => {
  it("1. CLOSED by default allows attempts", () => {
    const { breaker } = makeBreaker();
    expect(breaker.getState("m")).toBe("CLOSED");
    expect(breaker.canAttempt("m")).toEqual({ allow: true, probe: false });
  });

  it("2. consecutive failures up to threshold -> OPEN", () => {
    const { breaker } = makeBreaker();
    fail(breaker, "m", config.failureThreshold);
    expect(breaker.getState("m")).toBe("OPEN");
    expect(breaker.canAttempt("m")).toEqual({
      allow: false,
      probe: false,
      reason: "circuit_open",
    });
  });

  it("2b. failures below threshold stay CLOSED", () => {
    const { breaker } = makeBreaker();
    fail(breaker, "m", config.failureThreshold - 1);
    expect(breaker.getState("m")).toBe("CLOSED");
    expect(breaker.canAttempt("m").allow).toBe(true);
  });

  it("3. OPEN skips while still within cooldown", () => {
    const { breaker, clock } = makeBreaker();
    fail(breaker, "m", config.failureThreshold);
    clock.advance(config.cooldownMs - 1);
    expect(breaker.canAttempt("m")).toEqual({
      allow: false,
      probe: false,
      reason: "circuit_open",
    });
    expect(breaker.getState("m")).toBe("OPEN");
  });

  it("4. after cooldown -> HALF_OPEN probe", () => {
    const { breaker, clock } = makeBreaker();
    fail(breaker, "m", config.failureThreshold);
    clock.advance(config.cooldownMs);
    expect(breaker.canAttempt("m")).toEqual({ allow: true, probe: true });
    expect(breaker.getState("m")).toBe("HALF_OPEN");
  });

  it("5. probe lock is mutually exclusive — only one probe in flight", () => {
    const { breaker, clock } = makeBreaker();
    fail(breaker, "m", config.failureThreshold);
    clock.advance(config.cooldownMs);
    const first = breaker.canAttempt("m");
    expect(first).toEqual({ allow: true, probe: true });
    // Second concurrent attempt while probe in flight is treated as OPEN.
    expect(breaker.canAttempt("m")).toEqual({
      allow: false,
      probe: false,
      reason: "circuit_open",
    });
    expect(breaker.getState("m")).toBe("HALF_OPEN");
  });

  it("6. probe success -> CLOSED, counter cleared, lock released", () => {
    const { breaker, clock } = makeBreaker();
    fail(breaker, "m", config.failureThreshold);
    clock.advance(config.cooldownMs);
    breaker.canAttempt("m"); // acquire probe
    breaker.recordSuccess("m");
    expect(breaker.getState("m")).toBe("CLOSED");
    // Lock released, counter cleared -> allows again.
    expect(breaker.canAttempt("m")).toEqual({ allow: true, probe: false });
    // Counter cleared: threshold-1 more failures still CLOSED.
    fail(breaker, "m", config.failureThreshold - 1);
    expect(breaker.getState("m")).toBe("CLOSED");
  });

  it("7. probe failure -> OPEN again, cooldown origin refreshed, lock released", () => {
    const { breaker, clock } = makeBreaker();
    fail(breaker, "m", config.failureThreshold);
    clock.advance(config.cooldownMs);
    breaker.canAttempt("m"); // HALF_OPEN, acquire probe
    breaker.recordFailure("m"); // probe fails
    expect(breaker.getState("m")).toBe("OPEN");
    // Cooldown origin refreshed at the time of probe failure: still OPEN now.
    expect(breaker.canAttempt("m")).toEqual({
      allow: false,
      probe: false,
      reason: "circuit_open",
    });
    // After a fresh full cooldown a new probe is permitted (lock was released).
    clock.advance(config.cooldownMs);
    expect(breaker.canAttempt("m")).toEqual({ allow: true, probe: true });
  });

  it("8. failure-before-first-chunk / success-after contract", () => {
    const { breaker } = makeBreaker();
    // "connected but no chunk emitted, then failed" -> recordFailure counts.
    fail(breaker, "m", config.failureThreshold);
    expect(breaker.getState("m")).toBe("OPEN");
    // recover then "valid chunk emitted" -> recordSuccess clears.
    breaker.recordSuccess("m");
    expect(breaker.getState("m")).toBe("CLOSED");
    // A success on a CLOSED breaker zeroes the failure counter.
    fail(breaker, "m", config.failureThreshold - 1);
    breaker.recordSuccess("m");
    fail(breaker, "m", config.failureThreshold - 1);
    expect(breaker.getState("m")).toBe("CLOSED");
  });

  it("9. abort is a non-fault — state & counter unchanged, but probe lock released", () => {
    const { breaker, clock } = makeBreaker();
    // abort on CLOSED with some failures: counter unchanged.
    fail(breaker, "m", config.failureThreshold - 1);
    breaker.recordAbort("m");
    expect(breaker.getState("m")).toBe("CLOSED");
    // One more failure still reaches threshold (abort didn't reset counter).
    breaker.recordFailure("m");
    expect(breaker.getState("m")).toBe("OPEN");

    // abort while HALF_OPEN holding the probe lock must release it (no deadlock).
    clock.advance(config.cooldownMs);
    expect(breaker.canAttempt("m")).toEqual({ allow: true, probe: true });
    expect(breaker.getState("m")).toBe("HALF_OPEN");
    breaker.recordAbort("m");
    // Lock released -> another probe can be acquired (still HALF_OPEN, not reset
    // to OPEN since abort is not a fault).
    expect(breaker.canAttempt("m")).toEqual({ allow: true, probe: true });
  });

  it("10. per-model isolation — model A OPEN does not affect model B", () => {
    const { breaker } = makeBreaker();
    fail(breaker, "a", config.failureThreshold);
    expect(breaker.getState("a")).toBe("OPEN");
    expect(breaker.getState("b")).toBe("CLOSED");
    expect(breaker.canAttempt("b")).toEqual({ allow: true, probe: false });
  });

  it("H7: a failure recorded while OPEN does NOT refresh the cooldown window", () => {
    const { breaker, clock } = makeBreaker();
    fail(breaker, "m", config.failureThreshold); // -> OPEN, openedAt = 0
    expect(breaker.getState("m")).toBe("OPEN");
    // A stray pre-first-chunk failure lands partway through the cooldown (reachable via
    // the documented concurrent-probe window). It must NOT re-trip / reset openedAt.
    clock.advance(config.cooldownMs - 1);
    breaker.recordFailure("m");
    // 1ms later the ORIGINAL cooldown elapses → a probe is allowed. If the stray failure
    // had reset openedAt, this would still be SKIP and the breaker would never recover.
    clock.advance(1);
    expect(breaker.canAttempt("m")).toEqual({ allow: true, probe: true });
  });

  it("fail-open: an internal fault degrades to allow:true (treated as CLOSED)", () => {
    // Inject a now() that throws to simulate an internal read fault; the breaker
    // must NOT propagate — it degrades to allowing the request (principle 3).
    const { breaker } = makeBreaker({
      now: () => {
        throw new Error("clock blew up");
      },
    });
    expect(() => breaker.canAttempt("m")).not.toThrow();
    expect(breaker.canAttempt("m")).toEqual({ allow: true, probe: false });
  });
});
