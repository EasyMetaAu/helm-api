import type { AssembledMessage, Observation, RawMessage, Reflection } from "@helm/shared";
import type { MemoryStore } from "../store/ports.js";
import { forgettingScore, type ScoreConfig } from "./forgetting/score.js";
import { alreadyObservedMessageIds } from "./observer.js";

// Memory middleware — INJECT phase (docs/08 Phase 2 "observational-memory MVP"). When
// x-memory-mode=inject, this runs SYNCHRONOUSLY on the main request path, BEFORE
// classification/execution, and does three things:
//   1. load memory (project/resource reflections + thread observations + recent
//      raw messages) and assemble a STABLE, cache-friendly context prefix in the
//      fixed docs/08 order;
//   2. trim within a token budget — always sacrificing the OLDEST observations
//      first, NEVER the recent raw messages or the current user message;
//   3. enqueue a background observer job for write-back (compression stays OFF
//      the request path — inject only enqueues, never awaits compression).
//
// HARD safety rule (docs/08 + CLAUDE.md principle 3): if memory load/assembly
// fails for ANY reason, the request MUST continue WITHOUT memory and the failure
// is recorded — fail-open. Memory problems must never 5xx or stall the request.
//
// Framework-agnostic: store, token estimator, clock, enqueue and cost sink are all
// dependency-injected; this module imports no web framework and NEVER touches
// routing/lane state (memory is a MIDDLEWARE — it only provides context text).

export interface InjectInput {
  scope: { accountId: string; projectId?: string; resourceId?: string; threadId?: string };
  currentUserMessage: RawMessage;
  systemPrompt: string;
  // Upper bound for INJECTED memory tokens. The mandatory system prompt + current
  // user message are NOT counted against this budget (they always go through).
  tokenBudget: number;
}

// docs/12 P3 + P4 — the OPTIONAL forgetting wiring inject receives. Defaulting to
// ABSENT (the field is optional on InjectDeps) means every existing caller/test
// compiles and behaves byte-identically without change — with no `forgetting` dep
// the assembler runs exactly today's oldest-first trim and never reinforces. Only
// when `enabled` does the inject path switch on the two gated behaviours:
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

export interface InjectResult {
  messages: AssembledMessage[];
  metadata: {
    memory_hydrated: boolean;
    reflection_version: number | null;
    observation_count: number;
    memory_tokens_injected: number;
    observer_job_id: string | null;
    memory_writeback_status: "queued" | "skipped" | "failed";
    degraded: boolean;
  };
}

// Build the two mandatory, non-negotiable bookends of the context — the system
// prompt and the current user message. These ALWAYS ship, regardless of memory
// state or budget, and are the entirety of the fail-open minimal context.
function systemMessage(systemPrompt: string): AssembledMessage {
  return { role: "user", content: systemPrompt, source: "system" };
}

function currentMessage(current: RawMessage): AssembledMessage {
  return { role: current.role, content: current.content, source: "current" };
}

