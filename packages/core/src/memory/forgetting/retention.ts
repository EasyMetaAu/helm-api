import type { ForgettingConfig } from "@helm/shared";
import type { MemoryStore } from "../../store/ports.js";

// docs/12 "Eviction, demotion, promotion" pass 4 (P7) — the retention HARD-DELETE,
// the ONLY DELETE in the forgetting system. Everything else in the pipeline is a SOFT
// invalidate: decay archives observations (status='archived'), supersede expires facts
// (expired_at stamp). Those rows stop being injected but survive for audit. Retention
// is the audit-trail exception: rows that were ALREADY archived/expired and have since
// aged past their retention window are finally dropped. **Decay never destroys; it
// hides — retention deletes** (docs/12). Reflections are NEVER hard-deleted; active /
// unexpired rows are NEVER touched (the cutoffs only see archived / expired rows).
//
// This is an OFF-the-request-path, account-AGNOSTIC sweep — a sibling of
// maybeEnqueueDecayJobs run on the SAME worker tick / cadence as the existing
// payload_retention_days prune (apps/gateway payload-capture). It does not iterate
// accounts: a global age cutoff is account-neutral by construction (an archived row's
// archived_at / an expired fact's expired_at is the same wallclock for every tenant),
// so one pair of DELETEs over the whole store is correct and cheaper than per-account.
//
// GATING is the rollout lever (docs/12): with forgetting.enabled false (the default)
// this returns IMMEDIATELY without reading or deleting anything, so no row is ever hard-
// deleted and runtime behaviour is byte-identical to today. FAIL-OPEN throughout
// (CLAUDE.md principle 3): a store error is logged, never thrown — the rows are simply
// re-evaluated on the next tick (retention over-retains on error, never breaks the
// worker). The cutoff math lives here (pure, clock-injected); the two DELETEs live in
// the adapters (pruneExpiredMemory), verified against real sqlite + postgres.

const DAY_MS = 86_400_000;

export interface RetentionDeps {
  memoryStore: MemoryStore;
  // The forgetting config — `enabled` is the master gate; `retention.archived_days` /
  // `retention.facts_expired_days` are the hard-delete windows (in days).
  config: ForgettingConfig;
  // Injected clock (the cutoff anchor). Never the real clock here — the composition
  // root wires Date.now; tests pin it.
  now: () => Date;
  log: (line: string, meta?: object) => void;
}

// Compute the two retention cutoffs and run ONE pair of account-agnostic deletes.
// Returns nothing; all outcomes are logged. Safe to call every worker tick.
export async function pruneRetainedMemory(deps: RetentionDeps): Promise<void> {
  // Master gate: with forgetting off, do absolutely nothing — no read, no delete.
  if (!deps.config.enabled) return;

  const prune = deps.memoryStore.pruneExpiredMemory;
  if (prune === undefined) {
    // A store that predates this phase cannot hard-delete — quietly no-op rather than
    // crash the tick (retention simply never runs on such a build).
    deps.log("memory.retention.unsupported_store", {});
    return;
  }

  const nowMs = deps.now().getTime();
  // Cutoffs are STRICT lower bounds: delete rows whose stamp is strictly older than
  // (now − window). archived_days gates observations; facts_expired_days gates facts —
  // the two windows are independent (facts are kept longer by default).
  const archivedObservationsBeforeMs = nowMs - deps.config.retention.archived_days * DAY_MS;
  const expiredFactsBeforeMs = nowMs - deps.config.retention.facts_expired_days * DAY_MS;

  try {
    const result = await prune.call(deps.memoryStore, {
      archivedObservationsBeforeMs,
      expiredFactsBeforeMs,
    });
    if (result.observationsDeleted > 0 || result.factsDeleted > 0) {
      deps.log("memory.retention.pruned", {
        observations_deleted: result.observationsDeleted,
        facts_deleted: result.factsDeleted,
      });
    }
  } catch (err) {
    // fail-open: a delete failure never escapes — the rows are re-evaluated next tick.
    deps.log("memory.retention.prune_failed", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
