import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

// SQLite (Drizzle) table definitions for the memory middleware (docs/08
// "存储模型"). POST-MVP persistence floor: build + migrate only — no read /
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
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
});

export const memoryMessages = sqliteTable("memory_messages", {
  id: text("id").primaryKey(),
  threadId: text("thread_id").notNull(), // references memory_threads.id only
  role: text("role").notNull(), // 'user' | 'assistant' | 'tool' (IR-aligned)
  content: text("content").notNull(), // raw message text / JSON
  tokenEstimate: integer("token_estimate").notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
});

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
});

export const memoryReflections = sqliteTable("memory_reflections", {
  id: text("id").primaryKey(),
  projectId: text("project_id"),
  resourceId: text("resource_id"),
  threadId: text("thread_id"),
  reflectionText: text("reflection_text").notNull(),
  version: integer("version").notNull(), // monotonically increasing
  tokenEstimate: integer("token_estimate").notNull(),
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
export type MemoryJobsTable = typeof memoryJobs;
