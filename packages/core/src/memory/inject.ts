import type { Fact, Observation, RawMessage, Reflection } from "@helm/shared";
import type { MemoryStore } from "../store/ports.js";
import { forgettingScore, type ScoreConfig } from "./forgetting/score.js";
import { sha256Hex } from "./message-hash.js";
import { alreadyObservedMessageIds } from "./observer.js";

// Memory middleware — INJECT phase (docs/08 Phase 2, #217 Phase 4 TRAILING-REMINDER
// model). When x-memory-mode=inject, this runs SYNCHRONOUSLY on the main request path,
// BEFORE classification/execution. Unlike the original full-replace design, the
// assembler no longer rebuilds the conversation: it produces ONE memory TEXT BLOCK
// that the pipeline APPENDS as a trailing `<system-reminder>` turn AFTER the client's
// verbatim live conversation. The live messages (tool_calls, images, tool results,
// developer instructions) and the cached system prefix are KEPT untouched by the
// pipeline — memory is purely additive, so it works for every turn type (tool-using /
// multimodal / native passthrough) and can never destroy live structure. This module
// does three things:
//   1. load memory (project/resource reflections + thread observations) and
//      assemble a STABLE, cache-friendly memory text block;
//   2. WINDOW-AWARE DEDUP — drop any thread observation whose covered turns are
//      ALL still present in the current request's live window (the client still
//      sends them), and trim within a token budget (oldest/lowest-score
//      observations first; reflections are kept under budget pressure);
//   3. enqueue a background observer job for write-back (compression stays OFF
//      the request path — inject only enqueues, never awaits compression).
//
// HARD safety rule (docs/08 + CLAUDE.md principle 3): if memory load/assembly
// fails for ANY reason, the request MUST continue WITHOUT memory (memoryBlock =
// null) and the failure is recorded — fail-open. Memory problems must never 5xx
// or stall the request.
//
// Framework-agnostic: store, token estimator, clock, enqueue and cost sink are all
// dependency-injected; this module imports no web framework and NEVER touches
// routing/lane state (memory is a MIDDLEWARE — it only provides context text).

export interface InjectInput {
  scope: { accountId: string; projectId?: string; resourceId?: string; threadId?: string };
  // Upper bound for INJECTED memory tokens (the assembled block). Reflections are
  // kept first; observations get whatever remains and are trimmed under pressure.
  tokenBudget: number;
  // Salient-fact fast path (salient-fact-memory-spec Change B). When true, inject
  // ALSO surfaces a `## Known facts` section assembled from the scope's active facts
  // (listActiveFacts) — a STATIC scope load like reflections, NOT per-query
  // retrieval. Absent/false ⇒ no facts are loaded or injected (byte-identical to
  // today), so existing forgetting deployments do not start surfacing
  // Reflector-produced facts until the operator opts into eager_facts.
  injectKnownFacts?: boolean;
  // Optional top-K cap on injected facts (consolidate.max_facts_injected). Absent ⇒
  // internal prior. The inject token budget is the real bound; this is a safety
  // valve so a large fact set never crowds out observations.
  maxFactsInjected?: number;
  // WINDOW-AWARE DEDUP (#217 Phase 4). Occurrence counts of content_hashes in the
  // current request's live messages — the client's live window. Computed the SAME
  // way storage hashes a message (sha256Hex(serializeContent(content))) so they
  // match memory_messages.content_hash. A thread observation whose covered turns
  // are ALL still present in this counted window is SKIPPED (the client still
  // sends them verbatim — injecting the summary too would duplicate). Counts matter:
  // two historical "yes" turns require two live "yes" turns, not just one matching
  // hash. ABSENT/empty ⇒ no observation is deduped (every active observation is
  // considered) — so a caller that has no window still works.
  windowContentHashCounts?: Map<string, number>;
}

