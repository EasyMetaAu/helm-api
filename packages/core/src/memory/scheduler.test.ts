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

    expect(enqueued).toContainEqual({
      type: "reflector",
      scope: { accountId: "acct-a", projectId: "p1", threadId: "t1" },
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
