import { integer, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

// SQLite (Drizzle) table definitions for the memory middleware (docs/08
// "storage model"). POST-MVP persistence floor: build + migrate only — no read /
// inject / compress here. These tables are deliberately ISOLATED from the
// routing/key tables (lanes/policies/api_keys): memory is a MIDDLEWARE, not a
// routing strategy, and must never reach into lane rules (docs/08, CLAUDE.md).
// Dialect quirks (no native array/boolean; tags + ranges stored as JSON text)
// are encapsulated HERE so core and the supabase adapter never see them.

export const memoryThreads = sqliteTable("memory_threads", {
  id: text("id").primaryKey(), // uuid/cuid
  projectId: text("project_id"),
  resourceId: text("resource_id"),
  ownerId: text("owner_id"),
  // Alias of the model that served the thread's latest turn (v20). Stamped
  // best-effort by observeOutbound AFTER execution; the background observer
  // reads it to price the auto-compaction ledger. NULL = never stamped.
  lastServedModel: text("last_served_model"),
  // Denormalized admin activity (v39). getMemoryAdminStats used to COUNT/MAX the
  // raw message and observation tables on every cold page load. Those tables can
  // hold millions of body rows, and better-sqlite3 blocks Node while scanning.
  // Keep the small per-thread summary on the parent row instead; insert/prune
  // paths update it transactionally and the migration backfills existing data.
  messageCount: integer("message_count").notNull().default(0),
  lastMessageAt: integer("last_message_at", { mode: "timestamp_ms" }),
  observationCount: integer("observation_count").notNull().default(0),
  lastObservationAt: integer("last_observation_at", { mode: "timestamp_ms" }),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
});

export const memoryMessages = sqliteTable(
  "memory_messages",
  {
    id: text("id").primaryKey(),
    threadId: text("thread_id").notNull(), // references memory_threads.id only
    role: text("role").notNull(), // 'user' | 'assistant' | 'tool' (IR-aligned)
    content: text("content").notNull(), // raw message text / JSON
    tokenEstimate: integer("token_estimate").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    // Stable client-transcript position. This keeps repeated text at different
    // positions distinct while still making re-sent history idempotent.
    messageIndex: integer("message_index"),
    // Idempotency key (v21): sha256(content) hex, NO normalization. The client
    // re-sends the full transcript every turn; the UNIQUE(thread_id,
    // message_index, role, content_hash) index + ON CONFLICT DO NOTHING collapses
    // re-ingestion to a no-op while preserving repeated text at new positions.
    // NULL only for pre-v21 rows the ops script backfills — NULLs are distinct in
    // a UNIQUE index, so the index still builds.
    contentHash: text("content_hash"),
  },
  (t) => [
    uniqueIndex("uniq_memory_messages_thread_idx_role_hash").on(
      t.threadId,
      t.messageIndex,
      t.role,
      t.contentHash,
    ),
  ],
);

export const memoryObservations = sqliteTable("memory_observations", {
  id: text("id").primaryKey(),
  threadId: text("thread_id").notNull(),
  // docs/08: REQUIRED — records which memory_messages this observation was
  // compressed from, so compressed memory can be audited against originals.
  sourceMessageRange: text("source_message_range").notNull(),
  observationText: text("observation_text").notNull(),
  observedAt: integer("observed_at", { mode: "timestamp_ms" }).notNull(),
  referencedAt: integer("referenced_at", { mode: "timestamp_ms" }), // nullable
  priority: integer("priority"), // nullable
  tags: text("tags"), // JSON text array (SQLite has no native array)
  // Forgetting-score columns (docs/12 "Schema deltas", v18). The mid tier
  // decay-archives, so it carries the full score input set: reference_count +
  // importance feed the score, status/archived_at soft-invalidate, expired_at
  // mirrors the long-tier supersede stamp. Defaults keep legacy rows inert.
  referenceCount: integer("reference_count").notNull().default(0),
  importance: real("importance").notNull().default(0.5),
  status: text("status").notNull().default("active"), // active | archived
  archivedAt: integer("archived_at", { mode: "timestamp_ms" }), // nullable
  expiredAt: integer("expired_at", { mode: "timestamp_ms" }), // nullable
});

export const memoryReflections = sqliteTable("memory_reflections", {
  id: text("id").primaryKey(),
  ownerId: text("owner_id"),
  projectId: text("project_id"),
  resourceId: text("resource_id"),
  threadId: text("thread_id"),
  reflectionText: text("reflection_text").notNull(),
  version: integer("version").notNull(), // monotonically increasing
  tokenEstimate: integer("token_estimate").notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  // Forgetting deltas (docs/12 v18): reference tracking + visibility only —
  // reflections are the slow-changing long tier (no importance/archived).
  referencedAt: integer("referenced_at", { mode: "timestamp_ms" }), // nullable
  referenceCount: integer("reference_count").notNull().default(0),
  status: text("status").notNull().default("active"),
});

// docs/12 "Schema deltas" — memory_facts, the deduplicated, supersedable
// atomic-fact long tier. owner_id (= accountId) is the TENANT BOUNDARY (a fact
// may have a null thread_id, so it cannot lean on memory_threads.owner_id);
// project/resource/thread are in-account scopes and may be null. Dedup is
// account-scoped (UNIQUE(owner_id, content_hash), declared in the v18 migration,
// not here). Bi-temporal validity: valid_from/invalid_at/expired_at.
export const memoryFacts = sqliteTable("memory_facts", {
  id: text("id").primaryKey(),
  ownerId: text("owner_id").notNull(), // accountId — the tenant boundary
  projectId: text("project_id"),
  resourceId: text("resource_id"),
  threadId: text("thread_id"),
  subjectKey: text("subject_key").notNull(),
  factText: text("fact_text").notNull(),
  contentHash: text("content_hash").notNull(), // sha256(normalized_text)
  importance: real("importance").notNull().default(0.5),
  referenceCount: integer("reference_count").notNull().default(0),
  referencedAt: integer("referenced_at", { mode: "timestamp_ms" }), // nullable
  validFrom: integer("valid_from", { mode: "timestamp_ms" }).notNull(),
  invalidAt: integer("invalid_at", { mode: "timestamp_ms" }), // nullable
  expiredAt: integer("expired_at", { mode: "timestamp_ms" }), // nullable
  status: text("status").notNull().default("active"),
  sourceObservationRange: text("source_observation_range"), // JSON text; nullable
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
});

export const memoryJobs = sqliteTable("memory_jobs", {
  id: text("id").primaryKey(),
  type: text("type").notNull(), // 'observer' | 'reflector'
  scopeId: text("scope_id").notNull(), // thread/resource/project id
  status: text("status").notNull(), // 'pending' | 'running' | 'done' | 'failed'
  error: text("error"), // nullable
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
});

export type MemoryThreadsTable = typeof memoryThreads;
export type MemoryMessagesTable = typeof memoryMessages;
export type MemoryObservationsTable = typeof memoryObservations;
export type MemoryReflectionsTable = typeof memoryReflections;
export type MemoryFactsTable = typeof memoryFacts;
export type MemoryJobsTable = typeof memoryJobs;
