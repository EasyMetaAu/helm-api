import { z } from "zod";
import { ReflectionScopeSchema } from "./schema.js";

// Memory middleware background-job queue contracts (docs/08 Phase 2). The inject
// phase enqueues an observer job; the observer, after writing a new observation,
// promotes a reflector job; a background worker claims pending rows and dispatches
// by `type`. Per CLAUDE.md the Zod schema is the single source of truth — types
// come from z.infer (no hand-written interfaces). Framework-agnostic.

// The background job kinds. observer = compress a thread's older raw messages into
// one observation; reflector = merge a scope's observations into a stable, versioned
// reflection; decay (docs/12 P5) = the OFF-hot-path forgetting SWEEP that soft-
// archives sub-threshold observations for one account. embedding (docs/14 P8) =
// backfill `memory_facts.embedding` for newly inserted facts so hybrid recall gets a
// vector leg. All run OFF the request path. Additive: each new member leaves older
// rows parsing unchanged — the gating levers (forgetting.enabled / facts_retrieval.
// enabled / llm.embedding_model off ⇒ those jobs are never enqueued) keep the enum
// widening inert until the flag is on.
export const MemoryJobTypeSchema = z.enum(["observer", "reflector", "decay", "embedding"]);

// Input to enqueue a background job. The scope is the full ReflectionScope so a
// reflector job can land at the highest available level (project/resource/thread);
// an observer job uses scope.threadId. The store encodes the scope into the single
// memory_jobs.scope_id TEXT column (canonical JSON) and decodes it back on claim.
export const MemoryJobEnqueueInputSchema = z.object({
  type: MemoryJobTypeSchema,
  scope: ReflectionScopeSchema,
});

// A claimed job row read back from the store, with the scope already DECODED from
// the scope_id column. The worker dispatches on `type` and consumes `scope`.
export const MemoryJobRowSchema = z.object({
  jobId: z.string().min(1),
  // Incremented atomically on every claim/reclaim. Optional only so older
  // in-process fixtures remain parseable; production claims always return it.
  leaseGeneration: z.number().int().positive().optional(),
  type: MemoryJobTypeSchema,
  scope: ReflectionScopeSchema,
});

export type MemoryJobType = z.infer<typeof MemoryJobTypeSchema>;
export type MemoryJobEnqueueInput = z.infer<typeof MemoryJobEnqueueInputSchema>;
export type MemoryJobRow = z.infer<typeof MemoryJobRowSchema>;
