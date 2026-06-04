import type { MemoryJobRow } from "@helm/shared";
import type { MemoryStore } from "../store/ports.js";
import type { ObserverJob, ObserverResult } from "./observer.js";
import type { ReflectorJob, ReflectorResult } from "./reflector.js";

// Background memory worker (docs/08 Phase 2). The OFF-the-request-path drainer for
// the memory_jobs queue — the inject phase ENQUEUES observer jobs on the request
// path; this worker CONSUMES them later, plus the reflector jobs an observer
// promotes. Modeled on startSignalScheduler: a plain unref'd setInterval whose
// tick is fully fail-open, so a single bad job (or a whole bad tick) NEVER stops
// the timer or stalls the process (CLAUDE.md principle 3).
//
// Pure timer glue (no web framework) so it lives in core and is unit-testable with
// fake timers. The job runners + store are dependency-injected.

export interface MemoryWorkerDeps {
  memoryStore: MemoryStore;
  // How many jobs to claim per tick.
  batchSize: number;
  intervalMs: number;
  now: () => number; // epoch ms; injectable for tests
  log: (line: string, meta?: object) => void;
  // Run one observer job. Wired in the composition root to runObserverJob(job, observerDeps).
  runObserver: (job: ObserverJob) => Promise<ObserverResult>;
  // Run one reflector job. Wired to runReflectorJob(job, reflectorDeps).
  runReflector: (job: ReflectorJob) => Promise<ReflectorResult>;
}

export interface MemoryWorkerHandle {
  stop(): void;
}

// Process a single claimed job. Each branch is itself fail-open (the runners never
// throw), but we still guard so a thrown promotion/enqueue can't escape the tick.
async function processJob(job: MemoryJobRow, deps: MemoryWorkerDeps): Promise<void> {
  if (job.type === "observer") {
    // D2-bis: runObserverJob needs {jobId, threadId}, NOT a scope. threadId is
    // `.min(1)` and cannot be downgraded to "" — an observer row that lost its
    // thread anchor is unrunnable, so mark it failed and skip it.
    const threadId = job.scope.threadId;
    if (threadId === undefined) {
      await deps.memoryStore.updateJobStatus(job.jobId, "failed", "observer job missing threadId");
      deps.log("memory.worker.observer_missing_thread", { job_id: job.jobId });
      return;
    }
    const result = await deps.runObserver({
      jobId: job.jobId,
      accountId: job.scope.accountId,
      threadId,
    });
    // D5: only promote a reflector when the observer actually wrote a new
    // observation — a noop observer leaves the reflection untouched. The reflector
    // job inherits the observer's FULL scope: the thread anchor is its observation
    // SOURCE, while runReflectorJob writes the reflection at the highest READABLE
    // level (project > resource — the only slots inject hydrates from, docs/08).
    // A thread-only scope has no readable slot, so promoting it would burn merge
    // tokens on a reflection nothing reads — skip. enqueueJob dedupes a pending
    // reflector for the same scope (D6), so a flood collapses to one row.
    if (
      result.observationId !== null &&
      (job.scope.projectId !== undefined || job.scope.resourceId !== undefined)
    ) {
      try {
        await deps.memoryStore.enqueueJob({ type: "reflector", scope: job.scope });
      } catch (err) {
        // The observer itself succeeded (its runner recorded done) — a promotion
        // failure must not be converted into a failed observer job. The next
        // observer write for this scope re-promotes, so nothing is lost for good.
        deps.log("memory.worker.promote_failed", {
          job_id: job.jobId,
          scope: job.scope,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return;
  }
  // reflector: the whole scope drives the merge.
  await deps.runReflector({ jobId: job.jobId, scope: job.scope });
}

export function startMemoryWorker(deps: MemoryWorkerDeps): MemoryWorkerHandle {
  const tick = async (): Promise<void> => {
    const jobs = await deps.memoryStore.claimPendingJobs(deps.batchSize);
    for (const job of jobs) {
      // Per-job guard: a single failing job must not abort the rest of the batch
      // nor stop the timer (principle 3). The runners record their own outcome on
      // the row; this catch is the belt-and-braces around everything else.
      try {
        await processJob(job, deps);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        deps.log("memory.worker.job_failed", {
          job_id: job.jobId,
          type: job.type,
          error: message,
        });
        // claimPendingJobs already flipped this row to `running`, and enqueueJob
        // dedupes against pending AND running rows — swallowing the throw without
        // closing the row would block this scope's queue FOREVER. Best-effort:
        // even the failure bookkeeping must never escape the tick.
        try {
          await deps.memoryStore.updateJobStatus(job.jobId, "failed", message);
        } catch (updateErr) {
          deps.log("memory.worker.job_update_failed", {
            job_id: job.jobId,
            error: updateErr instanceof Error ? updateErr.message : String(updateErr),
          });
        }
      }
    }
  };

  const timer = setInterval(() => {
    // Fire-and-forget; tick is fail-open, but guard the promise so a rejection can
    // never become an unhandled rejection on the timer.
    void tick().catch((err: unknown) => {
      deps.log("memory.worker.tick_failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }, deps.intervalMs);

  // Do not keep the event loop alive solely for the memory worker (Node only).
  (timer as { unref?: () => void }).unref?.();

  return {
    stop() {
      clearInterval(timer);
    },
  };
}
