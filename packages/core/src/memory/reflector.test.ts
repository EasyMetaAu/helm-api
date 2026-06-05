import type { Observation, Reflection, ReflectionScope, ReflectionUpsertInput } from "@helm/shared";
import { describe, expect, it, vi } from "vitest";
import type { MemoryJobStatus, MemoryStore } from "../store/ports.js";
import { type ReflectorDeps, type ReflectorJob, runReflectorJob } from "./reflector.js";

// A recording fake MemoryStore for the background Reflector. It serves a fixed
// set of observations for a scope, holds an in-memory "current" reflection, and
// records job-status transitions so tests can assert versioning + fail-open.
// Memory is a MIDDLEWARE — this fake never touches routing/lane state.
function makeFakeStore(observations: Observation[], initial: Reflection | null = null) {
  let current: Reflection | null = initial;
  const upserts: ReflectionUpsertInput[] = [];
  const jobUpdates: Array<{ jobId: string; status: MemoryJobStatus; error?: string }> = [];
  const archiveCalls: ReflectionScope[] = [];
  const store: MemoryStore = {
    ensureThread: vi.fn(async () => {}),
    appendMessage: vi.fn(async () => "unused"),
    listMessages: vi.fn(async () => []),
    appendObservation: vi.fn(async () => "unused"),
    listObservations: vi.fn(async (_scope: ReflectionScope) => observations),
    getReflection: vi.fn(async (_scope: ReflectionScope) => current),
    upsertReflection: vi.fn(async (input: ReflectionUpsertInput) => {
      upserts.push(input);
      const id = `refl-${upserts.length}`;
      // Reflect the write back into "current" so a follow-up run reads it.
      current = {
        id,
        projectId: input.projectId ?? null,
        resourceId: input.resourceId ?? null,
        threadId: input.threadId ?? null,
        reflectionText: input.reflectionText,
        version: input.version,
        tokenEstimate: input.tokenEstimate,
        updatedAt: input.updatedAt,
        referencedAt: null,
        referenceCount: 0,
        status: "active",
      };
      return id;
    }),
    updateJobStatus: vi.fn(async (jobId: string, status: MemoryJobStatus, error?: string) => {
      jobUpdates.push(error === undefined ? { jobId, status } : { jobId, status, error });
    }),
    enqueueJob: vi.fn(async () => "job"),
    claimPendingJobs: vi.fn(async () => []),
    // docs/12 (Codex review fix) — archive every reflection version of a scope when
    // its active observation set empties out; records the scope it was asked to clear.
    archiveReflections: vi.fn(async (scope: ReflectionScope) => {
      archiveCalls.push(scope);
      if (current !== null) current = { ...current, status: "archived" };
    }),
  };
  return { store, upserts, jobUpdates, archiveCalls, getCurrent: () => current };
}

function makeObservations(texts: string[]): Observation[] {
  return texts.map((text, i) => ({
    id: `obs-${i + 1}`,
    threadId: "thread-1",
    sourceMessageRange: [`m${i * 2 + 1}`, `m${i * 2 + 2}`] as [string, string],
    observationText: text,
    observedAt: new Date(`2026-05-${String(i + 1).padStart(2, "0")}T00:00:00.000Z`),
    referenceCount: 0,
    importance: 0.5,
    status: "active" as const,
    referencedAt: null,
    archivedAt: null,
    expiredAt: null,
  }));
}

const NOW = new Date("2026-05-30T12:00:00.000Z");
const JOB: ReflectorJob = { jobId: "job-1", scope: { accountId: "acct-a", threadId: "thread-1" } };

// Deterministic merge stub: joins the observation texts (+ optional previous
// reflection prefix). Stands in for an LLM — same input → same output.
function makeDeps(store: MemoryStore, overrides: Partial<ReflectorDeps> = {}): ReflectorDeps {
  return {
    memoryStore: store,
    merge: vi.fn(async ({ observations, previousReflection }) => {
      const body = observations.map((o: Observation) => o.observationText).join(" | ");
      const text = previousReflection ? `${previousReflection.reflectionText}\n${body}` : body;
      return { reflectionText: text, tokenEstimate: Math.ceil(text.length / 4) };
    }),
    costSink: vi.fn(),
    now: () => NOW,
    log: vi.fn(),
    ...overrides,
  };
}

