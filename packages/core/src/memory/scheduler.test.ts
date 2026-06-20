import type { MemoryJobRow } from "@helm/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MemoryJobStatus, MemoryStore } from "../store/ports.js";
import type { ObserverResult } from "./observer.js";
import type { ReflectorResult } from "./reflector.js";
import { type MemoryWorkerDeps, startMemoryWorker } from "./scheduler.js";

const OBS_OK: ObserverResult = { observationId: "o1", sourceMessageRange: ["a", "b"] };
const OBS_NOOP: ObserverResult = { observationId: null, sourceMessageRange: null };
const REF_OK: ReflectorResult = { reflectionId: "r1", version: 1, changed: true };

// docs/08 Phase 2 — the background worker that drains memory_jobs. Mirrors the
// signal scheduler shape (setInterval + unref + fail-open). Each tick claims a
// batch and dispatches by type: observer rows run runObserverJob({jobId,threadId})
// built from scope.threadId (D2-bis); reflector rows run runReflectorJob(job,scope).
// An observer success promotes a reflector job (D5). A throwing job is swallowed
// so the timer keeps firing (principle 3).

// A fake MemoryStore that hands a fixed batch on the FIRST claim then drains, and
// records every enqueued + status-updated job.
function makeStore(firstBatch: MemoryJobRow[]) {
  const enqueued: Array<{ type: string; scope: unknown }> = [];
  const jobUpdates: Array<{ jobId: string; status: MemoryJobStatus }> = [];
  let served = false;
  const base = {
    ensureThread: vi.fn(async () => {}),
    appendMessage: vi.fn(async () => "m"),
    listMessages: vi.fn(async () => []),
    appendObservation: vi.fn(async () => "o"),
    listObservations: vi.fn(async () => []),
    getReflection: vi.fn(async () => null),
    upsertReflection: vi.fn(async () => "r"),
    updateJobStatus: vi.fn(async (jobId: string, status: MemoryJobStatus) => {
      jobUpdates.push({ jobId, status });
    }),
    enqueueJob: vi.fn(async (input: { type: string; scope: unknown }) => {
      enqueued.push(input);
      return `enq-${enqueued.length}`;
    }),
    claimPendingJobs: vi.fn(async () => {
      if (served) return [];
      served = true;
      return firstBatch;
    }),
  };
  return {
    store: base as unknown as MemoryStore,
    enqueued,
    jobUpdates,
    claim: base.claimPendingJobs,
  };
}

function makeDeps(store: MemoryStore, overrides: Partial<MemoryWorkerDeps> = {}): MemoryWorkerDeps {
  return {
    memoryStore: store,
    batchSize: 10,
    intervalMs: 1000,
    // Quiet window before a wake-triggered drain (debounce). Default to the
    // interval so existing interval-only tests never see a wake fire; the wake
    // tests override it explicitly.
    coalesceMs: 1000,
    now: () => Date.now(),
    log: vi.fn(),
    runObserver: vi.fn(async () => OBS_OK),
    runReflector: vi.fn(async () => REF_OK),
    ...overrides,
  };
}

