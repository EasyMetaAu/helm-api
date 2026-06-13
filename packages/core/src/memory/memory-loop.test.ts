import type { Observation, RawMessage } from "@helm/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SqliteMemoryStore } from "../store/sqlite/memory-store.js";
import { createSqliteDb } from "../store/sqlite/migrate.js";
import { assembleInjectedContext } from "./inject.js";
import { runObserverJob } from "./observer.js";
import { runReflectorJob } from "./reflector.js";
import { startMemoryWorker } from "./scheduler.js";

// docs/08 Phase 2 — the FULL background loop against a real sqlite store:
// enqueue observer job → worker tick runs the observer (compresses old raw into
// an observation) → promotes a reflector → next tick merges the reflection at the
// PROJECT level → the NEXT inject request actually hydrates that reflection.
// This is the end-to-end guarantee the unit tests can't give: the reflection the
// worker writes lands in a scope inject READS BACK (regression: it used to be
// written with the full thread scope and was permanently invisible to inject).

const SCOPE = { accountId: "acct-a", projectId: "proj-1", threadId: "t1" };

function deterministicStore() {
  let seq = 0;
  let tickMs = 1_000_000;
  // Injected id + clock: fake timers freeze Date, and message ordering falls back
  // to id when createdAt ties — keep BOTH strictly increasing.
  return new SqliteMemoryStore(
    createSqliteDb(":memory:"),
    () => {
      seq += 1;
      return `id-${String(seq).padStart(3, "0")}`;
    },
    () => {
      tickMs += 1000;
      return new Date(tickMs);
    },
  );
}

