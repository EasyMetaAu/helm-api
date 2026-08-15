import type { MemoryObservationInput, RawMessage } from "@helm/shared";
import { describe, expect, it, vi } from "vitest";
import type { MemoryJobStatus, MemoryStore } from "../store/ports.js";
import { type ObserverDeps, type ObserverJob, runObserverJob } from "./observer.js";

// A recording fake MemoryStore for the background Observer. It serves a fixed set
// of raw messages, captures every appended observation, and records job status
// transitions so tests can assert auditability + fail-open behavior. Memory is a
// MIDDLEWARE — this fake never touches routing/lane state.
function makeFakeStore(messages: RawMessage[], existingRanges: Array<[string, string]> = []) {
  const observations: MemoryObservationInput[] = [];
  const jobUpdates: Array<{ jobId: string; status: MemoryJobStatus; error?: string }> = [];
  // Salient-fact fast path: capture insertFactsReconciled calls so eager-extraction
  // tests can assert WHAT facts were persisted and at WHICH scope.
  const factCalls: Array<Parameters<NonNullable<MemoryStore["insertFactsReconciled"]>>[0]> = [];
  const store: MemoryStore = {
    ensureThread: vi.fn(async () => {}),
    appendMessage: vi.fn(async () => "unused"),
    listMessages: vi.fn(async () => messages),
    appendObservation: vi.fn(async (input: MemoryObservationInput) => {
      observations.push(input);
      return `obs-${observations.length}`;
    }),
    listObservations: vi.fn(async () =>
      existingRanges.map((range, i) => ({
        id: `existing-${i}`,
        threadId: "thread-1",
        sourceMessageRange: range,
        observationText: "already compressed",
        observedAt: NOW,
        referenceCount: 0,
        importance: 0.5,
        status: "active" as const,
        referencedAt: null,
        archivedAt: null,
        expiredAt: null,
      })),
    ),
    getReflection: vi.fn(async () => null),
    upsertReflection: vi.fn(async () => "unused"),
    updateJobStatus: vi.fn(async (jobId: string, status: MemoryJobStatus, error?: string) => {
      jobUpdates.push(error === undefined ? { jobId, status } : { jobId, status, error });
    }),
    enqueueJob: vi.fn(async () => "job"),
    claimPendingJobs: vi.fn(async () => []),
    insertFactsReconciled: vi.fn(async (input) => {
      factCalls.push(input);
      return { insertedIds: [], supersededIds: [] };
    }),
  };
  return { store, observations, jobUpdates, factCalls };
}

// A short, low-token thread that never crosses the 2048-token compaction trigger
// and is not idle — so the Observer writes NO observation. The salient-fact fast
// path must still mine the user turn for a durable fact.
function makeShortThread(): RawMessage[] {
  return [
    {
      id: "u1",
      threadId: "thread-1",
      role: "user",
      content: "我喜欢的数字是42,你记住",
      tokenEstimate: 12,
      createdAt: new Date(NOW.getTime() - 2000),
    },
    {
      id: "a1",
      threadId: "thread-1",
      role: "assistant",
      content: "记下了。",
      tokenEstimate: 4,
      createdAt: new Date(NOW.getTime() - 1000),
    },
  ];
}

function makeMessages(count: number, tokenEstimate = 600): RawMessage[] {
  // 600-token default: 8 messages cross the auto policy's 2048-token
  // memory-formation trigger while the keep floor (max(4, 25%)) still leaves a
  // compactable prefix. Timestamps sit just BEFORE NOW (1s apart, ascending) so
  // the observer's run-time idle check sees the thread as ACTIVE by default — the
  // idle path is exercised explicitly by overriding deps.now far into the future.
  return Array.from({ length: count }, (_v, i) => ({
    id: `m${i + 1}`,
    threadId: "thread-1",
    role: "user" as const,
    content: `message ${i + 1}`,
    tokenEstimate,
    createdAt: new Date(NOW.getTime() - (count - i) * 1000),
  }));
}

const NULL_PRICING = {
  modelKey: null,
  inputPerMtok: null,
  outputPerMtok: null,
  cacheReadPerMtok: null,
  cacheWritePerMtok: null,
  maxContextTokens: null,
};

const NOW = new Date("2026-05-30T12:00:00.000Z");

