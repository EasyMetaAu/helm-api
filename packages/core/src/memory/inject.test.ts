import type { Observation, RawMessage, Reflection } from "@helm/shared";
import { describe, expect, it, vi } from "vitest";
import type { MemoryStore } from "../store/ports.js";
import { assembleInjectedContext, type InjectDeps, type InjectInput } from "./inject.js";
import { sha256Hex } from "./message-hash.js";

// docs/08 Phase 2 (#217 Phase 4) — the inject assembler TRAILING-REMINDER model. The assembler
// no longer FULL-REPLACES the conversation: it produces ONE system-level memory TEXT
// BLOCK (reflections + window-deduped thread observations, trimmed to a token
// budget) which the pipeline appends after the client's verbatim live conversation.
// The live messages (tool_calls, images, tool results) are never reassembled here —
// so the assembler is structure-agnostic and works for every turn type. These tests
// pin the block FORMAT, the window-aware dedup, the budget trim, the empty/degraded
// → null paths, and the preserved cost/writeback/forgetting wiring.

function makeReflection(over: Partial<Reflection> & { reflectionText: string }): Reflection {
  return {
    id: "refl-1",
    projectId: null,
    resourceId: null,
    threadId: null,
    version: 1,
    tokenEstimate: 0,
    updatedAt: new Date("2026-05-30T00:00:00.000Z"),
    referencedAt: null,
    referenceCount: 0,
    status: "active",
    ...over,
  };
}

function makeObservation(
  id: string,
  text: string,
  observedAt: string,
  sourceMessageRange: [string, string] = ["m1", "m2"],
): Observation {
  return {
    id,
    threadId: "thread-1",
    sourceMessageRange,
    observationText: text,
    observedAt: new Date(observedAt),
    referenceCount: 0,
    importance: 0.5,
    status: "active",
    referencedAt: null,
    archivedAt: null,
    expiredAt: null,
  };
}

function makeRaw(id: string, role: RawMessage["role"], content: string): RawMessage {
  return {
    id,
    threadId: "thread-1",
    role,
    content,
    tokenEstimate: 0,
    createdAt: new Date("2026-05-29T00:00:00.000Z"),
  };
}

interface FakeStoreData {
  projectReflection?: Reflection | null;
  resourceReflection?: Reflection | null;
  observations?: Observation[];
  threadMessages?: RawMessage[];
  throwOn?: "getReflection" | "listObservations" | "listMessages";
}

function makeFakeStore(data: FakeStoreData) {
  const maybeThrow = (which: NonNullable<FakeStoreData["throwOn"]>) => {
    if (data.throwOn === which) throw new Error(`store boom: ${which}`);
  };
  const store: MemoryStore = {
    ensureThread: vi.fn(async () => {}),
    appendMessage: vi.fn(async () => "unused"),
    listMessages: vi.fn(async () => {
      maybeThrow("listMessages");
      return data.threadMessages ?? [];
    }),
    appendObservation: vi.fn(async () => "unused"),
    listObservations: vi.fn(async () => {
      maybeThrow("listObservations");
      return data.observations ?? [];
    }),
    getReflection: vi.fn(async (scope) => {
      maybeThrow("getReflection");
      // The assembler asks for project + resource scoped reflections separately.
      if (scope.resourceId !== undefined) return data.resourceReflection ?? null;
      if (scope.projectId !== undefined) return data.projectReflection ?? null;
      return null;
    }),
    upsertReflection: vi.fn(async () => "unused"),
    updateJobStatus: vi.fn(async () => {}),
    enqueueJob: vi.fn(async () => "job"),
    claimPendingJobs: vi.fn(async () => []),
  };
  return store;
}

const NOW = new Date("2026-05-31T12:00:00.000Z");

// ~1 token per word — deterministic, assertable estimator.
const estimateTokens = (text: string) => text.trim().split(/\s+/).filter(Boolean).length;

function makeDeps(store: MemoryStore, over: Partial<InjectDeps> = {}): InjectDeps {
  return {
    memoryStore: store,
    estimateTokens,
    enqueueObserverJob: vi.fn(async () => "observer-job-1"),
    costSink: vi.fn(),
    now: () => NOW,
    log: vi.fn(),
    ...over,
  };
}

