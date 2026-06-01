import { randomUUID } from "node:crypto";
import type {
  MemoryMessageInput,
  MemoryObservationInput,
  MemoryThreadInput,
  Observation,
  RawMessage,
  Reflection,
  ReflectionScope,
  ReflectionUpsertInput,
} from "@helm/shared";
import { and, asc, desc, eq, isNull, type SQL } from "drizzle-orm";
import type { MemoryJobStatus, MemoryStore } from "../ports.js";
import {
  memoryJobs,
  memoryMessages,
  memoryObservations,
  memoryReflections,
  memoryThreads,
} from "./memory-schema.js";
import type { SqliteDb } from "./migrate.js";

// Build an EXACT scope match: each level is `= value` when present and `IS NULL`
// when absent, so a thread-scoped read never returns a project-scoped row (and
// vice versa). Enforces docs/08 scope isolation (no cross-project profile).
function reflectionScopeWhere(scope: ReflectionScope): SQL {
  const clauses: SQL[] = [
    scope.projectId !== undefined
      ? eq(memoryReflections.projectId, scope.projectId)
      : isNull(memoryReflections.projectId),
    scope.resourceId !== undefined
      ? eq(memoryReflections.resourceId, scope.resourceId)
      : isNull(memoryReflections.resourceId),
    scope.threadId !== undefined
      ? eq(memoryReflections.threadId, scope.threadId)
      : isNull(memoryReflections.threadId),
  ];
  // `and` of a non-empty list is always defined.
  return and(...clauses) as SQL;
}

// SQLite adapter for the MemoryStore port (docs/08). POST-MVP persistence floor:
// ensure threads + append raw messages only — no read/inject/compress here. The
// adapter owns dialect details (timestamps as epoch ms via Drizzle timestamp_ms)
// so core/ports stay DB-agnostic. Memory is a MIDDLEWARE: this store never reads
// or writes routing/lane state.
export class SqliteMemoryStore implements MemoryStore {
  constructor(
    private readonly db: SqliteDb,
    private readonly genId: () => string = randomUUID,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async ensureThread(input: MemoryThreadInput): Promise<void> {
    const ts = this.now();
    // Idempotent: insert once; on conflict touch updated_at + scope fields. No
    // duplicate rows, no in-place loss of created_at.
    this.db
      .insert(memoryThreads)
      .values({
        id: input.id,
        projectId: input.projectId ?? null,
        resourceId: input.resourceId ?? null,
        ownerId: input.ownerId ?? null,
        createdAt: ts,
        updatedAt: ts,
      })
      .onConflictDoUpdate({
        target: memoryThreads.id,
        set: {
          projectId: input.projectId ?? null,
          resourceId: input.resourceId ?? null,
          ownerId: input.ownerId ?? null,
          updatedAt: ts,
        },
      })
      .run();
  }

  async appendMessage(input: MemoryMessageInput): Promise<string> {
    const id = this.genId();
    this.db
      .insert(memoryMessages)
      .values({
        id,
        threadId: input.threadId,
        role: input.role,
        content: input.content,
        tokenEstimate: input.tokenEstimate,
        createdAt: this.now(),
      })
      .run();
    return id;
  }

  // POST-MVP Phase 2 (Observer): read a thread's raw messages oldest-first.
  async listMessages(threadId: string): Promise<RawMessage[]> {
    const rows = this.db
      .select()
      .from(memoryMessages)
      .where(eq(memoryMessages.threadId, threadId))
      .orderBy(asc(memoryMessages.createdAt), asc(memoryMessages.id))
      .all();
    return rows.map((row) => ({
      id: row.id,
      threadId: row.threadId,
      // Stored role is the IR-aligned enum; widen back to the shared union.
      role: row.role as RawMessage["role"],
      content: row.content,
      tokenEstimate: row.tokenEstimate,
      createdAt: row.createdAt,
    }));
  }

  // Persist one compressed observation. tags are JSON-encoded (SQLite has no
  // native array); the source range tuple is JSON text too — dialect quirk owned
  // here so core/ports stay DB-agnostic.
  async appendObservation(input: MemoryObservationInput): Promise<string> {
    const id = this.genId();
    this.db
      .insert(memoryObservations)
      .values({
        id,
        threadId: input.threadId,
        sourceMessageRange: JSON.stringify(input.sourceMessageRange),
        observationText: input.observationText,
        observedAt: input.observedAt,
        referencedAt: null,
        priority: input.priority ?? null,
        tags: input.tags !== undefined ? JSON.stringify(input.tags) : null,
      })
      .run();
    return id;
  }

  // POST-MVP Phase 2 (Reflector): read a scope's active observations oldest-first.
  // Scope is matched on thread_id only here (observations are thread-anchored in
  // storage); the Reflector merges them into a scope-level reflection. Returns
  // empty when the scope has no thread anchor.
  async listObservations(scope: ReflectionScope): Promise<Observation[]> {
    if (scope.threadId === undefined) return [];
    const rows = this.db
      .select()
      .from(memoryObservations)
      .where(eq(memoryObservations.threadId, scope.threadId))
      .orderBy(asc(memoryObservations.observedAt), asc(memoryObservations.id))
      .all();
    return rows.map((row) => {
      const range = JSON.parse(row.sourceMessageRange) as [string, string];
      return {
        id: row.id,
        threadId: row.threadId,
        sourceMessageRange: range,
        observationText: row.observationText,
        observedAt: row.observedAt,
        ...(row.priority !== null ? { priority: row.priority } : {}),
        ...(row.tags !== null ? { tags: JSON.parse(row.tags) as string[] } : {}),
      };
    });
  }

  // Read the latest (highest-version) reflection for an EXACT scope match. Absent
  // scope levels must be NULL in storage (never a different scope's row) so the
  // Reflector never crosses project/resource/thread boundaries (docs/08 isolation).
  async getReflection(scope: ReflectionScope): Promise<Reflection | null> {
    const row = this.db
      .select()
      .from(memoryReflections)
      .where(reflectionScopeWhere(scope))
      .orderBy(desc(memoryReflections.version))
      .limit(1)
      .get();
    if (row === undefined) return null;
    return {
      id: row.id,
      projectId: row.projectId,
      resourceId: row.resourceId,
      threadId: row.threadId,
      reflectionText: row.reflectionText,
      version: row.version,
      tokenEstimate: row.tokenEstimate,
      updatedAt: row.updatedAt,
    };
  }

  // Persist a NEW reflection version. Reflections are append-only by version so
  // history is auditable; the latest version wins on read (getReflection).
  async upsertReflection(input: ReflectionUpsertInput): Promise<string> {
    const id = this.genId();
    this.db
      .insert(memoryReflections)
      .values({
        id,
        projectId: input.projectId ?? null,
        resourceId: input.resourceId ?? null,
        threadId: input.threadId ?? null,
        reflectionText: input.reflectionText,
        version: input.version,
        tokenEstimate: input.tokenEstimate,
        updatedAt: input.updatedAt,
      })
      .run();
    return id;
  }

  // Update a background job's lifecycle status (+ optional error on failure).
  async updateJobStatus(jobId: string, status: MemoryJobStatus, error?: string): Promise<void> {
    this.db
      .update(memoryJobs)
      .set({
        status,
        error: error ?? null,
        updatedAt: this.now(),
      })
      .where(eq(memoryJobs.id, jobId))
      .run();
  }
}
