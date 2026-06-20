import type { CompactionOverrides, Observation, RawMessage } from "@helm/shared";
import type { ResolvedCompactionPricing } from "../catalog/cost.js";
import type { MemoryStore } from "../store/ports.js";
import {
  type AutoCompactionInputs,
  chooseAutoCompaction,
  resolveCompactionTunables,
} from "./compaction-policy.js";
import { buildReconciledFactBatch } from "./forgetting/facts.js";
import type { ExtractedFact } from "./reflector.js";

// consolidate.max_facts_per_subject schema default — used when the composition root
// wires the eager extractor without an explicit cap.
const DEFAULT_MAX_FACTS_PER_SUBJECT = 8;

// Salient-fact fast path (salient-fact-memory-spec Change A). Mine the thread's
// UNCOVERED raw turns for durable facts and persist them at the thread's
// cross-thread scope — DECOUPLED from compaction, so a short "remember X" turn
// forms a fact even when nothing compacts. Called ONLY on the no-compaction exit
// paths: a run that compacts leaves facts to the Reflector (which extracts from the
// new observation), avoiding a double extraction. Fully self-contained + FAIL-OPEN:
// every error is swallowed + logged so the eager pass can never fail the observer
// job or the request that enqueued it. No-ops unless the extractor + the fact store
// are both wired (the composition root wires them only when memory.llm.enabled &&
// forgetting.consolidate.eager_facts).
async function maybeEagerExtractFacts(
  job: ObserverJob,
  all: RawMessage[],
  covered: Set<string>,
  deps: ObserverDeps,
): Promise<void> {
  const extract = deps.extractFactsFromMessages;
  const insert = deps.memoryStore.insertFactsReconciled;
  if (extract === undefined || insert === undefined) return;
  try {
    const uncovered = all.filter((m) => !covered.has(m.id));
    // Skip the LLM call when there is no NEW user-authored content to mine — a
    // tool-result / assistant-only batch carries no user-stated fact (the cost lever
    // that keeps eager extraction off agent tool-roundtrip turns).
    if (!uncovered.some((m) => m.role === "user")) return;
    const now = deps.now();
    const extracted = await extract({ messages: uncovered, now });
    if (extracted.length === 0) return;
    // Scope the fact at the broadest cross-thread level the job carries. With NEITHER
    // project nor resource (a valid thread-only job), fall back to the THREAD — never
    // an empty scope, which would persist an account-wide fact and leak a thread-local
    // statement into unrelated conversations (Codex review fix).
    const scope: { projectId?: string; resourceId?: string; threadId?: string } = {};
    if (job.projectId !== undefined) scope.projectId = job.projectId;
    if (job.resourceId !== undefined) scope.resourceId = job.resourceId;
    if (scope.projectId === undefined && scope.resourceId === undefined) {
      scope.threadId = job.threadId;
    }
    const facts = buildReconciledFactBatch({
      extracted,
      ownerId: job.accountId,
      scope,
      cap: deps.maxFactsPerSubject ?? DEFAULT_MAX_FACTS_PER_SUBJECT,
      fallbackNow: now,
    });
    if (facts.length === 0) return;
    // BIND to the store: insertFactsReconciled is a class method that uses `this.db`,
    // so a bare `insert(...)` would lose `this` and throw "reading 'db'" (fail-open ⇒
    // silent no-write). Mirror the `.call(deps.memoryStore, ...)` pattern used by the
    // idle-flush / decay-trigger optional-method call sites.
    await insert.call(deps.memoryStore, { accountId: job.accountId, scope, facts, now });
    deps.log("memory.observer.eager_facts_extracted", {
      thread_id: job.threadId,
      fact_count: facts.length,
    });
  } catch (err) {
    deps.log("memory.observer.eager_facts_failed", {
      thread_id: job.threadId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

// Background Observer (docs/08 Phase 2 "observational-memory MVP"). This is an OFF-the-main-
// request-path job: the request path only persists raw messages and enqueues an
// observer job; this function runs LATER, in a background worker, compressing a
// thread's OLDER raw messages into a single time-anchored observation. It never
// runs synchronously inside a request and must NEVER throw to a caller on the
// request path — failure is recorded on the job + logged (fail-open, CLAUDE.md
// principle 3). Framework-agnostic: LLM (summarize), store, clock and cost sink
// are all dependency-injected; this module imports no web framework and never
// touches routing/lane state (memory is a MIDDLEWARE).

// A background job: a pointer to the thread whose older history should be
// compressed. Enqueued by the request path (writeback) AND by the idle-flush
// sweep — both produce the SAME plain {accountId, threadId} scope, so the
// open-job dedupe collapses them to ONE lock per thread (no overlapping
// observers in a multi-worker deployment). Whether to fold the whole history
// (the idle backstop) is decided at RUN TIME from message ages, not a job flag.
export interface ObserverJob {
  jobId: string;
  accountId: string;
  threadId: string;
  // Salient-fact fast path (Change A): the thread's cross-thread scope, carried
  // verbatim from the enqueued job (the worker already has it — observer jobs are
  // enqueued with the full {accountId, projectId?, resourceId?, threadId} scope).
  // Eager facts are written at this scope so they are recallable in a NEW thread.
  // Absent ⇒ thread-only; the eager pass then writes a thread-scoped fact.
  projectId?: string;
  resourceId?: string;
}

export interface ObserverDeps {
  memoryStore: MemoryStore;
  // Compress a slice of raw messages into observation text. Injected so tests
  // use a deterministic stub and production uses an LLM. `now` lets the summary
  // embed a stable time anchor.
  summarize: (input: { messages: RawMessage[]; now: Date }) => Promise<{
    observationText: string;
    priority?: number;
    tags?: string[];
    // docs/12 (P0/P5 salience input). Optional [0,1] salience the summarizer can
    // emit directly; when absent it is DERIVED from `priority` (see below). This is
    // the `importance` multiplier the forgetting score uses as its decay brake — so
    // a real (LLM) summarizer's salience rating actually reaches the score curve
    // instead of every observation defaulting to a flat 0.5.
    importance?: number;
  }>;
  // Observer tokens are a SEPARATE cost bucket (docs/08 "cost accounting"): they must
  // NOT be hidden inside actor/provider execution cost.
  costSink: (bucket: "observer", tokens: number) => void;
  // Salient-fact fast path (salient-fact-memory-spec Change A). Extract atomic facts
  // DIRECTLY from raw new turns — decoupled from compaction so a short "remember X"
  // turn forms a durable fact even when nothing compacts. OPTIONAL + gated (the
  // composition root wires it only when memory.llm.enabled && eager_facts): absent ⇒
  // no eager extraction (byte-identical to today). There is NO deterministic
  // extractor for raw prose, so the LLM-unavailable / parse-fail path returns [] —
  // fail-open: an empty result (or a throw) never blocks compaction or the request.
  extractFactsFromMessages?: (input: {
    messages: RawMessage[];
    now: Date;
  }) => Promise<ExtractedFact[]>;
  // Per-subject cap for the eager fact batch (consolidate.max_facts_per_subject).
  // Optional: defaults to the schema default (8) when the composition root omits it.
  maxFactsPerSubject?: number;
  // Resolve the thread's last served model alias → catalog prices + context
  // window for the auto compaction policy. Injected by the composition root
  // (closure over the runtime catalog); null/unknown alias resolves all-null
  // and the policy falls back to its deterministic heuristics (fail-open).
  resolvePricing: (modelAlias: string | null) => ResolvedCompactionPricing;
  // Optional config.memory.compaction trigger overrides. Absent (the default
  // and the zero-config posture) → the internal AUTO_PRIORS apply verbatim.
  compaction?: CompactionOverrides;
  // Injected clock — observed_at + the summary's time anchor come from here.
  now: () => Date;
  log: (line: string, meta?: object) => void;
}

export interface ObserverResult {
  observationId: string | null;
  sourceMessageRange: [string, string] | null;
}

// Estimate the token cost of an observation pass. The Observer's own tokens are
// the input it compressed plus the produced text; we approximate from the raw
// token estimates already stored on each message plus the output length. This is
// only for the SEPARATE observer cost bucket, not for routing.

// Map observation source ranges back to the covered raw-message ids. EXPORTED:
// the observer uses it to skip re-summarizing covered turns, and the inject
// loader uses the SAME definition of "covered" to keep compressed turns out of
// the recent_raw layer (an observation already represents them — injecting both
// would duplicate content and grow the prompt without bound).
export function alreadyObservedMessageIds(
  messages: RawMessage[],
  ranges: Array<[string, string]>,
): Set<string> {
  const byId = new Map(messages.map((m, i) => [m.id, i]));
  const covered = new Set<string>();
  for (const [firstId, lastId] of ranges) {
    const first = byId.get(firstId);
    const last = byId.get(lastId);
    if (first === undefined || last === undefined) continue;
    const start = Math.min(first, last);
    const end = Math.max(first, last);
    for (let i = start; i <= end; i += 1) {
      const msg = messages[i];
      if (msg !== undefined) covered.add(msg.id);
    }
  }
  return covered;
}

function uncoveredContiguousSegments(messages: RawMessage[], covered: Set<string>): RawMessage[][] {
  const segments: RawMessage[][] = [];
  let current: RawMessage[] = [];
  for (const message of messages) {
    if (covered.has(message.id)) {
      if (current.length > 0) segments.push(current);
      current = [];
      continue;
    }
    current.push(message);
  }
  if (current.length > 0) segments.push(current);
  return segments;
}

function estimateObserverTokens(compressed: RawMessage[], observationText: string): number {
  const input = compressed.reduce((sum, m) => sum + m.tokenEstimate, 0);
  // Cheap output estimate; a real worker can swap in a tokenizer. ~4 chars/token.
  const output = Math.ceil(observationText.length / 4);
  return input + output;
}

// MEASURED retention: output/source token ratio across this thread's prior
// observations — what the summarizer ACTUALLY kept, not a declared constant
// (the truncation stub keeps ~5% of a long slice; a config saying 0.8 lies).
// null when the thread has no usable prior pass (first compaction → the policy
// applies its prior). Pure; reuses the same range mapping as coverage.
export function measuredRetention(
  messages: RawMessage[],
  observations: Array<Pick<Observation, "sourceMessageRange" | "observationText">>,
): number | null {
  const byId = new Map(messages.map((m, i) => [m.id, i]));
  let sourceTokens = 0;
  let outputTokens = 0;
  for (const obs of observations) {
    const [firstId, lastId] = obs.sourceMessageRange;
    const first = byId.get(firstId);
    const last = byId.get(lastId);
    if (first === undefined || last === undefined) continue;
    const start = Math.min(first, last);
    const end = Math.max(first, last);
    for (let i = start; i <= end; i += 1) {
      const msg = messages[i];
      if (msg !== undefined) sourceTokens += Math.max(0, msg.tokenEstimate);
    }
    outputTokens += Math.ceil(obs.observationText.length / 4);
  }
  if (sourceTokens <= 0) return null;
  return outputTokens / sourceTokens;
}

// Per-field provenance for the decision log: which price came from the catalog,
// which was derived by heuristic, which fell back entirely. Lets an operator
// reproduce the ledger from the log line alone.
function priceProvenance(pricing: ResolvedCompactionPricing): Record<string, string> {
  const source = (published: number | null, derivable: boolean): string =>
    published !== null ? "catalog" : derivable ? "derived" : "unpriced";
  const priced = pricing.inputPerMtok !== null;
  return {
    input: priced ? "catalog" : "unpriced",
    output: source(pricing.outputPerMtok, priced),
    cache_read: source(pricing.cacheReadPerMtok, priced),
    cache_write: source(pricing.cacheWritePerMtok, priced),
    context_window: pricing.maxContextTokens !== null ? "catalog" : "fallback",
  };
}

// Take a thread's older raw messages, compress them into ONE observation with a
// precise, auditable source_message_range and a time anchor, and book the cost
// into the observer bucket. The most recent RECENT_KEEP messages are preserved
// uncompressed. Success OR failure both update memory_jobs.status; failure is
// recorded + logged and NEVER thrown (fail-open). Returns the new observation id
// + range, or {null, null} when there was nothing old enough to compress.
export async function runObserverJob(
  job: ObserverJob,
  deps: ObserverDeps,
): Promise<ObserverResult> {
  try {
    const all = await deps.memoryStore.listMessages({
      accountId: job.accountId,
      threadId: job.threadId,
    });
    const existing = await deps.memoryStore.listObservations({
      accountId: job.accountId,
      threadId: job.threadId,
    });
    const covered = alreadyObservedMessageIds(
      all,
      existing.map((o) => o.sourceMessageRange),
    );

    // Auto-compaction inputs — all DERIVED, none configured (the whole point):
    //   model    → thread's last served alias, stamped by observeOutbound; the
    //              optional store method / missing stamp degrade to null (the
    //              policy's heuristics take over — fail-open, first-job race
    //              with the stamp is harmless).
    //   prices   → catalog lookup via the injected resolver.
    //   priorCompactionCount → the thread's actual observation count (the v1
    //              static 0 never engaged the distortion brake).
    //   retention → measured output/source ratio of prior observations.
    const threadMeta = await deps.memoryStore
      .getThreadMeta?.({ accountId: job.accountId, threadId: job.threadId })
      .catch(() => null);
    const modelAlias = threadMeta?.lastServedModel ?? null;
    const pricing = deps.resolvePricing(modelAlias);
    const tunables = resolveCompactionTunables(deps.compaction);
    // Idle is derived HERE, at run time, from the newest message's age — NOT from
    // a job flag. This is race-free (a thread that got activity between enqueue
    // and run is correctly seen as active) and means writeback + idle-sweep jobs
    // can share ONE plain-scope open-job lock per thread (no overlap hazard).
    const nowMs = deps.now().getTime();
    const newestMessageMs = all.reduce((max, m) => Math.max(max, m.createdAt.getTime()), 0);
    const idle = all.length > 0 && nowMs - newestMessageMs >= tunables.idleFlushS * 1000;
    // Context-pressure footprint = the ACTIVE prompt size, not the full raw audit
    // history. Inject suppresses covered raw messages (they are represented by
    // their observation), so a thread compacted once would otherwise keep
    // tokenSum(all) high forever and force-compact every later small segment. Use
    // the UNCOVERED raw tail + the VISIBLE observation texts (active + unexpired —
    // the exact set inject injects); archived/pruned observations stay out of the
    // footprint just as they stay out of the prompt. Reflections are
    // project/resource-level and bounded; excluded to keep this thread-local.
    const uncoveredTokens = all.reduce(
      (sum, m) => (covered.has(m.id) ? sum : sum + Math.max(0, m.tokenEstimate)),
      0,
    );
    const observationTokens = existing.reduce(
      (sum, o) =>
        (o.status ?? "active") === "active" && (o.expiredAt ?? null) === null
          ? sum + Math.ceil(o.observationText.length / 4)
          : sum,
      0,
    );
    const inputs: AutoCompactionInputs = {
      idle,
      tunables,
      pricing,
      priorCompactionCount: existing.length,
      measuredRetention: measuredRetention(all, existing),
      threadTotalTokens: uncoveredTokens + observationTokens,
    };

    // Covered rows can sit in the middle of the raw history. Never summarize a
    // sparse set and then write it as one continuous source range; choose the
    // oldest compactable contiguous uncovered segment instead.
    const segments = uncoveredContiguousSegments(all, covered);
    const decisions = segments.map((segment) => ({
      segment,
      decision: chooseAutoCompaction(segment, inputs),
    }));
    const selected = decisions.find(({ decision }) => decision.shouldCompact);
    if (selected === undefined) {
      // No compaction this run → mine the uncovered turns for durable facts.
      await maybeEagerExtractFacts(job, all, covered, deps);
      await deps.memoryStore.updateJobStatus(job.jobId, "done");
      const lastDecision = decisions.at(-1)?.decision;
      deps.log("memory.observer.noop_compaction_skipped", {
        thread_id: job.threadId,
        idle,
        reason: lastDecision?.reason ?? "nothing_to_compact",
        net_benefit_usd: lastDecision?.netBenefitUsd ?? 0,
        candidate_count: segments.reduce((sum, segment) => sum + segment.length, 0),
        resolved_model: pricing.modelKey,
      });
      return { observationId: null, sourceMessageRange: null };
    }
    const { segment: candidates, decision } = selected;
    const compressed = candidates.slice(0, decision.compressedCount);

    if (compressed.length === 0) {
      // Idempotent / nothing to do — never write an empty observation. Still a
      // no-compaction run, so the eager fact pass applies.
      await maybeEagerExtractFacts(job, all, covered, deps);
      await deps.memoryStore.updateJobStatus(job.jobId, "done");
      deps.log("memory.observer.noop_no_old_messages", { thread_id: job.threadId });
      return { observationId: null, sourceMessageRange: null };
    }

    const now = deps.now();
    const {
      observationText,
      priority,
      tags,
      importance: rawImportance,
    } = await deps.summarize({
      messages: compressed,
      now,
    });

    // docs/12 (P5 salience) — resolve the observation's `importance` ∈ [0,1] so the
    // forgetting score's decay-brake has a real input instead of always reading the
    // DB default 0.5. Preference: (1) an explicit `importance` from the summarizer;
    // (2) else DERIVE it from `priority`, treated as a 0–10 salience scale (the
    // Generative-Agents convention) → clamp(priority/10, 0, 1); (3) else leave
    // undefined so the store applies its 0.5 default. Pure + deterministic.
    const importance =
      rawImportance !== undefined
        ? Math.min(1, Math.max(0, rawImportance))
        : priority !== undefined
          ? Math.min(1, Math.max(0, priority / 10))
          : undefined;

    // source_message_range is REQUIRED + must be precise (docs/08 auditability).
    const first = compressed[0];
    const last = compressed[compressed.length - 1];
    if (first === undefined || last === undefined) {
      // Unreachable given length>0, but keep the range non-null guarantee honest.
      throw new Error("observer: empty compressed range");
    }
    const sourceMessageRange: [string, string] = [first.id, last.id];

    const observationId = await deps.memoryStore.appendObservation({
      threadId: job.threadId,
      sourceMessageRange,
      observationText,
      observedAt: now,
      ...(priority !== undefined ? { priority } : {}),
      ...(importance !== undefined ? { importance } : {}),
      ...(tags !== undefined ? { tags } : {}),
    });

    // Book Observer tokens into their OWN bucket — never the provider/actor one.
    deps.costSink("observer", estimateObserverTokens(compressed, observationText));

    await deps.memoryStore.updateJobStatus(job.jobId, "done");
    deps.log("memory.observer.compressed", {
      thread_id: job.threadId,
      observation_id: observationId,
      source_range: sourceMessageRange,
      compressed_count: compressed.length,
      compaction_reason: decision.reason,
      compaction_net_benefit_usd: decision.netBenefitUsd,
      kept_recent: decision.keepRecent,
      idle,
      // Provenance: the auto-resolved economics, reproducible from this line.
      resolved_model: pricing.modelKey,
      price_source: priceProvenance(pricing),
      measured_retention: inputs.measuredRetention,
      prior_compaction_count: inputs.priorCompactionCount,
    });
    return { observationId, sourceMessageRange };
  } catch (err) {
    // fail-open: Observer failure must never bubble to the request path. Record
    // it on the job + log; the request that enqueued this job is long gone.
    const message = err instanceof Error ? err.message : String(err);
    try {
      await deps.memoryStore.updateJobStatus(job.jobId, "failed", message);
    } catch (updateErr) {
      // Even the failure bookkeeping is best-effort — still never throw.
      deps.log("memory.observer.job_update_failed", {
        thread_id: job.threadId,
        error: updateErr instanceof Error ? updateErr.message : String(updateErr),
      });
    }
    deps.log("memory.observer.failed", { thread_id: job.threadId, error: message });
    return { observationId: null, sourceMessageRange: null };
  }
}
