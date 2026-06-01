import type { RawMessage } from "@helm/shared";
import type { MemoryStore } from "../store/ports.js";

// Background Observer (docs/08 Phase 2 "observational-memory MVP"). This is an OFF-the-main-
// request-path job: the request path only persists raw messages and enqueues an
// observer job; this function runs LATER, in a background worker, compressing a
// thread's OLDER raw messages into a single time-anchored observation. It never
// runs synchronously inside a request and must NEVER throw to a caller on the
// request path — failure is recorded on the job + logged (fail-open, CLAUDE.md
// principle 3). Framework-agnostic: LLM (summarize), store, clock and cost sink
// are all dependency-injected; this module imports no web framework and never
// touches routing/lane state (memory is a MIDDLEWARE).

// How many of the most recent raw messages are PRESERVED uncompressed, so inject
// can still serve them verbatim (docs/08 "recent raw messages must be preserved, to avoid information loss from compression").
const RECENT_KEEP = 2;

// A background job: a pointer to the thread whose older history should be
// compressed. Enqueued by the request path, consumed asynchronously by a worker.
export interface ObserverJob {
  jobId: string;
  threadId: string;
}

export interface ObserverDeps {
  memoryStore: MemoryStore;
  // Compress a slice of raw messages into observation text. Injected so tests
  // use a deterministic stub and production uses an LLM. `now` lets the summary
  // embed a stable time anchor.
  summarize: (input: {
    messages: RawMessage[];
    now: Date;
  }) => Promise<{ observationText: string; priority?: number; tags?: string[] }>;
  // Observer tokens are a SEPARATE cost bucket (docs/08 "cost accounting"): they must
  // NOT be hidden inside actor/provider execution cost.
  costSink: (bucket: "observer", tokens: number) => void;
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
    const all = await deps.memoryStore.listMessages(job.threadId);
    // Preserve the recent window; only compress what's older than it.
    const compressed = all.slice(0, Math.max(0, all.length - RECENT_KEEP));

    if (compressed.length === 0) {
      // Idempotent / nothing to do — never write an empty observation.
      await deps.memoryStore.updateJobStatus(job.jobId, "done");
      deps.log("memory.observer.noop_no_old_messages", { thread_id: job.threadId });
      return { observationId: null, sourceMessageRange: null };
    }

    const now = deps.now();
    const { observationText, priority, tags } = await deps.summarize({
      messages: compressed,
      now,
    });

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
