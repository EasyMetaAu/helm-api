import type {
  MemoryFactInput,
  Observation,
  Reflection,
  ReflectionScope,
  ReflectionUpsertInput,
} from "@helm/shared";
import { describe, expect, it, vi } from "vitest";
import type { MemoryJobStatus, MemoryStore } from "../store/ports.js";
import { factContentHash, normalizeSubjectKey } from "./forgetting/facts.js";
import {
  type ExtractedFact,
  type ReflectorDeps,
  type ReflectorJob,
  runReflectorJob,
} from "./reflector.js";

// docs/12 P6 — fact extraction in the Reflector (spec pass 2 "Promote mid → long").
// Gated on forgetting.enabled && a consolidate trigger (active-observation token
// sum ≥ consolidate.trigger_tokens): the Reflector ALSO extracts discrete facts
// (its new sibling output) and writes them via insertFactsReconciled. The
// existing reflection versioning path is unchanged (reflector.test.ts) — these
// are ADDITIVE assertions on a fact-capable fake store.

// A fake store that records insertFactsReconciled calls in addition to the
// reflection write. The fact methods are OPTIONAL on the port; a store WITHOUT
// them (the legacy fake in reflector.test.ts) must still drive the Reflector.
function makeFactStore(observations: Observation[], initial: Reflection | null = null) {
  let current: Reflection | null = initial;
  const upserts: ReflectionUpsertInput[] = [];
  const factCalls: Array<{
    accountId: string;
    scope: { projectId?: string; resourceId?: string; threadId?: string };
    facts: MemoryFactInput[];
    now: Date;
  }> = [];
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
    updateJobStatus: vi.fn(async () => {}),
    enqueueJob: vi.fn(async () => "job"),
    claimPendingJobs: vi.fn(async () => []),
    insertFactsReconciled: vi.fn(async (input) => {
      factCalls.push(input);
    }),
  };
  return { store, upserts, factCalls };
}

// One long observation (~ many tokens) so a single row can cross a trigger.
function bigObs(id: string, text: string): Observation {
  return {
    id,
    threadId: "thread-1",
    sourceMessageRange: ["m1", "m2"],
    observationText: text,
    observedAt: new Date("2026-05-01T00:00:00.000Z"),
    referenceCount: 0,
    importance: 0.5,
    status: "active",
    referencedAt: null,
    archivedAt: null,
    expiredAt: null,
  };
}

const NOW = new Date("2026-05-30T12:00:00.000Z");
const JOB: ReflectorJob = { jobId: "job-1", scope: { accountId: "acct-a", projectId: "proj-1" } };

function baseDeps(store: MemoryStore, overrides: Partial<ReflectorDeps> = {}): ReflectorDeps {
  return {
    memoryStore: store,
    merge: vi.fn(async ({ observations }) => {
      const text = observations.map((o: Observation) => o.observationText).join(" | ");
      return { reflectionText: text, tokenEstimate: 1 };
    }),
    costSink: vi.fn(),
    now: () => NOW,
    log: vi.fn(),
    ...overrides,
  };
}

// Deterministic extract stub (docs/08: the real LLM behind these interfaces is
// still deferred, so a deterministic default is correct). Stands in for an LLM.
function extractStub(facts: ExtractedFact[]) {
  return vi.fn(async () => facts);
}

