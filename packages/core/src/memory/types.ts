import { MemoryModeSchema } from "@helm/shared";
import { z } from "zod";

// Memory observe-phase value contracts (docs/08). Framework-agnostic: these are
// PURE data shapes that gateway assembles from request headers and hands to
// core — packages/core never parses HTTP itself (CLAUDE.md principle 1). Per the
// Zod schema-first rule, every type below comes from z.infer (no hand-written
// interfaces). Memory is a MIDDLEWARE; nothing here touches routing/lane state.

// Resolved memory scope for a request. The gateway boundary reads x-thread-id /
// x-resource-id / x-project-id / x-memory-mode and produces this; an absent or
// illegal x-memory-mode is normalized to "off" (default-safe) BEFORE it reaches
// core (see resolveMemoryMode helper).
export const MemoryScopeSchema = z.object({
  threadId: z.string().nullable(),
  resourceId: z.string().nullable(),
  projectId: z.string().nullable(),
  // Reuses the single source of truth for the mode enum (@helm/shared).
  mode: MemoryModeSchema,
});
export type MemoryScope = z.infer<typeof MemoryScopeSchema>;

// Request-level memory metadata surfaced to the request log / debug UI (docs/08
// "调试 UI 字段"). observe NEVER hydrates, so memory_hydrated is always false and
// the hydrate/observer/reflector counters stay at their null/zero defaults until
// the inject phase lights them up. This object carries NO injectable prompt.
export const MemoryMetaSchema = z.object({
  memory_mode: MemoryModeSchema,
  thread_id: z.string().nullable(),
  resource_id: z.string().nullable(),
  project_id: z.string().nullable(),
  memory_hydrated: z.boolean(),
  reflection_version: z.number().int().nonnegative().nullable(),
  observation_count: z.number().int().nonnegative(),
  memory_tokens_injected: z.number().int().nonnegative(),
  observer_job_id: z.string().nullable(),
  memory_writeback_status: z.string().nullable(),
});
export type MemoryMeta = z.infer<typeof MemoryMetaSchema>;