describe("runReflectorJob", () => {
  it("merges observations into a version=1 reflection when the scope has none", async () => {
    const obs = makeObservations(["likes terse answers", "prefers TypeScript"]);
    const { store, upserts } = makeFakeStore(obs);
    const deps = makeDeps(store);

    const out = await runReflectorJob(JOB, deps);

    expect(out.changed).toBe(true);
    expect(out.version).toBe(1);
    expect(out.reflectionId).toBe("refl-1");
    expect(upserts).toHaveLength(1);
    const up = upserts[0];
    if (!up) throw new Error("expected one upsert");
    expect(up.version).toBe(1);
    // The merged text reflects both observations.
    expect(up.reflectionText).toContain("likes terse answers");
    expect(up.reflectionText).toContain("prefers TypeScript");
    // updatedAt is exactly now().
    expect(up.updatedAt).toEqual(NOW);
    // Scope propagated.
    expect(up.threadId).toBe("thread-1");
  });

  // docs/12 (Codex review fix #2) — a decayed (archived) or retention-tombstoned
  // (pruned) observation is a FORGOTTEN row: it must NOT feed the long-lived
  // reflection merge, even though the store still returns it (its range serves as a
  // raw-coverage marker for inject/observer). Otherwise forgotten memory resurrects
  // through the reflection back door.
  it("excludes archived/pruned observations from the merge (forgotten rows stay forgotten)", async () => {
    const obs = makeObservations(["active fact", "archived fact", "pruned fact"]);
    const archived = obs[1];
    const pruned = obs[2];
    if (!archived || !pruned) throw new Error("fixture");
    archived.status = "archived";
    archived.archivedAt = new Date("2026-05-20T00:00:00.000Z");
    pruned.status = "pruned";
    const { store, upserts } = makeFakeStore(obs);
    const merge = vi.fn(async ({ observations }: { observations: Observation[] }) => {
      const text = observations.map((o) => o.observationText).join(" | ");
      return { reflectionText: text, tokenEstimate: text.length };
    });
    const deps = makeDeps(store, { merge });

    const out = await runReflectorJob(JOB, deps);

    expect(out.changed).toBe(true);
    // merge saw ONLY the active observation — archived + pruned were filtered out.
    const merged = (merge.mock.calls[0]?.[0]?.observations ?? []) as Observation[];
    expect(merged.map((o) => o.observationText)).toEqual(["active fact"]);
    expect(upserts[0]?.reflectionText).toBe("active fact");
  });

  it("is stable/slowly-changing: identical observations do not bump the version or write a new row", async () => {
    const obs = makeObservations(["a", "b"]);
    // Existing reflection whose text already equals what merge would produce.
    const existing: Reflection = {
      id: "refl-existing",
      projectId: null,
      resourceId: null,
      threadId: "thread-1",
      reflectionText: "a | b",
      version: 7,
      tokenEstimate: 1,
      updatedAt: new Date("2026-05-01T00:00:00.000Z"),
      referencedAt: null,
      referenceCount: 0,
      status: "active",
    };
    const { store, upserts } = makeFakeStore(obs, existing);
    // merge with NO previous-prefix behavior so identical input → identical "a | b".
    const deps = makeDeps(store, {
      merge: vi.fn(async ({ observations }) => {
        const text = observations.map((o: Observation) => o.observationText).join(" | ");
        return { reflectionText: text, tokenEstimate: 1 };
      }),
    });

    const out = await runReflectorJob(JOB, deps);

    expect(out.changed).toBe(false);
    // Version unchanged (no bump), no new row written.
    expect(out.version).toBe(7);
    expect(out.reflectionId).toBe("refl-existing");
    expect(upserts).toHaveLength(0);
    expect(store.upsertReflection).not.toHaveBeenCalled();
  });

  it("bumps the version only when the merged content actually changes", async () => {
    const obs = makeObservations(["a", "b", "c"]); // new observation 'c'
    const existing: Reflection = {
      id: "refl-existing",
      projectId: null,
      resourceId: null,
      threadId: "thread-1",
      reflectionText: "a | b",
      version: 1,
      tokenEstimate: 1,
      updatedAt: new Date("2026-05-01T00:00:00.000Z"),
      referencedAt: null,
      referenceCount: 0,
      status: "active",
    };
    const { store, upserts } = makeFakeStore(obs, existing);
    const deps = makeDeps(store, {
      merge: vi.fn(async ({ observations }) => {
        const text = observations.map((o: Observation) => o.observationText).join(" | ");
        return { reflectionText: text, tokenEstimate: 1 };
      }),
    });

    const out = await runReflectorJob(JOB, deps);

    expect(out.changed).toBe(true);
    expect(out.version).toBe(2);
    expect(upserts).toHaveLength(1);
    const up = upserts[0];
    if (!up) throw new Error("expected one upsert");
    expect(up.reflectionText).toBe("a | b | c");
    expect(up.version).toBe(2);
  });

  it("evolves from the previous reflection rather than rewriting from scratch", async () => {
    const obs = makeObservations(["fresh insight"]);
    const existing: Reflection = {
      id: "refl-existing",
      projectId: null,
      resourceId: null,
      threadId: "thread-1",
      reflectionText: "old stable summary",
      version: 3,
      tokenEstimate: 1,
      updatedAt: new Date("2026-05-01T00:00:00.000Z"),
      referencedAt: null,
      referenceCount: 0,
      status: "active",
    };
    const { store, upserts } = makeFakeStore(obs, existing);
    const merge = vi.fn(async ({ observations, previousReflection }) => {
      const body = observations.map((o: Observation) => o.observationText).join(" | ");
      const text = previousReflection ? `${previousReflection.reflectionText}\n${body}` : body;
      return { reflectionText: text, tokenEstimate: 1 };
    });
    const deps = makeDeps(store, { merge });

    await runReflectorJob(JOB, deps);

    // merge received the previous reflection so it can evolve it.
    const call = merge.mock.calls[0]?.[0];
    expect(call?.previousReflection?.reflectionText).toBe("old stable summary");
    const up = upserts[0];
    if (!up) throw new Error("expected one upsert");
    expect(up.reflectionText).toContain("old stable summary");
    expect(up.reflectionText).toContain("fresh insight");
    expect(up.version).toBe(4);
  });

  it("books Reflector tokens into the dedicated 'reflector' cost bucket only", async () => {
    const obs = makeObservations(["x", "y"]);
    const { store } = makeFakeStore(obs);
    const costSink = vi.fn();
    const deps = makeDeps(store, { costSink });

    await runReflectorJob(JOB, deps);

    expect(costSink).toHaveBeenCalledTimes(1);
    const [bucket, tokens] = costSink.mock.calls[0] ?? [];
    expect(bucket).toBe("reflector");
    expect(typeof tokens).toBe("number");
    expect(tokens).toBeGreaterThan(0);
  });

  it("is fail-open: a merge error does not throw, returns null/unchanged, and marks the job failed", async () => {
    const obs = makeObservations(["x"]);
    const { store, upserts, jobUpdates } = makeFakeStore(obs);
    const deps = makeDeps(store, {
      merge: vi.fn(async () => {
        throw new Error("llm down");
      }),
    });

    const out = await runReflectorJob(JOB, deps);

    expect(out.reflectionId).toBeNull();
    expect(out.changed).toBe(false);
    expect(out.version).toBeNull();
    // No reflection written on failure.
    expect(upserts).toHaveLength(0);
    // Job marked failed with the error recorded.
    const failed = jobUpdates.find((u) => u.status === "failed");
    expect(failed).toBeDefined();
    expect(failed?.error).toContain("llm down");
  });

  it("marks the job done on a successful run", async () => {
    const obs = makeObservations(["x"]);
    const { store, jobUpdates } = makeFakeStore(obs);
    const deps = makeDeps(store);

    await runReflectorJob(JOB, deps);

    expect(jobUpdates).toContainEqual({ jobId: "job-1", status: "done" });
  });

  it("writes nothing when the scope has no observations", async () => {
    const { store, upserts, jobUpdates, archiveCalls } = makeFakeStore([]);
    const deps = makeDeps(store);

    const out = await runReflectorJob(JOB, deps);

    expect(out.reflectionId).toBeNull();
    expect(out.changed).toBe(false);
    expect(upserts).toHaveLength(0);
    // merge never called — no wasted LLM tokens.
    expect(deps.merge).not.toHaveBeenCalled();
    expect(archiveCalls).toHaveLength(0); // no previous reflection → nothing to clear
    expect(jobUpdates).toContainEqual({ jobId: "job-1", status: "done" });
  });

  // docs/12 (Codex review fix) — a scope whose active observation set has emptied out
  // (everything decayed) is FORGOTTEN: the previous reflection is a stale cache of gone
  // observations and would keep injecting forgotten content. The Reflector ARCHIVES it
  // (soft-invalidate) so getReflection returns null and it stops being injected.
  it("archives the previous reflection when the active observation set is now empty", async () => {
    const existing: Reflection = {
      id: "refl-old",
      projectId: "proj-1",
      resourceId: null,
      threadId: null,
      reflectionText: "stale: user liked X (now decayed)",
      version: 4,
      tokenEstimate: 9,
      updatedAt: new Date("2026-05-01T00:00:00.000Z"),
      referencedAt: null,
      referenceCount: 0,
      status: "active",
    };
    const { store, upserts, archiveCalls, jobUpdates } = makeFakeStore([], existing);
    const deps = makeDeps(store);
    // A project-scoped job → target is an injectable project reflection.
    const projectJob: ReflectorJob = {
      jobId: "job-1",
      scope: { accountId: "acct-a", projectId: "proj-1" },
    };

    const out = await runReflectorJob(projectJob, deps);

    expect(archiveCalls).toEqual([{ accountId: "acct-a", projectId: "proj-1" }]); // cleared at the target scope
    expect(out.changed).toBe(true); // the scope's memory genuinely changed (it was forgotten)
    expect(out.reflectionId).toBeNull();
    expect(upserts).toHaveLength(0); // never writes an empty reflection (reflectionText min(1))
    expect(deps.merge).not.toHaveBeenCalled();
    expect(jobUpdates).toContainEqual({ jobId: "job-1", status: "done" });
  });
});