function makeDeps(store: MemoryStore, overrides: Partial<ObserverDeps> = {}): ObserverDeps {
  return {
    memoryStore: store,
    summarize: vi.fn(async ({ messages, now }) => ({
      // Deterministic stub that embeds a date anchor, like an LLM summary would.
      observationText: `Observed ${messages.length} msgs on ${now.toISOString().slice(0, 10)}`,
      priority: 3,
      tags: ["test"],
    })),
    costSink: vi.fn(),
    resolvePricing: vi.fn(() => NULL_PRICING),
    now: () => NOW,
    log: vi.fn(),
    ...overrides,
  };
}

const JOB: ObserverJob = { jobId: "job-1", accountId: "acct-a", threadId: "thread-1" };

describe("runObserverJob", () => {
  it("compresses older messages into exactly one observation with a time anchor + source range", async () => {
    const messages = makeMessages(8); // 8 total; keep floor 4 kept, 4 older compressed
    const { store, observations, jobUpdates } = makeFakeStore(messages);
    const deps = makeDeps(store);

    const out = await runObserverJob(JOB, deps);

    expect(observations).toHaveLength(1);
    const obs = observations[0];
    expect(obs).toBeDefined();
    if (!obs) throw new Error("expected one observation");
    // Time anchor present in the observation text.
    expect(obs.observationText).toContain("2026-05-30");
    // observed_at is exactly now().
    expect(obs.observedAt).toEqual(NOW);
    // source range covers the first..last compressed message ids.
    expect(obs.sourceMessageRange).toEqual(["m1", "m4"]);
    expect(out.observationId).toBe("obs-1");
    expect(out.sourceMessageRange).toEqual(["m1", "m4"]);
    // Job marked done.
    expect(jobUpdates).toContainEqual({ jobId: "job-1", status: "done" });
  });

  it("keeps the recent N raw messages out of the compressed source range", async () => {
    const messages = makeMessages(8);
    const { store, observations } = makeFakeStore(messages);
    const deps = makeDeps(store);

    await runObserverJob(JOB, deps);

    const obs = observations[0];
    if (!obs) throw new Error("expected one observation");
    // The kept suffix (m5..m8) must NOT be inside the compressed range.
    expect(obs.sourceMessageRange[1]).toBe("m4");
    expect(obs.sourceMessageRange).not.toContain("m5");
    expect(obs.sourceMessageRange).not.toContain("m8");
  });

  it("does not recompress a source range already covered by an existing observation", async () => {
    const messages = makeMessages(8);
    const { store, observations, jobUpdates } = makeFakeStore(messages, [["m1", "m4"]]);
    const deps = makeDeps(store);

    const out = await runObserverJob(JOB, deps);

    expect(out.observationId).toBeNull();
    expect(out.sourceMessageRange).toBeNull();
    expect(observations).toHaveLength(0);
    expect(deps.summarize).not.toHaveBeenCalled();
    expect(jobUpdates).toContainEqual({ jobId: "job-1", status: "done" });
  });

  it("does not write a sparse uncovered set as one continuous source range", async () => {
    const messages = makeMessages(8);
    const { store, observations } = makeFakeStore(messages, [["m2", "m3"]]);
    const deps = makeDeps(store);

    const out = await runObserverJob(JOB, deps);

    expect(observations).toHaveLength(1);
    const obs = observations[0];
    if (!obs) throw new Error("expected one observation");
    // m2..m3 is already covered, so the next observation must not claim m1..m4.
    // The oldest compactable contiguous uncovered segment is m4..m8 (3000 tokens
    // ≥ the size trigger); the keep floor of 4 compresses only m4 and writes an
    // exact single-row range.
    expect(obs.sourceMessageRange).toEqual(["m4", "m4"]);
    expect(obs.observationText).toContain("Observed 1 msgs");
    expect(out.sourceMessageRange).toEqual(["m4", "m4"]);
  });

  it("books Observer tokens into the dedicated 'observer' cost bucket only", async () => {
    const messages = makeMessages(8);
    const { store } = makeFakeStore(messages);
    const costSink = vi.fn();
    const deps = makeDeps(store, { costSink });

    await runObserverJob(JOB, deps);

    expect(costSink).toHaveBeenCalledTimes(1);
    const [bucket, tokens] = costSink.mock.calls[0] ?? [];
    expect(bucket).toBe("observer");
    expect(typeof tokens).toBe("number");
    expect(tokens).toBeGreaterThan(0);
  });

  it("is fail-open: a summarize error does not throw, returns null, and marks the job failed", async () => {
    const messages = makeMessages(8);
    const { store, observations, jobUpdates } = makeFakeStore(messages);
    const deps = makeDeps(store, {
      summarize: vi.fn(async () => {
        throw new Error("llm down");
      }),
    });

    const out = await runObserverJob(JOB, deps);

    expect(out.observationId).toBeNull();
    // No observation written on failure.
    expect(observations).toHaveLength(0);
    // Job marked failed with the error recorded.
    const failed = jobUpdates.find((u) => u.status === "failed");
    expect(failed).toBeDefined();
    expect(failed?.error).toContain("llm down");
  });

  // docs/12 (P5 salience, Codex review fix #5) — the Observer must resolve the
  // observation's `importance` so the forgetting score's decay-brake has a real
  // input instead of every row defaulting to a flat 0.5.
  it("derives importance from the summarizer priority (priority/10, clamped)", async () => {
    const messages = makeMessages(8);
    const { store, observations } = makeFakeStore(messages);
    // summarize stub returns priority:3 (see makeDeps) → importance 0.3.
    const deps = makeDeps(store);

    await runObserverJob(JOB, deps);

    expect(observations[0]?.importance).toBeCloseTo(0.3, 6);
  });

  it("prefers an explicit summarizer importance over the priority derivation", async () => {
    const messages = makeMessages(8);
    const { store, observations } = makeFakeStore(messages);
    const deps = makeDeps(store, {
      summarize: vi.fn(async () => ({
        observationText: "x",
        priority: 3, // would derive 0.3…
        importance: 0.9, // …but an explicit importance wins, and out-of-range is clamped
      })),
    });

    await runObserverJob(JOB, deps);

    expect(observations[0]?.importance).toBe(0.9);
  });

  it("leaves importance unset when the summarizer gives neither importance nor priority", async () => {
    const messages = makeMessages(8);
    const { store, observations } = makeFakeStore(messages);
    const deps = makeDeps(store, {
      summarize: vi.fn(async () => ({ observationText: "x" })),
    });

    await runObserverJob(JOB, deps);

    // Undefined → the store applies its 0.5 column default (no override here).
    expect(observations[0]?.importance).toBeUndefined();
  });

  it("writes no observation when there is nothing old enough to compress", async () => {
    // Below the memory-formation size trigger with no context pressure.
    const messages = makeMessages(2);
    const { store, observations, jobUpdates } = makeFakeStore(messages);
    const deps = makeDeps(store);

    const out = await runObserverJob(JOB, deps);

    expect(out.observationId).toBeNull();
    expect(out.sourceMessageRange).toBeNull();
    expect(observations).toHaveLength(0);
    // Still marks the job done (it ran successfully, just had nothing to do).
    expect(jobUpdates).toContainEqual({ jobId: "job-1", status: "done" });
    // summarize never called — no wasted LLM tokens.
    expect(deps.summarize).not.toHaveBeenCalled();
  });

  it("folds the WHOLE uncovered history when the thread is idle (run-time age check)", async () => {
    // 3 tiny messages — far below the size trigger, but a now() ≫ 1h past the
    // newest message makes the observer derive idle=true and full-flush, so short
    // threads still form memories. No job flag: idleness is computed at run time.
    const messages = makeMessages(3, 10);
    const { store, observations, jobUpdates } = makeFakeStore(messages);
    const deps = makeDeps(store, { now: () => new Date(NOW.getTime() + 2 * 3_600_000) });

    const out = await runObserverJob(JOB, deps);

    expect(observations).toHaveLength(1);
    expect(out.sourceMessageRange).toEqual(["m1", "m3"]);
    expect(jobUpdates).toContainEqual({ jobId: "job-1", status: "done" });
  });

  it("prefers the largest idle uncovered segment over a tiny leading gap", async () => {
    const messages = makeMessages(10, 10);
    const { store, observations } = makeFakeStore(messages, [
      ["m2", "m3"],
      ["m5", "m5"],
    ]);
    const deps = makeDeps(store, { now: () => new Date(NOW.getTime() + 2 * 3_600_000) });

    const out = await runObserverJob(JOB, deps);

    expect(observations).toHaveLength(1);
    expect(observations[0]?.sourceMessageRange).toEqual(["m6", "m10"]);
    expect(observations[0]?.observationText).toContain("Observed 5 msgs");
    expect(out.sourceMessageRange).toEqual(["m6", "m10"]);
  });

  it("resolves pricing from the thread's stamped model via getThreadMeta", async () => {
    const messages = makeMessages(8);
    const { store } = makeFakeStore(messages);
    const getThreadMeta = vi.fn(async () => ({ lastServedModel: "anthropic/claude-x" }));
    const resolvePricing = vi.fn(() => NULL_PRICING);
    const deps = makeDeps({ ...store, getThreadMeta } as typeof store, { resolvePricing });

    await runObserverJob(JOB, deps);

    expect(getThreadMeta).toHaveBeenCalledWith({ accountId: "acct-a", threadId: "thread-1" });
    expect(resolvePricing).toHaveBeenCalledWith("anthropic/claude-x");
  });

  it("a missing/failing getThreadMeta degrades to a null model (fail-open)", async () => {
    const messages = makeMessages(8);
    const { store, observations } = makeFakeStore(messages);
    const resolvePricing = vi.fn(() => NULL_PRICING);
    const failingMeta = vi.fn(async () => {
      throw new Error("db hiccup");
    });
    const deps = makeDeps({ ...store, getThreadMeta: failingMeta } as typeof store, {
      resolvePricing,
    });

    await runObserverJob(JOB, deps);

    // The job still compacts; pricing resolved with a null alias.
    expect(resolvePricing).toHaveBeenCalledWith(null);
    expect(observations).toHaveLength(1);
  });
});