// Enqueue the write-back observer job. Best-effort: a queue failure must NOT fail
// the request (fail-open) — it degrades the writeback status to "failed" and is
// logged, while the assembled context is still returned to the caller.
//
// When there is no writeback TARGET (no threadId — observations/messages are
// thread-anchored, so nothing can be written back), we do NOT enqueue and report
// "skipped" — distinct from a "failed" enqueue.
//
// EXPORTED separately from assembleInjectedContext: the D7 plain-text gate skips
// the whole assembly for tool/multipart turns, but the write-back must still fire
// for them (or tool-heavy threads would never compress) — the bridge calls this
// directly on that path.
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
// as separate scoped lookups so each lands in its own ordered slot; observations
// and recent raw messages come from the thread. Any throw here propagates up to
// the fail-open handler in assembleInjectedContext.
async function loadMemory(
  scope: InjectInput["scope"],
  store: MemoryStore,
): Promise<{
  projectReflection: Reflection | null;
  resourceReflection: Reflection | null;
  observations: Observation[];
  recentMessages: RawMessage[];
}> {
  const projectReflection =
    scope.projectId !== undefined
      ? await store.getReflection({ accountId: scope.accountId, projectId: scope.projectId })
      : null;
  const resourceReflection =
    scope.resourceId !== undefined
      ? await store.getReflection({ accountId: scope.accountId, resourceId: scope.resourceId })
      : null;
  // The inject layers stay THREAD-ANCHORED: pass threadId alone so this read
  // never crosses threads (the cross-thread project/resource aggregation is the
  // REFLECTOR's read shape, not inject's).
  const observations =
    scope.threadId !== undefined
      ? await store.listObservations({ accountId: scope.accountId, threadId: scope.threadId })
      : [];
  const allMessages =
    scope.threadId !== undefined
      ? await store.listMessages({ accountId: scope.accountId, threadId: scope.threadId })
      : [];
  // recent_raw = only the raw turns NOT yet covered by an observation's source
  // range. Covered turns are already represented by their observation — injecting
  // both would duplicate content and grow the prompt without bound (the raw rows
  // stay in storage for audit; they just stop riding the prefix once compressed).
  const covered = alreadyObservedMessageIds(
    allMessages,
    observations.map((o) => o.sourceMessageRange),
  );
  const recentMessages = allMessages.filter((m) => !covered.has(m.id));
  return { projectReflection, resourceReflection, observations, recentMessages };
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

export async function assembleInjectedContext(
  input: InjectInput,
  deps: InjectDeps,
): Promise<InjectResult> {
  // ── fail-open boundary ───────────────────────────────────────────────────
  // ANY failure loading/assembling memory degrades to the minimal context
  // (system + current) and is recorded — the request continues without memory.
  let loaded: Awaited<ReturnType<typeof loadMemory>>;
  try {
    loaded = await loadMemory(input.scope, deps.memoryStore);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    deps.log("memory.inject.load_failed", { scope: input.scope, error: message });
    // Still attempt write-back enqueue so the originals get compressed later;
    // if that also fails it stays best-effort (never throws).
    const writeback = await enqueueObserverWriteback(input.scope, deps);
    return {
      messages: [systemMessage(input.systemPrompt), currentMessage(input.currentUserMessage)],
      metadata: {
        memory_hydrated: false,
        reflection_version: null,
        observation_count: 0,
        memory_tokens_injected: 0,
        observer_job_id: writeback.observerJobId,
        // Memory load failed → the whole memory step is a degraded path; mark the
        // writeback status as failed (docs/08 "graceful degradation" + record the failure).
        // EXCEPT when there was no writeback target at all (no threadId): nothing
        // could be enqueued, so it stays an honest "skipped", not "failed".
        memory_writeback_status: writeback.status === "skipped" ? "skipped" : "failed",
        degraded: true,
      },
    };
  }

  const { projectReflection, resourceReflection, observations, recentMessages } = loaded;
  const forgettingOn = deps.forgetting?.enabled === true;

  // docs/12 (P4) — when forgetting is ON, archived/expired rows are INVISIBLE to
  // injection: a decayed/superseded observation must never ride the prefix (decay
  // hides; it does not delete, so the rows stay for audit but stop being injected).
  // The filter is applied at ASSEMBLE time (not at the store read) so it is a pure,
  // testable predicate over whatever the read returned and stays gated behind the
  // flag — with forgetting OFF the read result passes through untouched (legacy
  // rows carry status='active'/expiredAt=null defaults anyway, so this is inert).
  const visibleObservations = forgettingOn
    ? observations.filter((o) => o.status === "active" && (o.expiredAt ?? null) === null)
    : observations;

  // Build the trimmable injected layers in docs/08 order. Observations are sorted
  // oldest-first so the budget trimmer can drop the oldest ones first while
  // preserving the rest of the prefix (recent raw + current are NEVER trimmed).
  const sortedObservations = [...visibleObservations].sort(
    (a, b) => a.observedAt.getTime() - b.observedAt.getTime(),
  );

  // Reflections in priority order: project is kept before resource, so under
  // budget pressure we sacrifice the resource reflection FIRST, then the project
  // reflection. (Assembly order below still emits project → resource.)
  const projectReflectionMessage: AssembledMessage | null =
    projectReflection !== null
      ? { role: "user", content: projectReflection.reflectionText, source: "project_reflection" }
      : null;
  const resourceReflectionMessage: AssembledMessage | null =
    resourceReflection !== null
      ? { role: "user", content: resourceReflection.reflectionText, source: "resource_reflection" }
      : null;

  // Each observation paired with the message it produces AND its source id, so the
  // post-trim reinforcement (P3) can bump EXACTLY the rows that survived. Kept in
  // oldest-first order to mirror the legacy assembled-prefix order (docs/08).
  interface ObsEntry {
    id: string;
    message: AssembledMessage;
    observation: Observation;
  }
  const observationEntries: ObsEntry[] = sortedObservations.map((o) => ({
    id: o.id,
    observation: o,
    message: { role: "user", content: o.observationText, source: "thread_observation" },
  }));

  // Recent raw messages are kept verbatim, in order (docs/08 "recent raw messages must be preserved").
  const recentRawMessages: AssembledMessage[] = recentMessages.map((m) => ({
    role: m.role,
    content: m.content,
    source: "recent_raw" as const,
  }));

  // ── budget trim ──────────────────────────────────────────────────────────
  // HARD cap on INJECTED tokens (system + current are excluded from the budget).
  // Priority — recent raw is spec-mandated and ALWAYS survives (docs/08 "recent raw
  // messages must be preserved"). Everything else yields to the budget in this order:
  //   1. resource reflection (sacrificed first under pressure),
  //   2. project reflection,
  //   3. observations (oldest-first) get whatever remains.
  // If recent raw alone already overflows, we still keep it (mandated) but emit a
  // structured overflow signal so the breach is never silent.
  const tokensOf = (m: AssembledMessage) => deps.estimateTokens(m.content);

  // Recent raw is the non-negotiable floor; it consumes its tokens unconditionally.
  const recentRawTokens = recentRawMessages.reduce((sum, m) => sum + tokensOf(m), 0);

  // Reflections compete for what's left after recent raw. Keep project first, then
  // resource — i.e. drop resource BEFORE project when only one (or none) fits.
  let reflectionBudget = input.tokenBudget - recentRawTokens;
  const keptReflections: { project: boolean; resource: boolean } = {
    project: false,
    resource: false,
  };
  if (projectReflectionMessage !== null) {
    const cost = tokensOf(projectReflectionMessage);
    if (cost <= reflectionBudget) {
      keptReflections.project = true;
      reflectionBudget -= cost;
    }
  }
  if (resourceReflectionMessage !== null) {
    const cost = tokensOf(resourceReflectionMessage);
    if (cost <= reflectionBudget) {
      keptReflections.resource = true;
      reflectionBudget -= cost;
    }
  }

  // Emitted reflections, in docs/08 order (project → resource), after trimming.
  const reflectionMessages: AssembledMessage[] = [];
  if (keptReflections.project && projectReflectionMessage !== null) {
    reflectionMessages.push(projectReflectionMessage);
  }
  if (keptReflections.resource && resourceReflectionMessage !== null) {
    reflectionMessages.push(resourceReflectionMessage);
  }
  const reflectionTokens = reflectionMessages.reduce((sum, m) => sum + tokensOf(m), 0);

  // Observations get whatever the budget has left after recent raw + kept
  // reflections. The DROP ORDER is the one hot-path forgetting change (docs/12
  // "Eviction … inject-time trim"): legacy drops OLDEST-first; with forgetting ON
  // and drop_order=score we drop LOWEST-SCORE-first. Only the comparator changes —
  // recent_raw + current are still never trimmed; the invariants hold either way.
  //
  // `keepOrder` is the order in which entries are CONSIDERED for keeping (best to
  // keep → first). Whatever does not fit the budget falls off the END of this
  // order = the row that gets dropped first. Legacy: newest-first (so the oldest
  // is the first sacrificed). Score: highest-score-first (so the lowest-scored is
  // the first sacrificed). The kept set is then re-sorted to oldest-first for the
  // STRICT docs/08 prefix order — the drop order changes WHICH rows survive, never
  // the surviving rows' order in the prompt.
  let observationBudget = Math.max(0, input.tokenBudget - recentRawTokens - reflectionTokens);

  // observationEntries is oldest-first. Legacy keep order = newest-first (reverse).
  const legacyKeepOrder = (): ObsEntry[] => [...observationEntries].reverse();
  let keepOrder: ObsEntry[];
  if (forgettingOn && deps.forgetting?.dropOrder === "score") {
    // Score-trim: keep highest-score first so the lowest-scored is dropped first.
    // The score's per-tier fallback_ts for observations is observedAt (docs/12
    // fallback table) — a never-reinforced row ages from when it was observed.
    // FAIL-OPEN: if scoring throws for ANY row, abandon the score order entirely
    // and fall back to legacy oldest-first (a partial score order could silently
    // mis-rank), logging the fallback so the degrade is observable, never silent.
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
      // Highest score first. Tie-break newest-first (observedAt desc) so a tie
      // matches the legacy preference for recency.
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

  const keptEntries: ObsEntry[] = [];
  for (const entry of keepOrder) {
    const cost = tokensOf(entry.message);
    if (cost <= observationBudget) {
      keptEntries.push(entry);
      observationBudget -= cost;
    }
    // else: skip this (lowest-priority) observation — trimmed for budget.
  }
  // Restore oldest-first order for the prefix (observedAt asc) regardless of which
  // drop order chose the survivors.
  keptEntries.sort(
    (a, b) => a.observation.observedAt.getTime() - b.observation.observedAt.getTime(),
  );
  const keptObservations: AssembledMessage[] = keptEntries.map((e) => e.message);
  const keptObservationIds = keptEntries.map((e) => e.id);

  // Signal a budget breach whenever the un-trimmed fixed layers (all reflections +
  // recent raw) would have exceeded the cap — i.e. the budget actually forced a
  // reflection drop, or recent raw alone overflows. Surfacing it keeps the "hard
  // cap" meaningful: an overflow is observable, never silent.
  const fixedTokens =
    recentRawTokens +
    (projectReflectionMessage !== null ? tokensOf(projectReflectionMessage) : 0) +
    (resourceReflectionMessage !== null ? tokensOf(resourceReflectionMessage) : 0);
  if (fixedTokens > input.tokenBudget) {
    deps.log("memory.inject.budget_overflow", {
      scope: input.scope,
      token_budget: input.tokenBudget,
      fixed_tokens: fixedTokens,
      recent_raw_tokens: recentRawTokens,
    });
  }

  // Assemble the final ordered prefix: STRICT docs/08 order.
  const messages: AssembledMessage[] = [
    systemMessage(input.systemPrompt),
    ...reflectionMessages,
    ...keptObservations,
    ...recentRawMessages,
    currentMessage(input.currentUserMessage),
  ];

  // memory_tokens_injected = tokens of the injected memory layers ONLY (reflections
  // + kept observations + recent raw) — excluding the mandatory system + current.
  const injectedLayers = [...reflectionMessages, ...keptObservations, ...recentRawMessages];
  const memoryTokensInjected = injectedLayers.reduce((sum, m) => sum + tokensOf(m), 0);

  // Book hydrate tokens into their OWN bucket — never actor/observer/reflector.
  deps.costSink("hydrate", memoryTokensInjected);

  // Enqueue write-back (Observer stays background — we only enqueue, never await
  // compression). A queue failure is best-effort and never fails the request.
  const writeback = await enqueueObserverWriteback(input.scope, deps);

  const memoryHydrated = injectedLayers.length > 0;
  deps.log("memory.inject.assembled", {
    scope: input.scope,
    memory_hydrated: memoryHydrated,
    observation_count: keptObservations.length,
    memory_tokens_injected: memoryTokensInjected,
    observer_job_id: writeback.observerJobId,
  });

  // ── access reinforcement (docs/12 P3, gated) ──────────────────────────────
  // The injector knows EXACTLY which observations/reflections survived the trim
  // and were actually injected. Fire ONE batched, account-guarded bump for them —
  // FIRE-AND-FORGET: the promise is NEVER awaited on the response path (a
  // reinforcement write must not add latency or be able to fail the request).
  // A rejection is swallowed + logged (fail-open): a stale counter just means the
  // score reads the old value next time. Only runs when forgetting is enabled.
  if (forgettingOn && deps.forgetting !== undefined) {
    const injectedReflectionIds: string[] = [];
    if (keptReflections.project && projectReflection !== null) {
      injectedReflectionIds.push(projectReflection.id);
    }
    if (keptReflections.resource && resourceReflection !== null) {
      injectedReflectionIds.push(resourceReflection.id);
    }
    if (keptObservationIds.length > 0 || injectedReflectionIds.length > 0) {
      const bump = deps.forgetting.bumpReferences;
      void bump({
        accountId: input.scope.accountId,
        observationIds: keptObservationIds,
        reflectionIds: injectedReflectionIds,
        now: deps.now(),
      }).catch((err) => {
        deps.log("memory.inject.reinforce_failed", {
          scope: input.scope,
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }
  }

  return {
    messages,
    metadata: {
      memory_hydrated: memoryHydrated,
      reflection_version: latestReflectionVersion(projectReflection, resourceReflection),
      observation_count: keptObservations.length,
      memory_tokens_injected: memoryTokensInjected,
      observer_job_id: writeback.observerJobId,
      memory_writeback_status: writeback.status,
      degraded: false,
    },
  };
}
