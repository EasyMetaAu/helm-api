// Per-model circuit breaker — CLOSED / OPEN / HALF_OPEN with a single-probe
// lock. Framework-agnostic (packages/core, principle 1). Ports llm-router's
// battle-tested semantics WITHOUT importing it (see implementation-notes,
// 2026-05-30 execution-layer entry):
//   - failures are recorded only BEFORE the first valid chunk (connect/handshake
//     / early upstream errors); successes only AFTER the first valid chunk —
//     mid-stream breakage cannot count as success;
//   - client abort is a NON-provider fault: records neither failure nor success
//     (does not pollute health, does not trip the breaker), but releases any
//     held probe lock so HALF_OPEN never deadlocks;
//   - HALF_OPEN uses a per-model probe lock so only one probe request is in
//     flight; all other concurrent requests are treated as OPEN (skipped).
//
// fail-open (principle 3 / docs/02): the breaker is an optimization, never the
// judge of request success. If its own state read/write throws, it degrades to
// allowing the request (treated as CLOSED) and records the fault — it must never
// 5xx the request chain. Only "all providers failed" yields a structured error,
// produced by executor.fallback — not here.
//
// State is in-process per model (one entry each). Persisting to store.ports is
// NOT required by this task; this is the in-memory implementation, with the
// `now` clock injected so cooldown windows are deterministic in tests.

export type CircuitState = "CLOSED" | "OPEN" | "HALF_OPEN";

export interface CircuitConfig {
  /** Consecutive failures at which the circuit trips to OPEN (default 5). */
  failureThreshold: number;
  /** How long OPEN waits before a HALF_OPEN probe is allowed, in ms (default 30_000). */
  cooldownMs: number;
}

export interface BreakerDeps {
  config: CircuitConfig;
  /** Injected clock for deterministic cooldown windows in tests. */
  now: () => number;
}

export interface AttemptDecision {
  allow: boolean;
  probe: boolean;
  reason?: string;
}

export interface CircuitBreaker {
  /**
   * Asked before each attempt: may this model be called right now?
   *   CLOSED                          -> { allow:true,  probe:false }
   *   OPEN & within cooldown          -> { allow:false, probe:false, reason:"circuit_open" }
   *   OPEN & cooldown elapsed         -> grab probe lock: won  -> HALF_OPEN, { allow:true, probe:true }
   *                                                       lost -> { allow:false, probe:false, reason:"circuit_open" }
   *   HALF_OPEN (probe already in flight) -> { allow:false, probe:false, reason:"circuit_open" }
   */
  canAttempt(model: string): AttemptDecision;

  /** Call ONLY for failures occurring before the first valid chunk. */
  recordFailure(model: string): void;

  /** Call ONLY after a first valid chunk / valid response is received. */
  recordSuccess(model: string): void;

  /** Client abort: record nothing (non-provider fault), but release any probe lock. */
  recordAbort(model: string): void;

  getState(model: string): CircuitState;
}

interface ModelEntry {
  state: CircuitState;
  failures: number;
  openedAt: number;
  /** HALF_OPEN single-probe lock: only the holder gets allow:true, probe:true. */
  inFlightProbe: boolean;
}

const CIRCUIT_OPEN = "circuit_open";
const SKIP: AttemptDecision = { allow: false, probe: false, reason: CIRCUIT_OPEN };
const ALLOW: AttemptDecision = { allow: true, probe: false };
const PROBE: AttemptDecision = { allow: true, probe: true };

function freshEntry(): ModelEntry {
  return { state: "CLOSED", failures: 0, openedAt: 0, inFlightProbe: false };
}

export function createCircuitBreaker(deps: BreakerDeps): CircuitBreaker {
  const { config, now } = deps;
  const entries = new Map<string, ModelEntry>();

  function get(model: string): ModelEntry {
    let e = entries.get(model);
    if (e === undefined) {
      e = freshEntry();
      entries.set(model, e);
    }
    return e;
  }

  function reset(e: ModelEntry): void {
    e.state = "CLOSED";
    e.failures = 0;
    e.inFlightProbe = false;
  }

  function trip(e: ModelEntry): void {
    e.state = "OPEN";
    e.openedAt = now();
    e.inFlightProbe = false;
  }

  return {
    canAttempt(model) {
      try {
        const e = get(model);
        switch (e.state) {
          case "CLOSED":
            return ALLOW;
          case "HALF_OPEN":
            // A probe is already in flight — everyone else is skipped. If the
            // lock was released without resolution (e.g. after an abort), the
            // next caller may acquire it for a fresh probe.
            if (e.inFlightProbe) return SKIP;
            e.inFlightProbe = true;
            return PROBE;
          case "OPEN": {
            if (now() - e.openedAt < config.cooldownMs) return SKIP;
            // Cooldown elapsed — grab the probe lock and transition to HALF_OPEN.
            // (Single-threaded JS: the first synchronous caller wins the lock.)
            e.state = "HALF_OPEN";
            e.inFlightProbe = true;
            return PROBE;
          }
          default:
            return ALLOW;
        }
      } catch {
        // fail-open: breaker faults never block the request chain (principle 3).
        return ALLOW;
      }
    },

    recordFailure(model) {
      try {
        const e = get(model);
        if (e.state === "HALF_OPEN") {
          // Probe failed: re-OPEN, refresh cooldown origin, release the lock.
          trip(e);
          return;
        }
        // CLOSED (or OPEN): bump the consecutive-failure counter.
        e.failures += 1;
        if (e.failures >= config.failureThreshold) trip(e);
      } catch {
        // fail-open: swallow internal faults, never propagate (principle 3).
      }
    },

    recordSuccess(model) {
      try {
        // Any state -> CLOSED: clear the failure counter, release the probe lock.
        reset(get(model));
      } catch {
        // fail-open.
      }
    },

    recordAbort(model) {
      try {
        // Non-provider fault: record neither failure nor success. But release
        // any held probe lock so HALF_OPEN never deadlocks into a phantom OPEN.
        const e = get(model);
        e.inFlightProbe = false;
      } catch {
        // fail-open.
      }
    },

    getState(model) {
      try {
        return get(model).state;
      } catch {
        // fail-open: unknown/unreadable -> treat as CLOSED (allow).
        return "CLOSED";
      }
    },
  };
}
