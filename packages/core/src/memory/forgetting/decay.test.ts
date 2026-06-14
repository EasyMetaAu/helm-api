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

  it("a RECENTLY-reinforced row survives; a once-used STALE row is archived (no permanent immunity)", async () => {
    // docs/12 (Codex review fix) — the access bonus decays WITH recency. Reinforcement
    // works by resetting referenced_at (recency back to ~1 → full bonus), so:
    //  - "recent": touched at NOW → age 0 → score = importance + bonus → survives;
    //  - "stale": used once but last touched 100 half-lives ago → recency ~0 → the
    //    bonus decays with it → archived. Under the old ADDITIVE bonus this row scored
    //    0.3×log1p(1) ≈ 0.21 > 0.05 forever — the un-forgettable bug.
    const cfg = makeConfig({
      score: { half_life_s: 1, importance_floor: 0, importance_ceil: 1, access_weight: 0.3 },
    });
    const { store, archived } = makeStore([
      row("recent", 100, { referenceCount: 50, referencedAt: NOW }),
      row("stale", 100, { referenceCount: 1 }), // referencedAt null → ages from observedAt
    ]);
    const deps = makeDeps(store, NOW, cfg);

    await runDecayJob({ jobId: "d1", scope: { accountId: "acct-a" } }, deps);

    expect(archived).toEqual(["stale"]);
    expect(archived).not.toContain("recent");
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

  // The adapter methods are optional (gated/additive). A store that predates this
  // phase cannot sweep — fail the job cleanly (not crash, not silent noop) so the
  // operator sees WHY and the row never lingers pending. (decay.ts 91-101)
  it("fails the job with a reason when the store lacks sweep methods (predates this phase)", async () => {
    // A store that implements ONLY updateJobStatus — listScorableObservations /
    // archiveObservations are absent (older adapter).
    const jobUpdates: Array<{ jobId: string; status: MemoryJobStatus; error?: string }> = [];
    const legacyStore = {
      updateJobStatus: vi.fn(async (jobId: string, status: MemoryJobStatus, error?: string) => {
        jobUpdates.push({ jobId, status, error });
      }),
    };
    const deps = makeDeps(
      // biome-ignore lint/suspicious/noExplicitAny: deliberately models a store missing the optional sweep methods.
      legacyStore as any,
      NOW,
    );

    await expect(
      runDecayJob({ jobId: "d-legacy", scope: { accountId: "acct-a" } }, deps),
    ).resolves.toBeUndefined();

    expect(jobUpdates).toEqual([
      { jobId: "d-legacy", status: "failed", error: "decay: store lacks sweep methods" },
    ]);
    // The unsupported-store branch is logged so the operator can see it.
    expect(deps.log).toHaveBeenCalledWith(
      "memory.decay.unsupported_store",
      expect.objectContaining({ account_id: "acct-a" }),
    );
  });

  // A store with listScorableObservations but NO archiveObservations also can't sweep —
  // the guard is `list === undefined || archive === undefined` (decay.ts 93), so a
  // half-implemented adapter must fail the same way (covers the second OR arm).
  it("fails the job when the store can list but not archive (half-implemented adapter)", async () => {
    const jobUpdates: Array<{ jobId: string; status: MemoryJobStatus; error?: string }> = [];
    const halfStore = {
      listScorableObservations: vi.fn(async () => [row("stale", 100)]),
      // archiveObservations intentionally absent
      updateJobStatus: vi.fn(async (jobId: string, status: MemoryJobStatus, error?: string) => {
        jobUpdates.push({ jobId, status, error });
      }),
    };
    const deps = makeDeps(
      // biome-ignore lint/suspicious/noExplicitAny: archiveObservations deliberately missing.
      halfStore as any,
      NOW,
    );

    await runDecayJob({ jobId: "d-half", scope: { accountId: "acct-a" } }, deps);

    expect(jobUpdates).toEqual([
      { jobId: "d-half", status: "failed", error: "decay: store lacks sweep methods" },
    ]);
    // It must NOT have read the rows — the guard short-circuits before any scan.
    expect(halfStore.listScorableObservations).not.toHaveBeenCalled();
  });

  // The archive loop is hard-capped by max_iterations: at most N chunks per sweep, then
  // it BREAKS and logs `iteration_cap` (decay.ts 170-173). The existing "respects
  // max_iterations" test uses 100 rows (exactly 2 chunks) so the loop ends naturally at
  // offset=100 BEFORE the iterations>=max guard fires. Here 120 condemned rows = 3 chunks
  // with max_iterations 2, so iteration #3 trips the cap and exercises the break + log.
  it("breaks on max_iterations with leftover chunks and logs iteration_cap", async () => {
    const rows = Array.from({ length: 120 }, (_, i) => row(`s${i}`, 100));
    const { store, archived } = makeStore(rows);
    const cfg = makeConfig({
      sweep: { max_iterations: 2, max_wallclock_s: 900, max_consecutive_errors: 5 },
    });
    const deps = makeDeps(store, NOW, cfg);

    await runDecayJob({ jobId: "d-itercap", scope: { accountId: "acct-a" } }, deps);

    // Only 2 chunks of 50 ran (offsets 0 + 50) → 100 rows archived; the 3rd chunk
    // (offset 100) hit the iteration cap and was left for the next sweep.
    expect(store.archiveObservations.mock.calls.length).toBe(2);
    expect(archived.length).toBe(100);
    expect(deps.log).toHaveBeenCalledWith(
      "memory.decay.iteration_cap",
      expect.objectContaining({ account_id: "acct-a", iterations: 2 }),
    );
  });

  // The consecutive-error back-off must also LOG `error_cap` when it trips (decay.ts
  // 191-194). The existing back-off test has 30 rows = a SINGLE chunk, so consecutiveErrors
  // only ever reaches 1 (never >= max). Here 150 rows = 3 chunks all failing with
  // max_consecutive_errors 3, so the 3rd failure trips the cap branch + log.
  it("logs error_cap and stops after max_consecutive_errors failing chunks", async () => {
    const rows = Array.from({ length: 150 }, (_, i) => row(`s${i}`, 100));
    const { store } = makeStore(rows);
    store.archiveObservations.mockRejectedValue(new Error("write fail"));
    const cfg = makeConfig({
      sweep: { max_iterations: 200, max_wallclock_s: 900, max_consecutive_errors: 3 },
    });
    const deps = makeDeps(store, NOW, cfg);

    await runDecayJob({ jobId: "d-errcap", scope: { accountId: "acct-a" } }, deps);

    // Exactly 3 chunk attempts (all failed) then the error cap broke the loop.
    expect(store.archiveObservations.mock.calls.length).toBe(3);
    expect(deps.log).toHaveBeenCalledWith(
      "memory.decay.error_cap",
      expect.objectContaining({ account_id: "acct-a" }),
    );
    // The chunk failures are themselves logged with the running counter.
    expect(deps.log).toHaveBeenCalledWith(
      "memory.decay.chunk_failed",
      expect.objectContaining({ account_id: "acct-a", consecutive_errors: 3 }),
    );
    // The sweep itself still completes (fail-open) — the job is marked done, NOT failed:
    // archiving is best-effort and the leftover rows are re-swept on the next trigger.
    expect(store.updateJobStatus).toHaveBeenCalledWith("d-errcap", "done");
  });

  // Reflection-rebuild enqueue is FULLY fail-open: a single enqueueJob failure is logged
  // (`rebuild_enqueue_failed`) and the loop continues to the next scope; it never fails
  // the sweep (decay.ts 216-222). One scope throws, the other succeeds.
  it("logs and continues when a single reflector-rebuild enqueue fails (per-scope fail-open)", async () => {
    const scopes = [
      { accountId: "acct-a", projectId: "p1" },
      { accountId: "acct-a", resourceId: "r1" },
    ];
    const { store, enqueued, jobUpdates } = makeStore([row("a-stale", 100)], scopes);
    // First enqueue throws, second succeeds.
    store.enqueueJob
      .mockRejectedValueOnce(new Error("queue full"))
      .mockImplementationOnce(async (input: { type: string; scope: unknown }) => {
        enqueued.push(input);
        return "job";
      });
    const deps = makeDeps(store, NOW);

    await runDecayJob({ jobId: "d-enqfail", scope: { accountId: "acct-a" } }, deps);

    // The failing scope is logged; the surviving scope was still enqueued.
    expect(deps.log).toHaveBeenCalledWith(
      "memory.decay.rebuild_enqueue_failed",
      expect.objectContaining({ account_id: "acct-a", scope: scopes[0] }),
    );
    expect(enqueued).toEqual([
      { type: "reflector", scope: { accountId: "acct-a", resourceId: "r1" } },
    ]);
    // enqueued > 0 → the success line fires with the count that actually went through.
    expect(deps.log).toHaveBeenCalledWith(
      "memory.decay.rebuild_enqueued",
      expect.objectContaining({ account_id: "acct-a", scope_count: 1 }),
    );
    // The sweep itself succeeds regardless — the job is done.
    expect(jobUpdates).toContainEqual({ jobId: "d-enqfail", status: "done" });
  });

  // When EVERY rebuild enqueue fails, `enqueued` stays 0 → the success line is skipped
  // (decay.ts 224 false branch) while each failure is still logged. Defence in depth for
  // the enqueued>0 guard.
  it("skips the rebuild_enqueued success line when every enqueue fails", async () => {
    const scopes = [{ accountId: "acct-a", projectId: "p1" }];
    const { store, enqueued, jobUpdates } = makeStore([row("a-stale", 100)], scopes);
    store.enqueueJob.mockRejectedValue(new Error("queue full"));
    const deps = makeDeps(store, NOW);

    await runDecayJob({ jobId: "d-allenqfail", scope: { accountId: "acct-a" } }, deps);

    expect(enqueued).toEqual([]);
    expect(deps.log).not.toHaveBeenCalledWith("memory.decay.rebuild_enqueued", expect.anything());
    // Sweep still done — enqueue failures never fail the sweep.
    expect(jobUpdates).toContainEqual({ jobId: "d-allenqfail", status: "done" });
  });

  // If LISTING the active reflection scopes itself throws, the whole rebuild block is
  // wrapped — it logs `rebuild_list_failed` and the sweep still completes (decay.ts
  // 232-237). The archived rows are already committed; only the (best-effort) rebuild
  // enqueue is skipped.
  it("logs rebuild_list_failed and still finishes when listing reflection scopes throws", async () => {
    const { store, archived, jobUpdates } = makeStore(
      [row("a-stale", 100)],
      [{ accountId: "acct-a", projectId: "p1" }],
    );
    store.listActiveReflectionScopes.mockRejectedValueOnce(new Error("scope list down"));
    const deps = makeDeps(store, NOW);

    await runDecayJob({ jobId: "d-listfail", scope: { accountId: "acct-a" } }, deps);

    // The observation WAS archived — the failure is only in the downstream rebuild hop.
    expect(archived).toEqual(["a-stale"]);
    expect(store.enqueueJob).not.toHaveBeenCalled();
    expect(deps.log).toHaveBeenCalledWith(
      "memory.decay.rebuild_list_failed",
      expect.objectContaining({ account_id: "acct-a" }),
    );
    // Sweep still marked done despite the rebuild-list failure (fail-open).
    expect(jobUpdates).toContainEqual({ jobId: "d-listfail", status: "done" });
  });

  // Belt-and-braces: the outer catch records the failure on the job, but even that
  // bookkeeping write is best-effort — if updateJobStatus ALSO throws, the job_update_failed
  // line is logged and runDecayJob STILL never throws (decay.ts 253-259).
  it("never throws even when recording the job failure ALSO throws (double-fault path)", async () => {
    const { store } = makeStore([]);
    // The primary read throws → enters the outer catch.
    store.listScorableObservations.mockRejectedValueOnce(new Error("db down"));
    // The failure-bookkeeping write ALSO throws → exercises the inner catch.
    store.updateJobStatus.mockRejectedValueOnce(new Error("status write down"));
    const deps = makeDeps(store, NOW);

    await expect(
      runDecayJob({ jobId: "d-doublefault", scope: { accountId: "acct-a" } }, deps),
    ).resolves.toBeUndefined();

    // Both the bookkeeping-failure line AND the original sweep-failure line are logged.
    expect(deps.log).toHaveBeenCalledWith(
      "memory.decay.job_update_failed",
      expect.objectContaining({ account_id: "acct-a" }),
    );
    expect(deps.log).toHaveBeenCalledWith(
      "memory.decay.failed",
      expect.objectContaining({ account_id: "acct-a", error: "db down" }),
    );
  });

  // Every error log normalizes the caught value via `e instanceof Error ? e.message :
  // String(e)`. The tests above throw Error objects (the `.message` arm); these two
  // throw NON-Error values to exercise the `String(...)` arms (decay.ts 235 + 250).
  it("stringifies a non-Error thrown by the outer path (String() fallback arm)", async () => {
    const { store, jobUpdates } = makeStore([]);
    // Reject with a bare string, not an Error → forces the String(err) branch.
    store.listScorableObservations.mockRejectedValueOnce("boom-string");
    const deps = makeDeps(store, NOW);

    await runDecayJob({ jobId: "d-strthrow", scope: { accountId: "acct-a" } }, deps);

    expect(jobUpdates).toContainEqual({ jobId: "d-strthrow", status: "failed" });
    expect(deps.log).toHaveBeenCalledWith(
      "memory.decay.failed",
      expect.objectContaining({ account_id: "acct-a", error: "boom-string" }),
    );
  });

  it("stringifies a non-Error thrown while listing reflection scopes (String() fallback arm)", async () => {
    const { store, jobUpdates } = makeStore(
      [row("a-stale", 100)],
      [{ accountId: "acct-a", projectId: "p1" }],
    );
    store.listActiveReflectionScopes.mockRejectedValueOnce("scope-boom");
    const deps = makeDeps(store, NOW);

    await runDecayJob({ jobId: "d-listsstr", scope: { accountId: "acct-a" } }, deps);

    expect(deps.log).toHaveBeenCalledWith(
      "memory.decay.rebuild_list_failed",
      expect.objectContaining({ account_id: "acct-a", error: "scope-boom" }),
    );
    // Still done (fail-open) despite the non-Error rebuild-list failure.
    expect(jobUpdates).toContainEqual({ jobId: "d-listsstr", status: "done" });
  });

  // The remaining String()-arm branches: an archive chunk that rejects with a non-Error
  // (decay.ts 188) and an enqueue that rejects with a non-Error (decay.ts 220).
  it("stringifies a non-Error thrown by an archive chunk (chunk_failed String() arm)", async () => {
    const { store } = makeStore([row("stale", 100)]);
    store.archiveObservations.mockRejectedValueOnce("chunk-boom");
    const cfg = makeConfig({
      sweep: { max_iterations: 200, max_wallclock_s: 900, max_consecutive_errors: 5 },
    });
    const deps = makeDeps(store, NOW, cfg);

    await runDecayJob({ jobId: "d-chunkstr", scope: { accountId: "acct-a" } }, deps);

    expect(deps.log).toHaveBeenCalledWith(
      "memory.decay.chunk_failed",
      expect.objectContaining({ account_id: "acct-a", error: "chunk-boom" }),
    );
  });

  it("stringifies a non-Error thrown by a rebuild enqueue (rebuild_enqueue_failed String() arm)", async () => {
    const { store } = makeStore([row("a-stale", 100)], [{ accountId: "acct-a", projectId: "p1" }]);
    store.enqueueJob.mockRejectedValueOnce("enqueue-boom");
    const deps = makeDeps(store, NOW);

    await runDecayJob({ jobId: "d-enqstr", scope: { accountId: "acct-a" } }, deps);

    expect(deps.log).toHaveBeenCalledWith(
      "memory.decay.rebuild_enqueue_failed",
      expect.objectContaining({ account_id: "acct-a", error: "enqueue-boom" }),
    );
  });

  // The double-fault inner catch (decay.ts 255-258) when the bookkeeping write throws a
  // NON-Error → exercises its String() arm.
  it("stringifies a non-Error from the failure-bookkeeping write (job_update_failed String() arm)", async () => {
    const { store } = makeStore([]);
    store.listScorableObservations.mockRejectedValueOnce(new Error("db down"));
    store.updateJobStatus.mockRejectedValueOnce("status-boom");
    const deps = makeDeps(store, NOW);

    await expect(
      runDecayJob({ jobId: "d-updstr", scope: { accountId: "acct-a" } }, deps),
    ).resolves.toBeUndefined();

    expect(deps.log).toHaveBeenCalledWith(
      "memory.decay.job_update_failed",
      expect.objectContaining({ account_id: "acct-a", error: "status-boom" }),
    );
  });
});
