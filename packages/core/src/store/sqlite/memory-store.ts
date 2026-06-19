import { randomUUID } from "node:crypto";
import {
  decodeScopeId,
  encodeScopeId,
  type Fact,
  type MemoryFactInput,
  type MemoryFactPatch,
  type MemoryJobEnqueueInput,
  type MemoryJobRow,
  type MemoryMessageInput,
  type MemoryObservationInput,
  type MemoryScopeSummary,
  type MemoryStatus,
  type MemoryThreadInput,
  type Observation,
  type RawMessage,
  type Reflection,
  type ReflectionScope,
  type ReflectionUpsertInput,
} from "@helm/shared";
import { and, asc, count, desc, eq, gt, isNull, like, lt, ne, type SQL, sql } from "drizzle-orm";
import { factContentHash } from "../../memory/forgetting/facts.js";
import { sha256Hex } from "../../memory/message-hash.js";
import {
  MemoryFactContentHashConflictError,
  type MemoryJobStatus,
  type MemoryMessageArchiveRow,
  type MemoryStore,
} from "../ports.js";
import {
  memoryFacts,
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

// How long a claimed (`running`) job stays exclusively leased. After this window
// claimPendingJobs treats it as abandoned (worker crash between claim and finish)
// and re-claims it — without this, the enqueue dedupe against running rows would
// block the scope's queue FOREVER. 5 min is far beyond any real tick's work.
const RUNNING_LEASE_MS = 5 * 60_000;

// Observation read scope. Two shapes (docs/08):
//  - thread scope (inject + observer): the thread's own rows, owner-checked;
//  - project/resource scope (the REFLECTOR's target): aggregate across ALL the
//    owner's threads carrying that project/resource id — a project reflection
//    must see every thread of the project, never just the promoting one
//    (otherwise the merge is last-writer-wins per thread).
// No level at all → null (callers get []).
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

// Drizzle (timestamp_ms mode) already boxes the epoch-ms columns to Date on
// read, so these mappers are pure field projections shared by the inject read
// (listActiveFacts) AND the docs/13 management reads (getFactById / listFacts /
// updateFact) — one mapper, no drift in the Fact/Reflection shape.
function sqliteRowToFact(row: typeof memoryFacts.$inferSelect): Fact {
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
    referencedAt: row.referencedAt,
    validFrom: row.validFrom,
    invalidAt: row.invalidAt,
    expiredAt: row.expiredAt,
    status: row.status as Fact["status"],
    ...(row.sourceObservationRange !== null
      ? { sourceObservationRange: JSON.parse(row.sourceObservationRange) as [string, string] }
      : {}),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function sqliteRowToReflection(row: typeof memoryReflections.$inferSelect): Reflection {
  return {
    id: row.id,
    projectId: row.projectId,
    resourceId: row.resourceId,
    threadId: row.threadId,
    reflectionText: row.reflectionText,
    version: row.version,
    tokenEstimate: row.tokenEstimate,
    updatedAt: row.updatedAt,
    referencedAt: row.referencedAt,
    referenceCount: row.referenceCount,
    status: row.status as Reflection["status"],
  };
}

// docs/13 — collapse a version-DESC reflection list to the highest-version row
// per (project, resource, thread) scope group. upsertReflection appends versions
// without archiving older ones, so a scope can hold several ACTIVE versions; the
// admin list shows one row per scope (like getReflection's MAX(version) pick),
// expandable via includeAllVersions. Dialect-neutral (runs over mapped rows).
function latestPerScope(rows: Reflection[]): Reflection[] {
  const seen = new Map<string, Reflection>();
  for (const r of rows) {
    const key = JSON.stringify([r.projectId, r.resourceId, r.threadId]);
    const cur = seen.get(key);
    if (cur === undefined || r.version > cur.version) seen.set(key, r);
  }
  return [...seen.values()];
}

// docs/13 — shared WHERE for the fact management list (account guard + scope +
// status visibility + subject/search). 'active' = the live set (status='active'
// AND expired_at IS NULL — matches inject); 'all' imposes no status/expired
// predicate so superseded rows are visible. SQLite LIKE is case-insensitive for
// ASCII (the pg adapter mirrors this with ILIKE).
function factListClauses(input: {
  accountId: string;
  projectId?: string;
  resourceId?: string;
  threadId?: string;
  status?: MemoryStatus | "all";
  subjectKey?: string;
  search?: string;
}): SQL[] {
  const clauses: SQL[] = [eq(memoryFacts.ownerId, input.accountId)];
  const status = input.status ?? "active";
  if (status === "active") {
    clauses.push(eq(memoryFacts.status, "active"), isNull(memoryFacts.expiredAt));
  } else if (status !== "all") {
    clauses.push(eq(memoryFacts.status, status));
  }
  if (input.projectId !== undefined) clauses.push(eq(memoryFacts.projectId, input.projectId));
  if (input.resourceId !== undefined) clauses.push(eq(memoryFacts.resourceId, input.resourceId));
  if (input.threadId !== undefined) clauses.push(eq(memoryFacts.threadId, input.threadId));
  if (input.subjectKey !== undefined) clauses.push(eq(memoryFacts.subjectKey, input.subjectKey));
  if (input.search !== undefined && input.search.length > 0) {
    clauses.push(like(memoryFacts.factText, `%${input.search}%`));
  }
  return clauses;
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
    const tsMs = ts.getTime();
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
              then ${tsMs}
            else ${memoryThreads.updatedAt}
          end`,
        },
      })
      .run();
  }

  async appendMessage(input: MemoryMessageInput): Promise<string> {
    const id = this.genId();
    // Idempotent ingest: a re-sent (thread_id, role, content) collapses to a
    // no-op via the v21 UNIQUE index (re-ingestion fix). Returned id is still
    // generated per call; on conflict it is inert (the row was left untouched).
    this.db
      .insert(memoryMessages)
      .values({
        id,
        threadId: input.threadId,
        messageIndex: input.messageIndex ?? 0,
        role: input.role,
        content: input.content,
        tokenEstimate: input.tokenEstimate,
        createdAt: this.now(),
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
      .run();
    return id;
  }

  // ONE synchronous transaction = ONE commit for the whole turn (vs N from the
  // appendMessage loop). createdAt is stamped base+i so listMessages (ordered by
  // createdAt, id) returns rows in append order even though randomUUID ids do not
  // sort — strictly more deterministic than the per-message loop, which collides
  // on the millisecond and then falls back to arbitrary id order.
  async appendMessages(inputs: MemoryMessageInput[]): Promise<string[]> {
    if (inputs.length === 0) return [];
    const base = this.now().getTime();
    const ids: string[] = [];
    const run = this.db.$sqlite.transaction(() => {
      inputs.forEach((input, i) => {
        const id = this.genId();
        ids.push(id);
        this.db
          .insert(memoryMessages)
          .values({
            id,
            threadId: input.threadId,
            messageIndex: input.messageIndex ?? i,
            role: input.role,
            content: input.content,
            tokenEstimate: input.tokenEstimate,
            createdAt: new Date(base + i),
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
          .run();
      });
    });
    run();
    return ids;
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
      .orderBy(
        sql`CASE WHEN ${memoryMessages.messageIndex} IS NULL THEN 1 ELSE 0 END`,
        asc(memoryMessages.messageIndex),
        asc(memoryMessages.createdAt),
        asc(memoryMessages.id),
      )
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
        // docs/12 (P5) — persist the Observer-resolved salience; absent ⇒ 0.5 so
        // the column default and an explicit default agree (legacy/no-salience path).
        ...(input.importance !== undefined ? { importance: input.importance } : {}),
        priority: input.priority ?? null,
        tags: input.tags !== undefined ? JSON.stringify(input.tags) : null,
      })
      .run();
    return id;
  }

  // POST-MVP Phase 2: read a scope's active observations oldest-first. Thread
  // scope = the thread's own rows (inject/observer); project/resource scope =
  // aggregated across all the owner's matching threads (the Reflector's target
  // read) — see observationScopeWhere.
  async listObservations(scope: ReflectionScope): Promise<Observation[]> {
    const where = observationScopeWhere(scope);
    if (where === null) return [];
    const rows = this.db
      .select()
      .from(memoryObservations)
      .where(where)
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
        referenceCount: row.referenceCount,
        importance: row.importance,
        status: row.status as Observation["status"],
        referencedAt: row.referencedAt,
        archivedAt: row.archivedAt,
        expiredAt: row.expiredAt,
        ...(row.priority !== null ? { priority: row.priority } : {}),
        ...(row.tags !== null ? { tags: JSON.parse(row.tags) as string[] } : {}),
      };
    });
  }

  // Read the latest (highest-version) reflection for an EXACT scope match. Absent
  // scope levels must be NULL in storage (never a different scope's row) so the
  // Reflector never crosses project/resource/thread boundaries (docs/08 isolation).
  async getReflection(scope: ReflectionScope): Promise<Reflection | null> {
    // Only the latest ACTIVE version (Codex review fix): a reflection archived by the
    // decay→rebuild path (its whole scope decayed) must be invisible to inject + the
    // Reflector. Legacy rows default status='active', so this is inert when forgetting
    // is off.
    const row = this.db
      .select()
      .from(memoryReflections)
      .where(and(reflectionScopeWhere(scope), eq(memoryReflections.status, "active")))
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
      referencedAt: row.referencedAt,
      referenceCount: row.referenceCount,
      status: row.status as Reflection["status"],
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

  // docs/12 (Codex review fix) — the distinct scopes that currently hold an ACTIVE
  // reflection for the account, so the decay job can enqueue ONE reflector rebuild
  // per scope. Reflections are stored at a single target level (project-only or
  // resource-only — reflectionTargetScope), so each returned scope carries exactly
  // the level(s) that were set.
  async listActiveReflectionScopes(accountId: string): Promise<ReflectionScope[]> {
    const rows = this.db.$sqlite
      .prepare(
        `SELECT DISTINCT project_id, resource_id, thread_id
           FROM memory_reflections
          WHERE owner_id = ? AND status = 'active'`,
      )
      .all(accountId) as Array<{
      project_id: string | null;
      resource_id: string | null;
      thread_id: string | null;
    }>;
    return rows.map((r) => ({
      accountId,
      ...(r.project_id !== null ? { projectId: r.project_id } : {}),
      ...(r.resource_id !== null ? { resourceId: r.resource_id } : {}),
      ...(r.thread_id !== null ? { threadId: r.thread_id } : {}),
    }));
  }

  // docs/12 (Codex review fix) — soft-invalidate EVERY version of a scope's
  // reflection (status='archived'); getReflection then returns null so the forgotten
  // reflection stops being injected. Never a DELETE (audit). Account-scoped.
  async archiveReflections(scope: ReflectionScope): Promise<void> {
    this.db
      .update(memoryReflections)
      .set({ status: "archived" })
      .where(and(reflectionScopeWhere(scope), eq(memoryReflections.status, "active")))
      .run();
  }

  // docs/12 (Codex review fix II) — MAX(version) across EVERY status of the scope's
  // reflection rows (0 when none). The Reflector writes at high-water + 1 so the
  // version stays monotonic across an archive→rebuild cycle (getReflection hides
  // archived rows, so the active row alone would reset the sequence to 1).
  async getReflectionVersionHighWater(scope: ReflectionScope): Promise<number> {
    const row = this.db
      .select({ version: memoryReflections.version })
      .from(memoryReflections)
      .where(reflectionScopeWhere(scope))
      .orderBy(desc(memoryReflections.version))
      .limit(1)
      .get();
    return row?.version ?? 0;
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

  // Atomically claim up to `limit` open jobs (oldest-first) by flipping them to
  // running in ONE UPDATE … RETURNING so a second tick/worker never
  // double-processes a row. Claimable = pending, PLUS running rows whose lease
  // (updated_at) expired — a worker that died between claim and finish must not
  // block its scope forever (enqueue dedupes against running rows). Re-claiming
  // refreshes updated_at, restarting the lease; the runners are idempotent
  // (observer skips covered ranges, reflector merges are stable), so a re-run of
  // a job that ACTUALLY finished is harmless. scope_id is decoded back to a
  // ReflectionScope (D1).
  async claimPendingJobs(limit: number): Promise<MemoryJobRow[]> {
    if (limit <= 0) return [];
    const updatedAt = this.now().getTime();
    const staleBefore = updatedAt - RUNNING_LEASE_MS;
    // Drizzle has no portable RETURNING-on-subselect-UPDATE helper, so use the raw
    // handle. The subquery picks the oldest claimable ids; the UPDATE flips just
    // those and returns their decoded fields.
    const rows = this.db.$sqlite
      .prepare(
        `UPDATE memory_jobs
            SET status = 'running', updated_at = ?
          WHERE id IN (
            SELECT id FROM memory_jobs
             WHERE status = 'pending'
                OR (status = 'running' AND updated_at <= ?)
             ORDER BY created_at ASC, id ASC
             LIMIT ?
          )
        RETURNING id, type, scope_id`,
      )
      .all(updatedAt, staleBefore, limit) as Array<{ id: string; type: string; scope_id: string }>;
    return rows.map((row) => ({
      jobId: row.id,
      // The type column is constrained to the enum at enqueue time; widen back.
      type: row.type as MemoryJobRow["type"],
      scope: decodeScopeId(row.scope_id),
    }));
  }

  // docs/12 "Access reinforcement" (P3). One batched, ACCOUNT-GUARDED UPDATE per
  // tier: bump reference_count + stamp referenced_at on exactly the injected ids.
  // Observations are guarded via their thread's owner_id (observations have no
  // owner_id column — they inherit it from memory_threads, matching the existing
  // read predicates); reflections carry owner_id directly. The guard makes the
  // bump tenant-safe even though the ids already came from an account-scoped read
  // (defence in depth). Empty id lists skip their UPDATE entirely. FAIL-OPEN is
  // the CALLER's contract — inject fires this fire-and-forget and never awaits it.
  async bumpReferences(input: {
    accountId: string;
    observationIds: string[];
    reflectionIds: string[];
    now: Date;
  }): Promise<void> {
    const nowMs = input.now.getTime();
    if (input.observationIds.length > 0) {
      const placeholders = input.observationIds.map(() => "?").join(", ");
      this.db.$sqlite
        .prepare(
          `UPDATE memory_observations
              SET reference_count = reference_count + 1, referenced_at = ?
            WHERE id IN (${placeholders})
              AND thread_id IN (
                SELECT id FROM memory_threads WHERE owner_id = ?
              )`,
        )
        .run(nowMs, ...input.observationIds, input.accountId);
    }
    if (input.reflectionIds.length > 0) {
      const placeholders = input.reflectionIds.map(() => "?").join(", ");
      this.db.$sqlite
        .prepare(
          `UPDATE memory_reflections
              SET reference_count = reference_count + 1, referenced_at = ?
            WHERE id IN (${placeholders})
              AND owner_id = ?`,
        )
        .run(nowMs, ...input.reflectionIds, input.accountId);
    }
  }

  // docs/12 P5 decay sweep — READ half. Every ACTIVE observation owned by the account
  // (joined to its thread's owner_id, since observations carry no owner_id — same
  // predicate shape as the existing reads), with ONLY the score-input columns. archived
  // rows are excluded so the sweep is idempotent (a re-run never re-sees a demoted row).
  // referenced_at / observed_at / archived_at are epoch-ms; Drizzle's timestamp_ms
  // surfaces them as Date through the typed select, so read via the raw handle and box
  // the ms back to Date here (the score fn + sweep are Date-typed).
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
    // OLDEST active first, scan bounded by `limit`. With `candidates` present, the
    // forgetting score is evaluated IN SQL — the SAME formula as forgetting/score.ts
    // (docs/12: "one pure function, identical in SQL and TypeScript"):
    //   pow(0.5, max(0, (now − coalesce(referenced_at, observed_at))/1000) / half_life)
    //     × (min(max(importance, floor), ceil) + access_weight × ln(1 + reference_count))
    //     < threshold
    // — so the page contains ONLY below-threshold (condemned) rows. This kills the
    // starvation mode of a limit-only page (Codex review fix II): survivors never
    // occupy the page, and archived candidates leave the active set, so every sweep
    // makes progress. pow/ln/min/max are SQLite built-ins (math functions).
    const hasLimit = scope.limit !== undefined && scope.limit > 0;
    const c = scope.candidates;
    const candidatePredicate =
      c !== undefined
        ? `\n            AND pow(0.5, max(0, (? - COALESCE(o.referenced_at, o.observed_at)) / 1000.0) / ?)
              * (min(max(o.importance, ?), ?) + ? * ln(1 + o.reference_count)) < ?`
        : "";
    const params: Array<string | number> = [scope.accountId];
    if (c !== undefined) {
      params.push(
        c.nowMs,
        c.half_life_s,
        c.importance_floor,
        c.importance_ceil,
        c.access_weight,
        c.threshold,
      );
    }
    if (hasLimit && scope.limit !== undefined) params.push(scope.limit);
    const rows = this.db.$sqlite
      .prepare(
        `SELECT o.id, o.referenced_at, o.observed_at, o.reference_count, o.importance
           FROM memory_observations o
          WHERE o.status = 'active'
            AND o.thread_id IN (
              SELECT id FROM memory_threads WHERE owner_id = ?
            )${candidatePredicate}
          ORDER BY o.observed_at ASC, o.id ASC${hasLimit ? "\n          LIMIT ?" : ""}`,
      )
      .all(...params) as Array<{
      id: string;
      referenced_at: number | null;
      observed_at: number;
      reference_count: number;
      importance: number;
    }>;
    return rows.map((row) => ({
      id: row.id,
      referencedAt: row.referenced_at === null ? null : new Date(row.referenced_at),
      observedAt: new Date(row.observed_at),
      referenceCount: row.reference_count,
      importance: row.importance,
    }));
  }

  // docs/12 P5 decay sweep — WRITE half. Soft-invalidate the named observations
  // (status='archived', archived_at=now) — NEVER a DELETE (audit-friendly). ACCOUNT-
  // GUARDED via the thread's owner_id (defence in depth — the ids already came from an
  // account-scoped read). Empty id list → no statement. Touches ONLY memory_observations
  // status/archived_at; raw messages and other accounts' rows are never affected.
  async archiveObservations(input: { accountId: string; ids: string[]; now: Date }): Promise<void> {
    if (input.ids.length === 0) return;
    const placeholders = input.ids.map(() => "?").join(", ");
    this.db.$sqlite
      .prepare(
        `UPDATE memory_observations
            SET status = 'archived', archived_at = ?
          WHERE id IN (${placeholders})
            AND status = 'active'
            AND thread_id IN (
              SELECT id FROM memory_threads WHERE owner_id = ?
            )`,
      )
      .run(input.now.getTime(), ...input.ids, input.accountId);
  }

  // docs/12 P5 trigger — the buffer-flush gate, computed in ONE account-grouped read.
  // For every owner with ≥1 active observation: find its last decay sweep time (the
  // newest memory_jobs.created_at of type='decay' for that account's scope_id) and the
  // count of its active observations newer than that sweep; the account is DUE if that
  // count ≥ triggerObservations OR (now − lastSweep) ≥ triggerIntervalS. An account that
  // has NEVER been swept (lastSweep NULL) is due on the time gate — its whole active set
  // is "new". scope_id is the canonical encodeScopeId JSON, so the account is matched
  // via json_extract(scope_id, '$.accountId') — NEVER by string-concatenating a
  // lookalike literal (Codex review fix: an id containing JSON-special characters like
  // `"` or `\` is escaped by the codec, so a concat would never match, last_sweep would
  // stay null forever, and the account would re-trigger on every worker tick).
  // Account-scoped throughout; never crosses owners.
  async listDecayCandidateAccounts(input: {
    triggerObservations: number;
    triggerIntervalS: number;
    nowMs: number;
  }): Promise<string[]> {
    const intervalCutoff = input.nowMs - input.triggerIntervalS * 1000;
    const rows = this.db.$sqlite
      .prepare(
        `SELECT mt.owner_id AS owner_id,
                (SELECT MAX(j.created_at) FROM memory_jobs j
                  WHERE j.type = 'decay'
                    AND json_extract(j.scope_id, '$.accountId') = mt.owner_id) AS last_sweep,
                COUNT(o.id) AS active_total,
                SUM(CASE WHEN o.observed_at > COALESCE(
                  (SELECT MAX(j2.created_at) FROM memory_jobs j2
                    WHERE j2.type = 'decay'
                      AND json_extract(j2.scope_id, '$.accountId') = mt.owner_id), 0)
                  THEN 1 ELSE 0 END) AS new_since_sweep
           FROM memory_observations o
           JOIN memory_threads mt ON mt.id = o.thread_id
          WHERE o.status = 'active'
            AND mt.owner_id IS NOT NULL
          GROUP BY mt.owner_id`,
      )
      .all() as Array<{
      owner_id: string;
      last_sweep: number | null;
      active_total: number;
      new_since_sweep: number;
    }>;
    return rows
      .filter((row) => {
        const countGate = row.new_since_sweep >= input.triggerObservations;
        const timeGate = row.last_sweep === null || row.last_sweep <= intervalCutoff;
        return (row.active_total > 0 && countGate) || (row.active_total > 0 && timeGate);
      })
      .map((row) => row.owner_id);
  }

  // docs/12 P6 — fact ingest with deterministic dedup + same-subject supersede,
  // ONE synchronous transaction per batch. Per fact (mirrors the port contract):
  //   1. INSERT OR IGNORE → the account-scoped UNIQUE(owner_id, content_hash)
  //      makes a repeat assertion a no-op (changes === 0) — idempotent dedup
  //      (Mem0 borrow). Two accounts with the same content_hash both insert (the
  //      index is keyed by owner_id, never global).
  //   2. On a REAL insert, supersede the OLDER same-subject row: a pure datetime
  //      UPDATE stamping expired_at=now + invalid_at=new.valid_from over the
  //      still-ACTIVE rows with the same (owner_id, subject_key), the scope
  //      columns that are non-null on the NEW fact, an OLDER valid_from, and a
  //      DIFFERENT id (never expire the row we just inserted). NEVER a DELETE
  //      (Graphiti borrow — decay hides, retention deletes). A skipped (deduped)
  //      fact triggers no supersede (changes === 0). The owner_id guard is the
  //      tenant boundary; every predicate carries it.
  async insertFactsReconciled(input: {
    accountId: string;
    scope: { projectId?: string; resourceId?: string; threadId?: string };
    facts: MemoryFactInput[];
    now: Date;
  }): Promise<{ insertedIds: string[]; supersededIds: string[] }> {
    if (input.facts.length === 0) return { insertedIds: [], supersededIds: [] };
    const nowMs = input.now.getTime();
    const insertOne = this.db.$sqlite.prepare(
      `INSERT OR IGNORE INTO memory_facts
         (id, owner_id, project_id, resource_id, thread_id, subject_key, fact_text,
          content_hash, importance, reference_count, referenced_at, valid_from,
          invalid_at, expired_at, status, source_observation_range, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const supersede = this.db.$sqlite.prepare(
      `UPDATE memory_facts
          SET expired_at = ?, invalid_at = ?, updated_at = ?
        WHERE owner_id = ?
          AND subject_key = ?
          AND status = 'active'
          AND expired_at IS NULL
          AND valid_from < ?
          AND id <> ?
          AND (? IS NULL OR project_id = ?)
          AND (? IS NULL OR resource_id = ?)
          AND (? IS NULL OR thread_id = ?)
        RETURNING id`,
    );
    // The whole batch is atomic: a partial ingest must not leave a fact inserted
    // without its supersede applied (or vice versa). Returns the ids inserted +
    // superseded (docs/13 — the MCP `memory_add` tool echoes the created fact).
    const runBatch = this.db.$sqlite.transaction((facts: MemoryFactInput[]) => {
      const insertedIds: string[] = [];
      const supersededIds: string[] = [];
      for (const f of facts) {
        // The top-level accountId is the authoritative tenant guard; each fact's
        // ownerId must already match it (the Reflector stamps the authenticated
        // accountId). Persist owner_id from the guard so a mismatched input can
        // never write under another tenant.
        const ownerId = input.accountId;
        const projectId = f.projectId ?? null;
        const resourceId = f.resourceId ?? null;
        const threadId = f.threadId ?? null;
        const id = this.genId();
        const res = insertOne.run(
          id,
          ownerId,
          projectId,
          resourceId,
          threadId,
          f.subjectKey,
          f.factText,
          f.contentHash,
          f.importance ?? 0.5,
          f.referenceCount ?? 0,
          f.referencedAt != null ? f.referencedAt.getTime() : null,
          f.validFrom.getTime(),
          f.invalidAt != null ? f.invalidAt.getTime() : null,
          f.expiredAt != null ? f.expiredAt.getTime() : null,
          f.status ?? "active",
          f.sourceObservationRange !== undefined ? JSON.stringify(f.sourceObservationRange) : null,
          nowMs,
          nowMs,
        );
        // Only a fresh insert supersedes; a deduped fact (changes === 0) does not.
        if (res.changes === 1) {
          insertedIds.push(id);
          // Supersede narrows by the NEW fact's NON-NULL scope columns ONLY — the
          // SAME semantics as the listActiveFacts read path (Codex review fix: a
          // stricter all-columns match here let a stale same-subject fact stay
          // visible to a read that also returns the newer one). A null scope column
          // on the new fact imposes NO constraint: `(? IS NULL OR col = ?)` is a
          // no-op clause when the bound value is null (docs/12 "optionally narrowed
          // by project/resource/thread").
          const superseded = supersede.all(
            nowMs,
            f.validFrom.getTime(),
            nowMs,
            ownerId,
            f.subjectKey,
            f.validFrom.getTime(),
            id,
            projectId,
            projectId,
            resourceId,
            resourceId,
            threadId,
            threadId,
          ) as Array<{ id: string }>;
          for (const s of superseded) supersededIds.push(s.id);
        }
      }
      return { insertedIds, supersededIds };
    });
    return runBatch(input.facts);
  }

  // docs/12 P6 — fact READ half. The account's still-alive facts: owner_id =
  // accountId AND status='active' AND expired_at IS NULL (the single predicate
  // that hides superseded/archived facts without deleting them), optionally
  // narrowed by the in-account scope columns. Account-scoped throughout; the
  // epoch-ms columns are boxed back to Date and the source range JSON is parsed.
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
    const rows = this.db
      .select()
      .from(memoryFacts)
      .where(and(...clauses) as SQL)
      .orderBy(asc(memoryFacts.createdAt), asc(memoryFacts.id))
      .all();
    return rows.map(sqliteRowToFact);
  }

  // =========================================================================
  // docs/13 — Memory ADMIN + MCP management surface (facts + reflections).
  // =========================================================================

  // Admin "By Scope" view. Distinct (account, project, resource, thread) groups
  // holding live facts and/or an active reflection, with per-tier counts + newest
  // updatedAt. facts ⊎ reflections via a UNION of grouped subqueries (SQLite has
  // no FULL OUTER JOIN); reflections guarded owner_id IS NOT NULL (nullable
  // column). An optional accountId narrows to one tenant.
  async listMemoryScopes(input: { accountId?: string }): Promise<MemoryScopeSummary[]> {
    const acct = input.accountId ?? null;
    const rows = this.db.$sqlite
      .prepare(
        `SELECT owner_id AS accountId, project_id AS projectId, resource_id AS resourceId,
                thread_id AS threadId,
                SUM(fc) AS factCount, SUM(rc) AS reflectionCount, MAX(lu) AS lastUpdated
           FROM (
             SELECT owner_id, project_id, resource_id, thread_id,
                    COUNT(*) AS fc, 0 AS rc, MAX(updated_at) AS lu
               FROM memory_facts
              WHERE status = 'active' AND expired_at IS NULL
                AND (? IS NULL OR owner_id = ?)
              GROUP BY owner_id, project_id, resource_id, thread_id
             UNION ALL
             SELECT owner_id, project_id, resource_id, thread_id,
                    0 AS fc, COUNT(*) AS rc, MAX(updated_at) AS lu
               FROM memory_reflections
              WHERE status = 'active' AND owner_id IS NOT NULL
                AND (? IS NULL OR owner_id = ?)
              GROUP BY owner_id, project_id, resource_id, thread_id
           )
          GROUP BY owner_id, project_id, resource_id, thread_id
          ORDER BY lastUpdated DESC`,
      )
      .all(acct, acct, acct, acct) as Array<{
      accountId: string;
      projectId: string | null;
      resourceId: string | null;
      threadId: string | null;
      factCount: number;
      reflectionCount: number;
      lastUpdated: number | null;
    }>;
    return rows.map((r) => ({
      accountId: r.accountId,
      projectId: r.projectId,
      resourceId: r.resourceId,
      threadId: r.threadId,
      factCount: r.factCount,
      reflectionCount: r.reflectionCount,
      lastUpdated: r.lastUpdated !== null ? new Date(r.lastUpdated) : null,
    }));
  }

  // Read ONE fact by id, account-guarded (cross-tenant id → null), ANY status.
  async getFactById(input: { accountId: string; id: string }): Promise<Fact | null> {
    const row = this.db
      .select()
      .from(memoryFacts)
      .where(and(eq(memoryFacts.id, input.id), eq(memoryFacts.ownerId, input.accountId)))
      .get();
    return row === undefined ? null : sqliteRowToFact(row);
  }

  // Paginated fact list with an EXPLICIT status filter. 'active' = the live set
  // (status='active' AND expired_at IS NULL — matches inject), so an omitted
  // status defaults to live; 'all' imposes no predicate (superseded rows visible).
  async listFacts(input: {
    accountId: string;
    projectId?: string;
    resourceId?: string;
    threadId?: string;
    status?: MemoryStatus | "all";
    subjectKey?: string;
    search?: string;
    limit: number;
    offset: number;
  }): Promise<{ rows: Fact[]; total: number }> {
    const where = and(...factListClauses(input)) as SQL;
    const rows = this.db
      .select()
      .from(memoryFacts)
      .where(where)
      .orderBy(desc(memoryFacts.updatedAt), desc(memoryFacts.id))
      .limit(input.limit)
      .offset(input.offset)
      .all();
    const totalRow = this.db
      .select({ n: sql<number>`count(*)` })
      .from(memoryFacts)
      .where(where)
      .get();
    return { rows: rows.map(sqliteRowToFact), total: totalRow?.n ?? 0 };
  }

  // Edit a fact in place (partial). factText edit recomputes content_hash (never
  // subjectKey); a collision with a DIFFERENT row's (owner_id, content_hash)
  // throws MemoryFactContentHashConflictError (route → 409). invalidAt tri-state
  // (undefined=leave, null=clear, Date=set). Stamps updated_at, never valid_from.
  async updateFact(input: {
    accountId: string;
    id: string;
    patch: MemoryFactPatch;
    now: Date;
  }): Promise<Fact | null> {
    const existing = await this.getFactById({ accountId: input.accountId, id: input.id });
    if (existing === null) return null;
    const { patch } = input;
    const set: Partial<typeof memoryFacts.$inferInsert> = { updatedAt: input.now };
    if (patch.factText !== undefined && patch.factText !== existing.factText) {
      const newHash = factContentHash(patch.factText);
      if (newHash !== existing.contentHash) {
        const conflict = this.db
          .select({ id: memoryFacts.id })
          .from(memoryFacts)
          .where(
            and(
              eq(memoryFacts.ownerId, input.accountId),
              eq(memoryFacts.contentHash, newHash),
              ne(memoryFacts.id, input.id),
            ),
          )
          .get();
        if (conflict !== undefined) throw new MemoryFactContentHashConflictError(conflict.id);
      }
      set.factText = patch.factText;
      set.contentHash = newHash;
    }
    if (patch.importance !== undefined) set.importance = patch.importance;
    if (patch.status !== undefined) {
      set.status = patch.status;
      // Keep expiry in SYNC with the lifecycle so the live read (status='active'
      // AND expired_at IS NULL) reflects the edit: reactivating CLEARS the
      // supersede/prune tombstone (else a reactivated fact stays invisible);
      // pruning STAMPS it (consistent with deleteFact). 'archived' is invisible via
      // status alone, so expiry is left untouched.
      if (patch.status === "active") set.expiredAt = null;
      else if (patch.status === "pruned") set.expiredAt = input.now;
    }
    if (patch.invalidAt !== undefined) set.invalidAt = patch.invalidAt; // Date | null
    this.db
      .update(memoryFacts)
      .set(set)
      .where(and(eq(memoryFacts.id, input.id), eq(memoryFacts.ownerId, input.accountId)))
      .run();
    return this.getFactById({ accountId: input.accountId, id: input.id });
  }

  // Soft-delete a fact: status='pruned' + stamp expired_at. Never a hard DELETE.
  // false for unknown/cross-tenant/already-pruned.
  async deleteFact(input: { accountId: string; id: string; now: Date }): Promise<boolean> {
    const res = this.db
      .update(memoryFacts)
      .set({ status: "pruned", expiredAt: input.now, updatedAt: input.now })
      .where(
        and(
          eq(memoryFacts.id, input.id),
          eq(memoryFacts.ownerId, input.accountId),
          ne(memoryFacts.status, "pruned"),
        ),
      )
      .run();
    return res.changes > 0;
  }

  // Paginated reflection list. Default = the highest-version ACTIVE row per scope
  // group (one row per scope); includeAllVersions returns every version. Grouping
  // is in app code (admin scale is small) so the query stays dialect-portable.
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
    const all = this.db
      .select()
      .from(memoryReflections)
      .where(and(...clauses) as SQL)
      .orderBy(desc(memoryReflections.version), desc(memoryReflections.updatedAt))
      .all()
      .map(sqliteRowToReflection);
    const grouped = input.includeAllVersions === true ? all : latestPerScope(all);
    grouped.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
    return {
      rows: grouped.slice(input.offset, input.offset + input.limit),
      total: grouped.length,
    };
  }

  // Read ONE reflection by id, account-guarded. ANY status (management read).
  async getReflectionById(input: { accountId: string; id: string }): Promise<Reflection | null> {
    const row = this.db
      .select()
      .from(memoryReflections)
      .where(
        and(eq(memoryReflections.id, input.id), eq(memoryReflections.ownerId, input.accountId)),
      )
      .get();
    return row === undefined ? null : sqliteRowToReflection(row);
  }

  // Edit reflection text IN PLACE; does NOT bump version (the Reflector's
  // machine-merge counter). Caller supplies the recomputed tokenEstimate. Stamps
  // updated_at. Unknown/cross-tenant id → null.
  async updateReflectionText(input: {
    accountId: string;
    id: string;
    reflectionText: string;
    tokenEstimate: number;
    now: Date;
  }): Promise<Reflection | null> {
    const res = this.db
      .update(memoryReflections)
      .set({
        reflectionText: input.reflectionText,
        tokenEstimate: input.tokenEstimate,
        updatedAt: input.now,
      })
      .where(
        and(eq(memoryReflections.id, input.id), eq(memoryReflections.ownerId, input.accountId)),
      )
      .run();
    if (res.changes === 0) return null;
    return this.getReflectionById({ accountId: input.accountId, id: input.id });
  }

  // Soft-delete a reflection: archive EVERY active version of its scope (not just
  // the one id). upsertReflection appends versions WITHOUT archiving the old ones,
  // so a scope can hold several active versions and getReflection returns the
  // highest; archiving only one id would let injection fall back to the next. Look
  // the row up to learn its scope, then archive all active versions there →
  // getReflection(scope) returns null and injection stops. Never a hard DELETE.
  // false for unknown/cross-tenant id or a scope with no active versions left.
  async deleteReflection(input: { accountId: string; id: string }): Promise<boolean> {
    const row = await this.getReflectionById({ accountId: input.accountId, id: input.id });
    if (row === null) return false;
    const scope: ReflectionScope = {
      accountId: input.accountId,
      ...(row.projectId !== null ? { projectId: row.projectId } : {}),
      ...(row.resourceId !== null ? { resourceId: row.resourceId } : {}),
      ...(row.threadId !== null ? { threadId: row.threadId } : {}),
    };
    const res = this.db
      .update(memoryReflections)
      .set({ status: "archived" })
      .where(and(reflectionScopeWhere(scope), eq(memoryReflections.status, "active")))
      .run();
    return res.changes > 0;
  }

  // docs/12 "Hard-delete (rare, retention only)" pass 4 (P7) — the ONLY DELETE in the
  // forgetting system, mirroring the payload_retention_days prune. Account-AGNOSTIC (a
  // retention age cutoff is tenant-neutral): two deletes over the WHOLE store, each a
  // STRICT lower bound (strictly-older-than — a row stamped exactly at the cutoff
  // survives, matching prunePayloads):
  //   1. archived observations whose archived_at < cutoff — NEVER active rows (the
  //      status='archived' predicate is the guard: decay archives first, retention
  //      deletes the aged archives), and NEVER raw messages;
  //   2. expired facts whose expired_at < cutoff — the `expired_at IS NOT NULL` predicate
  //      keeps still-alive facts (expired_at NULL) untouched; only superseded facts that
  //      have since aged past their window are dropped.
  // Reflections are NEVER hard-deleted here (docs/12). Returns the deleted counts for the
  // caller's log line. `changes` is the row count of the just-run statement.
  async pruneExpiredMemory(input: {
    archivedObservationsBeforeMs: number;
    expiredFactsBeforeMs: number;
  }): Promise<{ observationsDeleted: number; factsDeleted: number }> {
    // docs/12 (P7, Codex review fix) — observations are TOMBSTONED, not deleted.
    // An aged-out archived observation still owns a `sourceMessageRange` that
    // inject/observer rely on to know its raw turns are already covered; a hard
    // DELETE would orphan that coverage and resurrect the raw into the prefix /
    // re-compression. So we free the bulky text + tags but KEEP the row with
    // status='pruned' (invisible to content reads, still seen by coverage reads).
    const obs = this.db.$sqlite
      .prepare(
        `UPDATE memory_observations
            SET status = 'pruned', observation_text = '[pruned]', tags = NULL
          WHERE status = 'archived'
            AND archived_at IS NOT NULL
            AND archived_at < ?`,
      )
      .run(input.archivedObservationsBeforeMs);
    // Facts carry NO coverage role → a true hard DELETE is correct (the only
    // DELETE in the forgetting system). expired_at IS NOT NULL keeps live facts.
    const facts = this.db.$sqlite
      .prepare(
        `DELETE FROM memory_facts
          WHERE expired_at IS NOT NULL
            AND expired_at < ?`,
      )
      .run(input.expiredFactsBeforeMs);
    return { observationsDeleted: obs.changes, factsDeleted: facts.changes };
  }

  // ——— Cleanup/archival (raw transcript + job log) ———
  async countMessagesOlderThan(olderThanMs: number): Promise<number> {
    const row = this.db
      .select({ value: count() })
      .from(memoryMessages)
      .where(lt(memoryMessages.createdAt, new Date(olderThanMs)))
      .get();
    return row?.value ?? 0;
  }

  async selectMessagesOlderThan(
    olderThanMs: number,
    limit: number,
    afterId?: string,
  ): Promise<MemoryMessageArchiveRow[]> {
    const conds: SQL[] = [lt(memoryMessages.createdAt, new Date(olderThanMs))];
    if (afterId !== undefined) conds.push(gt(memoryMessages.id, afterId));
    return this.db
      .select()
      .from(memoryMessages)
      .where(and(...conds))
      .orderBy(asc(memoryMessages.id))
      .limit(limit)
      .all()
      .map((r) => ({
        id: r.id,
        threadId: r.threadId,
        role: r.role,
        content: r.content,
        tokenEstimate: r.tokenEstimate,
        messageIndex: r.messageIndex ?? null,
        contentHash: r.contentHash ?? null,
        createdAt: r.createdAt.getTime(),
      }));
  }

  async pruneMessagesOlderThan(olderThanMs: number): Promise<number> {
    const res = this.db
      .delete(memoryMessages)
      .where(lt(memoryMessages.createdAt, new Date(olderThanMs)))
      .run();
    return res.changes;
  }

  async pruneFinishedJobsOlderThan(olderThanMs: number): Promise<number> {
    const res = this.db.$sqlite
      .prepare(
        `DELETE FROM memory_jobs
          WHERE status IN ('done', 'failed')
            AND updated_at < ?`,
      )
      .run(olderThanMs);
    return res.changes;
  }

  // Auto-compaction model→price resolution, write half: stamp the served model
  // alias onto the thread row. Account-guarded (owner_id must match) so a stamp
  // can never cross tenants; an unknown thread is a silent no-op (fail-open —
  // the caller fires this best-effort after the response is gone).
  async stampThreadModel(input: {
    accountId: string;
    threadId: string;
    modelAlias: string;
  }): Promise<void> {
    this.db.$sqlite
      .prepare(
        `UPDATE memory_threads
            SET last_served_model = ?
          WHERE id = ? AND owner_id = ?`,
      )
      .run(input.modelAlias, input.threadId, input.accountId);
  }

  // Read half: the thread's stamped model alias, account-guarded. null row =
  // unknown thread; null alias = never stamped (the policy's heuristics apply).
  async getThreadMeta(input: {
    accountId: string;
    threadId: string;
  }): Promise<{ lastServedModel: string | null } | null> {
    const row = this.db.$sqlite
      .prepare(
        `SELECT last_served_model AS last_served_model
           FROM memory_threads
          WHERE id = ? AND owner_id = ?`,
      )
      .get(input.threadId, input.accountId) as { last_served_model: string | null } | undefined;
    return row === undefined ? null : { lastServedModel: row.last_served_model };
  }

  // Idle-flush sweep candidates: threads quiet since `idleBeforeMs` that still
  // have UNCOMPACTED history. Idleness = MAX(memory_messages.created_at) ≤
  // idleBeforeMs — the thread's last appended message, NOT memory_threads.
  // updated_at (ordinary turns append messages without touching the thread row,
  // so updated_at would mark an active thread idle and compact it mid-chat).
  // "Uncompacted" is the COVERAGE FRONTIER: a message newer than the newest
  // message any observation covers (range ends joined back to their message rows;
  // coverage is prefix-contiguous, so the frontier is exact for tails — the only
  // steady-state uncovered shape). NOT observed_at: the observer runs AFTER the
  // messages it covers, so observed_at would hide the kept-recent tail a writeback
  // pass left uncovered. project_id/resource_id ride along so the observer can
  // promote the resulting observation to the project/resource reflection. Once the
  // frontier catches up the thread leaves the candidate set, so the sweep
  // TERMINATES. Oldest-idle first; `limit` bounds the scan.
  async listIdleFlushCandidates(input: {
    idleBeforeMs: number;
    limit: number;
  }): Promise<
    Array<{ accountId: string; threadId: string; projectId?: string; resourceId?: string }>
  > {
    const rows = this.db.$sqlite
      .prepare(
        `SELECT t.owner_id AS owner_id, t.id AS thread_id,
                t.project_id AS project_id, t.resource_id AS resource_id,
                (SELECT MAX(m.created_at) FROM memory_messages m WHERE m.thread_id = t.id)
                  AS last_activity
           FROM memory_threads t
          WHERE t.owner_id IS NOT NULL
            AND last_activity IS NOT NULL
            AND last_activity <= ?
            AND EXISTS (
              -- A message NOT covered by ANY observation's [first,last] range —
              -- the SAME interval semantics alreadyObservedMessageIds uses, over
              -- the SAME (created_at, id) order listMessages uses. Interval
              -- containment (not a global frontier) is load-bearing twice over:
              -- a sparse gap BEFORE a later observation must still surface the
              -- thread, and messages appended in one request can share a
              -- millisecond, so the full tuple — not just created_at — decides
              -- containment. A thread with no observations has no ranges, so
              -- every message qualifies.
              SELECT 1 FROM memory_messages m
               WHERE m.thread_id = t.id
                 AND NOT EXISTS (
                   SELECT 1 FROM memory_observations o
                   JOIN memory_messages mf
                     ON mf.id = json_extract(o.source_message_range, '$[0]')
                   JOIN memory_messages ml
                     ON ml.id = json_extract(o.source_message_range, '$[1]')
                    WHERE o.thread_id = t.id
                      AND (mf.created_at < m.created_at
                        OR (mf.created_at = m.created_at AND mf.id <= m.id))
                      AND (ml.created_at > m.created_at
                        OR (ml.created_at = m.created_at AND ml.id >= m.id))
                 )
            )
          ORDER BY last_activity ASC
          LIMIT ?`,
      )
      .all(input.idleBeforeMs, input.limit) as Array<{
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
