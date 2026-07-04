import type { CompactionOverrides } from "@helm/shared";
import type { MemoryStore } from "../store/ports.js";
import { resolveCompactionTunables } from "./compaction-policy.js";

// Idle-flush trigger — the memory-FORMATION backstop for short threads. Most
// compaction is enqueued on the request path (writeback) and fires once the
// uncovered segment crosses the size trigger; but a thread that asks one short
// question and never returns would never reach that size, so its turns would
// never become an observation (the raw material of reflections + facts). This
// sweep, run on the worker tick (never per request, like decay), enqueues an
// idle-flush observer job for every thread that went quiet (last activity ≥
// idle_flush_s ago) while still holding uncovered history. The observer's idle
// path folds EVERYTHING, so the next sweep's coverage-frontier query stops
// matching the thread and the loop TERMINATES — no eternal re-enqueue.
//
// Unlike decay, this is NOT gated behind forgetting.enabled: memory formation is
// a baseline responsibility of the gateway, independent of the forgetting layer.
// Fail-open throughout (principle 3): a store without the optional candidate
// query, a read failure, or a single enqueue failure is logged, never thrown —
// the thread is simply re-evaluated next tick. The open-job dedupe collapses an
// already-queued thread to a no-op, so we enqueue without pre-checking.

export interface IdleFlushDeps {
  memoryStore: MemoryStore;
  // Injected clock (epoch-ms source for the idle cutoff). The composition root
  // wires Date.now; tests pin it.
  now: () => Date;
  // Bound the per-tick scan so one busy deployment can't enqueue unbounded jobs
  // in a single sweep; leftovers are picked up on the next tick.
  batchSize: number;
  // Optional config.memory.compaction trigger overrides (idle_flush_s drives the
  // sweep cutoff). Absent → the internal AUTO_PRIORS default applies.
  compaction?: CompactionOverrides;
  log: (line: string, meta?: object) => void;
}

// Evaluate the idle gate once and enqueue idle-flush observer jobs for quiet
// threads with uncovered history. Returns nothing; all outcomes are logged.
// Safe to call every worker tick.
export async function maybeEnqueueIdleObserverJobs(deps: IdleFlushDeps): Promise<void> {
  const listCandidates = deps.memoryStore.listIdleFlushCandidates;
  if (listCandidates === undefined) {
    // A store predating this phase cannot compute candidates — quietly no-op
    // (the idle sweep simply never triggers on such a build).
    deps.log("memory.idle_flush.unsupported_store", {});
    return;
  }

  try {
    const nowMs = deps.now().getTime();
    const tunables = resolveCompactionTunables(deps.compaction);
    const input: { idleBeforeMs: number; idleAfterMs?: number; limit: number } = {
      idleBeforeMs: nowMs - tunables.idleFlushS * 1000,
      limit: deps.batchSize,
    };
    if (tunables.idleFlushMaxAgeS !== undefined) {
      input.idleAfterMs = nowMs - tunables.idleFlushMaxAgeS * 1000;
    }
    const candidates = await listCandidates.call(deps.memoryStore, input);
    for (const { accountId, threadId, projectId, resourceId } of candidates) {
      // Per-thread guard: one thread's enqueue failure must not skip the rest.
      try {
        // A PLAIN observer scope (no trigger): identical to a writeback enqueue,
        // so the open-job dedupe collapses both to ONE lock per thread — no
        // overlapping writeback+idle observers in a multi-worker deployment. The
        // observer decides whether to fold the whole history from message ages at
        // run time. Carry project/resource so the resulting observation can
        // promote to the project/resource reflection (the only slots inject
        // hydrates); without it a short idle thread's observation would have no
        // readable target and the reflector would never run.
        await deps.memoryStore.enqueueJob({
          type: "observer",
          scope: {
            accountId,
            threadId,
            ...(projectId !== undefined ? { projectId } : {}),
            ...(resourceId !== undefined ? { resourceId } : {}),
          },
        });
      } catch (err) {
        deps.log("memory.idle_flush.enqueue_failed", {
          thread_id: threadId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    if (candidates.length > 0) {
      deps.log("memory.idle_flush.enqueued", { count: candidates.length });
    }
  } catch (err) {
    // fail-open: a candidate-read failure never escapes — the gate re-evaluates
    // next tick (idle flush is delayed, never breaks the worker).
    deps.log("memory.idle_flush.failed", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
