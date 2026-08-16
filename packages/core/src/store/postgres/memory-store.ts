import { randomUUID } from "node:crypto";
import {
  decodeScopeId,
  encodeScopeId,
  type Fact,
  type FactListStatus,
  type MemoryFactInput,
  type MemoryFactPatch,
  type MemoryJobEnqueueInput,
  type MemoryJobRow,
  type MemoryMessageInput,
  type MemoryObservationInput,
  type MemoryScopeSummary,
  type MemoryThreadInput,
  type Observation,
  type RawMessage,
  type Reflection,
  type ReflectionScope,
  type ReflectionUpsertInput,
} from "@helm/shared";
import {
  and,
  asc,
  count,
  desc,
  eq,
  gt,
  ilike,
  inArray,
  isNotNull,
  isNull,
  lt,
  ne,
  or,
  type SQL,
  sql,
} from "drizzle-orm";
import { factContentHash } from "../../memory/forgetting/facts.js";
import { forgettingScore, type ScoreConfig } from "../../memory/forgetting/score.js";
import { sha256Hex } from "../../memory/message-hash.js";
import { reciprocalRankFusion } from "../../memory/recall/rrf.js";
import {
  type MemoryAdminStats,
  type MemoryAdminStatsScope,
  MemoryFactContentHashConflictError,
  type MemoryFactReconcileResult,
  type MemoryJobStatus,
  type MemoryMessageArchiveRow,
  type MemoryObserverCursor,
  type MemoryObserverPage,
  type MemoryObserverPageCommitInput,
  type MemoryObserverPageCommitResult,
  type MemoryReflectionJobCommitInput,
  type MemoryReflectionJobCommitResult,
  type MemoryStore,
} from "../ports.js";
import type { PgDb } from "./migrate.js";
import {
  memoryFacts,
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
  return and(...clauses) as SQL;
}

// How long a claimed (`running`) job stays exclusively leased — pg mirror of the
// sqlite adapter's constant (same contract, see its comment).
const RUNNING_LEASE_MS = 5 * 60_000;
const REFLECTOR_JOB_LOCK_SEED = 740;

function dateOrNull(ms: number | string | null | undefined): Date | null {
  return ms === null || ms === undefined ? null : new Date(Number(ms));
}

function numberOf(value: number | string | bigint | null | undefined): number {
  return value === null || value === undefined ? 0 : Number(value);
}

function pgRows<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  const maybe = result as { rows?: T[] };
  return Array.isArray(maybe.rows) ? maybe.rows : [];
}

function pgMemoryJobScopeClauses(input: MemoryAdminStatsScope): SQL[] {
  const clauses: SQL[] = [];
  if (input.accountId !== undefined) {
    clauses.push(sql`scope_id::jsonb ->> 'accountId' = ${input.accountId}`);
  }
  if (input.projectId !== undefined) {
    clauses.push(sql`scope_id::jsonb ->> 'projectId' = ${input.projectId}`);
  }
  if (input.resourceId !== undefined) {
    clauses.push(sql`scope_id::jsonb ->> 'resourceId' = ${input.resourceId}`);
  }
  if (input.threadId !== undefined) {
    clauses.push(sql`scope_id::jsonb ->> 'threadId' = ${input.threadId}`);
  }
  return clauses;
}

function pgWhere(clauses: readonly SQL[]): SQL {
  return clauses.length > 0 ? sql`WHERE ${sql.join([...clauses], sql` AND `)}` : sql``;
}

// Observation read scope — pg mirror of the sqlite adapter's observationScopeWhere
// (same contract, different dialect). Thread scope = the thread's own rows;
// project/resource scope = aggregated across all the owner's matching threads
// (the REFLECTOR's target read — a project reflection must see every thread of
// the project, never just the promoting one). No level at all → null (→ []).
function observationScopeWhere(scope: ReflectionScope): SQL | null {
  if (
    scope.threadId === undefined &&
    scope.projectId === undefined &&
    scope.resourceId === undefined
  ) {
    return null;
  }
  const threadFilters: SQL[] = [sql`mt.owner_id = ${scope.accountId}`];
  if (scope.projectId !== undefined) threadFilters.push(sql`mt.project_id = ${scope.projectId}`);
  if (scope.resourceId !== undefined) {
    threadFilters.push(sql`mt.resource_id = ${scope.resourceId}`);
  }
  const ownerScope = sql`EXISTS (SELECT 1 FROM memory_threads mt WHERE mt.id = ${memoryObservations.threadId} AND ${sql.join(threadFilters, sql` AND `)})`;
  return scope.threadId !== undefined
    ? (and(eq(memoryObservations.threadId, scope.threadId), ownerScope) as SQL)
    : ownerScope;
}

// docs/13 — raw shape of the listMemoryScopes UNION aggregate (bigint sums come
// back as string from the pg driver, so the mapper Number()s them).
interface ScopeAggRow {
  accountId: string;
  projectId: string | null;
  resourceId: string | null;
  threadId: string | null;
  factCount: number | string;
  reflectionCount: number | string;
  lastUpdated: number | string | null;
}

// docs/13 — pg row → domain mappers (bigint epoch-ms → Date; jsonb native).
// Shared by the inject read (listActiveFacts) and the management reads
// (getFactById / listFacts / updateFact) so the Fact/Reflection shape can't drift.
function pgRowToFact(row: typeof memoryFacts.$inferSelect): Fact {
  return {
    id: row.id,
    ownerId: row.ownerId,
    projectId: row.projectId,
    resourceId: row.resourceId,
    threadId: row.threadId,
    subjectKey: row.subjectKey,
    factText: row.factText,
    contentHash: row.contentHash,
    importance: row.importance,
    referenceCount: row.referenceCount,
    referencedAt: row.referencedAt === null ? null : new Date(row.referencedAt),
    validFrom: new Date(row.validFrom),
    invalidAt: row.invalidAt === null ? null : new Date(row.invalidAt),
    expiredAt: row.expiredAt === null ? null : new Date(row.expiredAt),
    status: row.status as Fact["status"],
    ...(row.sourceObservationRange !== null
      ? { sourceObservationRange: row.sourceObservationRange }
      : {}),
    createdAt: new Date(row.createdAt),
    updatedAt: new Date(row.updatedAt),
  };
}

function pgRowToReflection(row: typeof memoryReflections.$inferSelect): Reflection {
  return {
    id: row.id,
    projectId: row.projectId,
    resourceId: row.resourceId,
    threadId: row.threadId,
    reflectionText: row.reflectionText,
    version: row.version,
    tokenEstimate: row.tokenEstimate,
    updatedAt: new Date(row.updatedAt),
    referencedAt: row.referencedAt === null ? null : new Date(row.referencedAt),
    referenceCount: row.referenceCount,
    status: row.status as Reflection["status"],
  };
}

// docs/13 — collapse a version-DESC reflection list to the highest-version row
// per (project, resource, thread) scope (mirror of the sqlite adapter's helper;
// pure + dialect-neutral, runs over already-mapped rows).
function latestPerScope(rows: Reflection[]): Reflection[] {
  const seen = new Map<string, Reflection>();
  for (const r of rows) {
    const key = JSON.stringify([r.projectId, r.resourceId, r.threadId]);
    const cur = seen.get(key);
    if (cur === undefined || r.version > cur.version) seen.set(key, r);
  }
  return [...seen.values()];
}

// docs/13 — shared WHERE for the fact management list (pg mirror; ILIKE for the
// case-insensitive search the sqlite adapter gets from LIKE). 'active' = the live
// set (status='active' AND expired_at IS NULL); 'all' imposes no predicate.
function factListClauses(input: {
  accountId: string;
  projectId?: string;
  resourceId?: string;
  threadId?: string;
  status?: FactListStatus;
  subjectKey?: string;
  search?: string;
}): SQL[] {
  const clauses: SQL[] = [eq(memoryFacts.ownerId, input.accountId)];
  const status = input.status ?? "active";
  if (status === "active") {
    // Live: active AND not yet superseded.
    clauses.push(eq(memoryFacts.status, "active"), isNull(memoryFacts.expiredAt));
  } else if (status === "superseded") {
    // Replaced by a newer same-subject fact: still 'active' status, but expired_at stamped.
    clauses.push(eq(memoryFacts.status, "active"), isNotNull(memoryFacts.expiredAt));
  } else if (status !== "all") {
    clauses.push(eq(memoryFacts.status, status));
  }
  if (input.projectId !== undefined) clauses.push(eq(memoryFacts.projectId, input.projectId));
  if (input.resourceId !== undefined) clauses.push(eq(memoryFacts.resourceId, input.resourceId));
  if (input.threadId !== undefined) clauses.push(eq(memoryFacts.threadId, input.threadId));
  if (input.subjectKey !== undefined) clauses.push(eq(memoryFacts.subjectKey, input.subjectKey));
  if (input.search !== undefined && input.search.length > 0) {
    clauses.push(ilike(memoryFacts.factText, `%${input.search}%`));
  }
  return clauses;
}