function baseInput(over: Partial<InjectInput> = {}): InjectInput {
  return {
    scope: { accountId: "acct-a", projectId: "proj-1", resourceId: "res-1", threadId: "thread-1" },
    tokenBudget: 1000,
    ...over,
  };
}

describe("assembleInjectedContext — memory TEXT BLOCK (trailing-reminder model)", () => {
  it("assembles a single system-level block with section headers in deterministic order", async () => {
    const store = makeFakeStore({
      projectReflection: makeReflection({ projectId: "proj-1", reflectionText: "project memory" }),
      resourceReflection: makeReflection({
        resourceId: "res-1",
        reflectionText: "resource memory",
      }),
      observations: [
        makeObservation("o1", "older observation", "2026-05-20T00:00:00.000Z"),
        makeObservation("o2", "newer observation", "2026-05-28T00:00:00.000Z"),
      ],
    });
    const out = await assembleInjectedContext(baseInput(), makeDeps(store));

    expect(out.memoryBlock).not.toBeNull();
    const block = out.memoryBlock ?? "";
    // A single deterministic block: header + only the sections that have content,
    // reflections first (project → resource) then observations oldest-first.
    expect(block).toContain("# Persistent memory (injected by helm)");
    expect(block).toContain("## Project knowledge");
    expect(block).toContain("project memory");
    expect(block).toContain("## Resource knowledge");
    expect(block).toContain("resource memory");
    expect(block).toContain("## Earlier context (summarized)");
    // Observations appear oldest-first.
    expect(block.indexOf("older observation")).toBeLessThan(block.indexOf("newer observation"));
    // Reflections come before observations.
    expect(block.indexOf("project memory")).toBeLessThan(block.indexOf("older observation"));

    expect(out.metadata.memory_hydrated).toBe(true);
    expect(out.metadata.reflection_version).toBe(1);
    expect(out.metadata.observation_count).toBe(2);
    expect(out.metadata.memory_writeback_status).toBe("queued");
    // memory_tokens_injected = estimated tokens of the final block string.
    expect(out.metadata.memory_tokens_injected).toBe(estimateTokens(block));
  });

  it("omits sections that have no content (only project reflection → no resource/observation headers)", async () => {
    const store = makeFakeStore({
      projectReflection: makeReflection({ projectId: "proj-1", reflectionText: "only project" }),
    });
    const out = await assembleInjectedContext(baseInput(), makeDeps(store));
    const block = out.memoryBlock ?? "";
    expect(block).toContain("## Project knowledge");
    expect(block).toContain("only project");
    expect(block).not.toContain("## Resource knowledge");
    expect(block).not.toContain("## Earlier context (summarized)");
  });

  it("returns null when there is nothing to inject (no reflections, no observations)", async () => {
    const store = makeFakeStore({ threadMessages: [] });
    const out = await assembleInjectedContext(baseInput(), makeDeps(store));
    expect(out.memoryBlock).toBeNull();
    expect(out.metadata.memory_hydrated).toBe(false);
    expect(out.metadata.observation_count).toBe(0);
    expect(out.metadata.memory_tokens_injected).toBe(0);
  });

  it("reflections are ALWAYS included regardless of the live window (cross-thread recall)", async () => {
    const store = makeFakeStore({
      projectReflection: makeReflection({ projectId: "proj-1", reflectionText: "proj refl" }),
      resourceReflection: makeReflection({ resourceId: "res-1", reflectionText: "res refl" }),
    });
    // Even with a non-empty window, reflections are never deduped against it.
    const out = await assembleInjectedContext(
      baseInput({ windowContentHashCounts: new Map([[sha256Hex("anything"), 1]]) }),
      makeDeps(store),
    );
    const block = out.memoryBlock ?? "";
    expect(block).toContain("proj refl");
    expect(block).toContain("res refl");
  });

  it("SKIPS a thread observation whose covered turns are ALL already in the live window", async () => {
    // The client still sends r1+r2 verbatim, so the observation covering exactly
    // them is redundant — injecting it would duplicate turns the client still holds.
    const threadMessages = [
      makeRaw("r1", "user", "turn one"),
      makeRaw("r2", "assistant", "reply one"),
    ];
    const obs = makeObservation("o1", "compressed r1..r2", "2026-05-30T00:00:00.000Z", [
      "r1",
      "r2",
    ]);
    const store = makeFakeStore({ observations: [obs], threadMessages });

    const windowContentHashCounts = new Map([
      [sha256Hex("turn one"), 1],
      [sha256Hex("reply one"), 1],
    ]);
    const out = await assembleInjectedContext(
      baseInput({ windowContentHashCounts }),
      makeDeps(store),
    );

    expect(out.memoryBlock).toBeNull();
    expect(out.metadata.observation_count).toBe(0);
  });

  it("INCLUDES an observation when repeated covered content appears fewer times in the live window", async () => {
    const threadMessages = [
      makeRaw("r1", "user", "yes"),
      makeRaw("r2", "assistant", "ok"),
      makeRaw("r3", "user", "yes"),
    ];
    const obs = makeObservation("o1", "compressed repeated yes turns", "2026-05-30T00:00:00.000Z", [
      "r1",
      "r3",
    ]);
    const store = makeFakeStore({ observations: [obs], threadMessages });

    // The range r1..r3 covers both "yes" turns AND the "ok" turn between them.
    // The client kept "ok" and only ONE "yes" occurrence. The observation still
    // recalls the other "yes", so a set-based hash check would wrongly suppress it.
    const windowContentHashCounts = new Map([
      [sha256Hex("yes"), 1],
      [sha256Hex("ok"), 1],
    ]);
    const out = await assembleInjectedContext(
      baseInput({ windowContentHashCounts }),
      makeDeps(store),
    );

    expect(out.memoryBlock ?? "").toContain("compressed repeated yes turns");
    expect(out.metadata.observation_count).toBe(1);
  });

  it("SKIPS an observation when repeated covered content appears enough times in the live window", async () => {
    const threadMessages = [
      makeRaw("r1", "user", "yes"),
      makeRaw("r2", "assistant", "ok"),
      makeRaw("r3", "user", "yes"),
    ];
    const obs = makeObservation("o1", "compressed repeated yes turns", "2026-05-30T00:00:00.000Z", [
      "r1",
      "r3",
    ]);
    const store = makeFakeStore({ observations: [obs], threadMessages });

    // Every covered turn (both "yes" + the "ok" between them) is still present in
    // the window with sufficient count → the observation is fully redundant.
    const windowContentHashCounts = new Map([
      [sha256Hex("yes"), 2],
      [sha256Hex("ok"), 1],
    ]);
    const out = await assembleInjectedContext(
      baseInput({ windowContentHashCounts }),
      makeDeps(store),
    );

    expect(out.memoryBlock).toBeNull();
    expect(out.metadata.observation_count).toBe(0);
  });

  it("INCLUDES a thread observation when its covered turns are NOT all in the window (recall of dropped turns)", async () => {
    const threadMessages = [
      makeRaw("r1", "user", "dropped turn one"),
      makeRaw("r2", "assistant", "dropped reply one"),
    ];
    const obs = makeObservation("o1", "compressed dropped turns", "2026-05-30T00:00:00.000Z", [
      "r1",
      "r2",
    ]);
    const store = makeFakeStore({ observations: [obs], threadMessages });

    // The window holds NONE of the covered turns → the observation must be injected.
    const windowContentHashCounts = new Map([[sha256Hex("a brand new turn"), 1]]);
    const out = await assembleInjectedContext(
      baseInput({ windowContentHashCounts }),
      makeDeps(store),
    );

    const block = out.memoryBlock ?? "";
    expect(block).toContain("compressed dropped turns");
    expect(out.metadata.observation_count).toBe(1);
  });

  it("INCLUDES an observation when only SOME of its covered turns are in the window", async () => {
    const threadMessages = [
      makeRaw("r1", "user", "still in window"),
      makeRaw("r2", "assistant", "dropped by client"),
    ];
    const obs = makeObservation("o1", "covers r1..r2", "2026-05-30T00:00:00.000Z", ["r1", "r2"]);
    const store = makeFakeStore({ observations: [obs], threadMessages });

    // Only r1 is in the window; r2 was dropped → not ALL covered → must include.
    const windowContentHashCounts = new Map([[sha256Hex("still in window"), 1]]);
    const out = await assembleInjectedContext(
      baseInput({ windowContentHashCounts }),
      makeDeps(store),
    );

    expect(out.memoryBlock ?? "").toContain("covers r1..r2");
    expect(out.metadata.observation_count).toBe(1);
  });

  it("with NO window set, no observation is deduped (every active observation is considered)", async () => {
    const store = makeFakeStore({
      observations: [makeObservation("o1", "obs text", "2026-05-20T00:00:00.000Z", ["r1", "r2"])],
      threadMessages: [makeRaw("r1", "user", "x"), makeRaw("r2", "assistant", "y")],
    });
    const out = await assembleInjectedContext(baseInput(), makeDeps(store));
    expect(out.memoryBlock ?? "").toContain("obs text");
    expect(out.metadata.observation_count).toBe(1);
  });

  it("token budget trims OBSERVATIONS (oldest-first) but never reflections under a generous budget", async () => {
    const store = makeFakeStore({
      projectReflection: makeReflection({ projectId: "proj-1", reflectionText: "keep this proj" }),
      observations: [
        makeObservation("o1", "drop me oldest", "2026-05-10T00:00:00.000Z", ["a", "b"]),
        makeObservation("o2", "keep me newer", "2026-05-28T00:00:00.000Z", ["c", "d"]),
      ],
    });
    // Budget fits the reflection (3 tokens) + exactly one 3-token observation.
    const out = await assembleInjectedContext(baseInput({ tokenBudget: 6 }), makeDeps(store));
    const block = out.memoryBlock ?? "";
    // reflection survives.
    expect(block).toContain("keep this proj");
    // newer observation survives; oldest is the first sacrificed.
    expect(block).toContain("keep me newer");
    expect(block).not.toContain("drop me oldest");
    expect(out.metadata.observation_count).toBe(1);
    // The CONTENT selected (reflection + kept observation text) respects the budget;
    // the rendered block adds fixed section-header overhead on top, so
    // memory_tokens_injected (the final string) is reported separately.
    const selectedContentTokens =
      estimateTokens("keep this proj") + estimateTokens("keep me newer");
    expect(selectedContentTokens).toBeLessThanOrEqual(6);
  });

  it("trims reflections (resource before project) only when the budget cannot fit them, and signals overflow", async () => {
    const store = makeFakeStore({
      projectReflection: makeReflection({ projectId: "proj-1", reflectionText: "PROJ" }),
      resourceReflection: makeReflection({ resourceId: "res-1", reflectionText: "RES" }),
    });
    const log = vi.fn();
    // Budget fits exactly one 1-token reflection → project kept, resource dropped.
    const out = await assembleInjectedContext(
      baseInput({ tokenBudget: 1 }),
      makeDeps(store, { log }),
    );
    const block = out.memoryBlock ?? "";
    expect(block).toContain("PROJ");
    expect(block).not.toContain("RES");
    const logged = log.mock.calls.map((c) => String(c[0])).join("\n");
    expect(logged).toMatch(/memory.inject.*overflow/i);
  });

  it("produces a valid block for a TOOL / MULTIMODAL current turn (no plain-text restriction in the assembler)", async () => {
    // The assembler is window-hash + memory only; it never inspects the live turn's
    // structure. A window containing tool/multipart hash counts is just opaque data.
    const store = makeFakeStore({
      projectReflection: makeReflection({
        projectId: "proj-1",
        reflectionText: "tool-thread memory",
      }),
      observations: [
        makeObservation("o1", "earlier tool summary", "2026-05-20T00:00:00.000Z", ["x", "y"]),
      ],
      threadMessages: [
        makeRaw("x", "user", '[{"type":"image","url":"data:..."}]'),
        makeRaw("y", "tool", "tool out"),
      ],
    });
    const windowContentHashCounts = new Map([[sha256Hex('[{"type":"text","text":"now"}]'), 1]]);
    const out = await assembleInjectedContext(
      baseInput({ windowContentHashCounts }),
      makeDeps(store),
    );
    const block = out.memoryBlock ?? "";
    expect(block).toContain("tool-thread memory");
    expect(block).toContain("earlier tool summary");
    expect(out.metadata.memory_hydrated).toBe(true);
  });

  it("books the block tokens into the dedicated hydrate cost bucket", async () => {
    const store = makeFakeStore({
      projectReflection: makeReflection({ projectId: "proj-1", reflectionText: "alpha beta" }),
    });
    const costSink = vi.fn();
    const out = await assembleInjectedContext(baseInput(), makeDeps(store, { costSink }));
    expect(costSink).toHaveBeenCalledWith("hydrate", out.metadata.memory_tokens_injected);
    for (const [bucket] of costSink.mock.calls) {
      expect(bucket).toBe("hydrate");
    }
  });

  it("enqueues an observer job and reports its id as queued writeback", async () => {
    const store = makeFakeStore({});
    const enqueueObserverJob = vi.fn(async () => "observer-job-42");
    const out = await assembleInjectedContext(baseInput(), makeDeps(store, { enqueueObserverJob }));
    expect(enqueueObserverJob).toHaveBeenCalledWith(baseInput().scope);
    expect(out.metadata.observer_job_id).toBe("observer-job-42");
    expect(out.metadata.memory_writeback_status).toBe("queued");
  });

  it("reports 'skipped' writeback and does NOT enqueue when there is no thread target", async () => {
    const store = makeFakeStore({});
    const enqueueObserverJob = vi.fn(async () => "observer-job-1");
    const out = await assembleInjectedContext(
      baseInput({ scope: { accountId: "acct-a", projectId: "proj-1" } }),
      makeDeps(store, { enqueueObserverJob }),
    );
    expect(enqueueObserverJob).not.toHaveBeenCalled();
    expect(out.metadata.memory_writeback_status).toBe("skipped");
    expect(out.metadata.observer_job_id).toBeNull();
  });

  it("only reads observations from the thread (thread-anchored store contract)", async () => {
    const store = makeFakeStore({
      observations: [makeObservation("o1", "should not load", "2026-05-20T00:00:00.000Z")],
    });
    const out = await assembleInjectedContext(
      baseInput({ scope: { accountId: "acct-a", projectId: "proj-1", resourceId: "res-1" } }),
      makeDeps(store),
    );
    expect(store.listObservations).not.toHaveBeenCalled();
    expect(out.metadata.observation_count).toBe(0);
  });

  it("queries listObservations with the threadId only (no project/resource spread)", async () => {
    const store = makeFakeStore({
      observations: [makeObservation("o1", "obs", "2026-05-20T00:00:00.000Z")],
    });
    await assembleInjectedContext(baseInput(), makeDeps(store));
    expect(store.listObservations).toHaveBeenCalledWith({
      accountId: "acct-a",
      threadId: "thread-1",
    });
  });

  it("fail-open: when memory load throws, returns null block + degraded metadata + logs it", async () => {
    const store = makeFakeStore({ throwOn: "listObservations" });
    const log = vi.fn();
    const out = await assembleInjectedContext(baseInput(), makeDeps(store, { log }));

    expect(out.memoryBlock).toBeNull();
    expect(out.metadata.degraded).toBe(true);
    expect(out.metadata.memory_hydrated).toBe(false);
    expect(out.metadata.reflection_version).toBeNull();
    expect(out.metadata.observation_count).toBe(0);
    expect(out.metadata.memory_tokens_injected).toBe(0);
    expect(out.metadata.memory_writeback_status).toBe("failed");
    const logged = log.mock.calls.map((c) => String(c[0])).join("\n");
    expect(logged).toMatch(/memory.inject.*fail/i);
  });

  it("fail-open never rejects even if enqueue also fails", async () => {
    const store = makeFakeStore({ throwOn: "getReflection" });
    const enqueueObserverJob = vi.fn(async () => {
      throw new Error("queue down");
    });
    await expect(
      assembleInjectedContext(baseInput(), makeDeps(store, { enqueueObserverJob })),
    ).resolves.toBeDefined();
  });

  it("does not emit any lane / routing field — only the block + metadata", async () => {
    const store = makeFakeStore({
      projectReflection: makeReflection({ projectId: "proj-1", reflectionText: "x" }),
    });
    const out = await assembleInjectedContext(baseInput(), makeDeps(store));
    expect(Object.keys(out).sort()).toEqual(["memoryBlock", "metadata"]);
    expect(out).not.toHaveProperty("lane");
    expect(out.metadata).not.toHaveProperty("lane");
  });
});
