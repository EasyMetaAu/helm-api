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
// archives sub-threshold observations for one account. All three run OFF the request
// path. Additive: 'decay' is a NEW member, so an old observer/reflector row still
// parses unchanged — the gating lever (forgetting.enabled:false ⇒ no decay jobs are
// ever enqueued) keeps the enum widening inert until the flag is on.
export const MemoryJobTypeSchema = z.enum(["observer", "reflector", "decay"]);

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
  type: MemoryJobTypeSchema,
  scope: ReflectionScopeSchema,
});

export type MemoryJobType = z.infer<typeof MemoryJobTypeSchema>;
export type MemoryJobEnqueueInput = z.infer<typeof MemoryJobEnqueueInputSchema>;
export type MemoryJobRow = z.infer<typeof MemoryJobRowSchema>;
