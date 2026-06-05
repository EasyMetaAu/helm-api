import type { Observation, RawMessage, Reflection } from "@helm/shared";
import { describe, expect, it, vi } from "vitest";
import type { MemoryStore } from "../store/ports.js";
import type { ScoreConfig } from "./forgetting/score.js";
import {
  assembleInjectedContext,
  type ForgettingInjectDeps,
  type InjectDeps,
  type InjectInput,
} from "./inject.js";

// docs/12 P3 (Access reinforcement) + P4 (score-driven inject trim) — the two
// inject-path forgetting changes, ALL gated behind forgetting.enabled. With the
// flag off (or absent) the assembler is byte-identical to today (see the explicit
// regression case below + the untouched inject.test.ts). With the flag on:
//   P4 — the observation budget trim drops LOWEST-SCORE-first instead of
//        oldest-first, so a high-reference_count old observation outlives a
//        never-referenced newer one; a throwing comparator falls back to
//        oldest-first (fail-open); archived/expired rows are never injected.
//   P3 — after the prefix is assembled, bumpReferences is fired (fire-and-forget)
//        with EXACTLY the post-trim injected ids; a throwing bump never changes
//        the returned messages; only the request account's rows are bumped.

function makeObservation(over: Partial<Observation> & { id: string }): Observation {
  return {
    threadId: "thread-1",
    sourceMessageRange: ["m1", "m2"],
    observationText: over.id,
    observedAt: new Date("2026-05-20T00:00:00.000Z"),
    referenceCount: 0,
    importance: 0.5,
    status: "active",
    referencedAt: null,
    archivedAt: null,
    expiredAt: null,
    ...over,
  };
}

function makeRaw(id: string, content: string): RawMessage {
  return {
    id,
    threadId: "thread-1",
    role: "user",
    content,
    tokenEstimate: 0,
    createdAt: new Date("2026-05-29T00:00:00.000Z"),
  };
}

function makeFakeStore(observations: Observation[], over: Partial<MemoryStore> = {}) {
  const store: MemoryStore = {
    ensureThread: vi.fn(async () => {}),
    appendMessage: vi.fn(async () => "unused"),
    listMessages: vi.fn(async () => []),
    appendObservation: vi.fn(async () => "unused"),
    listObservations: vi.fn(async () => observations),
    getReflection: vi.fn(async (): Promise<Reflection | null> => null),
    upsertReflection: vi.fn(async () => "unused"),
    updateJobStatus: vi.fn(async () => {}),
    enqueueJob: vi.fn(async () => "job"),
    claimPendingJobs: vi.fn(async () => []),
    bumpReferences: vi.fn(async () => {}),
    ...over,
  };
  return store;
}

// The reinforcement write signature (docs/12 P3) — typing the spy with it makes
// `mock.calls[0][0]` the input object instead of an empty-args tuple.
type BumpInput = {
  accountId: string;
  observationIds: string[];
  reflectionIds: string[];
  now: Date;
};
const makeBumpSpy = () => vi.fn<(input: BumpInput) => Promise<void>>(async () => {});

const NOW = new Date("2026-05-31T12:00:00.000Z");
const CURRENT = makeRaw("cur", "current question");
const estimateTokens = (text: string) => text.trim().split(/\s+/).filter(Boolean).length;

const SCORE_CONFIG: ScoreConfig = {
  half_life_s: 86400,
  importance_floor: 0.1,
  importance_ceil: 1.0,
  access_weight: 0.15,
};

function forgetting(over: Partial<ForgettingInjectDeps> = {}): ForgettingInjectDeps {
  return {
    enabled: true,
    dropOrder: "score",
    scoreConfig: SCORE_CONFIG,
    bumpReferences: vi.fn(async () => {}),
    ...over,
  };
}

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
    currentUserMessage: CURRENT,
    systemPrompt: "you are helpful",
    tokenBudget: 1000,
    ...over,
  };
}

