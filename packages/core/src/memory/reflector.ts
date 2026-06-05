import type { MemoryFactInput, Observation, Reflection, ReflectionScope } from "@helm/shared";
import type { MemoryStore } from "../store/ports.js";
import { factContentHash, normalizeSubjectKey } from "./forgetting/facts.js";

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

// docs/12 P6 — one discrete fact the extractor produced from a scope's
// observations (spec pass 2). The extractor returns RAW strings; the Reflector
// derives the DETERMINISTIC subject_key + content_hash itself (so the
// supersede/dedup keys never depend on the LLM — the open-question resolved as
// deterministic-from-tags/subject). Like `merge`/`summarize`, the real LLM behind
// this interface is still deferred (docs/08), so a deterministic stub is correct.
export interface ExtractedFact {
  subjectText: string; // the topic; normalized into subject_key for same-subject supersede
  factText: string; // the atomic assertion; hashed for idempotent ingest
  // docs/12 (Codex review fix) — the time the fact BECAME TRUE, taken from the
  // SUPPORTING observation's observed_at, NOT the wall-clock processing time. The
  // supersede predicate is `valid_from < new.valid_from`, so stamping every fact
  // with `now` made same-run facts un-supersedable (all equal) and let a stale
  // observation processed late expire a genuinely newer fact. Optional for backward
  // compat: the Reflector falls back to `now` when an extractor omits it.
  validFrom?: Date;
  // Optional audit trail back to the source observation range.
  sourceObservationRange?: [string, string];
}

// docs/12 P6 — the consolidate-config subset the Reflector reads (structural, so
// reflector stays a leaf and never imports the config loader). z.infer of the P1
// `ForgettingSchema.consolidate` is assignable to this. Keys are snake_case to
// mirror the YAML / config shape exactly.
export interface ReflectorForgettingConfig {
  readonly enabled: boolean;
  readonly consolidate: {
    readonly trigger_tokens: number; // extract facts when active-obs token sum ≥ this
    readonly max_facts_per_subject: number; // hard cap per subject_key regardless of extractor output
  };
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
  // docs/12 P6 (OPTIONAL — gated + additive). Extract discrete facts from a
  // scope's observations (the Reflector's new sibling output). Injected exactly
  // like `merge`: a deterministic stub in tests, an LLM later (still deferred,
  // docs/08). Only invoked when `forgetting.enabled` AND the active-observation
  // token sum crosses `consolidate.trigger_tokens`; absent dep ⇒ no extraction
  // (opt-in). Fail-open: a throw here NEVER breaks the reflection write.
  extractFacts?: (input: {
    observations: Observation[];
    previousReflection: Reflection | null;
    now: Date;
  }) => Promise<ExtractedFact[]>;
  // docs/12 P6 (OPTIONAL). The forgetting config subset that gates extraction.
  // Absent ⇒ disabled (byte-identical to today — the gating lever). z.infer of
  // ForgettingSchema is assignable.
  forgetting?: ReflectorForgettingConfig;
  // OPTIONAL token estimator for the consolidate trigger (active-obs token sum).
  // Defaults to ~4 chars/token, matching the Observer's estimate (observer.ts).
  // Deterministic + pure; only consulted when extraction is gated on.
  estimateTokens?: (text: string) => number;
}

export interface ReflectorResult {
  reflectionId: string | null;
  version: number | null;
  changed: boolean;
}