// The reflection TARGET scope must be one inject actually READS BACK. inject loads
// reflections as getReflection({accountId, projectId}) / ({accountId, resourceId})
// — exact matches where absent levels are NULL — so a reflection written with the
// observer job's full scope (threadId included) would be permanently invisible.
// The job scope stays the OBSERVATION SOURCE (thread-anchored); the reflection is
// written at the highest readable level: project > resource > thread (legacy).
describe("runReflectorJob — reflection target scope (readable by inject)", () => {
  it("writes the reflection at the PROJECT level when the job scope carries a thread anchor", async () => {
    const { store, upserts } = makeFakeStore(makeObservations(["obs A"]));
    const deps = makeDeps(store);
    const job: ReflectorJob = {
      jobId: "job-p",
      scope: { accountId: "acct-a", projectId: "proj-1", threadId: "thread-1" },
    };

    const out = await runReflectorJob(job, deps);

    expect(out.changed).toBe(true);
    // BOTH reads happen at the project level: observations aggregate across ALL
    // the project's threads (never just the promoting one), and the reflection
    // slot is the exact scope the next inject's getReflection reads back.
    expect(store.listObservations).toHaveBeenCalledWith({
      accountId: "acct-a",
      projectId: "proj-1",
    });
    expect(store.getReflection).toHaveBeenCalledWith({ accountId: "acct-a", projectId: "proj-1" });
    expect(upserts[0]).toMatchObject({ accountId: "acct-a", projectId: "proj-1" });
    expect(upserts[0]?.threadId).toBeUndefined();
    expect(upserts[0]?.resourceId).toBeUndefined();
  });

  it("writes the reflection at the RESOURCE level when the scope has a resource but no project", async () => {
    const { store, upserts } = makeFakeStore(makeObservations(["obs A"]));
    const deps = makeDeps(store);
    const job: ReflectorJob = {
      jobId: "job-r",
      scope: { accountId: "acct-a", resourceId: "res-1", threadId: "thread-1" },
    };

    const out = await runReflectorJob(job, deps);

    expect(out.changed).toBe(true);
    expect(store.getReflection).toHaveBeenCalledWith({ accountId: "acct-a", resourceId: "res-1" });
    expect(upserts[0]).toMatchObject({ accountId: "acct-a", resourceId: "res-1" });
    expect(upserts[0]?.threadId).toBeUndefined();
    expect(upserts[0]?.projectId).toBeUndefined();
  });

  it("lands at the PROJECT level (highest) when both project and resource are present", async () => {
    const { store, upserts } = makeFakeStore(makeObservations(["obs A"]));
    const deps = makeDeps(store);
    const job: ReflectorJob = {
      jobId: "job-pr",
      scope: {
        accountId: "acct-a",
        projectId: "proj-1",
        resourceId: "res-1",
        threadId: "thread-1",
      },
    };

    const out = await runReflectorJob(job, deps);

    expect(out.changed).toBe(true);
    expect(store.getReflection).toHaveBeenCalledWith({ accountId: "acct-a", projectId: "proj-1" });
    expect(upserts[0]).toMatchObject({ accountId: "acct-a", projectId: "proj-1" });
    expect(upserts[0]?.resourceId).toBeUndefined();
    expect(upserts[0]?.threadId).toBeUndefined();
  });
});
