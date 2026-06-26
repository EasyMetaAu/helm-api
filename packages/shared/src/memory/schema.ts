import { z } from "zod";

// Memory middleware storage contracts (docs/08 "storage model"). POST-MVP: these
// shapes back the persistence floor for the observe/inject phases — this layer
// only models thread + message inputs (no read/inject/compress here). Per
// CLAUDE.md the Zod schema is the single source of truth; types come from
// z.infer (no hand-written interfaces). Framework-agnostic.

// Role aligns with the IR message role (docs/08 list: user | assistant | tool).
export const MemoryRoleSchema = z.enum(["user", "assistant", "tool"]);

// Input to create/ensure a thread. project/resource/owner are optional so a
// thread can be scoped at request time without forcing a global user profile
// (docs/08 non-goals: no cross-project / global profile).
export const MemoryThreadInputSchema = z.object({
  id: z.string().min(1),
  projectId: z.string().min(1).optional(),
  resourceId: z.string().min(1).optional(),
  ownerId: z.string().min(1).optional(),
});

// Input to append a raw message to a thread (observe phase persists originals).
export const MemoryMessageInputSchema = z.object({
  threadId: z.string().min(1),
  // Stable zero-based position within the client-visible transcript. Production
  // observe writes always supply it; it stays optional at the port boundary so
  // older low-level tests/fakes can still write single messages.
  messageIndex: z.number().int().nonnegative().optional(),
  role: MemoryRoleSchema,
  content: z.string(), // raw message text / JSON string
  tokenEstimate: z.number().int().nonnegative(),
});

// A persisted raw message row read back from the store (docs/08 Phase 2 Observer
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

// Input to persist one compressed observation (docs/08 Phase 2). source_message_range
// is REQUIRED so compressed memory is auditable against its originals; observedAt
// is the time anchor; priority/tags are optional ranking hints.
export const MemoryObservationInputSchema = z.object({
  threadId: z.string().min(1),
  // [firstMessageId, lastMessageId] of the compressed range — REQUIRED (docs/08).
  sourceMessageRange: z.tuple([z.string().min(1), z.string().min(1)]),
  observationText: z.string().min(1),
  observedAt: z.date(),
  priority: z.number().int().optional(),
  // docs/12 (P5 salience). Optional [0,1] importance the Observer resolves (from a
  // summarizer rating, or derived from `priority`); the store applies 0.5 when
  // absent. This is the forgetting score's decay-brake multiplier.
  importance: z.number().min(0).max(1).optional(),
  tags: z.array(z.string()).optional(),
});

// docs/12 "Forgetting score" — the mid-tier (observation) status enum. `active`
// rows are injected + counted toward the budget; `archived` rows are
// soft-invalidated by the decay sweep (never deleted), invisible to content
// reads, but kept for audit. `pruned` is the retention tombstone (docs/12 P7):
// an aged-out archived row whose bulky text has been freed, but whose row +
// `sourceMessageRange` are KEPT so it still marks its raw messages as covered —
// a hard DELETE here would orphan that coverage and resurrect the raw turns into
// inject/observer. Content reads treat `archived` and `pruned` identically
// (invisible); only coverage reads (raw dedup) still see them.
export const MemoryStatusSchema = z.enum(["active", "archived", "pruned"]);

// A persisted observation row read back from the store (docs/08 Phase 2). The
// background Reflector reads a scope's active observations to merge them into a
// stable reflection; distinct from MemoryObservationInput it carries the
// generated id the store assigned. observedAt is the time anchor.
//
// docs/12 "Schema deltas" (P2): the forgetting columns are appended as
// OPTIONAL-WITH-DEFAULT so a row persisted before the v18 migration still parses
// (the regression guard) — `ObservationSchema.parse(oldRow)` backfills
// reference_count=0 / importance=0.5 / status='active' and leaves the nullable
// timestamps null. referencedAt starts null (never reinforced); the score fn
// (P0) coalesces a null referencedAt to observedAt, so null can never produce a
// NaN score. With forgetting.enabled=false nothing reads these fields, so the
// defaults are inert and runtime is byte-identical to today.
export const ObservationSchema = z.object({
  id: z.string().min(1),
  threadId: z.string().min(1),
  sourceMessageRange: z.tuple([z.string().min(1), z.string().min(1)]),
  observationText: z.string().min(1),
  observedAt: z.date(),
  priority: z.number().int().optional(),
  tags: z.array(z.string()).optional(),
  // Forgetting deltas (docs/12). Optional-with-default → legacy rows still parse.
  referenceCount: z.number().int().nonnegative().default(0),
  importance: z.number().min(0).max(1).default(0.5),
  status: MemoryStatusSchema.default("active"),
  // Nullable timestamps: null = "not yet" (never reinforced / not archived /
  // not superseded). Default null so an absent field parses to an explicit null.
  referencedAt: z.date().nullish().default(null),
  archivedAt: z.date().nullish().default(null),
  expiredAt: z.date().nullish().default(null),
});

