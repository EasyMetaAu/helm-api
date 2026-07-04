import type { MemoryJobRow, ReflectionScope } from "@helm/shared";
import type { MemoryStore } from "../store/ports.js";
import type { DecayJob } from "./forgetting/decay.js";
import type { ObserverJob, ObserverResult } from "./observer.js";
import type { EmbeddingJob } from "./recall/embedding-job.js";
import { type ReflectorJob, type ReflectorResult, reflectionTargetScope } from "./reflector.js";

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
  // How many claimed jobs may run at the same time. Defaults to 1 for old
  // callers/tests; the gateway can raise it modestly to drain LLM-bound backlog
  // without claiming a huge batch that sits `running` for minutes.
  concurrency?: number;
  intervalMs: number;
  // Catch-up mode: one interval/wake drain can claim multiple batches back-to-back
  // instead of waiting for the next timer. Defaults to 1 for old callers/tests; the
  // gateway sets a larger value so a large backlog clears quickly.
  maxBatchesPerDrain?: number;
  // Wall-clock guard for catch-up drains. Checked between batches, so an in-flight
  // batch is allowed to finish and record job statuses before the cap applies.
  maxDrainMs?: number;
  // Optional macrotask yield between full batches. The gateway wires this so a
  // backlog catch-up drain does not monopolize Node's event loop on small hosts.
  yieldBetweenBatches?: () => Promise<void>;
  // Quiet-window (ms) for wake() — the event-driven, OFF-interval drain the request
  // path triggers after a memory observe settles. TRAILING-EDGE debounce: each wake
  // re-arms the window, so a burst of turns coalesces into ONE drain. Because the
  // open observer job dedupes a thread's turns while it sits pending (memory-store
  // enqueueJob), waiting coalesceMs before draining MERGES those turns into a single
  // observer run = a single LLM call — the latency lever that does NOT inflate the
  // observer's per-turn cost. The intervalMs timer remains the backstop/maxWait, so
  // worst-case formation latency is still ≤ intervalMs even under continuous activity.
  coalesceMs: number;
  now: () => number; // epoch ms; injectable for tests
  log: (line: string, meta?: object) => void;
  // Run one observer job. Wired in the composition root to runObserverJob(job, observerDeps).
  runObserver: (job: ObserverJob) => Promise<ObserverResult>;
  // Run one reflector job. Wired to runReflectorJob(job, reflectorDeps).
  runReflector: (job: ReflectorJob) => Promise<ReflectorResult>;
  // Run one decay sweep (docs/12 P5). Wired to runDecayJob(job, decayDeps). OPTIONAL
  // + GATED: 'decay' rows are only enqueued when forgetting.enabled, so a worker built
  // without forgetting (the default) never receives one — and if one somehow arrives,
  // the dispatch fails it cleanly rather than running the wrong worker (no reflector
  // fall-through). Keeping it optional also means existing worker fixtures that predate
  // this phase stay valid unmodified (the gating lever applies to the type surface too).
  runDecay?: (job: DecayJob) => Promise<void>;
  // docs/14 — run one embedding job (fill the vector index for an account's facts).
  // Wired to runEmbeddingJob when memory.llm.embedding_model is set; absent ⇒ no
  // 'embedding' rows are enqueued, and a stray one is failed cleanly (like decay).
  runEmbedding?: (job: EmbeddingJob) => Promise<void>;
  // OPTIONAL per-tick hook run BEFORE claiming jobs (docs/12 P5 trigger). The
  // composition root wires maybeEnqueueDecayJobs here so the buffer-flush gate is
  // evaluated on the worker interval (OFF the request path — decay never triggers per
  // request). Itself fail-open + guarded by the tick wrapper; with forgetting off it is
  // either unset or a no-op, so the tick is byte-identical to today.
  onTick?: () => Promise<void>;
}

export interface MemoryWorkerHandle {
  stop(): void;
  // Request-path trigger: schedule a drain after coalesceMs of quiet (debounced).
  // Coalesced, non-blocking, fail-open — the caller (a write-queue task settle) is
  // never blocked and a wake can never throw. Does NOT run the onTick housekeeping
  // (that stays on the interval cadence).
  wake(): void;
}

