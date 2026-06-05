import type { ForgettingConfig, ReflectionScope } from "@helm/shared";
import type { MemoryStore } from "../../store/ports.js";
import { forgettingScore } from "./score.js";

// The decay SWEEP (docs/12 "Eviction, demotion, promotion", pass 1 — memory_jobs.
// type='decay'). This is an OFF-the-request-path job, a sibling of runObserverJob /
// runReflectorJob: a background worker claims a `decay` row and runs this. It NEVER
// runs synchronously inside a request and must NEVER throw to a caller (fail-open,
// CLAUDE.md principle 3): failure is recorded on the job + logged. Framework-agnostic
// — store, clock, log and the forgetting config are all dependency-injected; the
// score math is the SAME pure function (forgetting/score.ts) the inject trim uses, so
// "alive" means one thing across retrieval and forgetting (docs/12).
//
// v1 implements PASS 1 ONLY (docs/12 sweep passes 1–4): DEMOTE mid → archived. For
// the job's account scope, score every ACTIVE observation (fallback_ts = observed_at,
// referenced_at coalesced) and soft-invalidate (status='archived', archived_at=now)
// the ones scoring below `decay.archive_threshold`. Never deleted (audit-friendly);
// archived rows simply stop being injected and stop counting toward the budget. The
// later passes (promote→facts, supersede, hard-delete) land in P6/P7.
//
// GATING (defence in depth, Codex review fix): 'decay' jobs are only ever ENQUEUED
// when forgetting.enabled is true (see the scheduler trigger) — but the queue is
// PERSISTENT, so a pending row enqueued during an earlier enabled window can survive
// a restart with the master switch turned off. The enqueue gate alone is therefore
// not enough: runDecayJob RE-CHECKS `config.enabled` at entry and no-ops the job
// (marked done — never left pending to retry forever) when the flag is off. This
// keeps the contract absolute: enabled:false ⇒ nothing is ever archived, including
// by leftover jobs.

// A background job: a pointer to the ACCOUNT being swept. The scope is an account-only
// ReflectionScope (no project/resource/thread level), so the enqueue dedupe keys one
// open decay row per account (docs/12 "buffer-flush … never per request").
export interface DecayJob {
  jobId: string;
  scope: ReflectionScope;
}

// The per-row scoring inputs the sweep reads off one ACTIVE observation. Mirrors the
// `ScoreInput` of forgetting/score.ts but named for the mid tier: `observedAt` is the
// per-tier `fallback_ts` (docs/12 fallback table — observations fall back to observed_at
// when referenced_at is null). The store read returns ONLY active rows of the account.
export interface ScorableObservation {
  id: string;
  referencedAt: Date | null;
  observedAt: Date;
  referenceCount: number;
  importance: number;
}

// The store surface the sweep needs. Both methods are account-guarded in the adapters
// (defence in depth — same as the existing read predicates and bumpReferences). They
// are optional on MemoryStore (additive, gated), so the sweep null-checks before use
// and fails the job cleanly if an adapter predates this phase.
export interface DecayDeps {
  memoryStore: MemoryStore;
  // The whole forgetting config block; the sweep reads `score` (curve) + `decay`
  // (archive_threshold) + `sweep` (loop bounds).
  config: ForgettingConfig;
  // Injected clock — the score's `now`, the archived_at stamp, AND the ONLY source of
  // wallclock for the bounded loop (tests use a fake clock; the real clock is wired in
  // the composition root). NEVER read the real time inside this module.
  now: () => Date;
  log: (line: string, meta?: object) => void;
}

// How many sub-threshold ids are archived per loop ITERATION. Each chunk is one bounded
// step: the loop stops at max_iterations chunks, when the wallclock budget is spent, or
// after max_consecutive_errors chunk failures in a row (docs/12 "bounded loop"). Kept
// small + constant so a single sweep does not issue one giant UPDATE.
const ARCHIVE_CHUNK = 50;