// docs/12 P3 + P4 — the OPTIONAL forgetting wiring inject receives. Defaulting to
// ABSENT (the field is optional on InjectDeps) means every existing caller/test
// compiles and behaves byte-identically without change — with no `forgetting` dep
// the assembler runs oldest-first observation trim and never reinforces. Only when
// `enabled` does the inject path switch on the two gated behaviours:
//   - P4 score-trim: when `dropOrder === "score"` the observation budget trim
//     drops the LOWEST-scored row first instead of the oldest (scoreConfig is the
//     `memory.forgetting.score` block; the score's per-tier fallback_ts is
//     observedAt for observations). Fail-open: if scoring throws, fall back to
//     oldest-first.
//   - P3 reinforcement: after assembly, `bumpReferences` is fired fire-and-forget
//     with exactly the post-trim injected ids (never awaited on the response path).
export interface ForgettingInjectDeps {
  enabled: boolean;
  dropOrder: "score" | "oldest";
  scoreConfig: ScoreConfig;
  bumpReferences: (input: {
    accountId: string;
    observationIds: string[];
    reflectionIds: string[];
    now: Date;
  }) => Promise<void>;
}

export interface InjectDeps {
  memoryStore: MemoryStore;
  estimateTokens: (text: string) => number;
  // Enqueue the background observer job; returns observer_job_id. Inject NEVER
  // awaits the compression itself — it only enqueues (Observer stays background).
  enqueueObserverJob: (scope: InjectInput["scope"]) => Promise<string>;
  // Hydrate tokens are a SEPARATE cost bucket (docs/08 "cost accounting"): they must NOT
  // be mixed into the actor / observer / reflector buckets.
  costSink: (bucket: "hydrate", tokens: number) => void;
  now: () => Date;
  log: (line: string, meta?: object) => void;
  // OPTIONAL (docs/12 P3/P4). Absent ⇒ today's behaviour exactly (no score-trim,
  // no reinforcement). Present-but-disabled (`enabled:false`) is identical to absent.
  forgetting?: ForgettingInjectDeps;
}

// The assembler returns a single memory TEXT BLOCK (or null when there is nothing
// to inject / a degraded load), plus the debug-UI metadata. The pipeline owns the
// live conversation; this never reassembles messages.
export interface InjectResult {
  memoryBlock: string | null;
  metadata: {
    memory_hydrated: boolean;
    reflection_version: number | null;
    observation_count: number;
    facts_injected: number;
    memory_tokens_injected: number;
    observer_job_id: string | null;
    memory_writeback_status: "queued" | "skipped" | "failed";
    degraded: boolean;
  };
}

// Block format — a clean, token-efficient text block with stable section headers.
// Only sections WITH content are emitted, so a project-only memory yields just the
// header + the Project knowledge section (deterministic, cache-friendly).
const BLOCK_HEADER = "# Persistent memory (injected by helm)";
const PROJECT_HEADER = "## Project knowledge";
const RESOURCE_HEADER = "## Resource knowledge";
const KNOWN_FACTS_HEADER = "## Known facts";
const OBSERVATIONS_HEADER = "## Earlier context (summarized)";

// Internal prior for the injected-fact count cap (consolidate.max_facts_injected
// overrides it). The token budget is the real bound; this caps a pathological fact
// set so it never crowds out observations.
const DEFAULT_MAX_FACTS_INJECTED = 16;

function buildMemoryBlock(parts: {
  projectReflectionText: string | null;
  resourceReflectionText: string | null;
  factTexts: string[];
  observationTexts: string[];
}): string | null {
  const sections: string[] = [];
  if (parts.projectReflectionText !== null) {
    sections.push(`${PROJECT_HEADER}\n${parts.projectReflectionText}`);
  }
  if (parts.resourceReflectionText !== null) {
    sections.push(`${RESOURCE_HEADER}\n${parts.resourceReflectionText}`);
  }
  // Facts sit between the stable reflections and the time-anchored observations:
  // they are precise + durable, so under budget pressure they outrank observations.
  if (parts.factTexts.length > 0) {
    sections.push(`${KNOWN_FACTS_HEADER}\n${parts.factTexts.join("\n")}`);
  }
  if (parts.observationTexts.length > 0) {
    sections.push(`${OBSERVATIONS_HEADER}\n${parts.observationTexts.join("\n")}`);
  }
  if (sections.length === 0) return null;
  return `${BLOCK_HEADER}\n${sections.join("\n\n")}`;
}

