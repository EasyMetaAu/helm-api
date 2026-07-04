import { describe, expect, it, vi } from "vitest";
import type { MemoryStore } from "../store/ports.js";
import { AUTO_PRIORS } from "./compaction-policy.js";
import { type IdleFlushDeps, maybeEnqueueIdleObserverJobs } from "./idle-flush.js";

// The idle-flush trigger enqueues idle-flush observer jobs OFF the request path
// (the worker tick) for quiet threads with uncovered history. Memory formation is
// a baseline duty, so — unlike decay — it is NOT gated behind forgetting.enabled.

function makeStore(
  candidates: Array<{
    accountId: string;
    threadId: string;
    projectId?: string;
    resourceId?: string;
  }>,
) {
  const enqueued: Array<{ type: string; scope: unknown }> = [];
  const store = {
    listIdleFlushCandidates: vi.fn(async () => candidates),
    enqueueJob: vi.fn(async (input: { type: string; scope: unknown }) => {
      enqueued.push(input);
      return `enq-${enqueued.length}`;
    }),
  };
  return { store, enqueued };
}

function makeDeps(store: ReturnType<typeof makeStore>["store"]): IdleFlushDeps {
  return {
    // biome-ignore lint/suspicious/noExplicitAny: fake implements only the called subset.
    memoryStore: store as any,
    now: () => new Date("2026-06-05T00:00:00.000Z"),
    batchSize: 100,
    log: vi.fn(),
  };
}

describe("maybeEnqueueIdleObserverJobs", () => {
  it("enqueues one idle-flush observer job per quiet thread", async () => {
    const { store, enqueued } = makeStore([
      { accountId: "acct-a", threadId: "t1" },
      { accountId: "acct-b", threadId: "t2" },
    ]);
    await maybeEnqueueIdleObserverJobs(makeDeps(store));

    // The idle cutoff is now − idle_flush_s.
    expect(store.listIdleFlushCandidates).toHaveBeenCalledWith({
      idleBeforeMs: new Date("2026-06-05T00:00:00.000Z").getTime() - AUTO_PRIORS.idleFlushS * 1000,
      limit: 100,
    });
    expect(enqueued).toEqual([
      { type: "observer", scope: { accountId: "acct-a", threadId: "t1" } },
      { type: "observer", scope: { accountId: "acct-b", threadId: "t2" } },
    ]);
  });

  it("carries the candidate's project/resource scope into the enqueued job (for promotion)", async () => {
    const { store, enqueued } = makeStore([
      { accountId: "acct-a", threadId: "t1", projectId: "proj-1", resourceId: "res-1" },
      { accountId: "acct-a", threadId: "t2", projectId: "proj-1" },
    ]);
    await maybeEnqueueIdleObserverJobs(makeDeps(store));
    expect(enqueued).toEqual([
      {
        type: "observer",
        scope: {
          accountId: "acct-a",
          threadId: "t1",
          projectId: "proj-1",
          resourceId: "res-1",
        },
      },
      {
        type: "observer",
        scope: { accountId: "acct-a", threadId: "t2", projectId: "proj-1" },
      },
    ]);
  });

  it("honors the idle_flush_s config override for the sweep cutoff", async () => {
    const { store } = makeStore([]);
    const deps = { ...makeDeps(store), compaction: { idle_flush_s: 7200 } };
    await maybeEnqueueIdleObserverJobs(deps);
    expect(store.listIdleFlushCandidates).toHaveBeenCalledWith({
      idleBeforeMs: new Date("2026-06-05T00:00:00.000Z").getTime() - 7200 * 1000,
      limit: 100,
    });
  });

  it("passes idle_flush_max_age_s as a lower activity bound to skip cold backfill", async () => {
    const { store } = makeStore([]);
    const deps = { ...makeDeps(store), compaction: { idle_flush_max_age_s: 86_400 } };
    await maybeEnqueueIdleObserverJobs(deps);
    expect(store.listIdleFlushCandidates).toHaveBeenCalledWith({
      idleBeforeMs: new Date("2026-06-05T00:00:00.000Z").getTime() - AUTO_PRIORS.idleFlushS * 1000,
      idleAfterMs: new Date("2026-06-05T00:00:00.000Z").getTime() - 86_400 * 1000,
      limit: 100,
    });
  });

  it("is a no-op when no thread is idle", async () => {
    const { store, enqueued } = makeStore([]);
    await maybeEnqueueIdleObserverJobs(makeDeps(store));
    expect(enqueued).toEqual([]);
  });

  it("runs regardless of forgetting state (no enabled gate — memory formation is baseline)", async () => {
    // There is deliberately no forgetting config on the deps; the sweep must work.
    const { store, enqueued } = makeStore([{ accountId: "acct-a", threadId: "t1" }]);
    await maybeEnqueueIdleObserverJobs(makeDeps(store));
    expect(enqueued).toHaveLength(1);
  });

  it("relies on enqueueJob dedupe — a re-enqueue of an open idle job is harmless", async () => {
    const { store } = makeStore([{ accountId: "acct-a", threadId: "t1" }]);
    const deps = makeDeps(store);
    await maybeEnqueueIdleObserverJobs(deps);
    await maybeEnqueueIdleObserverJobs(deps);
    expect(store.enqueueJob).toHaveBeenCalledTimes(2);
  });

  it("never throws when the candidate read fails (fail-open)", async () => {
    const { store } = makeStore([]);
    store.listIdleFlushCandidates.mockRejectedValueOnce(new Error("db down"));
    await expect(maybeEnqueueIdleObserverJobs(makeDeps(store))).resolves.toBeUndefined();
  });

  it("a single enqueue failure does not abort the rest (per-thread guard)", async () => {
    const { store, enqueued } = makeStore([
      { accountId: "acct-a", threadId: "t1" },
      { accountId: "acct-b", threadId: "t2" },
    ]);
    (store.enqueueJob as ReturnType<typeof vi.fn>).mockImplementationOnce(async () => {
      throw new Error("queue down");
    });
    await maybeEnqueueIdleObserverJobs(makeDeps(store));
    expect(enqueued).toEqual([
      { type: "observer", scope: { accountId: "acct-b", threadId: "t2" } },
    ]);
  });

  it("no-ops when the store lacks the candidate method (unsupported build)", async () => {
    const store = { enqueueJob: vi.fn(async () => "x") } as unknown as MemoryStore;
    const deps: IdleFlushDeps = {
      memoryStore: store,
      now: () => new Date(),
      batchSize: 100,
      log: vi.fn(),
    };
    await expect(maybeEnqueueIdleObserverJobs(deps)).resolves.toBeUndefined();
    expect(store.enqueueJob).not.toHaveBeenCalled();
  });
});
