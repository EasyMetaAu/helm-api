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
import type { PgDb } from "./migrate.js";
import {
  memoryJobs,
  memoryMessages,
  memoryObservations,
  memoryReflections,
  memoryThreads,
} from "./schema.js";

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
  return and(...clauses) as SQL;
}

// Postgres adapter for the MemoryStore port — the supabase implementation
// (docs/08). Same contract as SqliteMemoryStore, but async and using native
// jsonb (source ranges + tags) instead of JSON-string encoding. Epoch-ms
// timestamps are stored as bigint, so Date <-> epoch conversion lives HERE (the
// pg bigint column has no native Date mode like sqlite's timestamp_ms). Memory is
// a MIDDLEWARE: this store never reads or writes routing/lane state.
export class PgMemoryStore implements MemoryStore {
  constructor(
    private readonly db: PgDb,
    private readonly genId: () => string = randomUUID,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async ensureThread(input: MemoryThreadInput): Promise<void> {
    const ts = this.now().getTime();
    await this.db
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
      });
  }

  async appendMessage(input: MemoryMessageInput): Promise<string> {
    const id = this.genId();
    await this.db.insert(memoryMessages).values({
      id,
      threadId: input.threadId,
      role: input.role,
      content: input.content,
      tokenEstimate: input.tokenEstimate,
      createdAt: this.now().getTime(),
    });
    return id;
  }

  async listMessages(threadId: string): Promise<RawMessage[]> {
    const rows = await this.db
      .select()
      .from(memoryMessages)
      .where(eq(memoryMessages.threadId, threadId))
      .orderBy(asc(memoryMessages.createdAt), asc(memoryMessages.id));
    return rows.map((row) => ({
      id: row.id,
      threadId: row.threadId,
      role: row.role as RawMessage["role"],
      content: row.content,
      tokenEstimate: row.tokenEstimate,
      createdAt: new Date(row.createdAt),
    }));
  }

  async appendObservation(input: MemoryObservationInput): Promise<string> {
    const id = this.genId();
    await this.db.insert(memoryObservations).values({
      id,
      threadId: input.threadId,
      sourceMessageRange: input.sourceMessageRange,
      observationText: input.observationText,
      observedAt: input.observedAt.getTime(),
      referencedAt: null,
      priority: input.priority ?? null,
      tags: input.tags ?? null,
    });
    return id;
  }

  async listObservations(scope: ReflectionScope): Promise<Observation[]> {
    if (scope.threadId === undefined) return [];
    const rows = await this.db
      .select()
      .from(memoryObservations)
      .where(eq(memoryObservations.threadId, scope.threadId))
      .orderBy(asc(memoryObservations.observedAt), asc(memoryObservations.id));
    return rows.map((row) => ({
      id: row.id,
      threadId: row.threadId,
      sourceMessageRange: row.sourceMessageRange,
      observationText: row.observationText,
      observedAt: new Date(row.observedAt),
      ...(row.priority !== null ? { priority: row.priority } : {}),
      ...(row.tags !== null ? { tags: row.tags } : {}),
    }));
  }

  async getReflection(scope: ReflectionScope): Promise<Reflection | null> {
    const rows = await this.db
      .select()
      .from(memoryReflections)
      .where(reflectionScopeWhere(scope))
      .orderBy(desc(memoryReflections.version))
      .limit(1);
    const row = rows[0];
    if (row === undefined) return null;
    return {
      id: row.id,
      projectId: row.projectId,
      resourceId: row.resourceId,
      threadId: row.threadId,
      reflectionText: row.reflectionText,
      version: row.version,
      tokenEstimate: row.tokenEstimate,
      updatedAt: new Date(row.updatedAt),
    };
  }

  async upsertReflection(input: ReflectionUpsertInput): Promise<string> {
    const id = this.genId();
    await this.db.insert(memoryReflections).values({
      id,
      projectId: input.projectId ?? null,
      resourceId: input.resourceId ?? null,
      threadId: input.threadId ?? null,
      reflectionText: input.reflectionText,
      version: input.version,
      tokenEstimate: input.tokenEstimate,
      updatedAt: input.updatedAt.getTime(),
    });
    return id;
  }

  async updateJobStatus(jobId: string, status: MemoryJobStatus, error?: string): Promise<void> {
    await this.db
      .update(memoryJobs)
      .set({
        status,
        error: error ?? null,
        updatedAt: this.now().getTime(),
      })
      .where(eq(memoryJobs.id, jobId));
  }
}