describe("startMemoryWorker", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("claims a batch each tick and dispatches an observer row to runObserver", async () => {
    const { store } = makeStore([
      { jobId: "j1", type: "observer", scope: { accountId: "acct-a", threadId: "t1" } },
    ]);
    const runObserver = vi.fn(async (): Promise<ObserverResult> => OBS_NOOP);
    const handle = startMemoryWorker(makeDeps(store, { runObserver }));

    await vi.advanceTimersByTimeAsync(1000);
    handle.stop();

    expect(runObserver).toHaveBeenCalledTimes(1);
    expect(runObserver).toHaveBeenCalledWith({ jobId: "j1", accountId: "acct-a", threadId: "t1" });
  });

  it("dispatches a reflector row to runReflector with the full scope", async () => {
    const scope = { accountId: "acct-a", projectId: "p1", threadId: "t1" };
    const { store } = makeStore([{ jobId: "j2", type: "reflector", scope }]);
    const runReflector = vi.fn(async (): Promise<ReflectorResult> => REF_OK);
    const handle = startMemoryWorker(makeDeps(store, { runReflector }));

    await vi.advanceTimersByTimeAsync(1000);
    handle.stop();

    expect(runReflector).toHaveBeenCalledTimes(1);
    expect(runReflector).toHaveBeenCalledWith({ jobId: "j2", scope });
  });

  it("marks an observer row with no threadId failed and skips it (D2-bis)", async () => {
    const { store, jobUpdates } = makeStore([
      { jobId: "j3", type: "observer", scope: { accountId: "acct-a" } },
    ]);
    const runObserver = vi.fn(async (): Promise<ObserverResult> => OBS_NOOP);
    const handle = startMemoryWorker(makeDeps(store, { runObserver }));

    await vi.advanceTimersByTimeAsync(1000);
    handle.stop();

    expect(runObserver).not.toHaveBeenCalled();
    expect(jobUpdates).toContainEqual({ jobId: "j3", status: "failed" });
  });

  it("promotes a reflector job after a successful observer write (D5)", async () => {
    const { store, enqueued } = makeStore([
      {
        jobId: "j1",
        type: "observer",
        scope: { accountId: "acct-a", projectId: "p1", threadId: "t1" },
      },
    ]);
    const runObserver = vi.fn(async (): Promise<ObserverResult> => OBS_OK);
    const handle = startMemoryWorker(makeDeps(store, { runObserver }));

    await vi.advanceTimersByTimeAsync(1000);
    handle.stop();

    // Promoted AT THE TARGET LEVEL (no thread anchor): the reflector aggregates
    // across the project's threads, and target-level scope ids let promotions
    // from different threads of the same project dedupe to one row (D6).
    expect(enqueued).toContainEqual({
      type: "reflector",
      scope: { accountId: "acct-a", projectId: "p1" },
    });
  });

  it("does NOT promote a reflector when the observer wrote nothing (noop)", async () => {
    const { store, enqueued } = makeStore([
      { jobId: "j1", type: "observer", scope: { accountId: "acct-a", threadId: "t1" } },
    ]);
    const runObserver = vi.fn(async (): Promise<ObserverResult> => OBS_NOOP);
    const handle = startMemoryWorker(makeDeps(store, { runObserver }));

    await vi.advanceTimersByTimeAsync(1000);
    handle.stop();

    expect(enqueued).toEqual([]);
  });

  it("does NOT promote a reflector for a thread-only scope (no readable reflection slot)", async () => {
    // inject only reads project/resource reflection slots (docs/08 assembly order)
    // — a thread-only reflection would be dead data + wasted merge tokens.
    const { store, enqueued } = makeStore([
      { jobId: "j1", type: "observer", scope: { accountId: "acct-a", threadId: "t1" } },
    ]);
    const handle = startMemoryWorker(makeDeps(store));

    await vi.advanceTimersByTimeAsync(1000);
    handle.stop();

    expect(enqueued).toEqual([]);
  });

  it("marks a claimed job failed when its runner throws (never a permanent running row)", async () => {
    // claimPendingJobs already flipped the row to running, and enqueueJob dedupes
    // against pending AND running rows — a swallowed throw must close the row or
    // the scope is blocked forever.
    const { store, jobUpdates } = makeStore([
      { jobId: "j1", type: "observer", scope: { accountId: "acct-a", threadId: "t1" } },
    ]);
    const runObserver = vi.fn(async () => {
      throw new Error("boom");
    });
    const handle = startMemoryWorker(makeDeps(store, { runObserver }));

    await vi.advanceTimersByTimeAsync(1000);
    handle.stop();

    expect(jobUpdates).toContainEqual({ jobId: "j1", status: "failed" });
  });

  it("a failing reflector promotion does not overwrite the observer job's own status", async () => {
    // The observer runner records its own done/failed; a throw from the PROMOTION
    // enqueue must be logged, not converted into a failed observer job.
    const { store, jobUpdates } = makeStore([
      {
        jobId: "j1",
        type: "observer",
        scope: { accountId: "acct-a", projectId: "p1", threadId: "t1" },
      },
    ]);
    (store.enqueueJob as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      throw new Error("queue down");
    });
    const log = vi.fn();
    const handle = startMemoryWorker(makeDeps(store, { log }));

    await vi.advanceTimersByTimeAsync(1000);
    handle.stop();

    expect(jobUpdates).not.toContainEqual({ jobId: "j1", status: "failed" });
    expect(log).toHaveBeenCalledWith(
      "memory.worker.promote_failed",
      expect.objectContaining({ job_id: "j1" }),
    );
  });

  it("swallows a throwing job and keeps the timer firing (fail-open)", async () => {
    const { store } = makeStore([
      { jobId: "j1", type: "observer", scope: { accountId: "acct-a", threadId: "t1" } },
    ]);
    const runObserver = vi.fn(async () => {
      throw new Error("boom");
    });
    const claimSpy = store.claimPendingJobs as ReturnType<typeof vi.fn>;
    const handle = startMemoryWorker(makeDeps(store, { runObserver }));

    await vi.advanceTimersByTimeAsync(1000);
    const callsAfterOne = claimSpy.mock.calls.length;
    await vi.advanceTimersByTimeAsync(1000);
    handle.stop();

    // The timer fired a SECOND time despite the first job throwing.
    expect(claimSpy.mock.calls.length).toBeGreaterThan(callsAfterOne);
  });

  it("dispatches a decay row to runDecay (NOT the reflector) — docs/12 P5", async () => {
    const scope = { accountId: "acct-a" };
    const { store } = makeStore([{ jobId: "d1", type: "decay", scope }]);
    const runDecay = vi.fn(async () => {});
    const runReflector = vi.fn(async (): Promise<ReflectorResult> => REF_OK);
    const handle = startMemoryWorker(makeDeps(store, { runDecay, runReflector }));

    await vi.advanceTimersByTimeAsync(1000);
    handle.stop();

    expect(runDecay).toHaveBeenCalledTimes(1);
    expect(runDecay).toHaveBeenCalledWith({ jobId: "d1", scope });
    // The decay row must NOT fall through to the reflector (the bug P5 fixes).
    expect(runReflector).not.toHaveBeenCalled();
  });

  it("fails an unknown job type gracefully instead of running the wrong worker", async () => {
    // A row whose type is none of observer/reflector/decay must be marked failed —
    // never dispatched to a runner (no silent reflector fall-through).
    const { store, jobUpdates } = makeStore([
      // biome-ignore lint/suspicious/noExplicitAny: deliberately forging an out-of-enum type.
      { jobId: "x1", type: "compactor" as any, scope: { accountId: "acct-a" } },
    ]);
    const runReflector = vi.fn(async (): Promise<ReflectorResult> => REF_OK);
    const runDecay = vi.fn(async () => {});
    const handle = startMemoryWorker(makeDeps(store, { runReflector, runDecay }));

    await vi.advanceTimersByTimeAsync(1000);
    handle.stop();

    expect(runReflector).not.toHaveBeenCalled();
    expect(runDecay).not.toHaveBeenCalled();
    expect(jobUpdates).toContainEqual({ jobId: "x1", status: "failed" });
  });

  it("runs the onTick hook before claiming, and swallows its throw (P5 trigger)", async () => {
    const { store } = makeStore([]);
    const calls: string[] = [];
    const onTick = vi.fn(async () => {
      calls.push("onTick");
      throw new Error("trigger boom");
    });
    const claimSpy = store.claimPendingJobs as ReturnType<typeof vi.fn>;
    claimSpy.mockImplementation(async () => {
      calls.push("claim");
      return [];
    });
    const handle = startMemoryWorker(makeDeps(store, { onTick }));

    await vi.advanceTimersByTimeAsync(1000);
    handle.stop();

    expect(onTick).toHaveBeenCalled();
    // onTick fired BEFORE the claim, and its throw did not abort the tick.
    expect(calls.slice(0, 2)).toEqual(["onTick", "claim"]);
  });

  it("stop() clears the interval (no further claims)", async () => {
    const { store } = makeStore([]);
    const claimSpy = store.claimPendingJobs as ReturnType<typeof vi.fn>;
    const handle = startMemoryWorker(makeDeps(store));

    await vi.advanceTimersByTimeAsync(1000);
    const calls = claimSpy.mock.calls.length;
    handle.stop();
    await vi.advanceTimersByTimeAsync(5000);

    expect(claimSpy.mock.calls.length).toBe(calls);
  });
});

