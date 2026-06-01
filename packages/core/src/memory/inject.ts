import type { AssembledMessage, Observation, RawMessage, Reflection } from "@helm/shared";
import type { MemoryStore } from "../store/ports.js";

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
  scope: { projectId?: string; resourceId?: string; threadId?: string };
  currentUserMessage: RawMessage;
  systemPrompt: string;
  // Upper bound for INJECTED memory tokens. The mandatory system prompt + current
  // user message are NOT counted against this budget (they always go through).
  tokenBudget: number;
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
async function enqueueWriteback(
  input: InjectInput,
  deps: InjectDeps,
): Promise<{ observerJobId: string | null; status: "queued" | "skipped" | "failed" }> {
  if (input.scope.threadId === undefined) {
    return { observerJobId: null, status: "skipped" };
  }
  try {
    const observerJobId = await deps.enqueueObserverJob(input.scope);
    return { observerJobId, status: "queued" };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    deps.log("memory.inject.writeback_enqueue_failed", { scope: input.scope, error: message });
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
      ? await store.getReflection({ projectId: scope.projectId })
      : null;
  const resourceReflection =
    scope.resourceId !== undefined
      ? await store.getReflection({ resourceId: scope.resourceId })
      : null;
  // Observations are THREAD-ANCHORED by schema: both store adapters return []
  // unless threadId is set and ignore project/resource. Gate on threadId only and
  // pass threadId alone — aligned with the store contract (no cross-thread
  // retrieval; there is no schema support for it).
  const observations =
    scope.threadId !== undefined ? await store.listObservations({ threadId: scope.threadId }) : [];
  const recentMessages =
    scope.threadId !== undefined ? await store.listMessages(scope.threadId) : [];
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
    const writeback = await enqueueWriteback(input, deps);
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
      },
    };
  }

  const { projectReflection, resourceReflection, observations, recentMessages } = loaded;

  // Build the trimmable injected layers in docs/08 order. Observations are sorted
  // oldest-first so the budget trimmer can drop the oldest ones first while
  // preserving the rest of the prefix (recent raw + current are NEVER trimmed).
  const sortedObservations = [...observations].sort(
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

  const observationMessages: AssembledMessage[] = sortedObservations.map((o) => ({
    role: "user" as const,
    content: o.observationText,
    source: "thread_observation" as const,
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
  // reflections; drop oldest-first until they fit.
  let observationBudget = Math.max(0, input.tokenBudget - recentRawTokens - reflectionTokens);
  const keptObservations: AssembledMessage[] = [];
  // Newest-first so we add the most recent observations until the budget is spent,
  // then re-sort to oldest-first for the assembled order.
  for (const obs of [...observationMessages].reverse()) {
    const cost = tokensOf(obs);
    if (cost <= observationBudget) {
      keptObservations.push(obs);
      observationBudget -= cost;
    }
    // else: skip this (older) observation — it's been trimmed for budget.
  }
  keptObservations.reverse(); // restore oldest-first order for the prefix

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
  const writeback = await enqueueWriteback(input, deps);

  const memoryHydrated = injectedLayers.length > 0;
  deps.log("memory.inject.assembled", {
    scope: input.scope,
    memory_hydrated: memoryHydrated,
    observation_count: keptObservations.length,
    memory_tokens_injected: memoryTokensInjected,
    observer_job_id: writeback.observerJobId,
  });

  return {
    messages,
    metadata: {
      memory_hydrated: memoryHydrated,
      reflection_version: latestReflectionVersion(projectReflection, resourceReflection),
      observation_count: keptObservations.length,
      memory_tokens_injected: memoryTokensInjected,
      observer_job_id: writeback.observerJobId,
      memory_writeback_status: writeback.status,
    },
  };
}