// A persisted reflection row read back from the store (docs/08 "storage model":
// memory_reflections). Reflections are VERSIONED + slowly-changing: the
// Reflector only bumps `version` when the merged text actually changes, keeping
// the injected prefix cache-friendly. Scoped at project / resource / thread
// level (no global / cross-project profile — docs/08 non-goals).
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
  // Forgetting deltas (docs/12 "Schema deltas", P2): reference tracking +
  // visibility only — reflections are the slow-changing long tier, so they get
  // no importance/archived columns (only observations decay-archive). Appended
  // optional-with-default so a pre-v18 reflection row still parses; the score fn
  // coalesces a null referencedAt to updatedAt (the reflection tier's fallback).
  referencedAt: z.date().nullish().default(null),
  referenceCount: z.number().int().nonnegative().default(0),
  status: MemoryStatusSchema.default("active"),
});

// The scope a reflection merges over: project / resource / thread (one or more
// levels), always bound to the authenticated account owner.
export const ReflectionScopeSchema = z.object({
  accountId: z.string().min(1),
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

// The fixed layers of the inject-phase context prefix (docs/08 "context assembly order").
// The order of these literals is LOAD-BEARING: the inject assembler emits messages
// strictly in this sequence — system → project reflection → resource reflection →
// thread observations → recent raw → current. `source` tags which memory layer a
// message came from so the debug UI + tests can assert the order/provenance, and
// so budget trimming can target the oldest observations first while NEVER dropping
// recent raw / current (docs/08 "recent raw messages must be retained").
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

// docs/12 "Schema deltas" — memory_facts, the deduplicated, supersedable
// atomic-fact layer of the LONG tier (the discrete facts reflections gesture at
// today but never store). A persisted fact row read back from the store.
//
// Tenant isolation (docs/12 "Tenant isolation"): a fact has NO guaranteed
// memory_threads parent (a project/resource-level fact may have a null
// threadId), so it carries `ownerId` (= accountId) ITSELF as the tenant
// boundary. project/resource/thread are in-account SCOPES and may be null.
// Every fact read/dedup/supersede predicate must include ownerId; the dedup
// index is account-scoped (`UNIQUE(owner_id, content_hash)`), never global.
//
// Bi-temporal validity (docs/12 "time as structure"): validFrom = when the fact
// became true (valid_at); invalidAt = when it became false; expiredAt = when the
// system LEARNED it was superseded (supersede-on-contradiction stamps this — a
// pure datetime UPDATE, no LLM). Reads filter `expiredAt IS NULL`.
export const FactSchema = z.object({
  id: z.string().min(1),
  ownerId: z.string().min(1), // accountId — the tenant boundary
  projectId: z.string().min(1).nullable(),
  resourceId: z.string().min(1).nullable(),
  threadId: z.string().min(1).nullable(),
  subjectKey: z.string().min(1), // normalized topic key for same-subject supersede
  factText: z.string().min(1),
  contentHash: z.string().min(1), // sha256(normalized_text) — idempotent ingest
  importance: z.number().min(0).max(1).default(0.5),
  referenceCount: z.number().int().nonnegative().default(0),
  // last_referenced_at — null → score coalesces to createdAt (the fact tier's fallback).
  referencedAt: z.date().nullish().default(null),
  validFrom: z.date(), // fact became true (bi-temporal: valid_at)
  invalidAt: z.date().nullish().default(null), // fact became false
  expiredAt: z.date().nullish().default(null), // system learned it was superseded
  status: MemoryStatusSchema.default("active"),
  // Audit trail back to observations: [firstObservationId, lastObservationId].
  sourceObservationRange: z.tuple([z.string().min(1), z.string().min(1)]).optional(),
  createdAt: z.date(),
  updatedAt: z.date(),
});

// Input to write/ingest one fact (the Reflector's new sibling output, P6).
// ownerId is REQUIRED and is the authenticated accountId — NEVER client-supplied
// (docs/12 "Tenant isolation"): the store assigns id/createdAt/updatedAt, the
// caller supplies scope + text + the deterministic contentHash + validFrom.
// Defaults mirror FactSchema so an input round-trips into a row.
export const MemoryFactInputSchema = z.object({
  ownerId: z.string().min(1), // accountId — required, server-derived
  projectId: z.string().min(1).optional(),
  resourceId: z.string().min(1).optional(),
  threadId: z.string().min(1).optional(),
  subjectKey: z.string().min(1),
  factText: z.string().min(1),
  contentHash: z.string().min(1),
  importance: z.number().min(0).max(1).default(0.5),
  referenceCount: z.number().int().nonnegative().default(0),
  referencedAt: z.date().nullish().default(null),
  validFrom: z.date(),
  invalidAt: z.date().nullish().default(null),
  expiredAt: z.date().nullish().default(null),
  status: MemoryStatusSchema.default("active"),
  sourceObservationRange: z.tuple([z.string().min(1), z.string().min(1)]).optional(),
});

// docs/13 — Memory admin + MCP surfaces. A scope-group summary for the admin
// "By Scope" view: one row per distinct (account, project, resource, thread)
// group that holds active facts and/or an active reflection, with per-tier
// counts and the most-recent updatedAt across both tiers. lastUpdated is null
// only defensively (a group with zero live rows is never emitted by the store).
export const MemoryScopeSummarySchema = z.object({
  accountId: z.string().min(1),
  projectId: z.string().min(1).nullable(),
  resourceId: z.string().min(1).nullable(),
  threadId: z.string().min(1).nullable(),
  factCount: z.number().int().nonnegative(),
  reflectionCount: z.number().int().nonnegative(),
  lastUpdated: z.date().nullable(),
});

// docs/13 — admin/MCP fact edit (partial). An ABSENT key leaves the column
// unchanged; `invalidAt` is tri-state (absent = leave, null = clear, date =
// set). Editing `factText` recomputes content_hash in the store — a collision
// with a sibling row's (owner_id, content_hash) surfaces as 409. `subjectKey`
// is deliberately NOT editable here: it is the supersede identity, independent
// of free-text wording (docs/13). `status` lets an operator archive/prune or
// re-activate a row. `.strict()` so an unknown field fails closed.
export const MemoryFactPatchSchema = z
  .object({
    factText: z.string().min(1).optional(),
    importance: z.number().min(0).max(1).optional(),
    status: MemoryStatusSchema.optional(),
    invalidAt: z.coerce.date().nullable().optional(),
  })
  .strict();

// docs/13 — admin/MCP reflection edit. Edits the targeted row's text IN PLACE;
// the store recomputes tokenEstimate + stamps updatedAt but does NOT bump
// `version` (that stays the Reflector's machine-merge counter, docs/13).
export const MemoryReflectionPatchSchema = z
  .object({
    reflectionText: z.string().min(1),
  })
  .strict();

// docs/13 — admin "add fact". The operator supplies a free-text SUBJECT (normalized
// to the supersede key in the store, like every machine-extracted fact) + the fact
// text + an optional importance. No status: a hand-added fact is always `active`.
// `.strict()` so an unknown field fails closed.
export const MemoryFactCreateSchema = z
  .object({
    subjectText: z.string().min(1),
    factText: z.string().min(1),
    importance: z.number().min(0).max(1).optional(),
  })
  .strict();

export type MemoryRole = z.infer<typeof MemoryRoleSchema>;
export type MemoryThreadInput = z.infer<typeof MemoryThreadInputSchema>;
export type MemoryMessageInput = z.infer<typeof MemoryMessageInputSchema>;
export type RawMessage = z.infer<typeof RawMessageSchema>;
export type MemoryObservationInput = z.infer<typeof MemoryObservationInputSchema>;
export type MemoryStatus = z.infer<typeof MemoryStatusSchema>;
// The status VALUES the management fact-list filter accepts. `superseded` is NOT a
// stored status — it is the derived view `status='active' AND expired_at IS NOT NULL`
// (a live fact replaced by a newer same-subject one). `all` drops the status predicate.
export type FactListStatus = MemoryStatus | "all" | "superseded";
export type Observation = z.infer<typeof ObservationSchema>;
export type Reflection = z.infer<typeof ReflectionSchema>;
export type Fact = z.infer<typeof FactSchema>;
// z.input (not z.infer): the defaulted fields (importance / referenceCount /
// status / the nullable timestamps) are OPTIONAL for the caller — the Reflector
// supplies only scope + text + contentHash + validFrom; the store applies the
// defaults on write (docs/12 P6). z.infer would make them required on the DTO.
export type MemoryFactInput = z.input<typeof MemoryFactInputSchema>;
export type MemoryScopeSummary = z.infer<typeof MemoryScopeSummarySchema>;
export type MemoryFactPatch = z.infer<typeof MemoryFactPatchSchema>;
export type MemoryFactCreate = z.infer<typeof MemoryFactCreateSchema>;
export type MemoryReflectionPatch = z.infer<typeof MemoryReflectionPatchSchema>;
export type ReflectionScope = z.infer<typeof ReflectionScopeSchema>;
export type ReflectionUpsertInput = z.infer<typeof ReflectionUpsertInputSchema>;
export type AssembledMessageSource = z.infer<typeof AssembledMessageSourceSchema>;
export type AssembledMessage = z.infer<typeof AssembledMessageSchema>;