// Process a single claimed job. Dispatch is EXPLICIT per type (observer / reflector /
// decay) — NOT a two-branch "observer else reflector" fall-through (docs/12 P5: a
// decay row must never be silently handed to the reflector). Each branch is itself
// fail-open (the runners never throw), but we still guard so a thrown promotion/enqueue
// can't escape the tick. An UNKNOWN type (a corrupt row, or a future kind this worker
// build predates) is marked failed rather than run by the wrong worker.
// docs/14 — best-effort: after a fact-writing job (observer/reflector), enqueue ONE
// embedding job for the account so newly written facts get vectors. Gated on
// runEmbedding (no embedder ⇒ no embedding rows enqueued). The open-job unique index
// coalesces repeats; a failure just defers embedding to the next write (fail-open).
async function maybeEnqueueEmbedding(
  scope: ReflectionScope,
  deps: MemoryWorkerDeps,
): Promise<void> {
  if (deps.runEmbedding === undefined) return;
  try {
    await deps.memoryStore.enqueueJob({ type: "embedding", scope: { accountId: scope.accountId } });
  } catch {
    // best-effort — the next fact write re-enqueues.
  }
}

async function processJob(job: MemoryJobRow, deps: MemoryWorkerDeps): Promise<void> {
  if (job.type === "reflector") {
    // reflector: the whole scope drives the merge.
    await deps.runReflector({ jobId: job.jobId, scope: job.scope });
    await maybeEnqueueEmbedding(job.scope, deps);
    return;
  }
  if (job.type === "decay") {
    // decay sweep (docs/12 P5): account-scoped soft-archive of sub-threshold
    // observations. Only enqueued when forgetting.enabled, so runDecay should be wired;
    // if it is not (a worker built without forgetting), fail the row cleanly instead of
    // crashing or mis-routing.
    if (deps.runDecay === undefined) {
      await deps.memoryStore.updateJobStatus(
        job.jobId,
        "failed",
        "decay job but worker has no runDecay",
      );
      deps.log("memory.worker.decay_unsupported", { job_id: job.jobId });
      return;
    }
    await deps.runDecay({ jobId: job.jobId, scope: job.scope });
    return;
  }
  if (job.type === "embedding") {
    // docs/14 — fill the vector index for the account's facts. Like decay: only
    // enqueued when the embedder is wired (runEmbedding set); a stray row on a worker
    // without it is failed cleanly, never mis-routed.
    if (deps.runEmbedding === undefined) {
      await deps.memoryStore.updateJobStatus(
        job.jobId,
        "failed",
        "embedding job but worker has no runEmbedding",
      );
      deps.log("memory.worker.embedding_unsupported", { job_id: job.jobId });
      return;
    }
    await deps.runEmbedding({ jobId: job.jobId, scope: job.scope });
    return;
  }
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
      // Carry the cross-thread scope through so the Observer's salient-fact fast
      // path can write facts at project/resource level (recallable in a new thread).
      ...(job.scope.projectId !== undefined ? { projectId: job.scope.projectId } : {}),
      ...(job.scope.resourceId !== undefined ? { resourceId: job.scope.resourceId } : {}),
    });
    // D5: only promote a reflector when the observer actually wrote a new
    // observation — a noop observer leaves the reflection untouched. The reflector
    // job is enqueued AT THE TARGET level (project > resource — the only slots
    // inject hydrates from, docs/08): the reflector aggregates observations across
    // ALL the target's threads, so the thread anchor adds nothing, and dropping it
    // lets same-project promotions from different threads dedupe to ONE row (D6).
    // A thread-only scope has no readable slot, so promoting it would burn merge
    // tokens on a reflection nothing reads — skip.
    if (
      result.observationId !== null &&
      (job.scope.projectId !== undefined || job.scope.resourceId !== undefined)
    ) {
      try {
        await deps.memoryStore.enqueueJob({
          type: "reflector",
          scope: reflectionTargetScope(job.scope),
        });
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
    await maybeEnqueueEmbedding(job.scope, deps);
    return;
  }
  // Unknown type: a corrupt scope_id row, or a job kind this worker build predates.
  // Mark it failed (closing the running row so its scope's queue is not blocked
  // forever) rather than dispatching it to the wrong worker — the P5 dispatch
  // requirement (no reflector fall-through). `never` on a clean enum widening means a
  // newly-added MemoryJobType would surface here at compile time too.
  await deps.memoryStore.updateJobStatus(
    job.jobId,
    "failed",
    `unknown memory job type: ${String((job as { type: string }).type)}`,
  );
  deps.log("memory.worker.unknown_job_type", {
    job_id: job.jobId,
    type: (job as { type: string }).type,
  });
}