describe("runReflectorJob — fact extraction (docs/12 P6, gated)", () => {
  it("extracts + writes facts when forgetting.enabled and the token sum crosses trigger_tokens", async () => {
    // ~100-char observation → ~25 tokens; trigger_tokens=10 → crosses.
    const obs = [bigObs("o1", "x".repeat(100))];
    const { store, factCalls } = makeFactStore(obs);
    const extractFacts = extractStub([
      { subjectText: "Favourite Language", factText: "User likes TypeScript" },
    ]);
    const deps = baseDeps(store, {
      forgetting: { enabled: true, consolidate: { trigger_tokens: 10, max_facts_per_subject: 8 } },
      extractFacts,
    });

    const out = await runReflectorJob(JOB, deps);

    expect(out.changed).toBe(true); // reflection still written as before
    expect(extractFacts).toHaveBeenCalledTimes(1);
    expect(factCalls).toHaveLength(1);
    const call = factCalls[0];
    if (!call) throw new Error("expected an insertFactsReconciled call");
    expect(call.accountId).toBe("acct-a");
    expect(call.scope).toEqual({ projectId: "proj-1" });
    expect(call.now).toEqual(NOW);
    expect(call.facts).toHaveLength(1);
    const f = call.facts[0];
    if (!f) throw new Error("expected a fact");
    // subject_key + content_hash derived DETERMINISTICALLY by the Reflector.
    expect(f.ownerId).toBe("acct-a");
    expect(f.projectId).toBe("proj-1");
    expect(f.subjectKey).toBe(normalizeSubjectKey("Favourite Language"));
    expect(f.contentHash).toBe(factContentHash("User likes TypeScript"));
    expect(f.factText).toBe("User likes TypeScript");
    expect(f.validFrom).toEqual(NOW);
  });

  it("does NOT extract when the token sum is BELOW trigger_tokens", async () => {
    const obs = [bigObs("o1", "short")]; // ~2 tokens
    const { store, factCalls } = makeFactStore(obs);
    const extractFacts = extractStub([
      { subjectText: "anything", factText: "should not be written" },
    ]);
    const deps = baseDeps(store, {
      forgetting: {
        enabled: true,
        consolidate: { trigger_tokens: 1000, max_facts_per_subject: 8 },
      },
      extractFacts,
    });

    const out = await runReflectorJob(JOB, deps);

    expect(out.changed).toBe(true); // reflection unaffected
    expect(extractFacts).not.toHaveBeenCalled();
    expect(factCalls).toHaveLength(0);
  });

  it("does NOT extract when forgetting.enabled is false (flag OFF → byte-identical)", async () => {
    const obs = [bigObs("o1", "x".repeat(1000))]; // plenty of tokens
    const { store, factCalls } = makeFactStore(obs);
    const extractFacts = extractStub([{ subjectText: "s", factText: "f" }]);
    const deps = baseDeps(store, {
      forgetting: { enabled: false, consolidate: { trigger_tokens: 1, max_facts_per_subject: 8 } },
      extractFacts,
    });

    await runReflectorJob(JOB, deps);

    expect(extractFacts).not.toHaveBeenCalled();
    expect(factCalls).toHaveLength(0);
  });

  it("does NOT extract when extractFacts dep is absent (additive, opt-in)", async () => {
    const obs = [bigObs("o1", "x".repeat(1000))];
    const { store, factCalls } = makeFactStore(obs);
    const deps = baseDeps(store, {
      forgetting: { enabled: true, consolidate: { trigger_tokens: 1, max_facts_per_subject: 8 } },
      // no extractFacts
    });

    const out = await runReflectorJob(JOB, deps);

    expect(out.changed).toBe(true);
    expect(factCalls).toHaveLength(0);
  });

  it("caps the written facts per subject_key at max_facts_per_subject", async () => {
    const obs = [bigObs("o1", "x".repeat(1000))];
    const { store, factCalls } = makeFactStore(obs);
    // 5 facts that all normalize to the SAME subject_key; cap = 2.
    const extractFacts = extractStub([
      { subjectText: "Topic", factText: "fact 1" },
      { subjectText: "Topic", factText: "fact 2" },
      { subjectText: "Topic", factText: "fact 3" },
      { subjectText: "Topic", factText: "fact 4" },
      { subjectText: "Topic", factText: "fact 5" },
    ]);
    const deps = baseDeps(store, {
      forgetting: { enabled: true, consolidate: { trigger_tokens: 1, max_facts_per_subject: 2 } },
      extractFacts,
    });

    await runReflectorJob(JOB, deps);

    const call = factCalls[0];
    if (!call) throw new Error("expected an insertFactsReconciled call");
    // Only the first 2 facts of the shared subject survive the cap.
    expect(call.facts).toHaveLength(2);
    expect(call.facts.map((f) => f.factText)).toEqual(["fact 1", "fact 2"]);
  });

  it("is fail-open: an extractFacts throw does NOT break the reflection write", async () => {
    const obs = [bigObs("o1", "x".repeat(1000))];
    const { store, upserts, factCalls } = makeFactStore(obs);
    const deps = baseDeps(store, {
      forgetting: { enabled: true, consolidate: { trigger_tokens: 1, max_facts_per_subject: 8 } },
      extractFacts: vi.fn(async () => {
        throw new Error("extractor down");
      }),
    });

    const out = await runReflectorJob(JOB, deps);

    // Reflection still committed (changed=true, one upsert) despite the fact failure.
    expect(out.changed).toBe(true);
    expect(upserts).toHaveLength(1);
    expect(factCalls).toHaveLength(0);
  });

  it("is fail-open: an insertFactsReconciled throw does NOT break the reflection write", async () => {
    const obs = [bigObs("o1", "x".repeat(1000))];
    const { store, upserts } = makeFactStore(obs);
    (store.insertFactsReconciled as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error("db down"),
    );
    const deps = baseDeps(store, {
      forgetting: { enabled: true, consolidate: { trigger_tokens: 1, max_facts_per_subject: 8 } },
      extractFacts: extractStub([{ subjectText: "s", factText: "f" }]),
    });

    const out = await runReflectorJob(JOB, deps);

    expect(out.changed).toBe(true);
    expect(upserts).toHaveLength(1);
  });
});