// Enqueue the write-back observer job. Best-effort: a queue failure must NOT fail
// the request (fail-open) — it degrades the writeback status to "failed" and is
// logged, while the assembled block is still returned to the caller.
//
// When there is no writeback TARGET (no threadId — observations/messages are
// thread-anchored, so nothing can be written back), we do NOT enqueue and report
// "skipped" — distinct from a "failed" enqueue.
export async function enqueueObserverWriteback(
  scope: InjectInput["scope"],
  deps: Pick<InjectDeps, "enqueueObserverJob" | "log">,
): Promise<{ observerJobId: string | null; status: "queued" | "skipped" | "failed" }> {
  if (scope.threadId === undefined) {
    return { observerJobId: null, status: "skipped" };
  }
  try {
    const observerJobId = await deps.enqueueObserverJob(scope);
    return { observerJobId, status: "queued" };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    deps.log("memory.inject.writeback_enqueue_failed", { scope, error: message });
    return { observerJobId: null, status: "failed" };
  }
}

// Load every memory layer for the scope. project + resource reflections are read
// as separate scoped lookups so each lands in its own section. observations + the
// thread's raw messages come from the thread; the raw messages back the
// window-aware dedup (their content_hash is compared against the live window). Any
// throw here propagates up to the fail-open handler in assembleInjectedContext.
async function loadMemory(
  scope: InjectInput["scope"],
  store: MemoryStore,
  injectKnownFacts: boolean,
  factLimit?: number,
  factScore?: ScoreConfig & { nowMs: number },
): Promise<{
  projectReflection: Reflection | null;
  resourceReflection: Reflection | null;
  facts: Fact[];
  observations: Observation[];
  threadMessages: RawMessage[];
}> {
  const projectReflection =
    scope.projectId !== undefined
      ? await store.getReflection({ accountId: scope.accountId, projectId: scope.projectId })
      : null;
  const resourceReflection =
    scope.resourceId !== undefined
      ? await store.getReflection({ accountId: scope.accountId, resourceId: scope.resourceId })
      : null;
  // Salient-fact fast path (Change B): a STATIC scope load — the same read shape as
  // reflections, NOT per-query retrieval. Read by the BROADEST cross-thread scope the
  // request carries (project/resource); with NEITHER, fall back to the thread so a
  // thread-only request reads only its own facts. NEVER read with `accountId` alone —
  // omitted scope columns mean "no filter", which would surface every other
  // project/thread's facts in this prompt (Codex review fix). No usable scope ⇒ skip.
  const hasBroadFactScope = scope.projectId !== undefined || scope.resourceId !== undefined;
  const facts =
    injectKnownFacts &&
    store.listActiveFacts !== undefined &&
    (hasBroadFactScope || scope.threadId !== undefined)
      ? factLimit !== undefined && store.listInjectionFacts !== undefined
        ? await store.listInjectionFacts({
            accountId: scope.accountId,
            ...(scope.projectId !== undefined ? { projectId: scope.projectId } : {}),
            ...(scope.resourceId !== undefined ? { resourceId: scope.resourceId } : {}),
            ...(!hasBroadFactScope && scope.threadId !== undefined
              ? { threadId: scope.threadId }
              : {}),
            limit: factLimit,
            ...(factScore !== undefined ? { score: factScore } : {}),
          })
        : await store.listActiveFacts({
            accountId: scope.accountId,
            ...(scope.projectId !== undefined ? { projectId: scope.projectId } : {}),
            ...(scope.resourceId !== undefined ? { resourceId: scope.resourceId } : {}),
            // Thread fallback ONLY when there is no broader scope: a project read must
            // omit threadId (project facts carry threadId=null and would be filtered out).
            ...(!hasBroadFactScope && scope.threadId !== undefined
              ? { threadId: scope.threadId }
              : {}),
          })
      : [];
  // The inject layers stay THREAD-ANCHORED: pass threadId alone so this read
  // never crosses threads (the cross-thread project/resource aggregation is the
  // REFLECTOR's read shape, not inject's).
  const observations =
    scope.threadId !== undefined && store.listInjectionObservationsPage === undefined
      ? await store.listObservations({ accountId: scope.accountId, threadId: scope.threadId })
      : [];
  // The thread's raw rows are loaded ONLY to resolve each observation's covered
  // content_hashes for the window-aware dedup (they are NOT injected — the live
  // conversation already carries the recent turns). A thread with no observations
  // never needs them, but a single read keeps the dedup deterministic + cheap.
  const threadMessages =
    scope.threadId !== undefined && store.isInjectionObservationRedundant === undefined
      ? await store.listMessages({ accountId: scope.accountId, threadId: scope.threadId })
      : [];
  return { projectReflection, resourceReflection, facts, observations, threadMessages };
}