// The reflection TARGET is the highest scope level inject actually READS BACK.
// inject loads reflections as getReflection({accountId, projectId}) and
// ({accountId, resourceId}) — EXACT matches where absent levels are NULL (the
// docs/08 assembly order has only those two reflection slots). A job scope may
// also carry a thread anchor: writing it verbatim would pin the reflection to
// the thread and make it permanently invisible to the next inject. project >
// resource; a scope with neither keeps the legacy thread-level target (direct
// callers only — the worker no longer promotes thread-only scopes). EXPORTED so
// the worker promotes reflector jobs ALREADY at the target level (cross-thread
// promotions for the same project then dedupe to one queue row).
export function reflectionTargetScope(scope: ReflectionScope): ReflectionScope {
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
    // BOTH reads happen at the TARGET level: the reflection slot the next inject
    // hydrates from, and the observations AGGREGATED ACROSS every thread of that
    // project/resource (the store joins threads by owner + scope id). Merging
    // only the promoting thread's observations would make the project reflection
    // last-writer-wins per thread.
    const target = reflectionTargetScope(job.scope);
    // docs/12 (P5/P6 correctness) — the Reflector merges + extracts facts from
    // ACTIVE observations ONLY. `listObservations` returns every status (the
    // archived/pruned rows still serve as raw-coverage markers for inject/observer),
    // so a decayed (archived) or retention-tombstoned (pruned) observation would
    // otherwise leak back into a long-lived reflection or fact — "forgotten" memory
    // resurrecting through the back door. Filter here, unconditionally: with
    // forgetting OFF every row is `active` so this is a pure no-op (byte-identical
    // to today); with it ON, hidden rows stay hidden everywhere, not just in inject.
    const allObservations = await deps.memoryStore.listObservations(target);
    const observations = allObservations.filter(
      (o) => (o.status ?? "active") === "active" && (o.expiredAt ?? null) === null,
    );
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

    // docs/12 P6 (spec pass 2) — facts are a NEW sibling output of the Reflector.
    // Gated on forgetting.enabled && the consolidate token trigger; runs whether
    // or not the reflection text changed (a stable reflection can still surface
    // discrete facts). SELF-CONTAINED fail-open: a fact failure must NEVER break
    // the reflection write below — so it has its own try/catch and is awaited HERE
    // (before the version branches) only so the cost/merge already ran.
    await tryExtractFacts({ deps, target, observations, previousReflection, now });

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

// Default token estimate (~4 chars/token), matching the Observer's estimate
// (observer.ts estimateObserverTokens). Pure + deterministic.
function defaultEstimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

// docs/12 P6 (spec pass 2) — the gated fact-extraction step, fully SELF-CONTAINED
// and fail-open so a fact failure can never break the reflection write. Returns
// nothing; all effects are the optional insertFactsReconciled call + logging.
//
// Gates (ALL must hold, else a silent no-op):
//   - forgetting.enabled (the master lever — off ⇒ byte-identical to today);
//   - an extractFacts dep is wired (opt-in, additive — pre-phase callers omit it);
//   - the store implements insertFactsReconciled (optional on the port);
//   - the active-observation token sum ≥ consolidate.trigger_tokens (the
//     buffer-flush trigger — never per request).
//
// Determinism: the extractor returns RAW {subjectText, factText}; the Reflector
// derives subject_key + content_hash ITSELF via the pure helpers, so the
// supersede/dedup keys never depend on the LLM. Facts are capped at
// max_facts_per_subject PER subject_key (the spec's hard cap regardless of
// extractor output). The fact scope mirrors the reflection TARGET (project >
// resource > thread), and validFrom = now (the fact became known at this run).
async function tryExtractFacts(args: {
  deps: ReflectorDeps;
  target: ReflectionScope;
  observations: Observation[];
  previousReflection: Reflection | null;
  now: Date;
}): Promise<void> {
  const { deps, target, observations, previousReflection, now } = args;
  const { extractFacts, forgetting } = deps;
  // Gate 1–3: flag on, extractor wired, store capable.
  if (forgetting?.enabled !== true) return;
  if (extractFacts === undefined) return;
  if (deps.memoryStore.insertFactsReconciled === undefined) return;

  try {
    // Gate 4: the buffer-flush token trigger — active-observation token sum.
    const estimate = deps.estimateTokens ?? defaultEstimateTokens;
    const tokenSum = observations.reduce((sum, o) => sum + estimate(o.observationText), 0);
    if (tokenSum < forgetting.consolidate.trigger_tokens) return;

    const extracted = await extractFacts({ observations, previousReflection, now });
    if (extracted.length === 0) return;

    // Build fact inputs with DETERMINISTIC keys, capping per subject_key.
    const cap = forgetting.consolidate.max_facts_per_subject;
    const perSubjectCount = new Map<string, number>();
    const facts: MemoryFactInput[] = [];
    for (const e of extracted) {
      const subjectKey = normalizeSubjectKey(e.subjectText);
      // Skip facts whose subject/fact text strips to nothing (the Zod input min(1)
      // would reject them anyway — guard here so one bad row never aborts the batch).
      if (subjectKey.length === 0 || e.factText.trim().length === 0) continue;
      const seen = perSubjectCount.get(subjectKey) ?? 0;
      if (seen >= cap) continue; // hard cap per subject_key regardless of extractor output
      perSubjectCount.set(subjectKey, seen + 1);
      facts.push({
        ownerId: target.accountId,
        subjectKey,
        factText: e.factText,
        contentHash: factContentHash(e.factText),
        // validFrom = the supporting observation's time (Codex review fix), so
        // supersede orders by when facts became true, not when they were processed.
        // Fall back to `now` only when an extractor omits it (deferred-LLM stub).
        validFrom: e.validFrom ?? now,
        ...(e.sourceObservationRange !== undefined
          ? { sourceObservationRange: e.sourceObservationRange }
          : {}),
        ...(target.projectId !== undefined ? { projectId: target.projectId } : {}),
        ...(target.resourceId !== undefined ? { resourceId: target.resourceId } : {}),
        ...(target.threadId !== undefined ? { threadId: target.threadId } : {}),
      });
    }
    if (facts.length === 0) return;

    const scope: { projectId?: string; resourceId?: string; threadId?: string } = {};
    if (target.projectId !== undefined) scope.projectId = target.projectId;
    if (target.resourceId !== undefined) scope.resourceId = target.resourceId;
    if (target.threadId !== undefined) scope.threadId = target.threadId;

    await deps.memoryStore.insertFactsReconciled({
      accountId: target.accountId,
      scope,
      facts,
      now,
    });
    deps.log("memory.reflector.facts_extracted", {
      target_scope: target,
      fact_count: facts.length,
    });
  } catch (err) {
    // FAIL-OPEN: a fact failure must never break the reflection write. Log + swallow.
    deps.log("memory.reflector.facts_failed", {
      target_scope: target,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
