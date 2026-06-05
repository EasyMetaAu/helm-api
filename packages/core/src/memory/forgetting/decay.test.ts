import type { ForgettingConfig } from "@helm/shared";
import { describe, expect, it, vi } from "vitest";
import type { MemoryJobStatus } from "../../store/ports.js";
import { type DecayDeps, runDecayJob, type ScorableObservation } from "./decay.js";

// docs/12 P5 — the OFF-hot-path decay SWEEP (memory_jobs.type='decay'), pass 1:
// soft-archive sub-threshold ACTIVE observations for ONE account. The job is
// deps-injected (store / clock / log / config), NEVER throws to a caller (fail-open,
// CLAUDE.md principle 3), and updates memory_jobs.status on BOTH success and failure.
// Bounded by sweep config (iterations / wallclock / consecutive errors) using ONLY
// the injected clock — no real time is read here.

// A forgetting config whose curve makes scoring trivially predictable: half_life 1s,
// no importance floor brake, no access bonus, so score(now) ≈ recency(age). archive
// anything scoring below 0.05. Sweep bounds are widened per-test where it matters.
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

// A fake store recording archive calls + job-status writes; listScorableObservations
// returns a caller-supplied fixture once (then [] so a re-run is idempotent).
function makeStore(rows: ScorableObservation[], reflectionScopes: unknown[] = []) {
  const archived: string[] = [];
  const jobUpdates: Array<{ jobId: string; status: MemoryJobStatus }> = [];
  const enqueued: Array<{ type: string; scope: unknown }> = [];
  let served = false;
  const store = {
    listScorableObservations: vi.fn(async (_scope: { accountId: string; limit?: number }) => {
      if (served) return [];
      served = true;
      return rows;
    }),
    archiveObservations: vi.fn(async (input: { accountId: string; ids: string[]; now: Date }) => {
      archived.push(...input.ids);
    }),
    // docs/12 (Codex review fix) — decay enqueues a reflector rebuild per active
    // reflection scope after it archives observations.
    listActiveReflectionScopes: vi.fn(async (_accountId: string) => reflectionScopes),
    enqueueJob: vi.fn(async (input: { type: string; scope: unknown }) => {
      enqueued.push(input);
      return "job";
    }),
    updateJobStatus: vi.fn(async (jobId: string, status: MemoryJobStatus) => {
      jobUpdates.push({ jobId, status });
    }),
  };
  return { store, archived, jobUpdates, enqueued };
}

function makeDeps(
  store: ReturnType<typeof makeStore>["store"],
  now: Date,
  config = makeConfig(),
  overrides: Partial<DecayDeps> = {},
): DecayDeps {
  return {
    // biome-ignore lint/suspicious/noExplicitAny: the fake implements only the subset the sweep calls.
    memoryStore: store as any,
    config,
    now: () => now,
    log: vi.fn(),
    ...overrides,
  };
}

const NOW = new Date("2026-06-05T00:00:00.000Z");

// A row referenced/observed `ageSeconds` before NOW.
function row(
  id: string,
  ageSeconds: number,
  extra: Partial<ScorableObservation> = {},
): ScorableObservation {
  const ts = new Date(NOW.getTime() - ageSeconds * 1000);
  return {
    id,
    referencedAt: null,
    observedAt: ts,
    referenceCount: 0,
    importance: 0.5,
    ...extra,
  };
}

