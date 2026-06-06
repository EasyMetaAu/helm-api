import type { RawMessage } from "@helm/shared";
import type { MemoryStore } from "../store/ports.js";
import { chooseObserverCompaction, type ObserverCompactionPolicy } from "./compaction-policy.js";

// Background Observer (docs/08 Phase 2 "observational-memory MVP"). This is an OFF-the-main-
// request-path job: the request path only persists raw messages and enqueues an
// observer job; this function runs LATER, in a background worker, compressing a
// thread's OLDER raw messages into a single time-anchored observation. It never
// runs synchronously inside a request and must NEVER throw to a caller on the
// request path — failure is recorded on the job + logged (fail-open, CLAUDE.md
// principle 3). Framework-agnostic: LLM (summarize), store, clock and cost sink
// are all dependency-injected; this module imports no web framework and never
// touches routing/lane state (memory is a MIDDLEWARE).

// The legacy Observer policy preserves recent raw messages verbatim; the default
// value lives in compaction-policy.ts so the pure selector and runtime agree.

// A background job: a pointer to the thread whose older history should be
// compressed. Enqueued by the request path, consumed asynchronously by a worker.
export interface ObserverJob {
  jobId: string;
  accountId: string;
  threadId: string;
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
  // Optional economy-aware compaction gate. Absent => legacy fixed RECENT_KEEP=2.
  compaction?: ObserverCompactionPolicy;
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

function estimateObserverTokens(compressed: RawMessage[], observationText: string): number {
  const input = compressed.reduce((sum, m) => sum + m.tokenEstimate, 0);
  // Cheap output estimate; a real worker can swap in a tokenizer. ~4 chars/token.
  const output = Math.ceil(observationText.length / 4);
  return input + output;
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

    // Legacy default: keep the two most recent raw messages and summarize older
    // uncovered rows. When `compaction.mode=economy` is configured, the same cut
    // is chosen by a cache/summary-aware benefit model so short threads do not pay
    // for premature summaries. Covered rows stay excluded either way.
    const candidates = all.filter((m) => !covered.has(m.id));
    const decision = chooseObserverCompaction(candidates, deps.compaction);
    if (!decision.shouldCompact) {
      await deps.memoryStore.updateJobStatus(job.jobId, "done");
      deps.log("memory.observer.noop_compaction_skipped", {
        thread_id: job.threadId,
        reason: decision.reason,
        net_benefit_usd: decision.netBenefitUsd,
        candidate_count: candidates.length,
      });
      return { observationId: null, sourceMessageRange: null };
    }
    const compressed = candidates.slice(0, decision.compressedCount);

    if (compressed.length === 0) {
      // Idempotent / nothing to do — never write an empty observation.
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