// Run ONE decay sweep for the job's account (pass 1: demote sub-threshold observations).
// Success OR failure both update memory_jobs.status; failure is recorded + logged and
// NEVER thrown (fail-open — a sweep failure never affects any in-flight request, and
// the swept account is simply re-swept on the next trigger).
export async function runDecayJob(job: DecayJob, deps: DecayDeps): Promise<void> {
  const accountId = job.scope.accountId;
  try {
    // Master-switch re-check (Codex review fix) — a persisted decay row from an
    // earlier ENABLED window must not sweep after a restart with the flag off.
    // Mark it done (a no-op, not a failure: nothing is wrong, the operator turned
    // forgetting off) so it never lingers pending. enabled:false ⇒ zero archives.
    if (deps.config.enabled !== true) {
      await deps.memoryStore.updateJobStatus(job.jobId, "done");
      deps.log("memory.decay.noop_disabled", { account_id: accountId });
      return;
    }

    // The adapter methods are optional (gated/additive). A store that predates this
    // phase cannot sweep — fail the job cleanly rather than crash or silently noop.
    const list = deps.memoryStore.listScorableObservations;
    const archive = deps.memoryStore.archiveObservations;
    if (list === undefined || archive === undefined) {
      await deps.memoryStore.updateJobStatus(
        job.jobId,
        "failed",
        "decay: store lacks sweep methods",
      );
      deps.log("memory.decay.unsupported_store", { account_id: accountId });
      return;
    }

    // Read the account's ACTIVE observations with their scoring fields, OLDEST first
    // and BOUNDED (Codex review fix): the read is capped at max_iterations × chunk so
    // it can never load more rows than the bounded archive loop could process in one
    // sweep — otherwise a huge tenant would score an unbounded set up front, bypassing
    // the iteration/wallclock caps. Leftover rows are swept on the next trigger
    // (decay over-retains on under-coverage — fail-open). The score is the pure
    // forgetting score (fallback_ts = observed_at; the null-referenced_at coalesce
    // lives inside the score fn). Sub-threshold rows are the demotion set.
    const now = deps.now();
    const scanLimit = deps.config.sweep.max_iterations * ARCHIVE_CHUNK;
    const threshold = deps.config.decay.archive_threshold;
    const scoreConfig = deps.config.score;
    // `candidates` pushes the SAME forgetting score into SQL so the page contains
    // ONLY below-threshold rows (Codex review fix II — starvation): with a plain
    // oldest-first LIMIT, a page full of survivors (reinforced/vital rows) would be
    // re-selected every sweep and condemned rows beyond the limit never reached.
    // Candidates leave the active set when archived, so every sweep makes progress.
    // The TS re-score below stays as defence in depth (float-edge disagreement → skip).
    const rows = await list.call(deps.memoryStore, {
      accountId,
      limit: scanLimit,
      candidates: {
        nowMs: now.getTime(),
        half_life_s: scoreConfig.half_life_s,
        importance_floor: scoreConfig.importance_floor,
        importance_ceil: scoreConfig.importance_ceil,
        access_weight: scoreConfig.access_weight,
        threshold,
      },
    });
    const condemned: string[] = [];
    for (const r of rows) {
      const score = forgettingScore(
        {
          referencedAt: r.referencedAt,
          fallbackTs: r.observedAt,
          referenceCount: r.referenceCount,
          importance: r.importance,
        },
        scoreConfig,
        now,
      );
      if (score < threshold) condemned.push(r.id);
    }

    if (condemned.length === 0) {
      await deps.memoryStore.updateJobStatus(job.jobId, "done");
      deps.log("memory.decay.noop_nothing_below_threshold", {
        account_id: accountId,
        scanned: rows.length,
      });
      return;
    }

    // Archive in bounded chunks. The loop is hard-capped THREE ways (docs/12), all
    // driven by the injected clock / config — never an unbounded drain:
    //   - max_iterations   : at most N chunks per sweep;
    //   - max_wallclock_s  : bail once the elapsed budget (clock-measured) is spent;
    //   - max_consecutive_errors: back off after N chunk failures in a row, so a
    //     persistently-failing write can never spin the worker. The leftover rows are
    //     simply re-swept on the next trigger — decay over-retains on error (fail-open).
    const { max_iterations, max_wallclock_s, max_consecutive_errors } = deps.config.sweep;
    const startMs = now.getTime();
    let archivedCount = 0;
    let consecutiveErrors = 0;
    let iterations = 0;
    for (let offset = 0; offset < condemned.length; offset += ARCHIVE_CHUNK) {
      if (iterations >= max_iterations) {
        deps.log("memory.decay.iteration_cap", { account_id: accountId, iterations });
        break;
      }
      if ((deps.now().getTime() - startMs) / 1000 >= max_wallclock_s) {
        deps.log("memory.decay.wallclock_cap", { account_id: accountId, iterations });
        break;
      }
      iterations += 1;
      const ids = condemned.slice(offset, offset + ARCHIVE_CHUNK);
      try {
        await archive.call(deps.memoryStore, { accountId, ids, now });
        archivedCount += ids.length;
        consecutiveErrors = 0;
      } catch (chunkErr) {
        consecutiveErrors += 1;
        deps.log("memory.decay.chunk_failed", {
          account_id: accountId,
          error: chunkErr instanceof Error ? chunkErr.message : String(chunkErr),
          consecutive_errors: consecutiveErrors,
        });
        if (consecutiveErrors >= max_consecutive_errors) {
          deps.log("memory.decay.error_cap", { account_id: accountId });
          break;
        }
      }
    }

    // docs/12 (Codex review fix) — a reflection is a derived cache of its scope's
    // ACTIVE observations, so archiving observations makes the affected reflections
    // STALE: the forgotten content lingers in the already-written reflection (and
    // keeps being injected) until something rebuilds it. So after a sweep that
    // actually archived rows, enqueue ONE reflector REBUILD per active-reflection
    // scope of this account. The rebuild re-merges the now-reduced active set
    // (forgotten content drops); a scope whose active set is now EMPTY gets its
    // reflection archived by the Reflector's empty-set branch. Dedupe via the
    // open-job index; FULLY fail-open — a rebuild-enqueue failure never fails the
    // sweep (the next sweep re-enqueues).
    if (archivedCount > 0 && deps.memoryStore.listActiveReflectionScopes !== undefined) {
      try {
        const scopes = await deps.memoryStore.listActiveReflectionScopes(accountId);
        for (const scope of scopes) {
          try {
            await deps.memoryStore.enqueueJob({ type: "reflector", scope });
          } catch (enqErr) {
            deps.log("memory.decay.rebuild_enqueue_failed", {
              account_id: accountId,
              scope,
              error: enqErr instanceof Error ? enqErr.message : String(enqErr),
            });
          }
        }
      } catch (listErr) {
        deps.log("memory.decay.rebuild_list_failed", {
          account_id: accountId,
          error: listErr instanceof Error ? listErr.message : String(listErr),
        });
      }
    }

    await deps.memoryStore.updateJobStatus(job.jobId, "done");
    deps.log("memory.decay.swept", {
      account_id: accountId,
      scanned: rows.length,
      condemned: condemned.length,
      archived: archivedCount,
    });
  } catch (err) {
    // fail-open: a sweep failure must never bubble. Record it on the job + log; this
    // runs entirely off the request path (the trigger that enqueued it is long gone).
    const message = err instanceof Error ? err.message : String(err);
    try {
      await deps.memoryStore.updateJobStatus(job.jobId, "failed", message);
    } catch (updateErr) {
      // Even the failure bookkeeping is best-effort — still never throw.
      deps.log("memory.decay.job_update_failed", {
        account_id: accountId,
        error: updateErr instanceof Error ? updateErr.message : String(updateErr),
      });
    }
    deps.log("memory.decay.failed", { account_id: accountId, error: message });
  }
}