describe("assembleInjectedContext — forgetting gated (P3 + P4)", () => {
  it("flag OFF (no forgetting dep): output is byte-identical to today and never bumps", async () => {
    const bumpReferences = vi.fn(async () => {});
    const store = makeFakeStore(
      [
        makeObservation({ id: "older", observedAt: new Date("2026-05-10T00:00:00.000Z") }),
        makeObservation({ id: "newer", observedAt: new Date("2026-05-28T00:00:00.000Z") }),
      ],
      { bumpReferences },
    );
    // Budget forces a single observation through → the legacy oldest-first drop
    // must keep "newer".
    const out = await assembleInjectedContext(baseInput({ tokenBudget: 1 }), makeDeps(store));

    const obs = out.messages.filter((m) => m.source === "thread_observation").map((m) => m.content);
    expect(obs).toEqual(["newer"]); // legacy oldest-first
    expect(bumpReferences).not.toHaveBeenCalled(); // no reinforcement when flag off
  });

  it("flag OFF explicit (forgetting.enabled=false): identical legacy trim, no bump", async () => {
    const bumpReferences = vi.fn(async () => {});
    const store = makeFakeStore(
      [
        // An OLD observation with a huge reference_count — under SCORE order it would
        // win, but with the flag OFF the legacy oldest-first must still drop it.
        makeObservation({
          id: "old-but-popular",
          observedAt: new Date("2026-01-01T00:00:00.000Z"),
          referenceCount: 100,
        }),
        makeObservation({ id: "fresh", observedAt: new Date("2026-05-30T00:00:00.000Z") }),
      ],
      { bumpReferences },
    );
    const deps = makeDeps(store);
    const out = await assembleInjectedContext(baseInput({ tokenBudget: 1 }), {
      ...deps,
      forgetting: forgetting({ enabled: false, bumpReferences }),
    });
    const obs = out.messages.filter((m) => m.source === "thread_observation").map((m) => m.content);
    expect(obs).toEqual(["fresh"]); // legacy oldest-first wins, not score
    expect(bumpReferences).not.toHaveBeenCalled();
  });

  it("flag ON + drop_order=score: a high-reference_count OLD obs outlives a never-referenced NEWER one", async () => {
    const store = makeFakeStore([
      makeObservation({
        id: "old-popular",
        observedAt: new Date("2026-01-01T00:00:00.000Z"),
        referenceCount: 50,
        referencedAt: new Date("2026-05-31T00:00:00.000Z"), // recently reinforced → high recency
      }),
      makeObservation({
        id: "new-cold",
        observedAt: new Date("2026-05-30T00:00:00.000Z"),
        referenceCount: 0,
        referencedAt: null,
      }),
    ]);
    // Budget allows exactly one observation token.
    const out = await assembleInjectedContext(baseInput({ tokenBudget: 1 }), {
      ...makeDeps(store),
      forgetting: forgetting(),
    });
    const obs = out.messages.filter((m) => m.source === "thread_observation").map((m) => m.content);
    expect(obs).toEqual(["old-popular"]); // score-trim kept the reinforced one
  });

  it("flag ON: a throwing score comparator falls back to legacy oldest-first (fail-open)", async () => {
    const store = makeFakeStore([
      makeObservation({ id: "older", observedAt: new Date("2026-05-10T00:00:00.000Z") }),
      makeObservation({ id: "newer", observedAt: new Date("2026-05-28T00:00:00.000Z") }),
    ]);
    const log = vi.fn();
    // A scoreConfig that makes the score throw: half_life_s = 0 would divide, but
    // recency clamps; instead inject a NaN-producing config via a poisoned getter.
    const poisoned = forgetting({
      scoreConfig: new Proxy(SCORE_CONFIG, {
        get() {
          throw new Error("score boom");
        },
      }) as ScoreConfig,
    });
    const out = await assembleInjectedContext(baseInput({ tokenBudget: 1 }), {
      ...makeDeps(store, { log }),
      forgetting: poisoned,
    });
    const obs = out.messages.filter((m) => m.source === "thread_observation").map((m) => m.content);
    expect(obs).toEqual(["newer"]); // fell back to oldest-first
    const logged = log.mock.calls.map((c) => String(c[0])).join("\n");
    expect(logged).toMatch(/memory.inject.*(score|forgetting).*fallback/i);
  });

  it("flag ON: archived / expired observations are never injected", async () => {
    const store = makeFakeStore([
      makeObservation({ id: "active", observedAt: new Date("2026-05-28T00:00:00.000Z") }),
      makeObservation({
        id: "archived",
        observedAt: new Date("2026-05-29T00:00:00.000Z"),
        status: "archived",
        archivedAt: new Date("2026-05-30T00:00:00.000Z"),
      }),
      makeObservation({
        id: "expired",
        observedAt: new Date("2026-05-29T00:00:00.000Z"),
        expiredAt: new Date("2026-05-30T00:00:00.000Z"),
      }),
    ]);
    const out = await assembleInjectedContext(baseInput(), {
      ...makeDeps(store),
      forgetting: forgetting(),
    });
    const obs = out.messages.filter((m) => m.source === "thread_observation").map((m) => m.content);
    expect(obs).toEqual(["active"]);
  });

  it("flag ON: bumpReferences is called with EXACTLY the post-trim injected ids", async () => {
    const bumpReferences = makeBumpSpy();
    const store = makeFakeStore(
      [
        makeObservation({ id: "kept-newer", observedAt: new Date("2026-05-30T00:00:00.000Z") }),
        makeObservation({ id: "dropped-older", observedAt: new Date("2026-05-01T00:00:00.000Z") }),
      ],
      { bumpReferences },
    );
    // drop_order=oldest so the trim is deterministic regardless of score; budget = 1.
    await assembleInjectedContext(baseInput({ tokenBudget: 1 }), {
      ...makeDeps(store),
      forgetting: forgetting({ dropOrder: "oldest", bumpReferences }),
    });
    // Allow the fire-and-forget write to settle: the invocation itself is DEFERRED
    // to a macrotask (setImmediate — Codex review fix: a sync sqlite .run() must not
    // execute on the request tick), so flush a macrotask, not just microtasks.
    await new Promise((resolve) => setImmediate(resolve));
    expect(bumpReferences).toHaveBeenCalledTimes(1);
    const call = bumpReferences.mock.calls[0]![0];
    expect(call.accountId).toBe("acct-a");
    expect(call.observationIds).toEqual(["kept-newer"]); // dropped-older NOT bumped
  });

  // docs/12 (Codex review fix) — the reinforcement INVOCATION is deferred off the
  // request tick: the default sqlite adapter's writes are synchronous (.run()), so
  // an inline (even un-awaited) call would still spend the write on the request
  // path. assemble must return BEFORE the bump executes; a SYNCHRONOUSLY-throwing
  // bump inside the macrotask must be caught (an uncaught macrotask throw would
  // crash the process), logged, and change nothing.
  it("flag ON: the bump runs AFTER assemble returns (deferred macrotask) and a sync throw is contained", async () => {
    const bumpReferences = vi.fn(() => {
      throw new Error("sync boom"); // SYNCHRONOUS throw — not a rejected promise
    }) as unknown as ReturnType<typeof makeBumpSpy>;
    const store = makeFakeStore(
      [makeObservation({ id: "o1", observedAt: new Date("2026-05-28T00:00:00.000Z") })],
      { bumpReferences },
    );
    const log = vi.fn();
    const out = await assembleInjectedContext(baseInput(), {
      ...makeDeps(store, { log }),
      forgetting: forgetting({ bumpReferences }),
    });

    // assemble has returned, the macrotask has NOT run yet — nothing bumped.
    expect(bumpReferences).not.toHaveBeenCalled();
    expect(out.messages.at(-1)?.source).toBe("current");

    await new Promise((resolve) => setImmediate(resolve)); // run the deferred task
    expect(bumpReferences).toHaveBeenCalledTimes(1);
    // The sync throw was caught + logged — no crash, no behavioural change.
    const logged = log.mock.calls.map((c) => String(c[0])).join("\n");
    expect(logged).toContain("memory.inject.reinforce_failed");
  });

  it("flag ON: a throwing bumpReferences does not change the returned messages (fail-open)", async () => {
    const bumpReferences = vi.fn(async () => {
      throw new Error("bump down");
    });
    const store = makeFakeStore(
      [makeObservation({ id: "o1", observedAt: new Date("2026-05-28T00:00:00.000Z") })],
      { bumpReferences },
    );
    const log = vi.fn();
    const out = await assembleInjectedContext(baseInput(), {
      ...makeDeps(store, { log }),
      forgetting: forgetting({ bumpReferences }),
    });
    await new Promise((resolve) => setImmediate(resolve)); // flush the deferred macrotask
    // The prefix still includes the observation and ends with current — unaffected.
    expect(out.messages.map((m) => m.source)).toContain("thread_observation");
    expect(out.messages.at(-1)?.source).toBe("current");
  });

  it("flag ON: bumpReferences includes the injected reflection ids and is account-guarded", async () => {
    const bumpReferences = makeBumpSpy();
    const projectReflection: Reflection = {
      id: "refl-p",
      projectId: "proj-1",
      resourceId: null,
      threadId: null,
      reflectionText: "P",
      version: 1,
      tokenEstimate: 0,
      updatedAt: new Date("2026-05-30T00:00:00.000Z"),
      referencedAt: null,
      referenceCount: 0,
      status: "active",
    };
    const store = makeFakeStore([], {
      bumpReferences,
      getReflection: vi.fn(async (scope) =>
        scope.projectId !== undefined && scope.resourceId === undefined ? projectReflection : null,
      ),
    });
    await assembleInjectedContext(baseInput(), {
      ...makeDeps(store),
      forgetting: forgetting({ bumpReferences }),
    });
    await new Promise((resolve) => setImmediate(resolve)); // flush the deferred macrotask
    const call = bumpReferences.mock.calls[0]![0];
    expect(call.accountId).toBe("acct-a");
    expect(call.reflectionIds).toContain("refl-p");
  });
});