// Pick the latest reflection_version across the project + resource reflections for
// the debug UI. null when neither exists.
function latestReflectionVersion(
  projectReflection: Reflection | null,
  resourceReflection: Reflection | null,
): number | null {
  const versions = [projectReflection?.version, resourceReflection?.version].filter(
    (v): v is number => typeof v === "number",
  );
  return versions.length === 0 ? null : Math.max(...versions);
}

// WINDOW-AWARE DEDUP (#217 Phase 4). An observation is REDUNDANT iff EVERY raw turn
// it covers is still in the live window (the client re-sends them verbatim, so the
// summary would duplicate). It is RELEVANT (recall of dropped turns) iff at least
// one covered turn is missing from the window. An observation whose covered rows
// cannot be resolved (range points outside the loaded messages) is kept — we never
// silently drop recall on missing audit rows. With no window (empty set) nothing is
// redundant, so every observation is considered.
function observationIsRedundant(
  observation: Observation,
  threadMessages: RawMessage[],
  windowContentHashCounts: Map<string, number>,
): boolean {
  if (windowContentHashCounts.size === 0) return false;
  const coveredIds = alreadyObservedMessageIds(threadMessages, [observation.sourceMessageRange]);
  if (coveredIds.size === 0) return false; // unresolved range → keep (don't lose recall)
  const required = new Map<string, number>();
  for (const message of threadMessages) {
    if (!coveredIds.has(message.id)) continue;
    const hash = sha256Hex(message.content);
    required.set(hash, (required.get(hash) ?? 0) + 1);
  }
  for (const [hash, count] of required) {
    // A covered turn occurrence the client no longer sends ⇒ the observation still recalls it.
    if ((windowContentHashCounts.get(hash) ?? 0) < count) return false;
  }
  return true; // every covered turn is still in the window → redundant
}

