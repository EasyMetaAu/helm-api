import { randomUUID } from "node:crypto";
import {
  decodeScopeId,
  encodeScopeId,
  type MemoryJobEnqueueInput,
  type MemoryJobRow,
  type MemoryMessageInput,
  type MemoryObservationInput,
  type MemoryThreadInput,
  type Observation,
  type RawMessage,
  type Reflection,
  type ReflectionScope,
  type ReflectionUpsertInput,
} from "@helm/shared";
import { and, asc, desc, eq, isNull, type SQL, sql } from "drizzle-orm";
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
    eq(memoryReflections.ownerId, scope.accountId),
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
      .onConflictDoNothing()
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
  async listMessages(scope: { threadId: string; accountId: string }): Promise<RawMessage[]> {
    const rows = this.db
      .select()
      .from(memoryMessages)
      .where(
        and(
          eq(memoryMessages.threadId, scope.threadId),
          sql`EXISTS (SELECT 1 FROM memory_threads mt WHERE mt.id = ${memoryMessages.threadId} AND mt.owner_id = ${scope.accountId})`,
        ),
      )
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
      .where(
        and(
          eq(memoryObservations.threadId, scope.threadId),
          sql`EXISTS (SELECT 1 FROM memory_threads mt WHERE mt.id = ${memoryObservations.threadId} AND mt.owner_id = ${scope.accountId})`,
        ),
      )
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
        ownerId: input.accountId,
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

  // Enqueue a background job. DEDUPE (D6): the partial unique index on OPEN
  // (pending/running) jobs owns the concurrency boundary; this method tries the
  // insert first, then reads the existing open row when another request won.
  async enqueueJob(input: MemoryJobEnqueueInput): Promise<string> {
    const scopeId = encodeScopeId(input.scope);
    const id = this.genId();
    const ts = this.now().getTime();
    const inserted = this.db.$sqlite
      .prepare(
        `INSERT OR IGNORE INTO memory_jobs
           (id, type, scope_id, status, error, created_at, updated_at)
         VALUES (?, ?, ?, 'pending', NULL, ?, ?)`,
      )
      .run(id, input.type, scopeId, ts, ts);
    if (inserted.changes === 1) return id;

    const existing = this.db.$sqlite
      .prepare(
        `SELECT id FROM memory_jobs
          WHERE type = ? AND scope_id = ? AND status IN ('pending', 'running')
          ORDER BY created_at ASC, id ASC
          LIMIT 1`,
      )
      .get(input.type, scopeId) as { id: string } | undefined;
    if (existing !== undefined) return existing.id;

    // If INSERT OR IGNORE was skipped for a non-open unique conflict, retry once;
    // completed jobs must not block a new pending enqueue for the same scope.
    this.db.$sqlite
      .prepare(
        `INSERT INTO memory_jobs
           (id, type, scope_id, status, error, created_at, updated_at)
         VALUES (?, ?, ?, 'pending', NULL, ?, ?)`,
      )
      .run(id, input.type, scopeId, ts, ts);
    return id;
  }

  // Atomically claim up to `limit` pending jobs (oldest-first) by flipping them
  // pending → running in ONE UPDATE … RETURNING so a second tick/worker never
  // double-processes a row. scope_id is decoded back to a ReflectionScope (D1).
  async claimPendingJobs(limit: number): Promise<MemoryJobRow[]> {
    if (limit <= 0) return [];
    const updatedAt = this.now().getTime();
    // Drizzle has no portable RETURNING-on-subselect-UPDATE helper, so use the raw
    // handle. The subquery picks the oldest pending ids; the UPDATE flips just
    // those and returns their decoded fields.
    const rows = this.db.$sqlite
      .prepare(
        `UPDATE memory_jobs
            SET status = 'running', updated_at = ?
          WHERE id IN (
            SELECT id FROM memory_jobs
             WHERE status = 'pending'
             ORDER BY created_at ASC, id ASC
             LIMIT ?
          )
        RETURNING id, type, scope_id`,
      )
      .all(updatedAt, limit) as Array<{ id: string; type: string; scope_id: string }>;
    return rows.map((row) => ({
      jobId: row.id,
      // The type column is constrained to the enum at enqueue time; widen back.
      type: row.type as MemoryJobRow["type"],
      scope: decodeScopeId(row.scope_id),
    }));
  }
}