// Salient-fact fast path (salient-fact-memory-spec Change A): the Observer mines
// raw turns for durable facts DECOUPLED from compaction, so a short "remember X"
// turn forms a fact even when nothing compacts.
describe("runObserverJob — eager fact extraction", () => {
  const eagerFact = {
    subjectText: "favorite number",
    factText: "The user's favorite number is 42.",
    validFrom: NOW,
  };

  it("forms a fact from a short thread that never compacts (the '42' case)", async () => {
    const { store, observations, factCalls } = makeFakeStore(makeShortThread());
    const extractFactsFromMessages = vi.fn(async () => [eagerFact]);
    const deps = makeDeps(store, { extractFactsFromMessages, maxFactsPerSubject: 8 });
    const job: ObserverJob = {
      jobId: "job-1",
      accountId: "acct-a",
      threadId: "thread-1",
      projectId: "proj-x",
    };

    const out = await runObserverJob(job, deps);

    // No compaction on a tiny thread…
    expect(out.observationId).toBeNull();
    expect(observations).toHaveLength(0);
    // …but the fact is extracted from the raw turns and persisted at PROJECT scope
    // (cross-thread — what makes it recallable in a new session).
    expect(extractFactsFromMessages).toHaveBeenCalledOnce();
    expect(factCalls).toHaveLength(1);
    expect(factCalls[0]).toMatchObject({ accountId: "acct-a", scope: { projectId: "proj-x" } });
    expect(factCalls[0]?.facts[0]).toMatchObject({
      ownerId: "acct-a",
      projectId: "proj-x",
      subjectKey: "favorite-number",
      factText: "The user's favorite number is 42.",
    });
  });

  it("passes the lease guard and does not report stale eager facts as published", async () => {
    const { store } = makeFakeStore(makeShortThread());
    (store.insertFactsReconciled as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      insertedIds: [],
      supersededIds: [],
      accepted: false,
    });
    const deps = makeDeps(store, {
      extractFactsFromMessages: vi.fn(async () => [eagerFact]),
    });

    await runObserverJob({ ...JOB, leaseGeneration: 7, projectId: "proj-x" }, deps);

    expect(store.insertFactsReconciled).toHaveBeenCalledWith(
      expect.objectContaining({ job: { id: "job-1", leaseGeneration: 7 } }),
    );
    expect(deps.log).toHaveBeenCalledWith("memory.observer.eager_facts_stale", {
      thread_id: "thread-1",
    });
    expect(deps.log).not.toHaveBeenCalledWith(
      "memory.observer.eager_facts_extracted",
      expect.anything(),
    );
  });

  it("feeds ONLY user messages to the extractor (assistant/tool noise excluded)", async () => {
    // deepseek drops the user's stated fact when the wire body is full of agent
    // tool/file noise (e.g. Mimi reading/writing its own MEMORY.md). Only user turns
    // carry user-stated facts, so only they should reach the extractor.
    const mixed: RawMessage[] = [
      {
        id: "u1",
        threadId: "thread-1",
        role: "user",
        content: "我有一辆特斯拉 Model Y，你记下来",
        tokenEstimate: 10,
        createdAt: new Date(NOW.getTime() - 4000),
      },
      {
        id: "a1",
        threadId: "thread-1",
        role: "assistant",
        content: "记下了。",
        tokenEstimate: 3,
        createdAt: new Date(NOW.getTime() - 3000),
      },
      {
        id: "t1",
        threadId: "thread-1",
        role: "tool",
        content: "# Memory\n用户最喜欢的数字是 42。\nSuccessfully replaced 1 block.",
        tokenEstimate: 30,
        createdAt: new Date(NOW.getTime() - 2000),
      },
    ];
    const { store } = makeFakeStore(mixed);
    const extractFactsFromMessages = vi.fn(
      async (_input: { messages: RawMessage[]; now: Date }) => [eagerFact],
    );
    const deps = makeDeps(store, { extractFactsFromMessages, maxFactsPerSubject: 8 });

    await runObserverJob({ ...JOB, projectId: "proj-x" }, deps);

    expect(extractFactsFromMessages).toHaveBeenCalledOnce();
    const sent = extractFactsFromMessages.mock.calls[0]?.[0]?.messages as RawMessage[];
    expect(sent.every((m) => m.role === "user")).toBe(true);
    expect(sent.map((m) => m.id)).toEqual(["u1"]);
  });

  it("retries the extraction once when the first result is empty, then succeeds", async () => {
    // deepseek-v4-flash is non-deterministic even at temperature:0 — it sometimes
    // returns 0 facts for a clear statement. One retry catches the unlucky empty.
    const { store, factCalls } = makeFakeStore(makeShortThread());
    const extractFactsFromMessages = vi
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([eagerFact]);
    const deps = makeDeps(store, { extractFactsFromMessages, maxFactsPerSubject: 8 });

    await runObserverJob({ ...JOB, projectId: "proj-x" }, deps);

    expect(extractFactsFromMessages).toHaveBeenCalledTimes(2);
    expect(deps.log).toHaveBeenCalledWith("memory.observer.eager_facts_retry", {
      thread_id: "thread-1",
    });
    expect(factCalls).toHaveLength(1);
  });

  it("calls insertFactsReconciled BOUND to the store (regression: unbound `insert(...)` loses `this`)", async () => {
    // Real adapters implement insertFactsReconciled as a CLASS METHOD that uses `this.db`.
    // The eager path extracts it to a var; calling it unbound (`insert(...)`) makes `this`
    // undefined → "Cannot read properties of undefined (reading 'db')" — and the path is
    // fail-open, so the symptom is a SILENT no-write (the exact prod failure for "可乐").
    // The plain-vi.fn fake never exercised `this`, so this store mimics that dependency.
    const { store } = makeFakeStore(makeShortThread());
    let boundInput: unknown = null;
    const thisSensitiveStore = {
      ...store,
      __isStore: true,
      insertFactsReconciled(
        input: Parameters<NonNullable<MemoryStore["insertFactsReconciled"]>>[0],
      ) {
        if ((this as { __isStore?: boolean })?.__isStore !== true) {
          throw new Error("insertFactsReconciled called unbound (this lost)");
        }
        boundInput = input;
        return Promise.resolve({ insertedIds: ["f1"], supersededIds: [] });
      },
    } as unknown as MemoryStore;
    const deps = makeDeps(thisSensitiveStore, {
      extractFactsFromMessages: vi.fn(async () => [eagerFact]),
      maxFactsPerSubject: 8,
    });
    const job: ObserverJob = {
      jobId: "job-1",
      accountId: "acct-a",
      threadId: "thread-1",
      projectId: "proj-x",
    };

    await runObserverJob(job, deps);

    // With the unbound bug the throw is swallowed (fail-open) → boundInput stays null.
    expect(boundInput).not.toBeNull();
  });

  it("does not extract or persist facts for a thread-only job", async () => {
    const { store, factCalls } = makeFakeStore(makeShortThread());
    const extractFactsFromMessages = vi.fn(async () => [eagerFact]);
    const deps = makeDeps(store, { extractFactsFromMessages });
    const job: ObserverJob = { jobId: "job-1", accountId: "acct-a", threadId: "thread-1" };

    await runObserverJob(job, deps);

    expect(extractFactsFromMessages).not.toHaveBeenCalled();
    expect(factCalls).toEqual([]);
  });

  it("skips the LLM call when the uncovered turns contain no user message", async () => {
    const assistantOnly: RawMessage[] = [
      {
        id: "a1",
        threadId: "thread-1",
        role: "assistant",
        content: "Working on it…",
        tokenEstimate: 4,
        createdAt: new Date(NOW.getTime() - 2000),
      },
      {
        id: "t1",
        threadId: "thread-1",
        role: "tool",
        content: "tool result",
        tokenEstimate: 4,
        createdAt: new Date(NOW.getTime() - 1000),
      },
    ];
    const { store, factCalls } = makeFakeStore(assistantOnly);
    const extractFactsFromMessages = vi.fn(async () => [eagerFact]);
    const deps = makeDeps(store, { extractFactsFromMessages });

    await runObserverJob({ ...JOB, projectId: "proj-x" }, deps);

    expect(extractFactsFromMessages).not.toHaveBeenCalled();
    expect(factCalls).toHaveLength(0);
  });

  it("does NOT eager-extract on a run that compacts (the Reflector owns facts there)", async () => {
    const { store, observations, factCalls } = makeFakeStore(makeMessages(8));
    const extractFactsFromMessages = vi.fn(async () => [eagerFact]);
    const deps = makeDeps(store, { extractFactsFromMessages });

    const out = await runObserverJob({ ...JOB, projectId: "proj-x" }, deps);

    expect(out.observationId).toBe("obs-1"); // compacted
    expect(observations).toHaveLength(1);
    expect(extractFactsFromMessages).not.toHaveBeenCalled();
    expect(factCalls).toHaveLength(0);
  });

  it("does nothing when the extractor dep is not wired (byte-identical to today)", async () => {
    const { store, factCalls } = makeFakeStore(makeShortThread());
    const deps = makeDeps(store); // no extractFactsFromMessages

    const out = await runObserverJob({ ...JOB, projectId: "proj-x" }, deps);

    expect(out.observationId).toBeNull();
    expect(factCalls).toHaveLength(0);
  });

  it("is fail-open: an extractor throw never fails the job", async () => {
    const { store, jobUpdates, factCalls } = makeFakeStore(makeShortThread());
    const extractFactsFromMessages = vi.fn(async () => {
      throw new Error("llm down");
    });
    const deps = makeDeps(store, { extractFactsFromMessages });

    const out = await runObserverJob({ ...JOB, projectId: "proj-x" }, deps);

    expect(out.observationId).toBeNull();
    expect(factCalls).toHaveLength(0);
    // job still completes (not failed by the eager pass)
    expect(jobUpdates).toContainEqual({ jobId: "job-1", status: "done" });
  });

  it("skips the insert when the extractor yields no facts (after one retry)", async () => {
    const { store, factCalls } = makeFakeStore(makeShortThread());
    const extractFactsFromMessages = vi.fn(async () => []);
    const deps = makeDeps(store, { extractFactsFromMessages });

    await runObserverJob({ ...JOB, projectId: "proj-x" }, deps);

    // Empty first result triggers one retry; still empty → give up, no insert.
    expect(extractFactsFromMessages).toHaveBeenCalledTimes(2);
    expect(factCalls).toHaveLength(0);
  });
});

