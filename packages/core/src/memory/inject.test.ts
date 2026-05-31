import type { Observation, RawMessage, Reflection } from "@helm/shared";
import { describe, expect, it, vi } from "vitest";
import type { MemoryStore } from "../store/ports.js";
import { assembleInjectedContext, type InjectDeps, type InjectInput } from "./inject.js";

// Recording fake MemoryStore for the inject phase. It serves a scope's reflections
// (project + resource), the thread's active observations, and the thread's recent
// raw messages. Read methods can be made to throw to exercise fail-open. Memory is
// a MIDDLEWARE — this fake never touches routing/lane state.
function makeReflection(over: Partial<Reflection> & { reflectionText: string }): Reflection {
  return {
    id: "refl-1",
    projectId: null,
    resourceId: null,
    threadId: null,
    version: 1,
    tokenEstimate: 0,
    updatedAt: new Date("2026-05-30T00:00:00.000Z"),
    ...over,
  };
}

function makeObservation(id: string, text: string, observedAt: string): Observation {
  return {
    id,
    threadId: "thread-1",
    sourceMessageRange: ["m1", "m2"],
    observationText: text,
    observedAt: new Date(observedAt),
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
  recentMessages?: RawMessage[];
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
      return data.recentMessages ?? [];
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
  };
  return store;
}

const NOW = new Date("2026-05-31T12:00:00.000Z");
const CURRENT = makeRaw("cur", "user", "current question");

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
    scope: { projectId: "proj-1", resourceId: "res-1", threadId: "thread-1" },
    currentUserMessage: CURRENT,
    systemPrompt: "you are helpful",
    tokenBudget: 1000,
    ...over,
  };
}

