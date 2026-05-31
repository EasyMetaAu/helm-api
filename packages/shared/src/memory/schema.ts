import { z } from "zod";

// Memory middleware storage contracts (docs/08 "存储模型"). POST-MVP: these
// shapes back the persistence floor for the observe/inject phases — this layer
// only models thread + message inputs (no read/inject/compress here). Per
// CLAUDE.md the Zod schema is the single source of truth; types come from
// z.infer (no hand-written interfaces). Framework-agnostic.

// Role aligns with the IR message role (docs/08 list: user | assistant | tool).
export const MemoryRoleSchema = z.enum(["user", "assistant", "tool"]);

// Input to create/ensure a thread. project/resource/owner are optional so a
// thread can be scoped at request time without forcing a global user profile
// (docs/08 非目标: no cross-project / global profile).
export const MemoryThreadInputSchema = z.object({
  id: z.string().min(1),
  projectId: z.string().min(1).optional(),
  resourceId: z.string().min(1).optional(),
  ownerId: z.string().min(1).optional(),
});

// Input to append a raw message to a thread (observe phase persists originals).
export const MemoryMessageInputSchema = z.object({
  threadId: z.string().min(1),
  role: MemoryRoleSchema,
  content: z.string(), // raw message text / JSON string
  tokenEstimate: z.number().int().nonnegative(),
});

// A persisted raw message row read back from the store (docs/08 阶段 2 Observer
// reads originals to compress). Distinct from MemoryMessageInput: it carries the
// generated id + createdAt the store assigned, so the Observer can record a
// precise, auditable source_message_range against the originals.
export const RawMessageSchema = z.object({
  id: z.string().min(1),
  threadId: z.string().min(1),
  role: MemoryRoleSchema,
  content: z.string(),
  tokenEstimate: z.number().int().nonnegative(),
  createdAt: z.date(),
});

// Input to persist one compressed observation (docs/08 阶段 2). source_message_range
// is REQUIRED so compressed memory is auditable against its originals; observedAt
// is the time anchor; priority/tags are optional ranking hints.
export const MemoryObservationInputSchema = z.object({
  threadId: z.string().min(1),
  // [firstMessageId, lastMessageId] of the compressed range — REQUIRED (docs/08).
  sourceMessageRange: z.tuple([z.string().min(1), z.string().min(1)]),
  observationText: z.string().min(1),
  observedAt: z.date(),
  priority: z.number().int().optional(),
  tags: z.array(z.string()).optional(),
});

// A persisted observation row read back from the store (docs/08 阶段 2). The
// background Reflector reads a scope's active observations to merge them into a
// stable reflection; distinct from MemoryObservationInput it carries the
// generated id the store assigned. observedAt is the time anchor.
export const ObservationSchema = z.object({
  id: z.string().min(1),
  threadId: z.string().min(1),
  sourceMessageRange: z.tuple([z.string().min(1), z.string().min(1)]),
  observationText: z.string().min(1),
  observedAt: z.date(),
  priority: z.number().int().optional(),
  tags: z.array(z.string()).optional(),
});

// A persisted reflection row read back from the store (docs/08 "存储模型":
// memory_reflections). Reflections are VERSIONED + slowly-changing: the
// Reflector only bumps `version` when the merged text actually changes, keeping
// the injected prefix cache-friendly. Scoped at project / resource / thread
// level (no global / cross-project profile — docs/08 非目标).
export const ReflectionSchema = z.object({
  id: z.string().min(1),
  projectId: z.string().min(1).nullable(),
  resourceId: z.string().min(1).nullable(),
  threadId: z.string().min(1).nullable(),
  reflectionText: z.string().min(1),
  // Monotonic version — starts at 1, increments only on a real content change.
  version: z.number().int().positive(),
  tokenEstimate: z.number().int().nonnegative(),
  updatedAt: z.date(),
});

// The scope a reflection merges over: project / resource / thread (one or more
// levels). Mirrors the optional nullable scope columns on memory_reflections.
export const ReflectionScopeSchema = z.object({
  projectId: z.string().min(1).optional(),
  resourceId: z.string().min(1).optional(),
  threadId: z.string().min(1).optional(),
});

// Input to upsert a new reflection version (docs/08). The store assigns the id +
// updatedAt; the caller (Reflector) supplies the scope, merged text, the next
// version number and a token estimate.
export const ReflectionUpsertInputSchema = ReflectionScopeSchema.extend({
  reflectionText: z.string().min(1),
  version: z.number().int().positive(),
  tokenEstimate: z.number().int().nonnegative(),
  updatedAt: z.date(),
});

// The fixed layers of the inject-phase context prefix (docs/08 「上下文组装顺序」).
// The order of these literals is LOAD-BEARING: the inject assembler emits messages
// strictly in this sequence — system → project reflection → resource reflection →
// thread observations → recent raw → current. `source` tags which memory layer a
// message came from so the debug UI + tests can assert the order/provenance, and
// so budget trimming can target the oldest observations first while NEVER dropping
// recent raw / current (docs/08 「必须保留近期原始消息」).
export const AssembledMessageSourceSchema = z.enum([
  "system",
  "project_reflection",
  "resource_reflection",
  "thread_observation",
  "recent_raw",
  "current",
]);

// One assembled context message produced by the inject phase. role aligns with
// the IR message role; content is the verbatim injectable text; source tags its
// memory layer. This carries NO routing/lane state — memory is a MIDDLEWARE.
export const AssembledMessageSchema = z.object({
  role: MemoryRoleSchema,
  content: z.string(),
  source: AssembledMessageSourceSchema,
});

export type MemoryRole = z.infer<typeof MemoryRoleSchema>;
export type MemoryThreadInput = z.infer<typeof MemoryThreadInputSchema>;
export type MemoryMessageInput = z.infer<typeof MemoryMessageInputSchema>;
export type RawMessage = z.infer<typeof RawMessageSchema>;
export type MemoryObservationInput = z.infer<typeof MemoryObservationInputSchema>;
export type Observation = z.infer<typeof ObservationSchema>;
export type Reflection = z.infer<typeof ReflectionSchema>;
export type ReflectionScope = z.infer<typeof ReflectionScopeSchema>;
export type ReflectionUpsertInput = z.infer<typeof ReflectionUpsertInputSchema>;
export type AssembledMessageSource = z.infer<typeof AssembledMessageSourceSchema>;
export type AssembledMessage = z.infer<typeof AssembledMessageSchema>;