describe("memory background loop (observer → reflector → inject)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("a worker-written reflection is hydrated by the next inject request", async () => {
    const store = deterministicStore();
    await store.ensureThread({ id: "t1", projectId: "proj-1", ownerId: "acct-a" });
    // 3 tiny messages — below the auto policy's size trigger, so this loop runs
    // through the IDLE-FLUSH path (the memory-formation backstop for short
    // threads): the observer folds the whole history into one observation.
    await store.appendMessage({
      threadId: "t1",
      role: "user",
      content: "the user prefers dark mode",
      tokenEstimate: 6,
    });
    await store.appendMessage({
      threadId: "t1",
      role: "assistant",
      content: "ok",
      tokenEstimate: 1,
    });
    await store.appendMessage({
      threadId: "t1",
      role: "user",
      content: "thanks",
      tokenEstimate: 1,
    });
    await store.enqueueJob({ type: "observer", scope: SCOPE });

    const log = () => {};
    const costSink = () => {};
    const now = () => new Date("2026-06-04T00:00:00.000Z");
    const handle = startMemoryWorker({
      memoryStore: store,
      batchSize: 10,
      intervalMs: 100,
      now: () => Date.now(),
      log,
      runObserver: (job) =>
        runObserverJob(job, {
          memoryStore: store,
          summarize: async ({ messages }: { messages: RawMessage[] }) => ({
            observationText: `OBSERVED: ${messages.map((m) => m.content).join(" / ")}`,
          }),
          costSink,
          resolvePricing: () => ({
            modelKey: null,
            inputPerMtok: null,
            outputPerMtok: null,
            cacheReadPerMtok: null,
            cacheWritePerMtok: null,
            maxContextTokens: null,
          }),
          now,
          log,
        }),
      runReflector: (job) =>
        runReflectorJob(job, {
          memoryStore: store,
          merge: async ({ observations }: { observations: Observation[] }) => {
            const text = `REFLECTION: ${observations.map((o) => o.observationText).join(" | ")}`;
            return { reflectionText: text, tokenEstimate: Math.ceil(text.length / 4) };
          },
          costSink,
          now,
          log,
        }),
    });

    // Tick 1: observer compresses + promotes the reflector. Tick 2: reflector merges.
    await vi.advanceTimersByTimeAsync(100);
    await vi.advanceTimersByTimeAsync(100);
    handle.stop();

    // The reflection must exist at the PROJECT level — the slot inject reads.
    const reflection = await store.getReflection({ accountId: "acct-a", projectId: "proj-1" });
    expect(reflection?.reflectionText).toContain("the user prefers dark mode");
    expect(reflection?.version).toBe(1);

    // And the NEXT inject request for the same scope hydrates it into the memory
    // TEXT BLOCK (#217 Phase 4 PREFIX model — the block is prepended at the system
    // level; the live conversation is kept verbatim by the pipeline, never here).
    const result = await assembleInjectedContext(
      {
        scope: SCOPE,
        tokenBudget: 4000,
      },
      {
        memoryStore: store,
        estimateTokens: (t) => Math.ceil(t.length / 4),
        enqueueObserverJob: async () => "wb-1",
        costSink,
        now,
        log,
      },
    );

    // The project reflection rides the block under its section header — the
    // compressed turn reaches the prompt ONLY as the merged reflection text, never
    // as a reassembled raw conversation (the assembler no longer rebuilds messages;
    // the live conversation stays with the pipeline).
    expect(result.memoryBlock).not.toBeNull();
    expect(result.memoryBlock).toContain("# Persistent memory (injected by helm)");
    expect(result.memoryBlock).toContain("## Project knowledge");
    expect(result.memoryBlock).toContain("dark mode");
    expect(result.metadata.memory_hydrated).toBe(true);
    expect(result.metadata.reflection_version).toBe(1);
  });

  it("a project reflection aggregates observations from ALL the project's threads (no last-writer-wins)", async () => {
    const store = deterministicStore();
    const seedThread = async (threadId: string, fact: string) => {
      await store.ensureThread({ id: threadId, projectId: "proj-1", ownerId: "acct-a" });
      await store.appendMessage({ threadId, role: "user", content: fact, tokenEstimate: 4 });
      await store.appendMessage({ threadId, role: "assistant", content: "ok", tokenEstimate: 1 });
      await store.appendMessage({ threadId, role: "user", content: "thanks", tokenEstimate: 1 });
      await store.enqueueJob({
        type: "observer",
        scope: { accountId: "acct-a", projectId: "proj-1", threadId },
      });
    };
    await seedThread("t1", "thread one fact");
    await seedThread("t2", "thread two fact");

    const log = () => {};
    const costSink = () => {};
    const now = () => new Date("2026-06-04T00:00:00.000Z");
    const handle = startMemoryWorker({
      memoryStore: store,
      batchSize: 10,
      intervalMs: 100,
      now: () => Date.now(),
      log,
      runObserver: (job) =>
        runObserverJob(job, {
          memoryStore: store,
          summarize: async ({ messages }: { messages: RawMessage[] }) => ({
            observationText: `OBSERVED: ${messages.map((m) => m.content).join(" / ")}`,
          }),
          costSink,
          resolvePricing: () => ({
            modelKey: null,
            inputPerMtok: null,
            outputPerMtok: null,
            cacheReadPerMtok: null,
            cacheWritePerMtok: null,
            maxContextTokens: null,
          }),
          now,
          log,
        }),
      runReflector: (job) =>
        runReflectorJob(job, {
          memoryStore: store,
          merge: async ({ observations }: { observations: Observation[] }) => {
            const text = `REFLECTION: ${observations.map((o) => o.observationText).join(" | ")}`;
            return { reflectionText: text, tokenEstimate: Math.ceil(text.length / 4) };
          },
          costSink,
          now,
          log,
        }),
    });

    // Tick 1: both observers run + promote. Tick 2: the reflector(s) merge.
    await vi.advanceTimersByTimeAsync(100);
    await vi.advanceTimersByTimeAsync(100);
    handle.stop();

    // The SECOND thread's reflector run must not wipe the first thread's
    // contribution — the project reflection covers the whole project.
    const reflection = await store.getReflection({ accountId: "acct-a", projectId: "proj-1" });
    expect(reflection?.reflectionText).toContain("thread one fact");
    expect(reflection?.reflectionText).toContain("thread two fact");
  });
});
