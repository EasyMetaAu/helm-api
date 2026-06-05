import type { ForgettingConfig } from "@helm/shared";
import type { MemoryStore } from "../store/ports.js";

// docs/12 P5 trigger — the buffer-flush GATE that enqueues decay sweeps. Observer jobs
// are enqueued on the REQUEST path (inject) and reflector jobs by the worker after an
// observer write; decay is different — the spec is emphatic it runs "never per request"
// (docs/12 "Eviction, demotion, promotion"). So this runs OFF the hot path, on the
// worker tick: ask the store which accounts are DUE (≥ trigger_observations new
// observations accumulated OR ≥ trigger_interval_s elapsed since their last sweep) and
// enqueue ONE account-scoped decay job each. The open-job dedupe index
// (uniq_memory_jobs_open_type_scope) makes a re-enqueue of an already-queued account a
// no-op, so we do not pre-check — we just enqueue and let the store collapse duplicates
// (exactly how observer enqueue already leans on the index).
//
// GATING is the whole point: when forgetting.enabled is false (the default) this returns
// immediately WITHOUT reading the store or enqueuing anything, so no `decay` row is ever
// created and runtime behaviour is byte-identical to today (the rollout lever). Fail-open
// throughout (CLAUDE.md principle 3): a store read failure or a single account's enqueue
// failure is logged, never thrown — the account is simply re-evaluated on the next tick.

export interface DecayTriggerDeps {
  memoryStore: MemoryStore;
  // The forgetting config — `enabled` is the master gate; `decay.trigger_observations` /
  // `decay.trigger_interval_s` are the buffer-flush thresholds passed to the store.
  config: ForgettingConfig;
  // Injected clock (epoch-ms source for the interval gate). Never the real clock here —
  // the composition root wires Date.now; tests pin it.
  now: () => Date;
  log: (line: string, meta?: object) => void;
}

// Evaluate the buffer-flush gate once and enqueue decay jobs for the due accounts.
// Returns nothing; all outcomes are logged. Safe to call every worker tick.
export async function maybeEnqueueDecayJobs(deps: DecayTriggerDeps): Promise<void> {
  // Master gate: with forgetting off, do absolutely nothing — no store read, no enqueue.
  if (!deps.config.enabled) return;

  const listCandidates = deps.memoryStore.listDecayCandidateAccounts;
  if (listCandidates === undefined) {
    // A store that predates this phase cannot compute candidates — quietly no-op rather
    // than crash the tick (the sweep simply never triggers on such a build).
    deps.log("memory.decay.trigger_unsupported_store", {});
    return;
  }

  try {
    const accounts = await listCandidates.call(deps.memoryStore, {
      triggerObservations: deps.config.decay.trigger_observations,
      triggerIntervalS: deps.config.decay.trigger_interval_s,
      nowMs: deps.now().getTime(),
    });
    for (const accountId of accounts) {
      // Per-account guard: one account's enqueue failure must not skip the rest.
      try {
        await deps.memoryStore.enqueueJob({ type: "decay", scope: { accountId } });
      } catch (err) {
        deps.log("memory.decay.trigger_enqueue_failed", {
          account_id: accountId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    if (accounts.length > 0) {
      deps.log("memory.decay.trigger_enqueued", { count: accounts.length });
    }
  } catch (err) {
    // fail-open: a candidate-read failure never escapes — the gate just re-evaluates
    // next tick (decay over-retains on error, never breaks the worker).
    deps.log("memory.decay.trigger_failed", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