describe("runDecayJob", () => {
  // docs/12 (Codex review fix) — the queue is PERSISTENT: a decay row enqueued during
  // an earlier ENABLED window can survive a restart with the master switch off. The
  // job must re-check `config.enabled` at entry and no-op (marked done, NOTHING
  // archived) — enabled:false means zero archives, including by leftover jobs.
  it("no-ops a leftover queued job when forgetting.enabled is false (re-checks the master switch)", async () => {
    const { store, archived, jobUpdates } = makeStore([row("stale", 100)]); // would archive if enabled
    const deps = makeDeps(store, NOW, makeConfig({ enabled: false }));

    await runDecayJob({ jobId: "d-off", scope: { accountId: "acct-a" } }, deps);

    expect(archived).toEqual([]); // nothing swept
    expect(store.listScorableObservations).not.toHaveBeenCalled(); // short-circuits before any read
    expect(jobUpdates).toContainEqual({ jobId: "d-off", status: "done" }); // done, never left pending
  });

  it("archives ONLY sub-threshold active observations (fresh rows survive)", async () => {
    // half_life 1s, threshold 0.05 → recency<0.05 at age>~4.32s. age 100s → archive;
    // age 0s → score≈0.5 → keep.
    const { store, archived, jobUpdates } = makeStore([row("stale", 100), row("fresh", 0)]);
    const deps = makeDeps(store, NOW);

    await runDecayJob({ jobId: "d1", scope: { accountId: "acct-a" } }, deps);

    expect(archived).toEqual(["stale"]);
    expect(archived).not.toContain("fresh");
    expect(jobUpdates).toContainEqual({ jobId: "d1", status: "done" });
  });

  it("scopes the read + archive to the swept account (two-account isolation)", async () => {
    const { store } = makeStore([row("a-stale", 100)]);
    const deps = makeDeps(store, NOW);

    await runDecayJob({ jobId: "d1", scope: { accountId: "acct-a" } }, deps);

    // The read is account-scoped AND bounded (Codex review fix): limit =
    // max_iterations × chunk so the scan can never exceed what the loop can archive.
    expect(store.listScorableObservations).toHaveBeenCalledWith(
      expect.objectContaining({ accountId: "acct-a", limit: 200 * 50 }),
    );
    expect(store.archiveObservations).toHaveBeenCalledWith(
      expect.objectContaining({ accountId: "acct-a", ids: ["a-stale"] }),
    );
  });

  // docs/12 (Codex review fix) — after archiving observations, decay enqueues a
  // reflector REBUILD per active-reflection scope so the stale reflections drop the
  // forgotten content (a reflection is a derived cache of active observations).
  it("enqueues a reflector rebuild per active reflection scope when it archived rows", async () => {
    const scopes = [
      { accountId: "acct-a", projectId: "p1" },
      { accountId: "acct-a", resourceId: "r1" },
    ];
    const { store, enqueued } = makeStore([row("a-stale", 100)], scopes);
    const deps = makeDeps(store, NOW);

    await runDecayJob({ jobId: "d1", scope: { accountId: "acct-a" } }, deps);

    expect(store.listActiveReflectionScopes).toHaveBeenCalledWith("acct-a");
    expect(enqueued).toEqual([
      { type: "reflector", scope: { accountId: "acct-a", projectId: "p1" } },
      { type: "reflector", scope: { accountId: "acct-a", resourceId: "r1" } },
    ]);
  });

  it("does NOT enqueue rebuilds when the sweep archived nothing", async () => {
    // age 0 → score ≈ 0.5 → above threshold → nothing archived.
    const { store, enqueued } = makeStore(
      [row("fresh", 0)],
      [{ accountId: "acct-a", projectId: "p1" }],
    );
    const deps = makeDeps(store, NOW);

    await runDecayJob({ jobId: "d1", scope: { accountId: "acct-a" } }, deps);

    expect(store.listActiveReflectionScopes).not.toHaveBeenCalled();
    expect(enqueued).toEqual([]);
  });

  it("a reinforced (high reference_count) old row survives via the score", async () => {
    // access_weight 0.3 + log1p(50) ≈ 1.18 access bonus alone clears 0.05 even at age 100s.
    const cfg = makeConfig({
      score: { half_life_s: 1, importance_floor: 0, importance_ceil: 1, access_weight: 0.3 },
    });
    const { store, archived } = makeStore([row("used", 100, { referenceCount: 50 })]);
    const deps = makeDeps(store, NOW, cfg);

    await runDecayJob({ jobId: "d1", scope: { accountId: "acct-a" } }, deps);

    expect(archived).toEqual([]);
  });

  it("is idempotent: a second run over no remaining active rows archives nothing new", async () => {
    const { store, archived } = makeStore([row("stale", 100)]);
    const deps = makeDeps(store, NOW);

    await runDecayJob({ jobId: "d1", scope: { accountId: "acct-a" } }, deps);
    expect(archived).toEqual(["stale"]);

    // Second run: the fake now returns [] (the row is archived → no longer active).
    await runDecayJob({ jobId: "d2", scope: { accountId: "acct-a" } }, deps);
    expect(archived).toEqual(["stale"]); // unchanged — nothing new archived
  });

  it("does nothing (and marks done) when there are no sub-threshold rows", async () => {
    const { store, archived, jobUpdates } = makeStore([row("fresh", 0)]);
    const deps = makeDeps(store, NOW);

    await runDecayJob({ jobId: "d1", scope: { accountId: "acct-a" } }, deps);

    expect(archived).toEqual([]);
    expect(store.archiveObservations).not.toHaveBeenCalled();
    expect(jobUpdates).toContainEqual({ jobId: "d1", status: "done" });
  });

  it("never throws and marks the job failed when the store read throws (fail-open)", async () => {
    const { store, jobUpdates } = makeStore([]);
    store.listScorableObservations.mockRejectedValueOnce(new Error("db down"));
    const deps = makeDeps(store, NOW);

    await expect(
      runDecayJob({ jobId: "d1", scope: { accountId: "acct-a" } }, deps),
    ).resolves.toBeUndefined();
    expect(jobUpdates).toContainEqual({ jobId: "d1", status: "failed" });
  });

  it("stops after max_consecutive_errors archive failures (does not loop forever)", async () => {
    // 30 stale rows, batches archived one chunk per iteration; each chunk throws.
    const rows = Array.from({ length: 30 }, (_, i) => row(`s${i}`, 100));
    const { store } = makeStore(rows);
    store.archiveObservations.mockRejectedValue(new Error("write fail"));
    const cfg = makeConfig({
      sweep: { max_iterations: 200, max_wallclock_s: 900, max_consecutive_errors: 3 },
    });
    const deps = makeDeps(store, NOW, cfg);

    await runDecayJob({ jobId: "d1", scope: { accountId: "acct-a" } }, deps);

    // Backed off after 3 consecutive failures — never attempted all 30 chunks.
    expect(store.archiveObservations.mock.calls.length).toBeLessThanOrEqual(3);
  });

  it("respects max_iterations (bounded archive chunks)", async () => {
    const rows = Array.from({ length: 100 }, (_, i) => row(`s${i}`, 100));
    const { store } = makeStore(rows);
    const cfg = makeConfig({
      sweep: { max_iterations: 2, max_wallclock_s: 900, max_consecutive_errors: 5 },
    });
    const deps = makeDeps(store, NOW, cfg);

    await runDecayJob({ jobId: "d1", scope: { accountId: "acct-a" } }, deps);

    expect(store.archiveObservations.mock.calls.length).toBeLessThanOrEqual(2);
  });

  it("respects max_wallclock_s using ONLY the injected clock", async () => {
    const rows = Array.from({ length: 100 }, (_, i) => row(`s${i}`, 100));
    const { store } = makeStore(rows);
    // Clock jumps 10s per read → the 1s wallclock budget is blown after the first read.
    let t = NOW.getTime();
    const cfg = makeConfig({
      sweep: { max_iterations: 200, max_wallclock_s: 1, max_consecutive_errors: 5 },
    });
    const deps = makeDeps(store, NOW, cfg, {
      now: () => {
        const at = new Date(t);
        t += 10_000;
        return at;
      },
    });

    await runDecayJob({ jobId: "d1", scope: { accountId: "acct-a" } }, deps);

    // Bailed early on the wallclock budget — not all 100 rows' worth of chunks ran.
    expect(store.archiveObservations.mock.calls.length).toBeLessThan(100);
  });
});
