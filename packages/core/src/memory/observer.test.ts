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
  };
  return { store, observations, jobUpdates };
}

function makeMessages(count: number): RawMessage[] {
  return Array.from({ length: count }, (_v, i) => ({
    id: `m${i + 1}`,
    threadId: "thread-1",
    role: "user" as const,
    content: `message ${i + 1}`,
    tokenEstimate: 5,
    // Spread across days so the time anchor is meaningful.
    createdAt: new Date(`2026-05-${String(i + 1).padStart(2, "0")}T00:00:00.000Z`),
  }));
}

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
    now: () => NOW,
    log: vi.fn(),
    ...overrides,
  };
}

const JOB: ObserverJob = { jobId: "job-1", accountId: "acct-a", threadId: "thread-1" };

describe("runObserverJob", () => {
  it("compresses older messages into exactly one observation with a time anchor + source range", async () => {
    const messages = makeMessages(6); // 6 total; recent 2 kept, 4 older compressed
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
    const messages = makeMessages(6);
    const { store, observations } = makeFakeStore(messages);
    const deps = makeDeps(store);

    await runObserverJob(JOB, deps);

    const obs = observations[0];
    if (!obs) throw new Error("expected one observation");
    // The recent 2 (m5, m6) must NOT be inside the compressed range.
    expect(obs.sourceMessageRange[1]).toBe("m4");
    expect(obs.sourceMessageRange).not.toContain("m5");
    expect(obs.sourceMessageRange).not.toContain("m6");
  });

  it("does not recompress a source range already covered by an existing observation", async () => {
    const messages = makeMessages(6);
    const { store, observations, jobUpdates } = makeFakeStore(messages, [["m1", "m4"]]);
    const deps = makeDeps(store);

    const out = await runObserverJob(JOB, deps);

    expect(out.observationId).toBeNull();
    expect(out.sourceMessageRange).toBeNull();
    expect(observations).toHaveLength(0);
    expect(deps.summarize).not.toHaveBeenCalled();
    expect(jobUpdates).toContainEqual({ jobId: "job-1", status: "done" });
  });

  it("books Observer tokens into the dedicated 'observer' cost bucket only", async () => {
    const messages = makeMessages(6);
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
    const messages = makeMessages(6);
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
    const messages = makeMessages(6);
    const { store, observations } = makeFakeStore(messages);
    // summarize stub returns priority:3 (see makeDeps) → importance 0.3.
    const deps = makeDeps(store);

    await runObserverJob(JOB, deps);

    expect(observations[0]?.importance).toBeCloseTo(0.3, 6);
  });

  it("prefers an explicit summarizer importance over the priority derivation", async () => {
    const messages = makeMessages(6);
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
    const messages = makeMessages(6);
    const { store, observations } = makeFakeStore(messages);
    const deps = makeDeps(store, {
      summarize: vi.fn(async () => ({ observationText: "x" })),
    });

    await runObserverJob(JOB, deps);

    // Undefined → the store applies its 0.5 column default (no override here).
    expect(observations[0]?.importance).toBeUndefined();
  });

  it("writes no observation when there is nothing old enough to compress", async () => {
    // Only the recent-keep window of messages exist → nothing older to compress.
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
});