// The coalescing race (the live "我喜欢的数字是42" bug on the box): an observer job
// snapshots the thread's messages ONCE at claim time. A turn that lands WHILE the job
// runs is coalesced by the open-job unique index into the already-snapshotted running
// job and silently lost — no follow-up job, so it is never mined until idle-flush
// (~1h, lossier path). Fix: at completion, if messages arrived SINCE the snapshot,
// enqueue a fresh observer job. The gate is "new since snapshot" (NOT "uncovered
// history exists"): the eager fact path never advances coverage, so a coverage-based
// gate would hot-loop a short thread forever — new-since-snapshot is monotonic and
// drains a burst then stops.
describe("runObserverJob — re-enqueue on a turn that arrives during the run", () => {
  function userMsg(id: string, content: string, offsetMs: number): RawMessage {
    return {
      id,
      threadId: "thread-1",
      role: "user",
      content,
      tokenEstimate: 10,
      createdAt: new Date(NOW.getTime() - offsetMs),
    };
  }

  it("enqueues a fresh observer job when a new message arrives during the run (the '42' race)", async () => {
    // Snapshot at claim time: only the '/new' reset notice — carries no durable fact.
    const snapshot = [userMsg("u-new", "A new session was started via /new.", 3000)];
    // The fact-bearing turn lands AFTER the snapshot, during the run.
    const late = userMsg("u-42", "我喜欢的数字是42", 500);

    const { store } = makeFakeStore(snapshot);
    // Stateful: the run's snapshot read sees only `snapshot`; the completion re-check
    // re-reads and now sees the late-arriving turn too.
    let reads = 0;
    store.listMessages = vi.fn(async () => {
      reads += 1;
      return reads === 1 ? snapshot : [...snapshot, late];
    });
    const deps = makeDeps(store);

    await runObserverJob({ ...JOB, projectId: "proj-x" }, deps);

    // A fresh observer job is enqueued for the SAME scope so the late turn gets mined.
    expect(store.enqueueJob).toHaveBeenCalledWith({
      type: "observer",
      scope: { accountId: "acct-a", threadId: "thread-1", projectId: "proj-x" },
    });
    expect(deps.log).toHaveBeenCalledWith(
      "memory.observer.recheck_reenqueued",
      expect.objectContaining({ thread_id: "thread-1", late_user_message_count: 1 }),
    );
  });

  it("does NOT re-enqueue for an assistant-only late turn (cost lever: facts come only from user turns)", async () => {
    const snapshot = [userMsg("u1", "我有一辆特斯拉 Model Y", 3000)];
    // Only the assistant's reply lands during the run — no new USER content to mine.
    const lateAssistant: RawMessage = {
      id: "a-late",
      threadId: "thread-1",
      role: "assistant",
      content: "记下了。",
      tokenEstimate: 4,
      createdAt: new Date(NOW.getTime() - 400),
    };
    const { store } = makeFakeStore(snapshot);
    let reads = 0;
    store.listMessages = vi.fn(async () => {
      reads += 1;
      return reads === 1 ? snapshot : [...snapshot, lateAssistant];
    });
    const deps = makeDeps(store);

    await runObserverJob({ ...JOB, projectId: "proj-x" }, deps);

    expect(store.enqueueJob).not.toHaveBeenCalled();
    expect(deps.log).toHaveBeenCalledWith("memory.observer.recheck_clean", {
      thread_id: "thread-1",
    });
  });

  it("does NOT re-enqueue when no new message arrived during the run (termination guard)", async () => {
    // listMessages returns the SAME set on every call → nothing new since the snapshot.
    // A noop/eager run must not self-trigger (the device_id hot-loop failure mode).
    const { store } = makeFakeStore(makeShortThread());
    const deps = makeDeps(store);

    await runObserverJob(JOB, deps);

    expect(store.enqueueJob).not.toHaveBeenCalled();
    expect(deps.log).toHaveBeenCalledWith("memory.observer.recheck_clean", {
      thread_id: "thread-1",
    });
  });

  it("does not materialize an oversized thread history", async () => {
    const { store, jobUpdates } = makeFakeStore(makeShortThread());
    store.getThreadMeta = vi.fn(async () => ({
      lastServedModel: null,
      messageCount: 4_097,
      observationCount: 0,
    }));
    const deps = makeDeps(store);

    await expect(runObserverJob(JOB, deps)).resolves.toEqual({
      observationId: null,
      sourceMessageRange: null,
    });
    expect(store.listMessages).not.toHaveBeenCalled();
    expect(store.listObservations).not.toHaveBeenCalled();
    expect(jobUpdates).toEqual([{ jobId: JOB.jobId, status: "done" }]);
  });

  it("advances a bounded page even when the thread counter is above the legacy guard", async () => {
    const page = makeMessages(8);
    const { store } = makeFakeStore(page);
    store.getThreadMeta = vi.fn(async () => ({
      lastServedModel: null,
      messageCount: 51_116,
      observationCount: 513,
    }));
    store.listObserverMessagesPage = vi.fn(async () => ({
      messages: page,
      expectedFrontier: null,
      nextCursor: { createdAtMs: page[7]?.createdAt.getTime() ?? 0, id: "m8" },
      hasMore: true,
    }));
    store.appendObservationAndAdvanceFrontier = vi.fn(async () => "obs-bounded");

    const out = await runObserverJob(JOB, makeDeps(store));

    expect(out.observationId).toBe("obs-bounded");
    expect(store.listMessages).not.toHaveBeenCalled();
    expect(store.listObservations).not.toHaveBeenCalled();
    expect(store.appendObservationAndAdvanceFrontier).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: "acct-a",
        expectedFrontier: null,
        nextFrontier: expect.objectContaining({ id: "m8" }),
      }),
    );
    expect(store.enqueueJob).toHaveBeenCalledWith({
      type: "observer",
      scope: { accountId: "acct-a", threadId: "thread-1" },
    });
  });

  it("compresses only the oldest uncovered gap from an all-status bounded coverage page", async () => {
    const page = makeMessages(8);
    const { store } = makeFakeStore(page);
    store.listObserverMessagesPage = vi.fn(async () => ({
      messages: page,
      coveredMessageIds: ["m1", "m2", "m3", "m5", "m6", "m7", "m8"],
      expectedFrontier: null,
      nextCursor: { createdAtMs: page[7]?.createdAt.getTime() ?? 0, id: "m8" },
      hasMore: true,
    }));
    store.commitObserverPage = vi.fn(async () => ({ observationId: "obs-gap" }));

    const out = await runObserverJob({ ...JOB, leaseGeneration: 1 }, makeDeps(store));

    expect(out).toEqual({ observationId: "obs-gap", sourceMessageRange: ["m4", "m4"] });
    expect(store.listObservations).not.toHaveBeenCalled();
    expect(store.commitObserverPage).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "observe",
        observation: expect.objectContaining({ sourceMessageRange: ["m4", "m4"] }),
        nextFrontier: expect.objectContaining({ id: "m4" }),
      }),
    );
  });

  it("uses one atomic page commit for the observation, job completion, and remainder", async () => {
    const page = makeMessages(8);
    const { store } = makeFakeStore(page);
    store.getThreadMeta = vi.fn(async () => ({
      lastServedModel: null,
      messageCount: 51_116,
      observationCount: 513,
    }));
    store.listObserverMessagesPage = vi.fn(async () => ({
      messages: page,
      expectedFrontier: null,
      nextCursor: { createdAtMs: page[7]?.createdAt.getTime() ?? 0, id: "m8" },
      hasMore: true,
    }));
    store.commitObserverPage = vi.fn(async () => ({ observationId: "obs-atomic" }));

    const out = await runObserverJob({ ...JOB, leaseGeneration: 1 }, makeDeps(store));

    expect(out.observationId).toBe("obs-atomic");
    expect(store.commitObserverPage).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "observe",
        job: {
          id: JOB.jobId,
          scope: { accountId: "acct-a", threadId: "thread-1" },
          leaseGeneration: 1,
        },
        successorScope: { accountId: "acct-a", threadId: "thread-1" },
      }),
    );
    expect(store.updateJobStatus).not.toHaveBeenCalled();
    expect(store.enqueueJob).not.toHaveBeenCalled();
  });

  it("atomically advances a fully covered page without another observation", async () => {
    const page = makeMessages(2, 10);
    const { store } = makeFakeStore(page);
    store.listObserverMessagesPage = vi.fn(async () => ({
      messages: page,
      coveredMessageIds: page.map((message) => message.id),
      expectedFrontier: null,
      nextCursor: { createdAtMs: page[1]?.createdAt.getTime() ?? 0, id: "m2" },
      hasMore: true,
    }));
    store.commitObserverPage = vi.fn(async () => ({ observationId: null }));
    const deps = makeDeps(store);

    const out = await runObserverJob({ ...JOB, leaseGeneration: 1 }, deps);

    expect(out).toEqual({ observationId: null, sourceMessageRange: null });
    expect(deps.summarize).not.toHaveBeenCalled();
    expect(store.commitObserverPage).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "advance",
        nextFrontier: expect.objectContaining({ id: "m2" }),
        successorScope: { accountId: "acct-a", threadId: "thread-1" },
      }),
    );
    expect(store.updateJobStatus).not.toHaveBeenCalled();
    expect(store.enqueueJob).not.toHaveBeenCalled();
  });
});