// wake() — the event-driven, debounced off-interval drain. The request path calls
// it after a memory observe settles so a just-stated fact forms in ~coalesceMs
// instead of waiting up to a full interval. It is a TRAILING-EDGE debounce: each
// wake re-arms the window, so a burst of turns coalesces into ONE drain (the open
// observer job dedupes their messages) — preserving the batching that keeps the
// observer's LLM-call count down. The interval timer stays the backstop/maxWait.
describe("startMemoryWorker wake()", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  // A long interval so ONLY wake() can drive a drain in these tests (the interval
  // backstop is verified separately by the describe above).
  const WAKE_DEPS = { coalesceMs: 8000, intervalMs: 60_000 } as const;

  it("debounces the drain by coalesceMs (no drain before the window elapses)", async () => {
    const { store } = makeStore([
      { jobId: "j1", type: "observer", scope: { accountId: "a", threadId: "t1" } },
    ]);
    const claimSpy = store.claimPendingJobs as ReturnType<typeof vi.fn>;
    const runObserver = vi.fn(async (): Promise<ObserverResult> => OBS_NOOP);
    const handle = startMemoryWorker(makeDeps(store, { ...WAKE_DEPS, runObserver }));

    handle.wake();
    await vi.advanceTimersByTimeAsync(5000); // still inside the 8s window
    expect(claimSpy).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(3000); // window (8s) elapses
    expect(claimSpy).toHaveBeenCalledTimes(1);
    expect(runObserver).toHaveBeenCalledWith({ jobId: "j1", accountId: "a", threadId: "t1" });
    handle.stop();
  });

  it("coalesces a burst of wakes into a single drain (trailing-edge reset)", async () => {
    const { store } = makeStore([
      { jobId: "j1", type: "observer", scope: { accountId: "a", threadId: "t1" } },
    ]);
    const claimSpy = store.claimPendingJobs as ReturnType<typeof vi.fn>;
    const handle = startMemoryWorker(makeDeps(store, WAKE_DEPS));

    handle.wake();
    await vi.advanceTimersByTimeAsync(5000);
    handle.wake(); // re-arms — the earlier 8s timer is cancelled
    await vi.advanceTimersByTimeAsync(5000); // 5s < 8s since the last wake
    expect(claimSpy).not.toHaveBeenCalled();
    handle.wake(); // re-arms again
    await vi.advanceTimersByTimeAsync(8000); // window elapses after the LAST wake

    expect(claimSpy).toHaveBeenCalledTimes(1); // three wakes → ONE drain
    handle.stop();
  });

  it("a wake-triggered drain does NOT run the onTick housekeeping (only the interval does)", async () => {
    const { store } = makeStore([]);
    const onTick = vi.fn(async () => {});
    const handle = startMemoryWorker(makeDeps(store, { ...WAKE_DEPS, onTick }));

    handle.wake();
    await vi.advanceTimersByTimeAsync(8000);

    expect(store.claimPendingJobs).toHaveBeenCalledTimes(1); // it DID drain
    expect(onTick).not.toHaveBeenCalled(); // but skipped the heavy housekeeping
    handle.stop();
  });

  it("a wake-triggered drain is fail-open (a throwing job is marked failed, never an unhandled throw)", async () => {
    const { store, jobUpdates } = makeStore([
      { jobId: "j1", type: "observer", scope: { accountId: "a", threadId: "t1" } },
    ]);
    const runObserver = vi.fn(async () => {
      throw new Error("boom");
    });
    const handle = startMemoryWorker(makeDeps(store, { ...WAKE_DEPS, runObserver }));

    handle.wake();
    await vi.advanceTimersByTimeAsync(8000);

    expect(jobUpdates).toContainEqual({ jobId: "j1", status: "failed" });
    handle.stop();
  });

  it("stop() cancels a pending wake (no drain fires after stop)", async () => {
    const { store } = makeStore([]);
    const claimSpy = store.claimPendingJobs as ReturnType<typeof vi.fn>;
    const handle = startMemoryWorker(makeDeps(store, WAKE_DEPS));

    handle.wake();
    await vi.advanceTimersByTimeAsync(3000); // wake armed but window not elapsed
    handle.stop();
    await vi.advanceTimersByTimeAsync(60_000); // past both the window and the interval

    expect(claimSpy).not.toHaveBeenCalled();
  });

  it("the interval still drains even when wake() is never called (backstop intact)", async () => {
    const { store } = makeStore([
      { jobId: "j1", type: "observer", scope: { accountId: "a", threadId: "t1" } },
    ]);
    const claimSpy = store.claimPendingJobs as ReturnType<typeof vi.fn>;
    const handle = startMemoryWorker(makeDeps(store, WAKE_DEPS));

    await vi.advanceTimersByTimeAsync(60_000); // no wake — the interval backstop fires

    expect(claimSpy).toHaveBeenCalled();
    handle.stop();
  });

  it("wake() after stop() is a no-op (never arms a drain against a closed store)", async () => {
    // On graceful shutdown the worker is stopped BEFORE the write queue is drained;
    // a still-pending observe task then fires onTaskDrain → wake(). That late wake
    // must not arm a timer that later claims jobs against an already-closed store.
    const { store } = makeStore([
      { jobId: "j1", type: "observer", scope: { accountId: "a", threadId: "t1" } },
    ]);
    const claimSpy = store.claimPendingJobs as ReturnType<typeof vi.fn>;
    const handle = startMemoryWorker(makeDeps(store, WAKE_DEPS));

    handle.stop();
    handle.wake(); // arrives after stop — must be ignored
    await vi.advanceTimersByTimeAsync(60_000);

    expect(claimSpy).not.toHaveBeenCalled();
  });
});
