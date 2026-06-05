import type { ForgettingConfig } from "@helm/shared";
import { describe, expect, it, vi } from "vitest";
import { pruneRetainedMemory, type RetentionDeps } from "./retention.js";

// docs/12 "Eviction, demotion, promotion" pass 4 (P7) — the retention HARD-DELETE,
// the ONLY DELETE in the forgetting system. This is an OFF-the-request-path, account-
// AGNOSTIC sweep run on the worker tick (a sibling of maybeEnqueueDecayJobs): it asks
// the store to drop (1) ARCHIVED observations older than retention.archived_days and
// (2) EXPIRED facts older than retention.facts_expired_days. It is GATED behind
// forgetting.enabled (default off ⇒ no delete ever runs, byte-identical behaviour) and
// FAIL-OPEN (a store error is logged, never thrown — CLAUDE.md principle 3). Decay
// never destroys; it hides — only retention age deletes, and only already-archived /
// already-expired rows. The pure cutoff math + gating live here; the SQL lives in the
// adapters (verified in the store contract test against real sqlite + postgres).

function makeConfig(overrides: Partial<ForgettingConfig> = {}): ForgettingConfig {
  return {
    enabled: true,
    score: { half_life_s: 1, importance_floor: 0, importance_ceil: 1, access_weight: 0 },
    inject: { drop_order: "score" },
    decay: { archive_threshold: 0.05, trigger_observations: 50, trigger_interval_s: 3600 },
    consolidate: { trigger_tokens: 1024, max_facts_per_subject: 8, enable_llm_supersede: false },
    retention: { archived_days: 30, facts_expired_days: 90 },
    sweep: { max_iterations: 200, max_wallclock_s: 900, max_consecutive_errors: 5 },
    ...overrides,
  } as ForgettingConfig;
}

// A fake store recording the cutoffs handed to pruneExpiredMemory, returning a fixed
// count. The method is OPTIONAL on the port, so the fake can also omit it.
function makeStore(opts: { omitMethod?: boolean; throws?: boolean } = {}) {
  const calls: Array<{ archivedObservationsBeforeMs: number; expiredFactsBeforeMs: number }> = [];
  const pruneExpiredMemory = vi.fn(
    async (input: { archivedObservationsBeforeMs: number; expiredFactsBeforeMs: number }) => {
      if (opts.throws) throw new Error("db down");
      calls.push(input);
      return { observationsDeleted: 2, factsDeleted: 1 };
    },
  );
  const store = opts.omitMethod ? {} : { pruneExpiredMemory };
  return { store, calls, pruneExpiredMemory };
}

const NOW = new Date("2026-06-05T00:00:00.000Z");
const DAY_MS = 86_400_000;

function makeDeps(
  store: ReturnType<typeof makeStore>["store"],
  config = makeConfig(),
  overrides: Partial<RetentionDeps> = {},
): RetentionDeps {
  return {
    // biome-ignore lint/suspicious/noExplicitAny: the fake implements only the subset the pruner calls.
    memoryStore: store as any,
    config,
    now: () => NOW,
    log: vi.fn(),
    ...overrides,
  };
}

describe("pruneRetainedMemory", () => {
  it("deletes archived observations + expired facts older than their retention cutoffs", async () => {
    const { store, calls } = makeStore();
    await pruneRetainedMemory(makeDeps(store));

    // archived_days 30 → cutoff = now − 30d; facts_expired_days 90 → now − 90d.
    expect(calls).toEqual([
      {
        archivedObservationsBeforeMs: NOW.getTime() - 30 * DAY_MS,
        expiredFactsBeforeMs: NOW.getTime() - 90 * DAY_MS,
      },
    ]);
  });

  it("honours non-default retention windows from config", async () => {
    const { store, calls } = makeStore();
    const cfg = makeConfig({
      retention: { archived_days: 7, facts_expired_days: 14 },
    });
    await pruneRetainedMemory(makeDeps(store, cfg));

    expect(calls).toEqual([
      {
        archivedObservationsBeforeMs: NOW.getTime() - 7 * DAY_MS,
        expiredFactsBeforeMs: NOW.getTime() - 14 * DAY_MS,
      },
    ]);
  });

  it("does NOTHING when forgetting is disabled (flag OFF ⇒ no delete ever runs)", async () => {
    const { store, pruneExpiredMemory } = makeStore();
    const cfg = makeConfig({ enabled: false });
    await pruneRetainedMemory(makeDeps(store, cfg));

    expect(pruneExpiredMemory).not.toHaveBeenCalled();
  });

  it("no-ops on a store that predates this phase (method absent) without throwing", async () => {
    const { store } = makeStore({ omitMethod: true });
    await expect(pruneRetainedMemory(makeDeps(store))).resolves.toBeUndefined();
  });

  it("never throws when the store delete fails — the error is logged (fail-open)", async () => {
    const { store } = makeStore({ throws: true });
    const log = vi.fn();
    await expect(
      pruneRetainedMemory(makeDeps(store, makeConfig(), { log })),
    ).resolves.toBeUndefined();
    expect(log).toHaveBeenCalledWith(
      "memory.retention.prune_failed",
      expect.objectContaining({ error: "db down" }),
    );
  });
});