export async function assembleInjectedContext(
  input: InjectInput,
  deps: InjectDeps,
): Promise<InjectResult> {
  // ── fail-open boundary ───────────────────────────────────────────────────
  // ANY failure loading/assembling memory degrades to NO memory (memoryBlock =
  // null) and is recorded — the request continues without memory.
  let loaded: Awaited<ReturnType<typeof loadMemory>>;
  try {
    loaded = await loadMemory(
      input.scope,
      deps.memoryStore,
      input.injectKnownFacts === true,
      Math.max(0, input.maxFactsInjected ?? DEFAULT_MAX_FACTS_INJECTED),
      deps.forgetting?.enabled === true
        ? { nowMs: deps.now().getTime(), ...deps.forgetting.scoreConfig }
        : undefined,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    deps.log("memory.inject.load_failed", { scope: input.scope, error: message });
    // Still attempt write-back enqueue so the originals get compressed later;
    // if that also fails it stays best-effort (never throws).
    const writeback = await enqueueObserverWriteback(input.scope, deps);
    return {
      memoryBlock: null,
      metadata: {
        memory_hydrated: false,
        reflection_version: null,
        observation_count: 0,
        facts_injected: 0,
        memory_tokens_injected: 0,
        observer_job_id: writeback.observerJobId,
        // Memory load failed → the whole memory step is a degraded path; mark the
        // writeback status as failed. EXCEPT when there was no writeback target at
        // all (no threadId): nothing could be enqueued, so it stays an honest
        // "skipped", not "failed".
        memory_writeback_status: writeback.status === "skipped" ? "skipped" : "failed",
        degraded: true,
      },
    };
  }

  const { projectReflection, resourceReflection, facts, observations, threadMessages } = loaded;
  const forgettingOn = deps.forgetting?.enabled === true;
  const windowContentHashCounts = input.windowContentHashCounts ?? new Map<string, number>();

  // ── Salient-fact selection (Change B) ──────────────────────────────────────
  // Active facts only (defence in depth — listActiveFacts already filters, but a
  // forgotten fact must never ride the block). RANK by the forgetting score when
  // forgetting is on (so decayed facts rank low, consistent with the observation
  // trim); else by recency (validFrom desc). Keep the top-K (maxFactsInjected ⇒
  // internal prior), then sort the survivors oldest-first for a STABLE block order
  // independent of `now` (cache-friendly). The fact tier's score fallback_ts is
  // createdAt (docs/12). Pure + deterministic for a given (facts, now).
  const visibleFacts = facts.filter(
    (f) => (f.status ?? "active") === "active" && (f.expiredAt ?? null) === null,
  );
  const factCap = input.maxFactsInjected ?? DEFAULT_MAX_FACTS_INJECTED;
  const factScoreCfg =
    forgettingOn && deps.forgetting !== undefined ? deps.forgetting.scoreConfig : null;
  const factNow = deps.now();
  const factPriority = (f: Fact): number =>
    factScoreCfg !== null
      ? forgettingScore(
          {
            referencedAt: f.referencedAt ?? null,
            fallbackTs: f.createdAt,
            referenceCount: f.referenceCount ?? 0,
            importance: f.importance ?? 0.5,
          },
          factScoreCfg,
          factNow,
        )
      : f.validFrom.getTime();
  // Priority order (highest first) for the budget trim — score when forgetting is on,
  // else recency. Capped to top-K; the kept survivors are sorted oldest-first for the
  // STABLE block order later (decoupled from `now`).
  const rankedFacts = [...visibleFacts]
    .sort(
      (a, b) => factPriority(b) - factPriority(a) || b.validFrom.getTime() - a.validFrom.getTime(),
    )
    .slice(0, Math.max(0, factCap));

  // docs/12 (P4/P7) — archived (decay), pruned (retention tombstone), and expired
  // rows are INVISIBLE to injection: a forgotten observation must never ride the
  // block. The filter is a pure, testable predicate applied UNCONDITIONALLY: with
  // forgetting OFF every legacy row is status='active'/expiredAt=null so it is a
  // no-op, but a row pruned/archived during an earlier enabled window stays hidden.
  const visibleObservations = observations.filter(
    (o) => (o.status ?? "active") === "active" && (o.expiredAt ?? null) === null,
  );

  // WINDOW-AWARE DEDUP — drop observations whose covered turns the client still
  // sends. Done BEFORE the budget trim so the budget is spent only on observations
  // that actually add recall (not duplicates of live turns).
  const relevantObservations = visibleObservations.filter(
    (o) => !observationIsRedundant(o, threadMessages, windowContentHashCounts),
  );

  // Observations are sorted oldest-first so the budget trimmer can drop the oldest
  // ones first while preserving the rest of the block.
  const sortedObservations = [...relevantObservations].sort(
    (a, b) => a.observedAt.getTime() - b.observedAt.getTime(),
  );

  // Reflection texts. project is kept before resource, so under budget pressure we
  // sacrifice the resource reflection FIRST, then the project reflection. Emission
  // order is still project → resource.
  const projectReflectionText = projectReflection?.reflectionText ?? null;
  const resourceReflectionText = resourceReflection?.reflectionText ?? null;

  // Each observation paired with the text it produces AND its id, so the post-trim
  // reinforcement (P3) can bump EXACTLY the rows that survived. Oldest-first.
  interface ObsEntry {
    id: string;
    text: string;
    observation: Observation;
  }
  const observationEntries: ObsEntry[] = sortedObservations.map((o) => ({
    id: o.id,
    text: o.observationText,
    observation: o,
  }));

  // ── budget trim ──────────────────────────────────────────────────────────
  // HARD cap on the assembled block's tokens. Priority:
  //   1. project reflection,
  //   2. resource reflection (sacrificed before project),
  //   3. observations (oldest-first, or lowest-score-first when forgetting=score)
  //      get whatever remains.
  // If the reflections alone overflow the budget we emit a structured overflow
  // signal so the breach is never silent.
  const tokensOf = (text: string) => deps.estimateTokens(text);

  let reflectionBudget = input.tokenBudget;
  let keepProjectReflection = false;
  let keepResourceReflection = false;
  if (projectReflectionText !== null) {
    const cost = tokensOf(projectReflectionText);
    if (cost <= reflectionBudget) {
      keepProjectReflection = true;
      reflectionBudget -= cost;
    }
  }
  if (resourceReflectionText !== null) {
    const cost = tokensOf(resourceReflectionText);
    if (cost <= reflectionBudget) {
      keepResourceReflection = true;
      reflectionBudget -= cost;
    }
  }

  const keptProjectReflectionText = keepProjectReflection ? projectReflectionText : null;
  const keptResourceReflectionText = keepResourceReflection ? resourceReflectionText : null;
  const reflectionTokens =
    (keptProjectReflectionText !== null ? tokensOf(keptProjectReflectionText) : 0) +
    (keptResourceReflectionText !== null ? tokensOf(keptResourceReflectionText) : 0);

  // ── facts budget (Change B) ────────────────────────────────────────────────
  // Facts get whatever the budget has left after the kept reflections, BEFORE
  // observations (precise + durable ⇒ outrank time-anchored observation summaries).
  // Trim in priority order (rankedFacts), then sort survivors oldest-first for a
  // stable block order. Each fact renders as a "- <text>" bullet.
  const factBudget = Math.max(0, input.tokenBudget - reflectionTokens);
  let factRemaining = factBudget;
  const keptFacts: Fact[] = [];
  for (const f of rankedFacts) {
    const cost = tokensOf(`- ${f.factText}`);
    if (cost <= factRemaining) {
      keptFacts.push(f);
      factRemaining -= cost;
    }
  }
  keptFacts.sort(
    (a, b) => a.validFrom.getTime() - b.validFrom.getTime() || a.id.localeCompare(b.id),
  );
  const keptFactTexts = keptFacts.map((f) => `- ${f.factText}`);
  const factTokens = keptFactTexts.reduce((sum, t) => sum + tokensOf(t), 0);

  // Observations get whatever the budget has left after the kept reflections. The
  // DROP ORDER is the one hot-path forgetting change (docs/12 "Eviction"): legacy
  // drops OLDEST-first; with forgetting ON and drop_order=score we drop
  // LOWEST-SCORE-first. Only the comparator changes; the surviving rows are always
  // re-sorted oldest-first for the deterministic block order.
  const observationBudget = Math.max(0, input.tokenBudget - reflectionTokens - factTokens);

  const keptEntries: ObsEntry[] = [];
  const pagedRead = deps.memoryStore.listInjectionObservationsPage;
  if (pagedRead !== undefined && input.scope.threadId !== undefined) {
    // Read only one small page of bodies at a time. The SQL order is the same
    // priority order used below (newest first, or score then newest), so once the
    // remaining budget reaches zero no older row can displace a kept one.
    let offset = 0;
    let remaining = observationBudget;
    const scoreMode = forgettingOn && deps.forgetting?.dropOrder === "score";
    const score = scoreMode ? deps.forgetting?.scoreConfig : undefined;
    const scoreNowMs = score === undefined ? undefined : deps.now().getTime();
    while (remaining > 0) {
      const page = await pagedRead({
        accountId: input.scope.accountId,
        threadId: input.scope.threadId,
        limit: 64,
        offset,
        order: scoreMode ? "score" : "newest",
        ...(score !== undefined && scoreNowMs !== undefined
          ? { score: { nowMs: scoreNowMs, ...score } }
          : {}),
      });
      if (page.length === 0) break;
      offset += page.length;
      for (const observation of page) {
        if (remaining === 0) break;
        const redundant =
          deps.memoryStore.isInjectionObservationRedundant !== undefined
            ? await deps.memoryStore.isInjectionObservationRedundant({
                accountId: input.scope.accountId,
                threadId: input.scope.threadId,
                sourceMessageRange: observation.sourceMessageRange,
                windowContentHashCounts,
              })
            : observationIsRedundant(observation, threadMessages, windowContentHashCounts);
        if (redundant) continue;
        const cost = tokensOf(observation.observationText);
        if (cost <= remaining) {
          keptEntries.push({ id: observation.id, text: observation.observationText, observation });
          remaining -= cost;
        }
      }
      if (page.length < 64) break;
    }
  } else {
    // observationEntries is oldest-first. Legacy keep order = newest-first (reverse)
    // so the oldest is the first sacrificed.
    const legacyKeepOrder = (): ObsEntry[] => [...observationEntries].reverse();
    let keepOrder: ObsEntry[];
    if (forgettingOn && deps.forgetting?.dropOrder === "score") {
      // Score-trim: keep highest-score first so the lowest-scored is dropped first.
      // FAIL-OPEN: if scoring throws for ANY row, abandon the score order and fall
      // back to legacy oldest-first, logging the fallback so the degrade is observable.
      try {
        const scoreCfg = deps.forgetting.scoreConfig;
        const now = deps.now();
        const scored = observationEntries.map((entry) => ({
          entry,
          score: forgettingScore(
            {
              referencedAt: entry.observation.referencedAt ?? null,
              fallbackTs: entry.observation.observedAt,
              referenceCount: entry.observation.referenceCount ?? 0,
              importance: entry.observation.importance ?? 0.5,
            },
            scoreCfg,
            now,
          ),
        }));
        scored.sort(
          (a, b) =>
            b.score - a.score ||
            b.entry.observation.observedAt.getTime() - a.entry.observation.observedAt.getTime(),
        );
        keepOrder = scored.map((s) => s.entry);
      } catch (err) {
        deps.log("memory.inject.score_trim_fallback", {
          scope: input.scope,
          error: err instanceof Error ? err.message : String(err),
        });
        keepOrder = legacyKeepOrder();
      }
    } else {
      keepOrder = legacyKeepOrder();
    }

    let remaining = observationBudget;
    for (const entry of keepOrder) {
      const cost = tokensOf(entry.text);
      if (cost <= remaining) {
        keptEntries.push(entry);
        remaining -= cost;
      }
      // else: skip this (lowest-priority) observation — trimmed for budget.
    }
  }
  // Restore oldest-first order for the block regardless of which drop order chose
  // the survivors.
  keptEntries.sort(
    (a, b) => a.observation.observedAt.getTime() - b.observation.observedAt.getTime(),
  );
  const keptObservationTexts = keptEntries.map((e) => e.text);
  const keptObservationIds = keptEntries.map((e) => e.id);

  // Signal a budget breach whenever the reflections alone would have exceeded the
  // cap — i.e. the budget actually forced a reflection drop. Surfacing it keeps the
  // "hard cap" meaningful: an overflow is observable, never silent.
  const allReflectionTokens =
    (projectReflectionText !== null ? tokensOf(projectReflectionText) : 0) +
    (resourceReflectionText !== null ? tokensOf(resourceReflectionText) : 0);
  if (allReflectionTokens > input.tokenBudget) {
    deps.log("memory.inject.budget_overflow", {
      scope: input.scope,
      token_budget: input.tokenBudget,
      reflection_tokens: allReflectionTokens,
    });
  }

  // Assemble the final memory text block (null when no section has content).
  const memoryBlock = buildMemoryBlock({
    projectReflectionText: keptProjectReflectionText,
    resourceReflectionText: keptResourceReflectionText,
    factTexts: keptFactTexts,
    observationTexts: keptObservationTexts,
  });

  // memory_tokens_injected = estimated tokens of the FINAL block string.
  const memoryTokensInjected = memoryBlock !== null ? tokensOf(memoryBlock) : 0;

  // Book hydrate tokens into their OWN bucket — never actor/observer/reflector.
  deps.costSink("hydrate", memoryTokensInjected);

  // Enqueue write-back (Observer stays background — we only enqueue, never await
  // compression). A queue failure is best-effort and never fails the request.
  const writeback = await enqueueObserverWriteback(input.scope, deps);

  const memoryHydrated = memoryBlock !== null;
  deps.log("memory.inject.assembled", {
    scope: input.scope,
    memory_hydrated: memoryHydrated,
    observation_count: keptObservationTexts.length,
    memory_tokens_injected: memoryTokensInjected,
    observer_job_id: writeback.observerJobId,
  });

  // ── access reinforcement (docs/12 P3, gated) ──────────────────────────────
  // The injector knows EXACTLY which observations/reflections survived the trim
  // and were actually injected. Fire ONE batched, account-guarded bump for them —
  // FIRE-AND-FORGET: the promise is NEVER awaited on the response path. A rejection
  // is swallowed + logged (fail-open). Only runs when forgetting is enabled.
  if (forgettingOn && deps.forgetting !== undefined) {
    const injectedReflectionIds: string[] = [];
    if (keepProjectReflection && projectReflection !== null) {
      injectedReflectionIds.push(projectReflection.id);
    }
    if (keepResourceReflection && resourceReflection !== null) {
      injectedReflectionIds.push(resourceReflection.id);
    }
    if (keptObservationIds.length > 0 || injectedReflectionIds.length > 0) {
      const bump = deps.forgetting.bumpReferences;
      const bumpInput = {
        accountId: input.scope.accountId,
        observationIds: keptObservationIds,
        reflectionIds: injectedReflectionIds,
        now: deps.now(),
      };
      const logFailure = (err: unknown) => {
        deps.log("memory.inject.reinforce_failed", {
          scope: input.scope,
          error: err instanceof Error ? err.message : String(err),
        });
      };
      // DEFER the invocation itself to a macrotask (Codex review fix): the default
      // sqlite adapter's writes are SYNCHRONOUS (better-sqlite3 .run()), so calling
      // bump() inline would still execute the UPDATEs on the request tick before the
      // response returns. setImmediate pushes the whole call off the request path.
      // The try/catch guards a SYNCHRONOUS throw inside the macrotask (which would
      // otherwise crash the process — fail-open demands log-and-continue).
      setImmediate(() => {
        try {
          void bump(bumpInput).then(() => {
            deps.log("memory.inject.reinforced", {
              scope: input.scope,
              observation_count: bumpInput.observationIds.length,
              reflection_count: bumpInput.reflectionIds.length,
            });
          }, logFailure);
        } catch (err) {
          logFailure(err);
        }
      });
    }
  }

  return {
    memoryBlock,
    metadata: {
      memory_hydrated: memoryHydrated,
      reflection_version: latestReflectionVersion(projectReflection, resourceReflection),
      observation_count: keptObservationTexts.length,
      facts_injected: keptFactTexts.length,
      memory_tokens_injected: memoryTokensInjected,
      observer_job_id: writeback.observerJobId,
      memory_writeback_status: writeback.status,
      degraded: false,
    },
  };
}
