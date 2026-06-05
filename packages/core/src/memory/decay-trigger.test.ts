import type { ForgettingConfig } from "@helm/shared";
import { describe, expect, it, vi } from "vitest";
import type { MemoryStore } from "../store/ports.js";
import { type DecayTriggerDeps, maybeEnqueueDecayJobs } from "./decay-trigger.js";

// docs/12 P5 trigger — the buffer-flush gate that ENQUEUES decay jobs OFF the request
// path (the worker tick). Deterministic: enqueue one decay job per due account, only
// when forgetting.enabled, and lean on the open-job dedupe so duplicates collapse.

function makeConfig(
  overrides: Partial<ForgettingConfig["decay"]> = {},
  enabled = true,
): ForgettingConfig {
  return {
    enabled,
    score: { half_life_s: 86400, importance_floor: 0.1, importance_ceil: 1, access_weight: 0.15 },
    inject: { drop_order: "score" },
    decay: {
      archive_threshold: 0.05,
      trigger_observations: 50,
      trigger_interval_s: 3600,
      ...overrides,
    },
    consolidate: { trigger_tokens: 1024, max_facts_per_subject: 8, enable_llm_supersede: false },
    retention: { archived_days: 30, facts_expired_days: 90 },
    sweep: { max_iterations: 200, max_wallclock_s: 900, max_consecutive_errors: 5 },
  } as ForgettingConfig;
}

function makeStore(candidates: string[]) {
  const enqueued: Array<{ type: string; scope: unknown }> = [];
  const store = {
    listDecayCandidateAccounts: vi.fn(async () => candidates),
    enqueueJob: vi.fn(async (input: { type: string; scope: unknown }) => {
      enqueued.push(input);
      return `enq-${enqueued.length}`;
    }),
  };
  return { store, enqueued };
}

function makeDeps(
  store: ReturnType<typeof makeStore>["store"],
  config: ForgettingConfig,
): DecayTriggerDeps {
  return {
    // biome-ignore lint/suspicious/noExplicitAny: fake implements only the called subset.
    memoryStore: store as any,
    config,
    now: () => new Date("2026-06-05T00:00:00.000Z"),
    log: vi.fn(),
  };
}

describe("maybeEnqueueDecayJobs", () => {
  it("enqueues one account-scoped decay job per due account when enabled", async () => {
    const { store, enqueued } = makeStore(["acct-a", "acct-b"]);
    await maybeEnqueueDecayJobs(makeDeps(store, makeConfig()));

    expect(store.listDecayCandidateAccounts).toHaveBeenCalledWith({
      triggerObservations: 50,
      triggerIntervalS: 3600,
      nowMs: new Date("2026-06-05T00:00:00.000Z").getTime(),
    });
    expect(enqueued).toEqual([
      { type: "decay", scope: { accountId: "acct-a" } },
      { type: "decay", scope: { accountId: "acct-b" } },
    ]);
  });

  it("does NOTHING when forgetting is disabled (flag-off ⇒ no decay jobs ever)", async () => {
    const { store, enqueued } = makeStore(["acct-a"]);
    await maybeEnqueueDecayJobs(makeDeps(store, makeConfig({}, false)));

    expect(store.listDecayCandidateAccounts).not.toHaveBeenCalled();
    expect(enqueued).toEqual([]);
  });

  it("is a no-op when no account is due", async () => {
    const { store, enqueued } = makeStore([]);
    await maybeEnqueueDecayJobs(makeDeps(store, makeConfig()));
    expect(enqueued).toEqual([]);
  });

  it("relies on enqueueJob dedupe — a re-enqueue of an open scope is harmless", async () => {
    // The open-job index collapses duplicates; the trigger does not pre-check. Two
    // ticks with the same due account just call enqueueJob twice (it returns the same
    // open row id) — no second pending row is created by the store.
    const { store } = makeStore(["acct-a"]);
    const deps = makeDeps(store, makeConfig());
    await maybeEnqueueDecayJobs(deps);
    await maybeEnqueueDecayJobs(deps);
    expect(store.enqueueJob).toHaveBeenCalledTimes(2);
    expect(store.enqueueJob).toHaveBeenLastCalledWith({
      type: "decay",
      scope: { accountId: "acct-a" },
    });
  });

  it("never throws when the store read fails (fail-open)", async () => {
    const { store } = makeStore([]);
    store.listDecayCandidateAccounts.mockRejectedValueOnce(new Error("db down"));
    await expect(maybeEnqueueDecayJobs(makeDeps(store, makeConfig()))).resolves.toBeUndefined();
  });

  it("a single enqueue failure does not abort the rest (per-account guard)", async () => {
    const { store, enqueued } = makeStore(["acct-a", "acct-b"]);
    (store.enqueueJob as ReturnType<typeof vi.fn>).mockImplementationOnce(async () => {
      throw new Error("queue down");
    });
    await maybeEnqueueDecayJobs(makeDeps(store, makeConfig()));
    // acct-a threw; acct-b still enqueued.
    expect(enqueued).toEqual([{ type: "decay", scope: { accountId: "acct-b" } }]);
  });

  it("fails closed-ish to no-op when the store lacks the candidate method (unsupported)", async () => {
    const store = {
      enqueueJob: vi.fn(async () => "x"),
    } as unknown as MemoryStore;
    const deps: DecayTriggerDeps = {
      memoryStore: store,
      config: makeConfig(),
      now: () => new Date(),
      log: vi.fn(),
    };
    await expect(maybeEnqueueDecayJobs(deps)).resolves.toBeUndefined();
    expect(store.enqueueJob).not.toHaveBeenCalled();
  });
});