describe("assembleInjectedContext", () => {
  it("assembles the fixed docs/08 order within budget and reports injected tokens", async () => {
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
      recentMessages: [makeRaw("r1", "user", "earlier turn"), makeRaw("r2", "assistant", "reply")],
    });
    const deps = makeDeps(store);

    const out = await assembleInjectedContext(baseInput(), deps);

    // Strict fixed order: system → project reflection → resource reflection →
    // thread observations (oldest..newest) → recent raw → current.
    expect(out.messages.map((m) => m.source)).toEqual([
      "system",
      "project_reflection",
      "resource_reflection",
      "thread_observation",
      "thread_observation",
      "recent_raw",
      "recent_raw",
      "current",
    ]);
    expect(out.messages[0]?.content).toBe("you are helpful");
    expect(out.messages.at(-1)?.content).toBe("current question");

    expect(out.metadata.memory_hydrated).toBe(true);
    expect(out.metadata.reflection_version).toBe(1);
    expect(out.metadata.observation_count).toBe(2);
    expect(out.metadata.memory_writeback_status).toBe("queued");

    // memory_tokens_injected = tokens of the INJECTED memory layers only
    // (project + resource reflection + observations + recent raw), excluding the
    // mandatory system + current parts.
    const injectedText = [
      "project memory",
      "resource memory",
      "older observation",
      "newer observation",
      "earlier turn",
      "reply",
    ].join(" ");
    expect(out.metadata.memory_tokens_injected).toBe(estimateTokens(injectedText));
  });

  it("trims oldest observations first when over budget but keeps recent raw + current", async () => {
    const store = makeFakeStore({
      projectReflection: makeReflection({ projectId: "proj-1", reflectionText: "P" }),
      observations: [
        makeObservation("o1", "drop me oldest", "2026-05-10T00:00:00.000Z"),
        makeObservation("o2", "keep me newer", "2026-05-28T00:00:00.000Z"),
      ],
      recentMessages: [makeRaw("r1", "user", "must keep recent raw")],
    });
    // Budget only allows a couple of injected tokens — forces dropping observations.
    const deps = makeDeps(store);
    const out = await assembleInjectedContext(baseInput({ tokenBudget: 6 }), deps);

    const sources = out.messages.map((m) => m.source);
    const contents = out.messages.map((m) => m.content);

    // recent raw + current are NEVER dropped.
    expect(contents).toContain("must keep recent raw");
    expect(contents.at(-1)).toBe("current question");
    expect(sources.at(-1)).toBe("current");
    // The OLDEST observation is the first to be sacrificed.
    expect(contents).not.toContain("drop me oldest");
    // Budget is a hard cap on injected tokens.
    expect(out.metadata.memory_tokens_injected).toBeLessThanOrEqual(6);
  });

  it("enqueues an observer job and reports its id as queued writeback", async () => {
    const store = makeFakeStore({ recentMessages: [makeRaw("r1", "user", "hi")] });
    const enqueueObserverJob = vi.fn(async () => "observer-job-42");
    const deps = makeDeps(store, { enqueueObserverJob });

    const out = await assembleInjectedContext(baseInput(), deps);

    expect(enqueueObserverJob).toHaveBeenCalledWith(baseInput().scope);
    expect(out.metadata.observer_job_id).toBe("observer-job-42");
    expect(out.metadata.memory_writeback_status).toBe("queued");
  });

  it("fail-open: when memory load throws, request continues with system + current only + logs it", async () => {
    const store = makeFakeStore({ throwOn: "listObservations" });
    const log = vi.fn();
    const enqueueObserverJob = vi.fn(async () => "observer-job-1");
    const deps = makeDeps(store, { log, enqueueObserverJob });

    const out = await assembleInjectedContext(baseInput(), deps);

    // Minimal context = system + current ONLY.
    expect(out.messages.map((m) => m.source)).toEqual(["system", "current"]);
    expect(out.metadata.memory_hydrated).toBe(false);
    expect(out.metadata.reflection_version).toBeNull();
    expect(out.metadata.observation_count).toBe(0);
    expect(out.metadata.memory_tokens_injected).toBe(0);
    expect(out.metadata.memory_writeback_status).toBe("failed");
    // The failure must be RECORDED (CLAUDE.md principle 3).
    expect(log).toHaveBeenCalled();
    const logged = log.mock.calls.map((c) => String(c[0])).join("\n");
    expect(logged).toMatch(/memory.inject.*fail/i);
  });

  it("fail-open never rejects even if enqueue also fails", async () => {
    const store = makeFakeStore({ throwOn: "getReflection" });
    const enqueueObserverJob = vi.fn(async () => {
      throw new Error("queue down");
    });
    const deps = makeDeps(store, { enqueueObserverJob });

    await expect(assembleInjectedContext(baseInput(), deps)).resolves.toBeDefined();
  });

  it("books injected tokens into the dedicated hydrate cost bucket", async () => {
    const store = makeFakeStore({
      projectReflection: makeReflection({ projectId: "proj-1", reflectionText: "alpha beta" }),
      recentMessages: [makeRaw("r1", "user", "gamma")],
    });
    const costSink = vi.fn();
    const deps = makeDeps(store, { costSink });

    const out = await assembleInjectedContext(baseInput(), deps);

    expect(costSink).toHaveBeenCalledWith("hydrate", out.metadata.memory_tokens_injected);
    // Only the hydrate bucket — never actor/observer/reflector from inject.
    for (const [bucket] of costSink.mock.calls) {
      expect(bucket).toBe("hydrate");
    }
  });

  it("does not emit any lane / routing field — only context text", async () => {
    const store = makeFakeStore({
      projectReflection: makeReflection({ projectId: "proj-1", reflectionText: "x" }),
      recentMessages: [makeRaw("r1", "user", "y")],
    });
    const out = await assembleInjectedContext(baseInput(), deps(store));

    for (const m of out.messages) {
      expect(Object.keys(m).sort()).toEqual(["content", "role", "source"]);
    }
    expect(out).not.toHaveProperty("lane");
    expect(out.metadata).not.toHaveProperty("lane");
  });
});

function deps(store: MemoryStore): InjectDeps {
  return makeDeps(store);
}
