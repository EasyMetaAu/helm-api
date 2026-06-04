import type { Observation, Reflection, ReflectionScope } from "@helm/shared";
import type { MemoryStore } from "../store/ports.js";

// Background Reflector (docs/08 Phase 2 "observational-memory MVP"). This is an OFF-the-main-
// request-path job: a scheduler triggers it PERIODICALLY to merge a scope's many
// observations into ONE stable, slowly-changing, VERSIONED reflection — the
// cache-friendly "stable layer" the inject phase prefixes onto context. It never
// runs synchronously inside a request and must NEVER throw to a caller (fail-open,
// CLAUDE.md principle 3): failure is recorded on the job + logged. Framework-
// agnostic: the merger (LLM or stub), store, clock and cost sink are all
// dependency-injected; this module imports no web framework and never touches
// routing/lane state (memory is a MIDDLEWARE).

// A background job: a pointer to the scope whose observations should be merged.
// Scope is project / resource / thread (one or more levels, docs/08 storage
// model). Enqueued by the periodic scheduler, consumed asynchronously by a worker.
export interface ReflectorJob {
  jobId: string;
  scope: ReflectionScope;
}

export interface ReflectorDeps {
  memoryStore: MemoryStore;
  // Merge a scope's active observations (+ the existing reflection, so it can
  // EVOLVE rather than rewrite) into new reflection text. Injected so tests use a
  // deterministic stub and production uses an LLM. `now` lets the merge embed a
  // stable time anchor. Same input MUST yield the same text (stability).
  merge: (input: {
    observations: Observation[];
    previousReflection: Reflection | null;
    now: Date;
  }) => Promise<{ reflectionText: string; tokenEstimate: number }>;
  // Reflector tokens are a SEPARATE cost bucket (docs/08 "cost accounting"): they must
  // NOT be hidden inside actor/observer/provider execution cost.
  costSink: (bucket: "reflector", tokens: number) => void;
  // Injected clock — the new reflection's updated_at + the merge's time anchor
  // come from here.
  now: () => Date;
  log: (line: string, meta?: object) => void;
}

export interface ReflectorResult {
  reflectionId: string | null;
  version: number | null;
  changed: boolean;
}

// The reflection TARGET is the highest scope level inject actually READS BACK.
// inject loads reflections as getReflection({accountId, projectId}) and
// ({accountId, resourceId}) — EXACT matches where absent levels are NULL (the
// docs/08 assembly order has only those two reflection slots). The job scope is
// the OBSERVATION SOURCE (thread-anchored, may carry all three levels): writing
// it verbatim would pin the reflection to the thread and make it permanently
// invisible to the next inject. project > resource; a scope with neither keeps
// the legacy thread-level target (direct callers only — the worker no longer
// promotes thread-only scopes).
function reflectionTargetScope(scope: ReflectionScope): ReflectionScope {
  if (scope.projectId !== undefined) {
    return { accountId: scope.accountId, projectId: scope.projectId };
  }
  if (scope.resourceId !== undefined) {
    return { accountId: scope.accountId, resourceId: scope.resourceId };
  }
  return scope;
}

// Take a scope's active observations + the current reflection, merge them, and —
// ONLY when the merged text actually changed — write a version+1 reflection. If
// the text is identical the version is NOT bumped and no row is written, keeping
// the injected prefix stable + cache-friendly (docs/08 "reflections should be stable and slow-changing").
// Reflector tokens are booked into the 'reflector' bucket. Success OR failure both
// update memory_jobs.status; failure is recorded + logged and NEVER thrown
// (fail-open — Reflector failure never affects any in-flight request).
export async function runReflectorJob(
  job: ReflectorJob,
  deps: ReflectorDeps,
): Promise<ReflectorResult> {
  try {
    // Observations come from the SOURCE scope (thread-anchored); the reflection is
    // read + written at the TARGET level the next inject hydrates from.
    const target = reflectionTargetScope(job.scope);
    const observations = await deps.memoryStore.listObservations(job.scope);
    const previousReflection = await deps.memoryStore.getReflection(target);

    if (observations.length === 0) {
      // Idempotent / nothing to merge — never write an empty reflection.
      await deps.memoryStore.updateJobStatus(job.jobId, "done");
      deps.log("memory.reflector.noop_no_observations", { scope: job.scope });
      return {
        reflectionId: previousReflection?.id ?? null,
        version: previousReflection?.version ?? null,
        changed: false,
      };
    }

    const now = deps.now();
    const { reflectionText, tokenEstimate } = await deps.merge({
      observations,
      previousReflection,
      now,
    });

    // Book Reflector tokens into their OWN bucket — never the provider/actor/
    // observer one (docs/08 cost accounting). We always do this when the merge
    // ran, since it consumed tokens even if the text turned out unchanged.
    deps.costSink("reflector", tokenEstimate);

    // STABILITY: only bump the version + write a new row when the text actually
    // changed. Identical input → identical text → no churn (cache-friendly).
    if (previousReflection !== null && previousReflection.reflectionText === reflectionText) {
      await deps.memoryStore.updateJobStatus(job.jobId, "done");
      deps.log("memory.reflector.unchanged", {
        scope: job.scope,
        version: previousReflection.version,
      });
      return {
        reflectionId: previousReflection.id,
        version: previousReflection.version,
        changed: false,
      };
    }

    const nextVersion = (previousReflection?.version ?? 0) + 1;
    const reflectionId = await deps.memoryStore.upsertReflection({
      ...target,
      reflectionText,
      version: nextVersion,
      tokenEstimate,
      updatedAt: now,
    });

    await deps.memoryStore.updateJobStatus(job.jobId, "done");
    deps.log("memory.reflector.merged", {
      scope: job.scope,
      target_scope: target,
      reflection_id: reflectionId,
      version: nextVersion,
      observation_count: observations.length,
    });
    return { reflectionId, version: nextVersion, changed: true };
  } catch (err) {
    // fail-open: Reflector failure must never bubble to the request path. Record
    // it on the job + log; this runs off the main request path entirely.
    const message = err instanceof Error ? err.message : String(err);
    try {
      await deps.memoryStore.updateJobStatus(job.jobId, "failed", message);
    } catch (updateErr) {
      // Even the failure bookkeeping is best-effort — still never throw.
      deps.log("memory.reflector.job_update_failed", {
        scope: job.scope,
        error: updateErr instanceof Error ? updateErr.message : String(updateErr),
      });
    }
    deps.log("memory.reflector.failed", { scope: job.scope, error: message });
    return { reflectionId: null, version: null, changed: false };
  }
}