// Postgres adapter for the MemoryStore port — the supabase implementation
// (docs/08). Same contract as SqliteMemoryStore, but async and using native
// jsonb (source ranges + tags) instead of JSON-string encoding. Epoch-ms
// timestamps are stored as bigint, so Date <-> epoch conversion lives HERE (the
// pg bigint column has no native Date mode like sqlite's timestamp_ms). Memory is
// a MIDDLEWARE: this store never reads or writes routing/lane state.
export class PgMemoryStore implements MemoryStore {
  readonly archiveObservationsEnqueuesReflectors = true as const;
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
          ownerId: sql`case
            when ${memoryThreads.ownerId} is null and excluded.owner_id is not null
              then excluded.owner_id
            else ${memoryThreads.ownerId}
          end`,
          projectId: sql`case
            when ${memoryThreads.projectId} is null
              and excluded.project_id is not null
              and (
                ${memoryThreads.ownerId} is null
                or excluded.owner_id is null
                or ${memoryThreads.ownerId} = excluded.owner_id
              )
              then excluded.project_id
            else ${memoryThreads.projectId}
          end`,
          resourceId: sql`case
            when ${memoryThreads.resourceId} is null
              and excluded.resource_id is not null
              and (
                ${memoryThreads.ownerId} is null
                or excluded.owner_id is null
                or ${memoryThreads.ownerId} = excluded.owner_id
              )
              then excluded.resource_id
            else ${memoryThreads.resourceId}
          end`,
          updatedAt: sql`case
            when (
              ${memoryThreads.ownerId} is null and excluded.owner_id is not null
            ) or (
              ${memoryThreads.projectId} is null
              and excluded.project_id is not null
              and (
                ${memoryThreads.ownerId} is null
                or excluded.owner_id is null
                or ${memoryThreads.ownerId} = excluded.owner_id
              )
            ) or (
              ${memoryThreads.resourceId} is null
              and excluded.resource_id is not null
              and (
                ${memoryThreads.ownerId} is null
                or excluded.owner_id is null
                or ${memoryThreads.ownerId} = excluded.owner_id
              )
            )
              then ${ts}
            else ${memoryThreads.updatedAt}
          end`,
        },
      });
  }

  async appendMessage(input: MemoryMessageInput): Promise<string> {
    const id = this.genId();
    const nowMs = this.now().getTime();
    // Idempotent ingest (pg v20 mirror of sqlite v21): a re-sent
    // (thread_id, message_index, role, content) collapses to a no-op via the
    // UNIQUE index while repeated text at a new transcript position persists.
    await this.db.transaction(async (tx) => {
      const thread = (
        await tx
          .select({ lastMessageAt: memoryThreads.lastMessageAt })
          .from(memoryThreads)
          .where(eq(memoryThreads.id, input.threadId))
          .for("update")
      )[0];
      const createdAt = Math.max(nowMs, (thread?.lastMessageAt ?? nowMs - 1) + 1);
      const inserted = await tx
        .insert(memoryMessages)
        .values({
          id,
          threadId: input.threadId,
          messageIndex: input.messageIndex ?? 0,
          role: input.role,
          content: input.content,
          tokenEstimate: input.tokenEstimate,
          createdAt,
          contentHash: sha256Hex(input.content),
        })
        .onConflictDoNothing({
          target: [
            memoryMessages.threadId,
            memoryMessages.messageIndex,
            memoryMessages.role,
            memoryMessages.contentHash,
          ],
        })
        .returning();
      // RETURNING is empty on the dedup conflict, so the summary remains exact.
      if (inserted.length > 0) {
        await tx
          .update(memoryThreads)
          .set({
            messageCount: sql`${memoryThreads.messageCount} + 1`,
            lastMessageAt: sql`CASE
              WHEN ${memoryThreads.lastMessageAt} IS NULL OR ${memoryThreads.lastMessageAt} < ${createdAt}
                THEN ${createdAt}
              ELSE ${memoryThreads.lastMessageAt}
            END`,
          })
          .where(eq(memoryThreads.id, input.threadId));
      }
    });
    return id;
  }

  // Single multi-row INSERT = one round-trip / one implicit transaction for the
  // whole turn (vs N from the appendMessage loop). createdAt is stamped base+i so
  // listMessages (ordered by createdAt, id) returns rows in append order even
  // though randomUUID ids do not sort. Mirrors the sqlite adapter's batch path.
  async appendMessages(inputs: MemoryMessageInput[]): Promise<string[]> {
    if (inputs.length === 0) return [];
    const base = this.now().getTime();
    const ids: string[] = [];
    // ON CONFLICT DO NOTHING dedupes against EXISTING rows, but a single pg
    // multi-row INSERT cannot dedupe rows against EACH OTHER within the same
    // VALUES list — two identical messages in one turn (e.g. a repeated empty
    // assistant turn) would both be inserted. So collapse intra-batch dups by
    // (thread_id, message_index, role, content_hash) here, keeping the first. ids
    // stays one-per-input (caller discards it; the contract only requires length +
    // uniqueness).
    const seen = new Set<string>();
    const rows: Array<{
      id: string;
      threadId: string;
      messageIndex: number;
      role: MemoryMessageInput["role"];
      content: string;
      tokenEstimate: number;
      createdAt: number;
      contentHash: string;
    }> = [];
    inputs.forEach((input, i) => {
      const id = this.genId();
      ids.push(id);
      const contentHash = sha256Hex(input.content);
      const messageIndex = input.messageIndex ?? i;
      const key = JSON.stringify([input.threadId, messageIndex, input.role, contentHash]);
      if (seen.has(key)) return;
      seen.add(key);
      rows.push({
        id,
        threadId: input.threadId,
        messageIndex,
        role: input.role,
        content: input.content,
        tokenEstimate: input.tokenEstimate,
        createdAt: base + i,
        contentHash,
      });
    });
    // Defensive (review H4): rows is built by a conditional push, and Drizzle's
    // `.values([])` emits invalid SQL and THROWS. The dedup above always keeps the
    // FIRST input, so rows is non-empty whenever inputs is — i.e. unreachable today —
    // but guarding the insert keeps it robust if the dedup ever changes to drop the
    // first row too. Cheaper than making every future editor re-prove the invariant.
    if (rows.length === 0) return ids;
    await this.db.transaction(async (tx) => {
      const nextAt = new Map<string, number>();
      for (const threadId of [...new Set(rows.map((row) => row.threadId))].sort()) {
        const thread = (
          await tx
            .select({ lastMessageAt: memoryThreads.lastMessageAt })
            .from(memoryThreads)
            .where(eq(memoryThreads.id, threadId))
            .for("update")
        )[0];
        nextAt.set(threadId, Math.max(base, (thread?.lastMessageAt ?? base - 1) + 1));
      }
      for (const row of rows) {
        const createdAt = nextAt.get(row.threadId);
        if (createdAt === undefined) continue;
        row.createdAt = createdAt;
        nextAt.set(row.threadId, createdAt + 1);
      }
      const inserted = await tx
        .insert(memoryMessages)
        .values(rows)
        .onConflictDoNothing({
          target: [
            memoryMessages.threadId,
            memoryMessages.messageIndex,
            memoryMessages.role,
            memoryMessages.contentHash,
          ],
        })
        .returning();
      const activity = new Map<string, { count: number; lastAt: number }>();
      for (const row of inserted) {
        const current = activity.get(row.threadId);
        activity.set(row.threadId, {
          count: (current?.count ?? 0) + 1,
          lastAt: Math.max(current?.lastAt ?? row.createdAt, row.createdAt),
        });
      }
      for (const [threadId, summary] of activity) {
        await tx
          .update(memoryThreads)
          .set({
            messageCount: sql`${memoryThreads.messageCount} + ${summary.count}`,
            lastMessageAt: sql`CASE
              WHEN ${memoryThreads.lastMessageAt} IS NULL OR ${memoryThreads.lastMessageAt} < ${summary.lastAt}
                THEN ${summary.lastAt}
              ELSE ${memoryThreads.lastMessageAt}
            END`,
          })
          .where(eq(memoryThreads.id, threadId));
      }
    });
    return ids;
  }

  async listMessages(scope: { threadId: string; accountId: string }): Promise<RawMessage[]> {
    const rows = await this.db
      .select()
      .from(memoryMessages)
      .where(
        and(
          eq(memoryMessages.threadId, scope.threadId),
          sql`EXISTS (SELECT 1 FROM memory_threads mt WHERE mt.id = ${memoryMessages.threadId} AND mt.owner_id = ${scope.accountId})`,
        ),
      )
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

  async listObserverMessagesPage(input: {
    threadId: string;
    accountId: string;
    limit: number;
    maxBytes: number;
    maxTokens: number;
  }): Promise<MemoryObserverPage> {
    const thread = (
      await this.db
        .select({
          frontierAt: memoryThreads.observerFrontierAt,
          frontierId: memoryThreads.observerFrontierId,
        })
        .from(memoryThreads)
        .where(
          and(eq(memoryThreads.id, input.threadId), eq(memoryThreads.ownerId, input.accountId)),
        )
        .limit(1)
    )[0];
    if (thread === undefined) {
      return { messages: [], expectedFrontier: null, nextCursor: null, hasMore: false };
    }
    const expectedFrontier =
      thread.frontierAt === null || thread.frontierId === null
        ? null
        : { createdAtMs: thread.frontierAt, id: thread.frontierId };
    const cursorWhere =
      expectedFrontier === null
        ? undefined
        : or(
            gt(memoryMessages.createdAt, expectedFrontier.createdAtMs),
            and(
              eq(memoryMessages.createdAt, expectedFrontier.createdAtMs),
              gt(memoryMessages.id, expectedFrontier.id),
            ),
          );
    const rowLimit = Math.max(1, Math.floor(input.limit));
    const rows = await this.db
      .select({
        id: memoryMessages.id,
        threadId: memoryMessages.threadId,
        role: memoryMessages.role,
        tokenEstimate: memoryMessages.tokenEstimate,
        createdAt: memoryMessages.createdAt,
        contentHash: memoryMessages.contentHash,
        storedBytes: sql<number>`octet_length(${memoryMessages.content})`,
      })
      .from(memoryMessages)
      .where(and(eq(memoryMessages.threadId, input.threadId), cursorWhere))
      .orderBy(asc(memoryMessages.createdAt), asc(memoryMessages.id))
      .limit(rowLimit + 1);
    const selected: Array<(typeof rows)[number] & { oversized: boolean }> = [];
    let tokens = 0;
    let bytes = 0;
    for (const row of rows.slice(0, rowLimit)) {
      const rowBytes = Math.max(row.storedBytes, row.tokenEstimate * 4);
      const oversized = row.tokenEstimate > input.maxTokens || rowBytes > input.maxBytes;
      if (
        selected.length > 0 &&
        (tokens + row.tokenEstimate > input.maxTokens || bytes + rowBytes > input.maxBytes)
      ) {
        break;
      }
      selected.push({ ...row, oversized });
      if (!oversized) {
        tokens += row.tokenEstimate;
        bytes += rowBytes;
      }
      if (oversized) break;
    }
    const safeIds = selected.filter((row) => !row.oversized).map((row) => row.id);
    const selectedIds = selected.map((row) => row.id);
    const coveredMessageIds =
      selectedIds.length === 0
        ? []
        : pgRows<{ id: string }>(
            await this.db.execute(sql`
              SELECT m.id
                FROM memory_messages m
               WHERE m.id IN (${sql.join(
                 selectedIds.map((id) => sql`${id}`),
                 sql`, `,
               )})
                 AND EXISTS (
                   SELECT 1
                     FROM memory_observations o
                     JOIN memory_messages first_message
                       ON first_message.id = o.source_message_range ->> 0
                      AND first_message.thread_id = o.thread_id
                     JOIN memory_messages last_message
                       ON last_message.id = o.source_message_range ->> 1
                      AND last_message.thread_id = o.thread_id
                    WHERE o.thread_id = m.thread_id
                      AND (
                        ((first_message.created_at, first_message.id) <= (m.created_at, m.id)
                         AND (m.created_at, m.id) <= (last_message.created_at, last_message.id))
                        OR
                        ((last_message.created_at, last_message.id) <= (m.created_at, m.id)
                         AND (m.created_at, m.id) <= (first_message.created_at, first_message.id))
                      )
                 )
            `),
          ).map((row) => row.id);
    const contentRows =
      safeIds.length === 0
        ? []
        : await this.db
            .select({ id: memoryMessages.id, content: memoryMessages.content })
            .from(memoryMessages)
            .where(inArray(memoryMessages.id, safeIds));
    const contentById = new Map(contentRows.map((row) => [row.id, row.content]));
    const messages = selected.map((row) => ({
      id: row.id,
      threadId: row.threadId,
      role: row.role as RawMessage["role"],
      content: row.oversized
        ? `[oversized ${row.role} message omitted; sha256=${row.contentHash ?? "unknown"}]`
        : (contentById.get(row.id) ?? ""),
      tokenEstimate: row.oversized ? 32 : row.tokenEstimate,
      createdAt: new Date(row.createdAt),
    }));
    const last = selected.at(-1);
    const nextCursor = last === undefined ? null : { createdAtMs: last.createdAt, id: last.id };
    return {
      messages,
      coveredMessageIds,
      expectedFrontier,
      nextCursor,
      hasMore: selected.length < rows.length,
    };
  }

  async appendObservation(input: MemoryObservationInput): Promise<string> {
    const id = this.genId();
    const observedAt = input.observedAt.getTime();
    await this.db.transaction(async (tx) => {
      await tx.insert(memoryObservations).values({
        id,
        threadId: input.threadId,
        sourceMessageRange: input.sourceMessageRange,
        observationText: input.observationText,
        observedAt,
        referencedAt: null,
        // docs/12 (P5) — persist the Observer-resolved salience; absent ⇒ column
        // default 0.5 (pg mirror of the sqlite adapter).
        ...(input.importance !== undefined ? { importance: input.importance } : {}),
        priority: input.priority ?? null,
        tags: input.tags ?? null,
      });
      await tx
        .update(memoryThreads)
        .set({
          observationCount: sql`${memoryThreads.observationCount} + 1`,
          lastObservationAt: sql`CASE
            WHEN ${memoryThreads.lastObservationAt} IS NULL OR ${memoryThreads.lastObservationAt} < ${observedAt}
              THEN ${observedAt}
            ELSE ${memoryThreads.lastObservationAt}
          END`,
        })
        .where(eq(memoryThreads.id, input.threadId));
    });
    return id;
  }

  async appendObservationAndAdvanceFrontier(input: {
    accountId: string;
    observation: MemoryObservationInput;
    expectedFrontier: MemoryObserverCursor | null;
    nextFrontier: MemoryObserverCursor;
  }): Promise<string | null> {
    const id = this.genId();
    const observedAt = input.observation.observedAt.getTime();
    return this.db.transaction(async (tx) => {
      const expected = input.expectedFrontier;
      const updated = await tx
        .update(memoryThreads)
        .set({
          observerFrontierAt: input.nextFrontier.createdAtMs,
          observerFrontierId: input.nextFrontier.id,
          observationCount: sql`${memoryThreads.observationCount} + 1`,
          lastObservationAt: sql`CASE
            WHEN ${memoryThreads.lastObservationAt} IS NULL OR ${memoryThreads.lastObservationAt} < ${observedAt}
              THEN ${observedAt}
            ELSE ${memoryThreads.lastObservationAt}
          END`,
        })
        .where(
          and(
            eq(memoryThreads.id, input.observation.threadId),
            eq(memoryThreads.ownerId, input.accountId),
            expected === null
              ? and(
                  isNull(memoryThreads.observerFrontierAt),
                  isNull(memoryThreads.observerFrontierId),
                )
              : and(
                  eq(memoryThreads.observerFrontierAt, expected.createdAtMs),
                  eq(memoryThreads.observerFrontierId, expected.id),
                ),
          ),
        )
        .returning();
      if (updated.length === 0) return null;
      await tx.insert(memoryObservations).values({
        id,
        threadId: input.observation.threadId,
        sourceMessageRange: input.observation.sourceMessageRange,
        observationText: input.observation.observationText,
        observedAt,
        referencedAt: null,
        priority: input.observation.priority ?? null,
        tags: input.observation.tags ?? null,
        ...(input.observation.importance !== undefined
          ? { importance: input.observation.importance }
          : {}),
      });
      return id;
    });
  }

  async commitObserverPage(
    input: MemoryObserverPageCommitInput,
  ): Promise<MemoryObserverPageCommitResult | null> {
    const threadId =
      input.action === "observe" ? input.observation.threadId : input.job.scope.threadId;
    if (
      threadId === undefined ||
      input.job.scope.accountId !== input.accountId ||
      input.job.scope.threadId !== threadId ||
      (input.successorScope !== undefined &&
        (input.successorScope.accountId !== input.accountId ||
          input.successorScope.threadId !== threadId))
    ) {
      return null;
    }
    const id = input.action === "observe" ? this.genId() : null;
    const successorId = input.successorScope === undefined ? null : this.genId();
    const jobScopeId = encodeScopeId(input.job.scope);
    const successorScopeId =
      input.successorScope === undefined ? null : encodeScopeId(input.successorScope);
    const observedAt = input.action === "observe" ? input.observation.observedAt.getTime() : null;
    return this.db.transaction(async (tx) => {
      const currentJob = await tx
        .select({ id: memoryJobs.id })
        .from(memoryJobs)
        .where(
          and(
            eq(memoryJobs.id, input.job.id),
            eq(memoryJobs.type, "observer"),
            eq(memoryJobs.scopeId, jobScopeId),
            eq(memoryJobs.status, "running"),
            eq(memoryJobs.leaseGeneration, input.job.leaseGeneration),
          ),
        )
        .for("update");
      if (currentJob.length === 0) return null;
      const expected = input.expectedFrontier;
      const update =
        input.action === "observe"
          ? {
              observerFrontierAt: input.nextFrontier.createdAtMs,
              observerFrontierId: input.nextFrontier.id,
              observationCount: sql`${memoryThreads.observationCount} + 1`,
              lastObservationAt: sql`CASE
                WHEN ${memoryThreads.lastObservationAt} IS NULL OR ${memoryThreads.lastObservationAt} < ${observedAt}
                  THEN ${observedAt}
                ELSE ${memoryThreads.lastObservationAt}
              END`,
            }
          : {
              observerFrontierAt: input.nextFrontier.createdAtMs,
              observerFrontierId: input.nextFrontier.id,
            };
      const updated = await tx
        .update(memoryThreads)
        .set(update)
        .where(
          and(
            eq(memoryThreads.id, threadId),
            eq(memoryThreads.ownerId, input.accountId),
            expected === null
              ? and(
                  isNull(memoryThreads.observerFrontierAt),
                  isNull(memoryThreads.observerFrontierId),
                )
              : and(
                  eq(memoryThreads.observerFrontierAt, expected.createdAtMs),
                  eq(memoryThreads.observerFrontierId, expected.id),
                ),
          ),
        )
        .returning();
      if (updated.length === 0) return null;
      if (input.action === "observe" && id !== null && observedAt !== null) {
        await tx.insert(memoryObservations).values({
          id,
          threadId,
          sourceMessageRange: input.observation.sourceMessageRange,
          observationText: input.observation.observationText,
          observedAt,
          referencedAt: null,
          priority: input.observation.priority ?? null,
          tags: input.observation.tags ?? null,
          ...(input.observation.importance !== undefined
            ? { importance: input.observation.importance }
            : {}),
        });
      }
      const completed = await tx
        .update(memoryJobs)
        .set({ status: "done", error: null, updatedAt: this.now().getTime() })
        .where(
          and(
            eq(memoryJobs.id, input.job.id),
            eq(memoryJobs.type, "observer"),
            eq(memoryJobs.scopeId, jobScopeId),
            eq(memoryJobs.status, "running"),
            eq(memoryJobs.leaseGeneration, input.job.leaseGeneration),
          ),
        )
        .returning();
      if (completed.length !== 1) throw new Error("observer job fence changed during commit");
      if (successorId !== null && successorScopeId !== null) {
        const ts = this.now().getTime();
        await tx.execute(sql`
          INSERT INTO memory_jobs (id, type, scope_id, status, error, created_at, updated_at)
          VALUES (${successorId}, 'observer', ${successorScopeId}, 'pending', NULL, ${ts}, ${ts})
          ON CONFLICT (type, scope_id) WHERE status IN ('pending', 'running') DO NOTHING
        `);
      }
      return { observationId: id };
    });
  }

  async listObservations(scope: ReflectionScope): Promise<Observation[]> {
    const where = observationScopeWhere(scope);
    if (where === null) return [];
    const rows = await this.db
      .select()
      .from(memoryObservations)
      .where(where)
      .orderBy(asc(memoryObservations.observedAt), asc(memoryObservations.id));
    return rows.map((row) => ({
      id: row.id,
      threadId: row.threadId,
      sourceMessageRange: row.sourceMessageRange,
      observationText: row.observationText,
      observedAt: new Date(row.observedAt),
      referenceCount: row.referenceCount,
      importance: row.importance,
      status: row.status as Observation["status"],
      referencedAt: row.referencedAt !== null ? new Date(row.referencedAt) : null,
      archivedAt: row.archivedAt !== null ? new Date(row.archivedAt) : null,
      expiredAt: row.expiredAt !== null ? new Date(row.expiredAt) : null,
      ...(row.priority !== null ? { priority: row.priority } : {}),
      ...(row.tags !== null ? { tags: row.tags } : {}),
    }));
  }

  async listActiveObservationsBounded(
    scope: ReflectionScope,
    limit: number,
  ): Promise<Observation[]> {
    const where = observationScopeWhere(scope);
    if (where === null) return [];
    const rows = (
      await this.db
        .select()
        .from(memoryObservations)
        .where(
          and(where, eq(memoryObservations.status, "active"), isNull(memoryObservations.expiredAt)),
        )
        .orderBy(desc(memoryObservations.observedAt), desc(memoryObservations.id))
        .limit(Math.max(1, Math.floor(limit)))
    ).reverse();
    return rows.map((row) => ({
      id: row.id,
      threadId: row.threadId,
      sourceMessageRange: row.sourceMessageRange,
      observationText: row.observationText,
      observedAt: new Date(row.observedAt),
      referenceCount: row.referenceCount,
      importance: row.importance,
      status: row.status as Observation["status"],
      referencedAt: row.referencedAt !== null ? new Date(row.referencedAt) : null,
      archivedAt: row.archivedAt !== null ? new Date(row.archivedAt) : null,
      expiredAt: row.expiredAt !== null ? new Date(row.expiredAt) : null,
      ...(row.priority !== null ? { priority: row.priority } : {}),
      ...(row.tags !== null ? { tags: row.tags } : {}),
    }));
  }

  async listInjectionObservationsPage(input: {
    accountId: string;
    threadId: string;
    limit: number;
    offset: number;
    order: "newest" | "score";
    score?: {
      nowMs: number;
      half_life_s: number;
      importance_floor: number;
      importance_ceil: number;
      access_weight: number;
    };
  }): Promise<Observation[]> {
    const where = observationScopeWhere({ accountId: input.accountId, threadId: input.threadId });
    if (where === null) return [];
    const score = input.score;
    const scoreOrder =
      score === undefined
        ? undefined
        : sql`power(0.5, GREATEST(0, (${score.nowMs} - COALESCE(${memoryObservations.referencedAt}, ${memoryObservations.observedAt})) / 1000.0) / ${score.half_life_s}) * (LEAST(GREATEST(${memoryObservations.importance}, ${score.importance_floor}), ${score.importance_ceil}) + ${score.access_weight} * ln(1 + ${memoryObservations.referenceCount}))`;
    const rows = await this.db
      .select()
      .from(memoryObservations)
      .where(
        and(
          where,
          eq(memoryObservations.status, "active"),
          isNull(memoryObservations.expiredAt),
        ) as SQL,
      )
      .orderBy(
        input.order === "score" && scoreOrder !== undefined
          ? desc(scoreOrder)
          : desc(memoryObservations.observedAt),
        desc(memoryObservations.observedAt),
        desc(memoryObservations.id),
      )
      .limit(input.limit)
      .offset(input.offset);
    return rows.map((row) => ({
      id: row.id,
      threadId: row.threadId,
      sourceMessageRange: row.sourceMessageRange,
      observationText: row.observationText,
      observedAt: new Date(row.observedAt),
      referenceCount: row.referenceCount,
      importance: row.importance,
      status: row.status as Observation["status"],
      referencedAt: row.referencedAt === null ? null : new Date(row.referencedAt),
      archivedAt: row.archivedAt === null ? null : new Date(row.archivedAt),
      expiredAt: row.expiredAt === null ? null : new Date(row.expiredAt),
      ...(row.priority !== null ? { priority: row.priority } : {}),
      ...(row.tags !== null ? { tags: row.tags } : {}),
    }));
  }

  async findRedundantInjectionObservations(input: {
    accountId: string;
    threadId: string;
    candidateLimit: number;
    maxCoverageMessages: number;
    order: "newest" | "score";
    score?: {
      nowMs: number;
      half_life_s: number;
      importance_floor: number;
      importance_ceil: number;
      access_weight: number;
    };
    windowContentHashCounts: ReadonlyMap<string, number>;
  }): Promise<ReadonlySet<string>> {
    const candidateLimit = Math.max(0, Math.floor(input.candidateLimit));
    const maxCoverageMessages = Math.max(0, Math.floor(input.maxCoverageMessages));
    if (
      candidateLimit === 0 ||
      maxCoverageMessages === 0 ||
      input.windowContentHashCounts.size === 0
    ) {
      return new Set();
    }
    const live = JSON.stringify(Object.fromEntries(input.windowContentHashCounts));
    const score = input.order === "score" ? input.score : undefined;
    const candidateOrder =
      score === undefined
        ? sql`${memoryObservations.observedAt} DESC, ${memoryObservations.id} DESC`
        : sql`power(0.5, GREATEST(0, (${score.nowMs} - COALESCE(${memoryObservations.referencedAt}, ${memoryObservations.observedAt})) / 1000.0) / ${score.half_life_s})
              * (LEAST(GREATEST(${memoryObservations.importance}, ${score.importance_floor}), ${score.importance_ceil}) + ${score.access_weight} * ln(1 + ${memoryObservations.referenceCount})) DESC,
              ${memoryObservations.observedAt} DESC, ${memoryObservations.id} DESC`;
    const rows = pgRows<{ id: string }>(
      await this.db.execute(sql`
        WITH live AS (
          SELECT key, value::integer AS n FROM jsonb_each_text(${live}::jsonb)
        ), candidates AS MATERIALIZED (
          SELECT ${memoryObservations.id} AS id,
                 ${memoryObservations.sourceMessageRange} ->> 0 AS start_id,
                 ${memoryObservations.sourceMessageRange} ->> 1 AS end_id
            FROM ${memoryObservations}
            JOIN ${memoryThreads}
              ON ${memoryThreads.id} = ${memoryObservations.threadId}
             AND ${memoryThreads.ownerId} = ${input.accountId}
           WHERE ${memoryObservations.threadId} = ${input.threadId}
             AND ${memoryObservations.status} = 'active'
             AND ${memoryObservations.expiredAt} IS NULL
           ORDER BY ${candidateOrder}
           LIMIT ${candidateLimit}
        ), endpoints AS MATERIALIZED (
          SELECT c.id,
                 CASE WHEN (s.created_at, s.id) <= (e.created_at, e.id)
                   THEN s.created_at ELSE e.created_at END AS first_at,
                 CASE WHEN (s.created_at, s.id) <= (e.created_at, e.id)
                   THEN s.id ELSE e.id END AS first_id,
                 CASE WHEN (s.created_at, s.id) <= (e.created_at, e.id)
                   THEN e.created_at ELSE s.created_at END AS last_at,
                 CASE WHEN (s.created_at, s.id) <= (e.created_at, e.id)
                   THEN e.id ELSE s.id END AS last_id
            FROM candidates c
            JOIN memory_messages s ON s.id = c.start_id AND s.thread_id = ${input.threadId}
            JOIN memory_messages e ON e.id = c.end_id AND e.thread_id = ${input.threadId}
        ), bounded AS MATERIALIZED (
          SELECT e.* FROM endpoints e
           WHERE (
             SELECT COUNT(*) FROM (
               SELECT 1 FROM memory_messages m
                WHERE m.thread_id = ${input.threadId}
                  AND (m.created_at, m.id) >= (e.first_at, e.first_id)
                  AND (m.created_at, m.id) <= (e.last_at, e.last_id)
                ORDER BY m.created_at, m.id
                LIMIT ${maxCoverageMessages + 1}
             ) covered_limit
           ) <= ${maxCoverageMessages}
        )
        SELECT b.id FROM bounded b
         WHERE NOT EXISTS (
             SELECT 1 FROM memory_messages m
             LEFT JOIN live l ON l.key = m.content_hash
              WHERE m.thread_id = ${input.threadId}
                AND (m.created_at, m.id) >= (b.first_at, b.first_id)
                AND (m.created_at, m.id) <= (b.last_at, b.last_id)
              GROUP BY m.content_hash, l.n
             HAVING m.content_hash IS NULL OR l.n IS NULL OR l.n < COUNT(*)
           )
      `),
    );
    return new Set(rows.map((row) => row.id));
  }

  async getReflection(scope: ReflectionScope): Promise<Reflection | null> {
    // Latest ACTIVE version only (Codex review fix; pg mirror) — archived reflections
    // are invisible so forgotten content never re-injects.
    const rows = await this.db
      .select()
      .from(memoryReflections)
      .where(and(reflectionScopeWhere(scope), eq(memoryReflections.status, "active")))
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
      referencedAt: row.referencedAt !== null ? new Date(row.referencedAt) : null,
      referenceCount: row.referenceCount,
      status: row.status as Reflection["status"],
    };
  }

  async upsertReflection(input: ReflectionUpsertInput): Promise<string> {
    const id = this.genId();
    await this.db.insert(memoryReflections).values({
      id,
      ownerId: input.accountId,
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

  // docs/12 (Codex review fix; pg mirror) — distinct ACTIVE-reflection scopes for the
  // account, so the decay job can enqueue one reflector rebuild per scope.
  async listActiveReflectionScopes(accountId: string, limit = 512): Promise<ReflectionScope[]> {
    const rows = await this.db
      .selectDistinct({
        projectId: memoryReflections.projectId,
        resourceId: memoryReflections.resourceId,
        threadId: memoryReflections.threadId,
      })
      .from(memoryReflections)
      .where(and(eq(memoryReflections.ownerId, accountId), eq(memoryReflections.status, "active")))
      .orderBy(
        asc(memoryReflections.projectId),
        asc(memoryReflections.resourceId),
        asc(memoryReflections.threadId),
      )
      .limit(Math.max(1, Math.floor(limit)));
    return rows.map((r) => ({
      accountId,
      ...(r.projectId !== null ? { projectId: r.projectId } : {}),
      ...(r.resourceId !== null ? { resourceId: r.resourceId } : {}),
      ...(r.threadId !== null ? { threadId: r.threadId } : {}),
    }));
  }

  // docs/12 (Codex review fix; pg mirror) — soft-invalidate every version of a scope's
  // reflection so getReflection returns null. Never a DELETE (audit).
  async archiveReflections(scope: ReflectionScope): Promise<void> {
    await this.db
      .update(memoryReflections)
      .set({ status: "archived" })
      .where(and(reflectionScopeWhere(scope), eq(memoryReflections.status, "active")));
  }

  // docs/12 (Codex review fix II; pg mirror) — MAX(version) across every status so
  // the Reflector's next version stays monotonic across an archive→rebuild cycle.
  async getReflectionVersionHighWater(scope: ReflectionScope): Promise<number> {
    const rows = await this.db
      .select({ version: memoryReflections.version })
      .from(memoryReflections)
      .where(reflectionScopeWhere(scope))
      .orderBy(desc(memoryReflections.version))
      .limit(1);
    return rows[0]?.version ?? 0;
  }

  private async hasCurrentJobLease(
    tx: { execute: (query: SQL) => Promise<unknown> },
    job: { id: string; leaseGeneration: number },
  ): Promise<boolean> {
    return (
      pgRows<{ id: string }>(
        await tx.execute(sql`
          SELECT id FROM memory_jobs
           WHERE id = ${job.id}
             AND status = 'running'
             AND lease_generation = ${job.leaseGeneration}
           FOR UPDATE
        `),
      )[0] !== undefined
    );
  }

  async commitReflectionJob(
    jobId: string,
    input: MemoryReflectionJobCommitInput,
  ): Promise<MemoryReflectionJobCommitResult | null> {
    return this.db.transaction(async (tx) => {
      const scopeId = encodeScopeId(input.target);
      const claimed = pgRows<{ id: string }>(
        await tx.execute(sql`
          UPDATE memory_jobs
             SET status = 'done', error = NULL, updated_at = ${input.now.getTime()}
           WHERE id = ${jobId}
             AND type = 'reflector'
             AND scope_id = ${scopeId}
             AND status = 'running'
             AND lease_generation = ${input.leaseGeneration}
          RETURNING id
        `),
      );
      if (claimed[0] === undefined) return null;

      const facts = await this.reconcileFacts(
        { execute: (query) => tx.execute(query) },
        {
          accountId: input.target.accountId,
          scope: {
            ...(input.target.projectId !== undefined ? { projectId: input.target.projectId } : {}),
            ...(input.target.resourceId !== undefined
              ? { resourceId: input.target.resourceId }
              : {}),
            ...(input.target.threadId !== undefined ? { threadId: input.target.threadId } : {}),
          },
          facts: input.facts,
          now: input.now,
        },
      );

      let reflectionId: string | null = null;
      if (input.reflection.action === "archive") {
        await tx.execute(sql`
          UPDATE memory_reflections
             SET status = 'archived'
           WHERE owner_id = ${input.target.accountId}
             AND project_id IS NOT DISTINCT FROM ${input.target.projectId ?? null}
             AND resource_id IS NOT DISTINCT FROM ${input.target.resourceId ?? null}
             AND thread_id IS NOT DISTINCT FROM ${input.target.threadId ?? null}
             AND status = 'active'
        `);
      } else if (input.reflection.action === "upsert") {
        reflectionId = this.genId();
        await tx.insert(memoryReflections).values({
          id: reflectionId,
          ownerId: input.target.accountId,
          projectId: input.target.projectId ?? null,
          resourceId: input.target.resourceId ?? null,
          threadId: input.target.threadId ?? null,
          reflectionText: input.reflection.reflectionText,
          version: input.reflection.version,
          tokenEstimate: input.reflection.tokenEstimate,
          updatedAt: input.reflection.updatedAt.getTime(),
        });
      }
      return { reflectionId, facts };
    });
  }

  async updateJobStatus(
    jobId: string,
    status: MemoryJobStatus,
    error?: string,
    leaseGeneration?: number,
  ): Promise<void> {
    await this.db
      .update(memoryJobs)
      .set({
        status,
        error: error ?? null,
        updatedAt: this.now().getTime(),
      })
      .where(
        leaseGeneration === undefined
          ? eq(memoryJobs.id, jobId)
          : and(
              eq(memoryJobs.id, jobId),
              eq(memoryJobs.status, "running"),
              eq(memoryJobs.leaseGeneration, leaseGeneration),
            ),
      );
  }

  // Enqueue a background job. DEDUPE (D6): the partial unique index on OPEN
  // (pending/running) jobs owns the concurrency boundary; this method tries the
  // insert first, then reads the existing open row when another request won.
  // Reflectors also share a scope advisory lock with decay so no new open row can
  // slip between decay's fence and successor enqueue.
  async enqueueJob(input: MemoryJobEnqueueInput): Promise<string> {
    const scopeId = encodeScopeId(input.scope);
    const id = this.genId();
    const ts = this.now().getTime();
    const enqueue = async (executor: { execute: (query: SQL) => Promise<unknown> }) => {
      const insertedRows = pgRows<{ id: string }>(
        await executor.execute(sql`
          INSERT INTO memory_jobs (id, type, scope_id, status, error, created_at, updated_at)
          VALUES (${id}, ${input.type}, ${scopeId}, 'pending', NULL, ${ts}, ${ts})
          ON CONFLICT (type, scope_id) WHERE status IN ('pending', 'running') DO NOTHING
          RETURNING id
        `),
      );
      if (insertedRows[0] !== undefined) return insertedRows[0].id;

      const existingRows = pgRows<{ id: string }>(
        await executor.execute(sql`
          SELECT id FROM memory_jobs
           WHERE type = ${input.type}
             AND scope_id = ${scopeId}
             AND status IN ('pending', 'running')
           ORDER BY created_at ASC, id ASC
           LIMIT 1
        `),
      );
      if (existingRows[0] !== undefined) return existingRows[0].id;
      throw new Error("memory job enqueue conflict without existing open row");
    };

    if (input.type !== "reflector") return enqueue(this.db);
    return this.db.transaction(async (tx) => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${scopeId}, ${REFLECTOR_JOB_LOCK_SEED}))`,
      );
      return enqueue({ execute: (query) => tx.execute(query) });
    });
  }

  // Atomically claim up to `limit` open jobs (oldest-first). Postgres uses
  // FOR UPDATE SKIP LOCKED in the id subquery so concurrent workers never contend
  // on or double-process the same row; the outer UPDATE flips the rows to running
  // and RETURNS them. Claimable = pending, PLUS running rows whose lease
  // (updated_at) expired — a worker that died between claim and finish must not
  // block its scope forever (enqueue dedupes against running rows). Re-claiming
  // refreshes updated_at (lease restarts); the runners are idempotent, so a
  // re-run of a job that actually finished is harmless. scope_id is decoded back
  // to a ReflectionScope (D1). Mirrors the sqlite adapter's lease semantics.
  async claimPendingJobs(limit: number): Promise<MemoryJobRow[]> {
    if (limit <= 0) return [];
    const updatedAt = this.now().getTime();
    const staleBefore = updatedAt - RUNNING_LEASE_MS;
    const result = (await this.db.execute(sql`
      UPDATE memory_jobs
         SET status = 'running', updated_at = ${updatedAt},
             lease_generation = lease_generation + 1
       WHERE id IN (
         SELECT id FROM memory_jobs
          WHERE status = 'pending'
             OR (status = 'running' AND updated_at <= ${staleBefore})
          ORDER BY created_at ASC, id ASC
          LIMIT ${limit}
          FOR UPDATE SKIP LOCKED
       )
      RETURNING id, type, scope_id, lease_generation
    `)) as
      | {
          rows?: Array<{
            id: string;
            type: string;
            scope_id: string;
            lease_generation: number;
          }>;
        }
      | Array<{
          id: string;
          type: string;
          scope_id: string;
          lease_generation: number;
        }>;
    const rows = Array.isArray(result) ? result : (result.rows ?? []);
    return rows.map((row) => ({
      jobId: row.id,
      leaseGeneration: Number(row.lease_generation),
      type: row.type as MemoryJobRow["type"],
      scope: decodeScopeId(row.scope_id),
    }));
  }

  // docs/12 "Access reinforcement" (P3) — pg mirror of the sqlite adapter. One
  // batched, ACCOUNT-GUARDED UPDATE per tier: bump reference_count + stamp
  // referenced_at (epoch ms in the bigint column) on exactly the injected ids.
  // Observations are guarded via their thread's owner_id (no owner_id column of
  // their own); reflections carry owner_id directly. Empty id lists skip their
  // UPDATE. FAIL-OPEN is the caller's contract (inject never awaits this).
  async bumpReferences(input: {
    accountId: string;
    observationIds: string[];
    reflectionIds: string[];
    factIds?: string[];
    now: Date;
  }): Promise<void> {
    const nowMs = input.now.getTime();
    if (input.observationIds.length > 0) {
      const ids = sql.join(
        input.observationIds.map((id) => sql`${id}`),
        sql`, `,
      );
      await this.db.execute(sql`
        UPDATE memory_observations
           SET reference_count = reference_count + 1, referenced_at = ${nowMs}
         WHERE id IN (${ids})
           AND thread_id IN (
             SELECT id FROM memory_threads WHERE owner_id = ${input.accountId}
           )
      `);
    }
    if (input.reflectionIds.length > 0) {
      const ids = sql.join(
        input.reflectionIds.map((id) => sql`${id}`),
        sql`, `,
      );
      await this.db.execute(sql`
        UPDATE memory_reflections
           SET reference_count = reference_count + 1, referenced_at = ${nowMs}
         WHERE id IN (${ids})
           AND owner_id = ${input.accountId}
      `);
    }
    // docs/14 — recalled facts get the same reinforcement bump (memory_facts carry
    // owner_id directly, no thread join).
    if (input.factIds !== undefined && input.factIds.length > 0) {
      const ids = sql.join(
        input.factIds.map((id) => sql`${id}`),
        sql`, `,
      );
      await this.db.execute(sql`
        UPDATE memory_facts
           SET reference_count = reference_count + 1, referenced_at = ${nowMs}
         WHERE id IN (${ids})
           AND owner_id = ${input.accountId}
      `);
    }
  }

  // docs/14 / docs/12 P8 — HYBRID relevance retrieval over memory_facts (pg mirror of
  // the sqlite adapter). Three RRF-fused signals: tsvector('simple') full-text +
  // pgvector cosine (<=>, sequential scan; ONLY when a query embedding is given) + the
  // forgetting score over the candidate union. Account-scoped + active-only. The vector
  // leg is wrapped so a missing column/extension degrades to FTS+score (fail-open).
  async searchFacts(input: {
    accountId: string;
    projectId?: string;
    resourceId?: string;
    threadId?: string;
    queryText: string;
    queryEmbedding?: Float32Array;
    limit: number;
    now: Date;
    scoreConfig: ScoreConfig;
  }): Promise<Fact[]> {
    const candidateLimit = Math.max(input.limit * 5, 50);
    const scope: SQL[] = [
      eq(memoryFacts.ownerId, input.accountId),
      eq(memoryFacts.status, "active"),
      isNull(memoryFacts.expiredAt),
    ];
    if (input.projectId !== undefined) scope.push(eq(memoryFacts.projectId, input.projectId));
    if (input.resourceId !== undefined) scope.push(eq(memoryFacts.resourceId, input.resourceId));
    if (input.threadId !== undefined) scope.push(eq(memoryFacts.threadId, input.threadId));
    const scopeWhere = and(...scope) as SQL;

    // ── FTS leg (tsvector simple + websearch_to_tsquery — tolerates arbitrary input) ──
    const ftsIds: string[] = [];
    const cleaned = input.queryText.replace(/\s+/g, " ").trim();
    if (cleaned.length > 0) {
      const rows = await this.execRows(sql`
        SELECT id FROM ${memoryFacts}
         WHERE ${scopeWhere}
           AND to_tsvector('simple', fact_text) @@ websearch_to_tsquery('simple', ${cleaned})
         ORDER BY ts_rank(to_tsvector('simple', fact_text), websearch_to_tsquery('simple', ${cleaned})) DESC
         LIMIT ${candidateLimit}
      `);
      for (const r of rows) ftsIds.push(r.id as string);
    }

    // ── ILIKE fallback ── when the tsquery leg yields NO candidates — CJK that
    // tsvector('simple') can't segment, or a short literal — a substring scan restores
    // exact recall (parity with memory_search), so such queries never regress to empty.
    if (ftsIds.length === 0 && cleaned.length > 0) {
      const rows = await this.execRows(sql`
        SELECT id FROM ${memoryFacts}
         WHERE ${scopeWhere} AND fact_text ILIKE ${`%${cleaned}%`}
         ORDER BY updated_at DESC
         LIMIT ${candidateLimit}
      `);
      for (const r of rows) ftsIds.push(r.id as string);
    }

    // ── vector leg (pgvector cosine, sequential scan) ──
    const vecIds: string[] = [];
    if (input.queryEmbedding !== undefined) {
      const vecLiteral = `[${Array.from(input.queryEmbedding).join(",")}]`;
      try {
        const rows = await this.execRows(sql`
          SELECT id FROM ${memoryFacts}
           WHERE ${scopeWhere} AND embedding IS NOT NULL
           ORDER BY embedding <=> ${vecLiteral}::vector
           LIMIT ${candidateLimit}
        `);
        for (const r of rows) vecIds.push(r.id as string);
      } catch {
        // embedding column / pgvector absent → skip the vector leg (fail-open).
      }
    }

    const candidateIds = [...new Set([...ftsIds, ...vecIds])];
    if (candidateIds.length === 0) return [];

    const factById = new Map<string, Fact>();
    for (const row of await this.db
      .select()
      .from(memoryFacts)
      .where(inArray(memoryFacts.id, candidateIds))) {
      factById.set(row.id, pgRowToFact(row));
    }

    const scoreIds = [...factById.values()]
      .map((f) => ({
        id: f.id,
        score: forgettingScore(
          {
            referencedAt: f.referencedAt ?? null,
            fallbackTs: f.createdAt,
            referenceCount: f.referenceCount ?? 0,
            importance: f.importance ?? 0.5,
          },
          input.scoreConfig,
          input.now,
        ),
      }))
      .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
      .map((x) => x.id);

    return reciprocalRankFusion([ftsIds, vecIds, scoreIds])
      .map((r) => factById.get(r.id))
      .filter((f): f is Fact => f !== undefined)
      .slice(0, input.limit);
  }

  // docs/14 — embedding write sink (pg). Account-guarded; idempotent UPDATE per fact.
  async setFactEmbeddings(input: {
    accountId: string;
    items: Array<{ factId: string; embedding: Float32Array; model: string; dim: number }>;
    job?: { id: string; leaseGeneration: number };
  }): Promise<boolean> {
    if (input.items.length === 0) return true;
    return this.db.transaction(async (tx) => {
      if (input.job !== undefined && !(await this.hasCurrentJobLease(tx, input.job))) return false;
      for (const it of input.items) {
        const vecLiteral = `[${Array.from(it.embedding).join(",")}]`;
        await tx.execute(sql`
          UPDATE memory_facts
             SET embedding = ${vecLiteral}::vector, embedding_model = ${it.model}, embedding_dim = ${it.dim}
           WHERE id = ${it.factId} AND owner_id = ${input.accountId}
        `);
      }
      return true;
    });
  }

  // docs/14 — embedding job READ half (pg). ACTIVE facts with no embedding, one from a
  // DIFFERENT model, or a DIFFERENT dim (IS DISTINCT FROM is NULL-safe). Oldest-first.
  async listFactsNeedingEmbedding(input: {
    accountId: string;
    model: string;
    dim: number;
    limit: number;
  }): Promise<Array<{ id: string; factText: string }>> {
    const rows = await this.execRows(sql`
      SELECT id, fact_text AS "factText" FROM ${memoryFacts}
       WHERE owner_id = ${input.accountId}
         AND status = 'active'
         AND expired_at IS NULL
         AND (
           embedding IS NULL
           OR embedding_model IS DISTINCT FROM ${input.model}
           OR embedding_dim IS DISTINCT FROM ${input.dim}
         )
       ORDER BY created_at ASC
       LIMIT ${input.limit}
    `);
    return rows.map((r) => ({ id: r.id as string, factText: r.factText as string }));
  }

  // Normalize a raw drizzle-pg execute() result to plain rows (pglite returns
  // { rows }, postgres-js returns an array) — mirrors the migration runner.
  private async execRows(query: SQL): Promise<Array<Record<string, unknown>>> {
    const res = (await this.db.execute(query)) as
      | { rows?: Array<Record<string, unknown>> }
      | Array<Record<string, unknown>>;
    return Array.isArray(res) ? res : (res.rows ?? []);
  }

  // docs/12 P5 decay sweep — READ half (pg mirror of the sqlite adapter). Every
  // ACTIVE observation owned by the account (joined via its thread's owner_id —
  // observations carry no owner_id column), with ONLY the score-input columns.
  // archived rows are excluded → idempotent re-sweep. The bigint epoch-ms columns
  // surface as numbers; box back to Date here (the score fn + sweep are Date-typed).
  async listScorableObservations(scope: {
    accountId: string;
    limit?: number;
    candidates?: {
      nowMs: number;
      half_life_s: number;
      importance_floor: number;
      importance_ceil: number;
      access_weight: number;
      threshold: number;
    };
  }): Promise<
    Array<{
      id: string;
      referencedAt: Date | null;
      observedAt: Date;
      referenceCount: number;
      importance: number;
    }>
  > {
    // OLDEST active first + bound the scan by `limit`. With `candidates` present the
    // forgetting score is evaluated IN SQL (same formula as forgetting/score.ts; see
    // the sqlite adapter for the starvation rationale — pg mirror):
    //   power(0.5, GREATEST(0, (now − coalesce(ref, obs))/1000.0) / half_life)
    //     × (LEAST(GREATEST(importance, floor), ceil) + aw × ln(1 + reference_count))
    //     < threshold
    const c = scope.candidates;
    const filters: SQL[] = [
      eq(memoryObservations.status, "active"),
      sql`${memoryObservations.threadId} IN (SELECT id FROM memory_threads WHERE owner_id = ${scope.accountId})`,
    ];
    if (c !== undefined) {
      filters.push(
        sql`power(0.5, GREATEST(0, (${c.nowMs} - COALESCE(${memoryObservations.referencedAt}, ${memoryObservations.observedAt})) / 1000.0) / ${c.half_life_s})
          * (LEAST(GREATEST(${memoryObservations.importance}, ${c.importance_floor}), ${c.importance_ceil}) + ${c.access_weight} * ln(1 + ${memoryObservations.referenceCount})) < ${c.threshold}`,
      );
    }
    const base = this.db
      .select({
        id: memoryObservations.id,
        referencedAt: memoryObservations.referencedAt,
        observedAt: memoryObservations.observedAt,
        referenceCount: memoryObservations.referenceCount,
        importance: memoryObservations.importance,
      })
      .from(memoryObservations)
      .where(and(...filters))
      .orderBy(asc(memoryObservations.observedAt), asc(memoryObservations.id));
    const rows =
      scope.limit !== undefined && scope.limit > 0 ? await base.limit(scope.limit) : await base;
    return rows.map((row) => ({
      id: row.id,
      referencedAt: row.referencedAt === null ? null : new Date(row.referencedAt),
      observedAt: new Date(row.observedAt),
      referenceCount: row.referenceCount,
      importance: row.importance,
    }));
  }

  // docs/12 P5 decay sweep — WRITE half (pg mirror). Soft-invalidate the named
  // observations (status='archived', archived_at=now) — NEVER a DELETE. ACCOUNT-GUARDED
  // via the thread's owner_id; empty id list → no statement; touches ONLY the
  // observation status/archived_at, never raw messages nor other accounts' rows.
  async archiveObservations(input: {
    accountId: string;
    ids: string[];
    now: Date;
    job?: { id: string; leaseGeneration: number };
  }): Promise<boolean> {
    if (input.ids.length === 0) return true;
    const nowMs = input.now.getTime();
    const ids = sql.join(
      input.ids.map((id) => sql`${id}`),
      sql`, `,
    );
    return this.db.transaction(async (tx) => {
      if (input.job !== undefined && !(await this.hasCurrentJobLease(tx, input.job))) return false;
      const rows = pgRows<{
        project_id: string | null;
        resource_id: string | null;
        thread_id: string;
      }>(
        await tx.execute(sql`
          SELECT DISTINCT t.project_id, t.resource_id, t.id AS thread_id
            FROM memory_observations o
            JOIN memory_threads t ON t.id = o.thread_id
           WHERE o.id IN (${ids})
             AND o.status = 'active' AND t.owner_id = ${input.accountId}
        `),
      );
      const scopes = new Map<string, ReflectionScope>();
      for (const row of rows) {
        const targets: ReflectionScope[] = [];
        if (row.project_id !== null) {
          targets.push({ accountId: input.accountId, projectId: row.project_id });
        }
        if (row.resource_id !== null) {
          targets.push({ accountId: input.accountId, resourceId: row.resource_id });
        }
        if (targets.length === 0) {
          targets.push({ accountId: input.accountId, threadId: row.thread_id });
        }
        for (const target of targets) scopes.set(encodeScopeId(target), target);
      }
      const scopeIds = [...scopes.keys()].sort();
      // Serialize enqueue + publication around each affected scope. Close every
      // old open execution before hiding its inputs, then publish successors only
      // after observations and reflections have been archived in this transaction.
      for (const scopeId of scopeIds) {
        await tx.execute(
          sql`SELECT pg_advisory_xact_lock(hashtextextended(${scopeId}, ${REFLECTOR_JOB_LOCK_SEED}))`,
        );
      }
      for (const scopeId of scopeIds) {
        await tx.execute(sql`
          UPDATE memory_jobs
             SET status = 'failed', error = 'superseded by observation archive', updated_at = ${nowMs}
           WHERE type = 'reflector'
             AND scope_id = ${scopeId}
             AND status IN ('pending', 'running')
        `);
      }
      await tx.execute(sql`
        UPDATE memory_observations
           SET status = 'archived', archived_at = ${nowMs}
         WHERE id IN (${ids})
           AND status = 'active'
           AND thread_id IN (
             SELECT id FROM memory_threads WHERE owner_id = ${input.accountId}
           )
      `);
      for (const [scopeId, target] of scopes) {
        await tx.execute(sql`
          UPDATE memory_reflections
             SET status = 'archived'
           WHERE owner_id = ${target.accountId}
             AND project_id IS NOT DISTINCT FROM ${target.projectId ?? null}
             AND resource_id IS NOT DISTINCT FROM ${target.resourceId ?? null}
             AND thread_id IS NOT DISTINCT FROM ${target.threadId ?? null}
             AND status = 'active'
        `);
        if (target.projectId !== undefined || target.resourceId !== undefined) {
          await tx.execute(sql`
            INSERT INTO memory_jobs (id, type, scope_id, status, error, created_at, updated_at)
            VALUES (${this.genId()}, 'reflector', ${scopeId}, 'pending', NULL, ${nowMs}, ${nowMs})
            ON CONFLICT (type, scope_id) WHERE status IN ('pending', 'running') DO NOTHING
          `);
        }
      }
      return true;
    });
  }

  // docs/12 P5 trigger — pg mirror of the sqlite buffer-flush gate (same contract). For
  // every owner with ≥1 active observation: last decay sweep time (newest decay job's
  // created_at for its scope_id) + count of active observations newer than that sweep;
  // DUE if that count ≥ triggerObservations OR (now − lastSweep) ≥ triggerIntervalS (a
  // never-swept account is due on the time gate). scope_id is the canonical
  // encodeScopeId JSON, so the account is matched via `scope_id::jsonb ->> 'accountId'`
  // — NEVER by string-concatenating a lookalike literal (Codex review fix: a
  // JSON-special id is escaped by the codec, a concat would never match, last_sweep
  // would stay null forever and the account would re-trigger every worker tick).
  async listDecayCandidateAccounts(input: {
    triggerObservations: number;
    triggerIntervalS: number;
    nowMs: number;
    limit?: number;
  }): Promise<string[]> {
    const intervalCutoff = input.nowMs - input.triggerIntervalS * 1000;
    const limit = input.limit === undefined ? 100 : Math.max(0, input.limit);
    if (limit === 0) return [];
    const result = (await this.db.execute(sql`
      WITH decay_sweeps AS (
        SELECT scope_id::jsonb ->> 'accountId' AS owner_id, MAX(created_at) AS last_sweep
          FROM memory_jobs
         WHERE type = 'decay'
         GROUP BY scope_id::jsonb ->> 'accountId'
      ), candidates AS (
        SELECT mt.owner_id AS owner_id, ds.last_sweep AS last_sweep,
               COUNT(o.id) AS active_total,
               SUM(CASE WHEN o.observed_at > COALESCE(ds.last_sweep, 0)
                   THEN 1 ELSE 0 END) AS new_since_sweep
          FROM memory_observations o
          JOIN memory_threads mt ON mt.id = o.thread_id
          LEFT JOIN decay_sweeps ds ON ds.owner_id = mt.owner_id
         WHERE o.status = 'active' AND mt.owner_id IS NOT NULL
         GROUP BY mt.owner_id, ds.last_sweep
        HAVING COUNT(o.id) > 0
           AND (
             SUM(CASE WHEN o.observed_at > COALESCE(ds.last_sweep, 0) THEN 1 ELSE 0 END) >= ${input.triggerObservations}
             OR ds.last_sweep IS NULL OR ds.last_sweep <= ${intervalCutoff}
           )
      )
      SELECT owner_id FROM candidates
       ORDER BY owner_id
       LIMIT ${limit}
    `)) as unknown;
    const rows = (
      Array.isArray(result) ? result : ((result as { rows?: unknown[] }).rows ?? [])
    ) as Array<{
      owner_id: string;
      last_sweep: number | string | null;
      active_total: number | string;
      new_since_sweep: number | string | null;
    }>;
    return rows.map((row) => row.owner_id);
  }

  // docs/12 P6 — fact ingest with deterministic dedup + same-subject supersede
  // (pg mirror of the sqlite adapter; same contract). Per fact:
  //   1. INSERT … ON CONFLICT (owner_id, content_hash) DO NOTHING → the
  //      account-scoped unique index makes a repeat assertion a no-op (Mem0 dedup
  //      borrow); two accounts with the same content_hash both insert.
  //   2. On a REAL insert (RETURNING id non-empty), supersede the OLDER same-
  //      subject row: a pure datetime UPDATE stamping expired_at=now +
  //      invalid_at=new.valid_from over still-ACTIVE rows with the same
  //      (owner_id, subject_key), the new fact's scope (NULL-safe via IS NOT
  //      DISTINCT FROM), an OLDER valid_from and a DIFFERENT id. NEVER a DELETE
  //      (Graphiti borrow). Statement-by-statement (no native multi-row reconcile)
  //      — the dedupe/supersede logic is identical, the dialect differs.
  async insertFactsReconciled(input: {
    accountId: string;
    scope: { projectId?: string; resourceId?: string; threadId?: string };
    facts: MemoryFactInput[];
    now: Date;
    job?: { id: string; leaseGeneration: number };
  }): Promise<MemoryFactReconcileResult> {
    // docs/12 P6 (Codex review fix #3) — insert + supersede must be ATOMIC. The pg
    // adapter previously ran them as two un-wrapped statements: a crash AFTER the
    // insert but BEFORE the supersede left the new fact persisted while the old one
    // stayed active, and the retry hit `ON CONFLICT DO NOTHING` + `continue`, so the
    // stale fact was NEVER superseded. Wrapping the whole batch in ONE transaction
    // makes each insert+supersede pair all-or-nothing: a mid-batch failure rolls the
    // partial work back, and the content_hash unique index makes the retry's
    // re-insert idempotent so supersede runs again. Mirrors the sqlite adapter, which
    // already wraps the batch in `$sqlite.transaction`.
    return this.db.transaction((tx) =>
      this.reconcileFacts({ execute: (query) => tx.execute(query) }, input),
    );
  }

  private async reconcileFacts(
    tx: { execute: (query: SQL) => Promise<unknown> },
    input: {
      accountId: string;
      scope: { projectId?: string; resourceId?: string; threadId?: string };
      facts: MemoryFactInput[];
      now: Date;
      job?: { id: string; leaseGeneration: number };
    },
  ): Promise<MemoryFactReconcileResult> {
    if (input.facts.length === 0) {
      return { insertedIds: [], supersededIds: [], resurrectedIds: [] };
    }
    if (input.job !== undefined && !(await this.hasCurrentJobLease(tx, input.job))) {
      return { insertedIds: [], supersededIds: [], resurrectedIds: [], accepted: false };
    }
    const nowMs = input.now.getTime();
    const insertedIds: string[] = [];
    const supersededIds: string[] = [];
    const resurrectedIds: string[] = [];
    for (const f of input.facts) {
      // The top-level accountId is the authoritative tenant guard; persist it as
      // owner_id so a mismatched input can never write under another tenant.
      const ownerId = input.accountId;
      const projectId = f.projectId ?? null;
      const resourceId = f.resourceId ?? null;
      const threadId = f.threadId ?? null;
      const id = this.genId();
      const validFromMs = f.validFrom.getTime();
      const inserted = (await tx.execute(sql`
        INSERT INTO memory_facts
          (id, owner_id, project_id, resource_id, thread_id, subject_key, fact_text,
           content_hash, importance, reference_count, referenced_at, valid_from,
           invalid_at, expired_at, status, source_observation_range, created_at, updated_at)
        VALUES (
          ${id}, ${ownerId}, ${projectId}, ${resourceId}, ${threadId}, ${f.subjectKey},
          ${f.factText}, ${f.contentHash}, ${f.importance ?? 0.5}, ${f.referenceCount ?? 0},
          ${f.referencedAt != null ? f.referencedAt.getTime() : null}, ${validFromMs},
          ${f.invalidAt != null ? f.invalidAt.getTime() : null},
          ${f.expiredAt != null ? f.expiredAt.getTime() : null}, ${f.status ?? "active"},
          ${f.sourceObservationRange !== undefined ? JSON.stringify(f.sourceObservationRange) : null},
          ${nowMs}, ${nowMs}
        )
        ON CONFLICT (owner_id, content_hash) DO NOTHING
        RETURNING id
      `)) as { rows?: Array<{ id: string }> } | Array<{ id: string }>;
      const insertedRows = Array.isArray(inserted) ? inserted : (inserted.rows ?? []);
      if (insertedRows[0] === undefined) {
        // Dedup hit: the (owner_id, content_hash) row already exists. Resurrect it
        // when NOT live (pruned by a manual delete, or archived) so a re-observed
        // fact returns rather than being permanently suppressed by the idempotency
        // index. A live duplicate stays a no-op. Mirrors the sqlite adapter.
        const existingRes = (await tx.execute(sql`
          SELECT id, status FROM memory_facts
           WHERE owner_id = ${ownerId} AND content_hash = ${f.contentHash}
           LIMIT 1
        `)) as
          | { rows?: Array<{ id: string; status: string }> }
          | Array<{ id: string; status: string }>;
        const existingRows = Array.isArray(existingRes) ? existingRes : (existingRes.rows ?? []);
        const existing = existingRows[0];
        if (
          existing !== undefined &&
          (existing.status === "pruned" || existing.status === "archived")
        ) {
          // Re-scope on resurrect (Codex review fix; sqlite mirror): the
          // (owner_id, content_hash) index is ACCOUNT-GLOBAL, so a fact re-stated under
          // a different project/resource/thread dedup-hits the old row. Reactivating
          // without re-scoping would revive it at the STALE scope and the scoped inject
          // read would never surface it. The re-ingest's scope is authoritative, so
          // overwrite the scope columns too (same-scope re-statement = no-op rewrite).
          await tx.execute(sql`
            UPDATE memory_facts
               SET status = 'active', expired_at = NULL, invalid_at = NULL,
                   valid_from = ${validFromMs}, updated_at = ${nowMs},
                   project_id = ${projectId}, resource_id = ${resourceId}, thread_id = ${threadId}
             WHERE id = ${existing.id}
          `);
          resurrectedIds.push(existing.id);
          const reSuperseded = (await tx.execute(sql`
            UPDATE memory_facts
               SET expired_at = ${nowMs}, invalid_at = ${validFromMs}, updated_at = ${nowMs}
             WHERE owner_id = ${ownerId}
               AND subject_key = ${f.subjectKey}
               AND status = 'active'
               AND expired_at IS NULL
               AND valid_from < ${validFromMs}
               AND id <> ${existing.id}
               AND (${projectId}::text IS NULL OR project_id = ${projectId})
               AND (${resourceId}::text IS NULL OR resource_id = ${resourceId})
               AND (${threadId}::text IS NULL OR thread_id = ${threadId})
            RETURNING id
          `)) as { rows?: Array<{ id: string }> } | Array<{ id: string }>;
          const reSupersededRows = Array.isArray(reSuperseded)
            ? reSuperseded
            : (reSuperseded.rows ?? []);
          for (const s of reSupersededRows) supersededIds.push(s.id);
        }
        continue; // deduped (or resurrected above) → skip the fresh-insert supersede
      }
      insertedIds.push(id);

      // Supersede narrows by the NEW fact's NON-NULL scope columns ONLY — the SAME
      // semantics as the listActiveFacts read path (Codex review fix; pg mirror of
      // the sqlite adapter). A null scope column on the new fact imposes NO
      // constraint: `(${"value"}::text IS NULL OR col = value)` short-circuits to
      // a no-op clause when the bound value is null. RETURNING id surfaces the
      // superseded rows (docs/13 — the MCP add tool echoes them).
      const superseded = (await tx.execute(sql`
        UPDATE memory_facts
           SET expired_at = ${nowMs}, invalid_at = ${validFromMs}, updated_at = ${nowMs}
         WHERE owner_id = ${ownerId}
           AND subject_key = ${f.subjectKey}
           AND status = 'active'
           AND expired_at IS NULL
           AND valid_from < ${validFromMs}
           AND id <> ${id}
           AND (${projectId}::text IS NULL OR project_id = ${projectId})
           AND (${resourceId}::text IS NULL OR resource_id = ${resourceId})
           AND (${threadId}::text IS NULL OR thread_id = ${threadId})
        RETURNING id
      `)) as { rows?: Array<{ id: string }> } | Array<{ id: string }>;
      const supersededRows = Array.isArray(superseded) ? superseded : (superseded.rows ?? []);
      for (const s of supersededRows) supersededIds.push(s.id);
    }
    return { insertedIds, supersededIds, resurrectedIds };
  }

  // docs/12 P6 — fact READ half (pg mirror). The account's still-alive facts:
  // owner_id = accountId AND status='active' AND expired_at IS NULL, optionally
  // narrowed by the in-account scope columns. bigint epoch-ms columns boxed back
  // to Date; the source range jsonb is native.
  async listActiveFacts(input: {
    accountId: string;
    projectId?: string;
    resourceId?: string;
    threadId?: string;
  }): Promise<Fact[]> {
    const clauses: SQL[] = [
      eq(memoryFacts.ownerId, input.accountId),
      eq(memoryFacts.status, "active"),
      isNull(memoryFacts.expiredAt),
    ];
    if (input.projectId !== undefined) clauses.push(eq(memoryFacts.projectId, input.projectId));
    if (input.resourceId !== undefined) clauses.push(eq(memoryFacts.resourceId, input.resourceId));
    if (input.threadId !== undefined) clauses.push(eq(memoryFacts.threadId, input.threadId));
    const rows = await this.db
      .select()
      .from(memoryFacts)
      .where(and(...clauses) as SQL)
      .orderBy(asc(memoryFacts.createdAt), asc(memoryFacts.id));
    return rows.map(pgRowToFact);
  }

  async listInjectionFacts(input: {
    accountId: string;
    projectId?: string;
    resourceId?: string;
    threadId?: string;
    limit: number;
    score?: {
      nowMs: number;
      half_life_s: number;
      importance_floor: number;
      importance_ceil: number;
      access_weight: number;
    };
  }): Promise<Fact[]> {
    const clauses: SQL[] = [
      eq(memoryFacts.ownerId, input.accountId),
      eq(memoryFacts.status, "active"),
      isNull(memoryFacts.expiredAt),
    ];
    if (input.projectId !== undefined) clauses.push(eq(memoryFacts.projectId, input.projectId));
    if (input.resourceId !== undefined) clauses.push(eq(memoryFacts.resourceId, input.resourceId));
    if (input.threadId !== undefined) clauses.push(eq(memoryFacts.threadId, input.threadId));
    const score = input.score;
    const scoreOrder =
      score === undefined
        ? undefined
        : sql`power(0.5, GREATEST(0, (${score.nowMs} - COALESCE(${memoryFacts.referencedAt}, ${memoryFacts.createdAt})) / 1000.0) / ${score.half_life_s}) * (LEAST(GREATEST(${memoryFacts.importance}, ${score.importance_floor}), ${score.importance_ceil}) + ${score.access_weight} * ln(1 + ${memoryFacts.referenceCount}))`;
    const rows = await this.db
      .select()
      .from(memoryFacts)
      .where(and(...clauses) as SQL)
      .orderBy(
        scoreOrder === undefined ? desc(memoryFacts.validFrom) : desc(scoreOrder),
        desc(memoryFacts.validFrom),
        desc(memoryFacts.id),
      )
      .limit(input.limit);
    return rows.map(pgRowToFact);
  }

  // =========================================================================
  // docs/13 — Memory ADMIN + MCP management surface (pg mirror of the sqlite
  // adapter; identical contract, async + bigint-epoch boxing).
  // =========================================================================

  // Admin "By Scope" view. facts ⊎ reflections via a UNION of grouped subqueries
  // (kept for dialect parity with sqlite); reflections guarded owner_id IS NOT NULL.
  async listMemoryScopes(input: {
    accountId?: string;
    limit: number;
    offset: number;
  }): Promise<{ rows: MemoryScopeSummary[]; total: number }> {
    const acct = input.accountId ?? null;
    const aggregate = sql`
      SELECT owner_id AS "accountId", project_id AS "projectId", resource_id AS "resourceId",
             thread_id AS "threadId",
             SUM(fc)::bigint AS "factCount", SUM(rc)::bigint AS "reflectionCount",
             MAX(lu)::bigint AS "lastUpdated", COUNT(*) OVER()::bigint AS total
        FROM (
          SELECT owner_id, project_id, resource_id, thread_id,
                 COUNT(*) AS fc, 0 AS rc, MAX(updated_at) AS lu
            FROM memory_facts
           WHERE status = 'active' AND expired_at IS NULL
             AND (${acct}::text IS NULL OR owner_id = ${acct})
           GROUP BY owner_id, project_id, resource_id, thread_id
          UNION ALL
          SELECT owner_id, project_id, resource_id, thread_id,
                 0 AS fc, COUNT(*) AS rc, MAX(updated_at) AS lu
            FROM memory_reflections
           WHERE status = 'active' AND owner_id IS NOT NULL
             AND (${acct}::text IS NULL OR owner_id = ${acct})
           GROUP BY owner_id, project_id, resource_id, thread_id
       ) g
       GROUP BY owner_id, project_id, resource_id, thread_id
    `;
    const result = (await this.db.execute(sql`
      ${aggregate}
      ORDER BY MAX(lu) DESC, owner_id ASC,
               CASE WHEN project_id IS NULL THEN 0 ELSE 1 END, project_id ASC,
               CASE WHEN resource_id IS NULL THEN 0 ELSE 1 END, resource_id ASC,
               CASE WHEN thread_id IS NULL THEN 0 ELSE 1 END, thread_id ASC
      LIMIT ${input.limit} OFFSET ${input.offset}
    `)) as
      | { rows?: Array<ScopeAggRow & { total: number | string }> }
      | Array<ScopeAggRow & { total: number | string }>;
    const rows = Array.isArray(result) ? result : (result.rows ?? []);
    const total =
      rows[0] !== undefined
        ? Number(rows[0].total)
        : input.offset === 0 && input.limit > 0
          ? 0
          : Number(
              pgRows<{ total: number | string }>(
                await this.db.execute(
                  sql`SELECT COUNT(*)::bigint AS total FROM (${aggregate}) scopes`,
                ),
              )[0]?.total ?? 0,
            );
    return {
      rows: rows.map((r) => ({
        accountId: r.accountId,
        projectId: r.projectId,
        resourceId: r.resourceId,
        threadId: r.threadId,
        factCount: Number(r.factCount),
        reflectionCount: Number(r.reflectionCount),
        lastUpdated: r.lastUpdated !== null ? new Date(Number(r.lastUpdated)) : null,
      })),
      total,
    };
  }

  async getMemoryAdminStats(
    input: MemoryAdminStatsScope & { now: Date },
  ): Promise<MemoryAdminStats> {
    const accountId = input.accountId ?? null;
    const projectId = input.projectId ?? null;
    const resourceId = input.resourceId ?? null;
    const threadId = input.threadId ?? null;
    const noScopeFilter =
      accountId === null && projectId === null && resourceId === null && threadId === null;
    const jobScopeClauses = pgMemoryJobScopeClauses(input);
    // Aggregate the denormalized parent-row activity. This avoids scanning the
    // body-heavy memory_messages/memory_observations tables on an admin read.
    const threadActivity = pgRows<{
      n: number | string;
      messages: number | string;
      observations: number | string;
      lastMessageAt: number | string | null;
      lastObservationAt: number | string | null;
    }>(
      await this.db.execute(
        noScopeFilter
          ? sql`
              SELECT COUNT(*)::bigint AS n,
                     COALESCE(SUM(message_count), 0)::bigint AS messages,
                     COALESCE(SUM(observation_count), 0)::bigint AS observations,
                     MAX(last_message_at)::bigint AS "lastMessageAt",
                     MAX(last_observation_at)::bigint AS "lastObservationAt"
                FROM memory_threads
            `
          : sql`
              SELECT COUNT(*)::bigint AS n,
                     COALESCE(SUM(t.message_count), 0)::bigint AS messages,
                     COALESCE(SUM(t.observation_count), 0)::bigint AS observations,
                     MAX(t.last_message_at)::bigint AS "lastMessageAt",
                     MAX(t.last_observation_at)::bigint AS "lastObservationAt"
                FROM memory_threads t
               WHERE (${accountId}::text IS NULL OR t.owner_id = ${accountId})
                 AND (${projectId}::text IS NULL OR t.project_id = ${projectId})
                 AND (${resourceId}::text IS NULL OR t.resource_id = ${resourceId})
                 AND (${threadId}::text IS NULL OR t.id = ${threadId})
          `,
      ),
    )[0];
    const facts = pgRows<{
      n: number | string;
      active: number | string | null;
      lastAt: number | string | null;
    }>(
      await this.db.execute(
        noScopeFilter
          ? sql`
              SELECT COUNT(*)::bigint AS n,
                     SUM(CASE WHEN status = 'active' AND expired_at IS NULL THEN 1 ELSE 0 END)::bigint AS active,
                     MAX(updated_at)::bigint AS "lastAt"
                FROM memory_facts
            `
          : sql`
              SELECT COUNT(*)::bigint AS n,
                     SUM(CASE WHEN status = 'active' AND expired_at IS NULL THEN 1 ELSE 0 END)::bigint AS active,
                     MAX(updated_at)::bigint AS "lastAt"
                FROM memory_facts
               WHERE (${accountId}::text IS NULL OR owner_id = ${accountId})
                 AND (${projectId}::text IS NULL OR project_id = ${projectId})
                 AND (${resourceId}::text IS NULL OR resource_id = ${resourceId})
                 AND (${threadId}::text IS NULL OR thread_id = ${threadId})
            `,
      ),
    )[0];
    const reflections = pgRows<{
      n: number | string;
      active: number | string | null;
      lastAt: number | string | null;
    }>(
      await this.db.execute(
        noScopeFilter
          ? sql`
              SELECT COUNT(*)::bigint AS n,
                     SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END)::bigint AS active,
                     MAX(updated_at)::bigint AS "lastAt"
                FROM memory_reflections
            `
          : sql`
              SELECT COUNT(*)::bigint AS n,
                     SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END)::bigint AS active,
                     MAX(updated_at)::bigint AS "lastAt"
                FROM memory_reflections
               WHERE (${accountId}::text IS NULL OR owner_id = ${accountId})
                 AND (${projectId}::text IS NULL OR project_id = ${projectId})
                 AND (${resourceId}::text IS NULL OR resource_id = ${resourceId})
                 AND (${threadId}::text IS NULL OR thread_id = ${threadId})
            `,
      ),
    )[0];
    const queueRows = pgRows<{ status: string; n: number | string }>(
      await this.db.execute(
        sql`
          SELECT status, COUNT(*)::bigint AS n
            FROM memory_jobs
            ${pgWhere(jobScopeClauses)}
           GROUP BY status
        `,
      ),
    );
    const queue = { pending: 0, running: 0, done: 0, failed: 0 };
    for (const row of queueRows) {
      if (row.status === "pending") queue.pending = numberOf(row.n);
      else if (row.status === "running") queue.running = numberOf(row.n);
      else if (row.status === "done") queue.done = numberOf(row.n);
      else if (row.status === "failed") queue.failed = numberOf(row.n);
    }
    const jobScalar = async (
      expr: SQL,
      status: MemoryJobStatus,
      extraClauses: readonly SQL[] = [],
    ): Promise<number | string | null> => {
      const rows = pgRows<{ value: number | string | null }>(
        await this.db.execute(sql`
          SELECT ${expr} AS value
            FROM memory_jobs
            ${pgWhere([sql`status = ${status}`, ...jobScopeClauses, ...extraClauses])}
        `),
      );
      return rows[0]?.value ?? null;
    };
    const queueTimes = {
      oldestPendingAt: await jobScalar(sql`MIN(created_at)::bigint`, "pending"),
      oldestRunningAt: await jobScalar(sql`MIN(updated_at)::bigint`, "running"),
      newestDoneAt: await jobScalar(sql`MAX(updated_at)::bigint`, "done"),
      newestFailedAt: await jobScalar(sql`MAX(updated_at)::bigint`, "failed"),
      staleRunning: await jobScalar(sql`COUNT(*)::bigint`, "running", [
        sql`updated_at <= ${input.now.getTime() - RUNNING_LEASE_MS}`,
      ]),
    };
    const byType = pgRows<{ type: string; status: string; count: number | string }>(
      await this.db.execute(
        sql`
          SELECT type, status, COUNT(*)::bigint AS count
            FROM memory_jobs
            ${pgWhere(jobScopeClauses)}
           GROUP BY type, status
           ORDER BY type ASC, status ASC
        `,
      ),
    ).map((r) => ({ type: r.type, status: r.status, count: numberOf(r.count) }));
    return {
      generatedAt: input.now,
      scope: {
        ...(input.accountId !== undefined ? { accountId: input.accountId } : {}),
        ...(input.projectId !== undefined ? { projectId: input.projectId } : {}),
        ...(input.resourceId !== undefined ? { resourceId: input.resourceId } : {}),
        ...(input.threadId !== undefined ? { threadId: input.threadId } : {}),
      },
      storage: {
        threads: numberOf(threadActivity?.n),
        messages: numberOf(threadActivity?.messages),
        observations: numberOf(threadActivity?.observations),
        facts: numberOf(facts?.n),
        activeFacts: numberOf(facts?.active),
        reflections: numberOf(reflections?.n),
        activeReflections: numberOf(reflections?.active),
      },
      queue: {
        ...queue,
        open: queue.pending + queue.running,
        staleRunning: numberOf(queueTimes?.staleRunning),
        oldestPendingAt: dateOrNull(queueTimes?.oldestPendingAt),
        oldestRunningAt: dateOrNull(queueTimes?.oldestRunningAt),
        newestDoneAt: dateOrNull(queueTimes?.newestDoneAt),
        newestFailedAt: dateOrNull(queueTimes?.newestFailedAt),
        byType,
      },
      activity: {
        lastMessageAt: dateOrNull(threadActivity?.lastMessageAt),
        lastObservationAt: dateOrNull(threadActivity?.lastObservationAt),
        lastFactUpdatedAt: dateOrNull(facts?.lastAt),
        lastReflectionUpdatedAt: dateOrNull(reflections?.lastAt),
      },
    };
  }

  async getFactById(input: { accountId: string; id: string }): Promise<Fact | null> {
    const rows = await this.db
      .select()
      .from(memoryFacts)
      .where(and(eq(memoryFacts.id, input.id), eq(memoryFacts.ownerId, input.accountId)))
      .limit(1);
    return rows[0] === undefined ? null : pgRowToFact(rows[0]);
  }

  async listFacts(input: {
    accountId: string;
    projectId?: string;
    resourceId?: string;
    threadId?: string;
    status?: FactListStatus;
    subjectKey?: string;
    search?: string;
    limit: number;
    offset: number;
  }): Promise<{ rows: Fact[]; total: number }> {
    const where = and(...factListClauses(input)) as SQL;
    const rows = await this.db
      .select()
      .from(memoryFacts)
      .where(where)
      .orderBy(desc(memoryFacts.updatedAt), desc(memoryFacts.id))
      .limit(input.limit)
      .offset(input.offset);
    const totalRows = await this.db
      .select({ n: sql<number>`count(*)::int` })
      .from(memoryFacts)
      .where(where);
    return { rows: rows.map(pgRowToFact), total: Number(totalRows[0]?.n ?? 0) };
  }

  async updateFact(input: {
    accountId: string;
    id: string;
    patch: MemoryFactPatch;
    now: Date;
  }): Promise<Fact | null> {
    const existing = await this.getFactById({ accountId: input.accountId, id: input.id });
    if (existing === null) return null;
    const { patch } = input;
    const set: Partial<typeof memoryFacts.$inferInsert> = { updatedAt: input.now.getTime() };
    if (patch.factText !== undefined && patch.factText !== existing.factText) {
      const newHash = factContentHash(patch.factText);
      if (newHash !== existing.contentHash) {
        const conflict = await this.db
          .select({ id: memoryFacts.id })
          .from(memoryFacts)
          .where(
            and(
              eq(memoryFacts.ownerId, input.accountId),
              eq(memoryFacts.contentHash, newHash),
              ne(memoryFacts.id, input.id),
            ),
          )
          .limit(1);
        if (conflict[0] !== undefined) {
          throw new MemoryFactContentHashConflictError(conflict[0].id);
        }
      }
      set.factText = patch.factText;
      set.contentHash = newHash;
    }
    if (patch.importance !== undefined) set.importance = patch.importance;
    if (patch.status !== undefined) {
      set.status = patch.status;
      // Keep expiry in SYNC with the lifecycle (pg mirror): reactivating CLEARS the
      // supersede/prune tombstone (else status='active' AND expired_at IS NULL still
      // hides it); pruning STAMPS it (consistent with deleteFact). 'archived' is
      // invisible via status alone, so expiry is left untouched.
      if (patch.status === "active") set.expiredAt = null;
      else if (patch.status === "pruned") set.expiredAt = input.now.getTime();
    }
    if (patch.invalidAt !== undefined) {
      set.invalidAt = patch.invalidAt === null ? null : patch.invalidAt.getTime();
    }
    await this.db
      .update(memoryFacts)
      .set(set)
      .where(and(eq(memoryFacts.id, input.id), eq(memoryFacts.ownerId, input.accountId)));
    // docs/14 — a TEXT edit invalidates the stored vector (pg mirror): clear the
    // embedding columns so the fact re-embeds on the next embedding job and is NEVER
    // ranked by a stale vector (Codex review). Columns live outside the Drizzle schema
    // (raw migration v27). `set.factText` is set only when the text actually changed.
    if (set.factText !== undefined) {
      await this.db.execute(sql`
        UPDATE memory_facts
           SET embedding = NULL, embedding_model = NULL, embedding_dim = NULL
         WHERE id = ${input.id} AND owner_id = ${input.accountId}
      `);
    }
    return this.getFactById({ accountId: input.accountId, id: input.id });
  }

  async deleteFact(input: { accountId: string; id: string; now: Date }): Promise<boolean> {
    const deleted = await this.db
      .update(memoryFacts)
      .set({ status: "pruned", expiredAt: input.now.getTime(), updatedAt: input.now.getTime() })
      .where(
        and(
          eq(memoryFacts.id, input.id),
          eq(memoryFacts.ownerId, input.accountId),
          ne(memoryFacts.status, "pruned"),
        ),
      )
      .returning();
    return deleted.length > 0;
  }

  async listReflections(input: {
    accountId: string;
    projectId?: string;
    resourceId?: string;
    threadId?: string;
    status?: "active" | "archived" | "all";
    includeAllVersions?: boolean;
    limit: number;
    offset: number;
  }): Promise<{ rows: Reflection[]; total: number }> {
    const clauses: SQL[] = [eq(memoryReflections.ownerId, input.accountId)];
    const status = input.status ?? "active";
    if (status !== "all") clauses.push(eq(memoryReflections.status, status));
    if (input.projectId !== undefined) {
      clauses.push(eq(memoryReflections.projectId, input.projectId));
    }
    if (input.resourceId !== undefined) {
      clauses.push(eq(memoryReflections.resourceId, input.resourceId));
    }
    if (input.threadId !== undefined) clauses.push(eq(memoryReflections.threadId, input.threadId));
    const all = (
      await this.db
        .select()
        .from(memoryReflections)
        .where(and(...clauses) as SQL)
        .orderBy(desc(memoryReflections.version), desc(memoryReflections.updatedAt))
    ).map(pgRowToReflection);
    const grouped = input.includeAllVersions === true ? all : latestPerScope(all);
    grouped.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
    return {
      rows: grouped.slice(input.offset, input.offset + input.limit),
      total: grouped.length,
    };
  }

  async getReflectionById(input: { accountId: string; id: string }): Promise<Reflection | null> {
    const rows = await this.db
      .select()
      .from(memoryReflections)
      .where(
        and(eq(memoryReflections.id, input.id), eq(memoryReflections.ownerId, input.accountId)),
      )
      .limit(1);
    return rows[0] === undefined ? null : pgRowToReflection(rows[0]);
  }

  async updateReflectionText(input: {
    accountId: string;
    id: string;
    reflectionText: string;
    tokenEstimate: number;
    now: Date;
  }): Promise<Reflection | null> {
    const updated = await this.db
      .update(memoryReflections)
      .set({
        reflectionText: input.reflectionText,
        tokenEstimate: input.tokenEstimate,
        updatedAt: input.now.getTime(),
      })
      .where(
        and(eq(memoryReflections.id, input.id), eq(memoryReflections.ownerId, input.accountId)),
      )
      .returning();
    if (updated.length === 0) return null;
    return this.getReflectionById({ accountId: input.accountId, id: input.id });
  }

  // Archive EVERY active version of the reflection's scope (pg mirror) — see the
  // sqlite adapter: archiving one id alone would let getReflection fall back to a
  // sibling active version, so injection would not actually stop.
  // Two-stage operator delete (pg mirror of the sqlite adapter — same contract):
  // active row → SOFT archive every active version of the scope (rows survive);
  // already-archived row → HARD delete every archived version of the scope (a
  // second delete purges; this is what makes an archived row deletable from the
  // admin UI instead of 404'ing "reflection not found"). false only for an
  // unknown/cross-tenant id. See the sqlite comment for the full rationale.
  async deleteReflection(input: { accountId: string; id: string }): Promise<boolean> {
    const row = await this.getReflectionById({ accountId: input.accountId, id: input.id });
    if (row === null) return false;
    const scope: ReflectionScope = {
      accountId: input.accountId,
      ...(row.projectId !== null ? { projectId: row.projectId } : {}),
      ...(row.resourceId !== null ? { resourceId: row.resourceId } : {}),
      ...(row.threadId !== null ? { threadId: row.threadId } : {}),
    };
    if (row.status === "active") {
      const archived = await this.db
        .update(memoryReflections)
        .set({ status: "archived" })
        .where(and(reflectionScopeWhere(scope), eq(memoryReflections.status, "active")))
        .returning();
      return archived.length > 0;
    }
    const purged = await this.db
      .delete(memoryReflections)
      .where(and(reflectionScopeWhere(scope), ne(memoryReflections.status, "active")))
      .returning();
    return purged.length > 0;
  }

  // docs/12 P7 — the retention HARD-DELETE (pg mirror of the sqlite adapter; same
  // contract). The ONLY DELETE in the forgetting system, account-AGNOSTIC, two deletes
  // over the WHOLE store, each a STRICT lower bound (strictly-older-than — a row stamped
  // exactly at the cutoff survives): (1) archived observations whose archived_at < cutoff
  // (the status='archived' guard keeps active rows; raw messages untouched); (2) expired
  // facts whose expired_at < cutoff (expired_at IS NOT NULL keeps still-alive facts).
  // Reflections are NEVER hard-deleted. RETURNING id makes the deleted count portable
  // across pglite + postgres-js (rowCount shape differs between drivers).
  async pruneExpiredMemory(input: {
    archivedObservationsBeforeMs: number;
    expiredFactsBeforeMs: number;
  }): Promise<{ observationsDeleted: number; factsDeleted: number }> {
    // docs/12 (P7, Codex review fix) — TOMBSTONE, not delete: free the text but
    // keep the row + sourceMessageRange so raw coverage survives (pg mirror of the
    // sqlite adapter; see that comment for why a hard DELETE resurrects raw turns).
    let observationsDeleted = 0;
    for (;;) {
      const row = pgRows<{ n: number | string }>(
        await this.db.execute(sql`
          WITH doomed AS (
            SELECT id FROM memory_observations
             WHERE status = 'archived' AND archived_at IS NOT NULL
               AND archived_at < ${input.archivedObservationsBeforeMs}
             ORDER BY archived_at, id LIMIT 1000
          ), changed AS (
            UPDATE memory_observations o
               SET status = 'pruned', observation_text = '[pruned]', tags = NULL
              FROM doomed d WHERE o.id = d.id RETURNING 1
          )
          SELECT COUNT(*)::integer AS n FROM changed
        `),
      )[0];
      const n = numberOf(row?.n);
      observationsDeleted += n;
      if (n < 1000) break;
    }
    let factsDeleted = 0;
    for (;;) {
      const row = pgRows<{ n: number | string }>(
        await this.db.execute(sql`
          WITH doomed AS (
            SELECT id FROM memory_facts
             WHERE expired_at IS NOT NULL AND expired_at < ${input.expiredFactsBeforeMs}
             ORDER BY expired_at, id LIMIT 1000
          ), deleted AS (
            DELETE FROM memory_facts f USING doomed d WHERE f.id = d.id RETURNING 1
          )
          SELECT COUNT(*)::integer AS n FROM deleted
        `),
      )[0];
      const n = numberOf(row?.n);
      factsDeleted += n;
      if (n < 1000) break;
    }
    return { observationsDeleted, factsDeleted };
  }

  // ——— Cleanup/archival (raw transcript + job log) — pg mirror; created_at/
  // updated_at are epoch-ms bigint here, so no Date conversion. ———
  async countMessagesOlderThan(olderThanMs: number): Promise<number> {
    const rows = await this.db
      .select({ value: count() })
      .from(memoryMessages)
      .where(
        and(
          lt(memoryMessages.createdAt, olderThanMs),
          sql`EXISTS (
            SELECT 1 FROM memory_threads mt
             WHERE mt.id = ${memoryMessages.threadId}
               AND mt.observer_frontier_at IS NOT NULL
               AND (
                 ${memoryMessages.createdAt} < mt.observer_frontier_at OR
                 (${memoryMessages.createdAt} = mt.observer_frontier_at AND ${memoryMessages.id} <= mt.observer_frontier_id)
               )
          )`,
        ),
      );
    return rows[0]?.value ?? 0;
  }

  async selectMessagesOlderThan(
    olderThanMs: number,
    limit: number,
    afterId?: string,
  ): Promise<MemoryMessageArchiveRow[]> {
    const conds: SQL[] = [
      lt(memoryMessages.createdAt, olderThanMs),
      sql`EXISTS (
        SELECT 1 FROM memory_threads mt
         WHERE mt.id = ${memoryMessages.threadId}
           AND mt.observer_frontier_at IS NOT NULL
           AND (
             ${memoryMessages.createdAt} < mt.observer_frontier_at OR
             (${memoryMessages.createdAt} = mt.observer_frontier_at AND ${memoryMessages.id} <= mt.observer_frontier_id)
           )
      )`,
    ];
    if (afterId !== undefined) conds.push(gt(memoryMessages.id, afterId));
    const rows = await this.db
      .select()
      .from(memoryMessages)
      .where(and(...conds))
      .orderBy(asc(memoryMessages.id))
      .limit(limit);
    return rows.map((r) => ({
      id: r.id,
      threadId: r.threadId,
      role: r.role,
      content: r.content,
      tokenEstimate: r.tokenEstimate,
      messageIndex: r.messageIndex ?? null,
      contentHash: r.contentHash ?? null,
      createdAt: r.createdAt,
    }));
  }

  async pruneMessagesOlderThan(olderThanMs: number): Promise<number> {
    return this.db.transaction(async (tx) => {
      // A session-local key table keeps the repair set bounded to affected threads
      // without returning every deleted body row through the JS driver.
      await tx.execute(sql`
        CREATE TEMP TABLE IF NOT EXISTS _helm_pruned_message_threads (
          thread_id TEXT PRIMARY KEY
        ) ON COMMIT DELETE ROWS
      `);
      let deletedCount = 0;
      for (;;) {
        await tx.execute(sql`DELETE FROM _helm_pruned_message_threads`);
        // Discover only the threads touched by this bounded delete batch. The old
        // implementation materialized every affected thread before pruning.
        await tx.execute(sql`
          INSERT INTO _helm_pruned_message_threads (thread_id)
          WITH doomed AS (
            SELECT m.id
              FROM memory_messages m
              JOIN memory_threads t ON t.id = m.thread_id
             WHERE m.created_at < ${olderThanMs}
               AND t.observer_frontier_at IS NOT NULL
               AND (
                 m.created_at < t.observer_frontier_at OR
                 (m.created_at = t.observer_frontier_at AND m.id <= t.observer_frontier_id)
               )
             ORDER BY m.created_at, m.id
             LIMIT 1000
          )
          SELECT DISTINCT m.thread_id
            FROM memory_messages m
            JOIN doomed d ON d.id = m.id
          ON CONFLICT (thread_id) DO NOTHING
        `);
        // Serialize summary maintenance with appendMessage/appendMessages, whose
        // counter increments lock the same parent rows. The lock set is bounded
        // by this batch, not the tenant's full historical thread set.
        await tx.execute(sql`
          SELECT t.id
            FROM memory_threads t
            JOIN _helm_pruned_message_threads a ON a.thread_id = t.id
           ORDER BY t.id
             FOR UPDATE
        `);
        const deleted = pgRows<{ n: number | string }>(
          await tx.execute(sql`
            WITH doomed AS (
              SELECT m.id
                FROM memory_messages m
                JOIN memory_threads t ON t.id = m.thread_id
                JOIN _helm_pruned_message_threads a ON a.thread_id = m.thread_id
               WHERE m.created_at < ${olderThanMs}
                 AND t.observer_frontier_at IS NOT NULL
                 AND (
                   m.created_at < t.observer_frontier_at OR
                   (m.created_at = t.observer_frontier_at AND m.id <= t.observer_frontier_id)
                 )
               ORDER BY m.created_at, m.id
               LIMIT 1000
            ), deleted AS (
              DELETE FROM memory_messages m USING doomed d
               WHERE m.id = d.id
               RETURNING 1
            )
            SELECT COUNT(*)::integer AS n FROM deleted
          `),
        )[0];
        const n = numberOf(deleted?.n);
        deletedCount += n;
        // Repair summaries while this batch's bounded lock set is still the
        // active temp set; do not accumulate every touched thread in memory.
        await tx.execute(sql`
          UPDATE memory_threads AS t
             SET message_count = (
                   SELECT COUNT(*)::integer FROM memory_messages m WHERE m.thread_id = t.id
                 ),
                 last_message_at = (
                   SELECT MAX(m.created_at)::bigint FROM memory_messages m WHERE m.thread_id = t.id
                 )
           WHERE EXISTS (
             SELECT 1 FROM _helm_pruned_message_threads a WHERE a.thread_id = t.id
           )
        `);
        if (n < 1000) break;
      }
      return deletedCount;
    });
  }

  async pruneFinishedJobsOlderThan(olderThanMs: number): Promise<number> {
    let total = 0;
    for (;;) {
      const row = pgRows<{ n: number | string }>(
        await this.db.execute(sql`
          WITH doomed AS (
            SELECT id FROM memory_jobs
             WHERE status IN ('done', 'failed') AND updated_at < ${olderThanMs}
             ORDER BY updated_at, id LIMIT 1000
          ), deleted AS (
            DELETE FROM memory_jobs j USING doomed d WHERE j.id = d.id RETURNING 1
          )
          SELECT COUNT(*)::integer AS n FROM deleted
        `),
      )[0];
      const n = numberOf(row?.n);
      total += n;
      if (n < 1000) return total;
    }
  }

  // Auto-compaction model→price resolution — pg mirror of the sqlite adapter
  // (same contract; see those comments). Write half: account-guarded stamp,
  // unknown thread = silent no-op (fail-open, fired best-effort post-response).
  async stampThreadModel(input: {
    accountId: string;
    threadId: string;
    modelAlias: string;
  }): Promise<void> {
    await this.db.execute(sql`
      UPDATE memory_threads
         SET last_served_model = ${input.modelAlias}
       WHERE id = ${input.threadId} AND owner_id = ${input.accountId}
    `);
  }

  // Read half: the thread's stamped model alias, account-guarded.
  async getThreadMeta(input: { accountId: string; threadId: string }): Promise<{
    lastServedModel: string | null;
    messageCount: number;
    observationCount: number;
  } | null> {
    const result = (await this.db.execute(sql`
      SELECT last_served_model, message_count, observation_count
        FROM memory_threads
       WHERE id = ${input.threadId} AND owner_id = ${input.accountId}
    `)) as unknown;
    const rows = (
      Array.isArray(result) ? result : ((result as { rows?: unknown[] }).rows ?? [])
    ) as Array<{
      last_served_model: string | null;
      message_count: number;
      observation_count: number;
    }>;
    const row = rows[0];
    return row === undefined
      ? null
      : {
          lastServedModel: row.last_served_model,
          messageCount: Number(row.message_count),
          observationCount: Number(row.observation_count),
        };
  }

  async getObservationCount(scope: ReflectionScope): Promise<number> {
    const where = observationScopeWhere(scope);
    if (where === null) return 0;
    const rows = await this.db
      .select({ n: sql<number>`count(*)::int` })
      .from(memoryObservations)
      .where(
        and(where, eq(memoryObservations.status, "active"), isNull(memoryObservations.expiredAt)),
      );
    return Number(rows[0]?.n ?? 0);
  }

  // Idle-flush sweep candidates — pg mirror of the sqlite adapter. Idleness =
  // MAX(memory_messages.created_at) ≤ idleBeforeMs (the last appended message,
  // NOT memory_threads.updated_at — ordinary turns append messages without
  // touching the thread row, so updated_at would mark an active thread idle).
  // Uncompacted uses the SAME interval order as listMessages/Observer:
  // message_index first, then created_at/id as the legacy tie-break. Candidates
  // are interleaved by owner+project+resource so one stale project backlog cannot
  // monopolize the worker's small per-tick page.
  async listIdleFlushCandidates(input: {
    idleBeforeMs: number;
    idleAfterMs?: number;
    limit: number;
  }): Promise<
    Array<{ accountId: string; threadId: string; projectId?: string; resourceId?: string }>
  > {
    const idleAfterMs = input.idleAfterMs ?? null;
    const result = (await this.db.execute(sql`
      WITH candidates AS (
        SELECT t.owner_id AS owner_id, t.id AS thread_id,
               t.project_id AS project_id, t.resource_id AS resource_id,
               t.last_message_at AS last_activity
          FROM memory_threads t
         WHERE t.owner_id IS NOT NULL
           AND t.last_message_at <= ${input.idleBeforeMs}
           AND (${idleAfterMs}::bigint IS NULL OR
                t.last_message_at >= ${idleAfterMs} OR
                t.observer_frontier_at IS NULL)
           AND EXISTS (
             SELECT 1 FROM memory_messages m
              WHERE m.thread_id = t.id
                AND (
                  t.observer_frontier_at IS NULL OR
                  m.created_at > t.observer_frontier_at OR
                  (m.created_at = t.observer_frontier_at AND m.id > t.observer_frontier_id)
                )
           )
      ),
      ranked AS (
        SELECT *,
               ROW_NUMBER() OVER (
                 PARTITION BY owner_id, COALESCE(project_id, ''), COALESCE(resource_id, '')
                 ORDER BY last_activity ASC, thread_id ASC
               ) AS scope_rank
          FROM candidates
      )
      SELECT owner_id, thread_id, project_id, resource_id
        FROM ranked
       ORDER BY scope_rank ASC, last_activity ASC, thread_id ASC
       LIMIT ${input.limit}
    `)) as unknown;
    const rows = (
      Array.isArray(result) ? result : ((result as { rows?: unknown[] }).rows ?? [])
    ) as Array<{
      owner_id: string;
      thread_id: string;
      project_id: string | null;
      resource_id: string | null;
    }>;
    return rows.map((row) => ({
      accountId: row.owner_id,
      threadId: row.thread_id,
      ...(row.project_id !== null ? { projectId: row.project_id } : {}),
      ...(row.resource_id !== null ? { resourceId: row.resource_id } : {}),
    }));
  }
}