export function startMemoryWorker(deps: MemoryWorkerDeps): MemoryWorkerHandle {
  // Claim + dispatch one batch. The latency-critical path — NO onTick housekeeping
  // (that is the interval's job). Shared by the interval tick and the wake drain.
  const workerConcurrency = Math.max(1, Math.floor(deps.concurrency ?? 1));

  const runOneJob = async (job: MemoryJobRow): Promise<void> => {
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
  };

  const processClaimedJobs = async (jobs: MemoryJobRow[]): Promise<void> => {
    if (jobs.length === 0) return;
    let next = 0;
    const runLane = async (): Promise<void> => {
      while (next < jobs.length) {
        const job = jobs[next];
        next += 1;
        if (job !== undefined) await runOneJob(job);
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(workerConcurrency, jobs.length) }, () => runLane()),
    );
  };

  const drainJobs = async (): Promise<number> => {
    const jobs = await deps.memoryStore.claimPendingJobs(deps.batchSize);
    await processClaimedJobs(jobs);
    return jobs.length;
  };

  // Reentrancy guard: the interval tick and a wake drain (or two overlapping wakes)
  // must never run drainJobs concurrently. A trigger that arrives mid-drain sets
  // `rerun` so the in-flight loop drains once more — a job enqueued during the drain
  // is never stranded until the next interval. claimPendingJobs is itself an atomic
  // UPDATE…RETURNING, so this guard is about avoiding wasted overlap, not correctness.
  let draining = false;
  let rerun = false;
  const drainCoalesced = async (): Promise<void> => {
    if (draining) {
      rerun = true;
      return;
    }
    draining = true;
    try {
      do {
        rerun = false;
        const maxBatches = Math.max(1, Math.floor(deps.maxBatchesPerDrain ?? 1));
        const maxDrainMs =
          deps.maxDrainMs !== undefined ? Math.max(1, Math.floor(deps.maxDrainMs)) : null;
        const startedAt = deps.now();
        let batches = 0;
        let lastClaimed = 0;
        do {
          lastClaimed = await drainJobs();
          batches += 1;
          if (lastClaimed < deps.batchSize) break;
          if (maxDrainMs !== null && deps.now() - startedAt >= maxDrainMs) break;
          if (batches < maxBatches) await deps.yieldBetweenBatches?.();
        } while (batches < maxBatches);
        if (lastClaimed >= deps.batchSize && batches >= maxBatches) {
          deps.log("memory.worker.drain_batch_cap", { batches, batch_size: deps.batchSize });
        } else if (lastClaimed >= deps.batchSize && maxDrainMs !== null) {
          deps.log("memory.worker.drain_time_cap", { batches, max_drain_ms: maxDrainMs });
        }
      } while (rerun);
    } finally {
      draining = false;
    }
  };

  const tick = async (): Promise<void> => {
    // Per-tick hook (P5 trigger). Runs BEFORE the claim so a decay job enqueued this
    // tick can be drained the same tick. Guarded: a throw here must never abort the
    // drain nor stop the timer (fail-open, principle 3). DELIBERATELY only on the
    // interval — wake() skips it so request-driven drains never accelerate the heavy
    // decay/retention/idle-flush housekeeping.
    if (deps.onTick !== undefined) {
      try {
        await deps.onTick();
      } catch (err) {
        deps.log("memory.worker.on_tick_failed", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    await drainCoalesced();
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

  // Trailing-edge debounce timer for wake(): re-armed on every wake, fires one
  // jobs-only drain after coalesceMs of quiet.
  let wakeTimer: ReturnType<typeof setTimeout> | null = null;
  // Latched by stop(): a wake() arriving afterwards (e.g. a write-queue task that
  // settles while the queue drains on shutdown — stop() runs before that drain) must
  // not arm a fresh timer that later claims jobs against an already-closed store.
  let stopped = false;

  return {
    stop() {
      stopped = true;
      clearInterval(timer);
      if (wakeTimer !== null) {
        clearTimeout(wakeTimer);
        wakeTimer = null;
      }
    },
    wake() {
      if (stopped) return;
      if (wakeTimer !== null) clearTimeout(wakeTimer);
      wakeTimer = setTimeout(() => {
        wakeTimer = null;
        // Jobs-only drain (no onTick). Fail-open: a rejection is logged, never an
        // unhandled rejection on the timer.
        void drainCoalesced().catch((err: unknown) => {
          deps.log("memory.worker.wake_drain_failed", {
            error: err instanceof Error ? err.message : String(err),
          });
        });
      }, deps.coalesceMs);
      (wakeTimer as { unref?: () => void }).unref?.();
    },
  };
}
