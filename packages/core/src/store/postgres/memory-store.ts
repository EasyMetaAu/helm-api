import { randomUUID } from "node:crypto";
import {
  decodeScopeId,
  encodeScopeId,
  type Fact,
  type MemoryFactInput,
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

  // Single multi-row INSERT = one round-trip / one implicit transaction for the
  // whole turn (vs N from the appendMessage loop). createdAt is stamped base+i so
  // listMessages (ordered by createdAt, id) returns rows in append order even
  // though randomUUID ids do not sort. Mirrors the sqlite adapter's batch path.
  async appendMessages(inputs: MemoryMessageInput[]): Promise<string[]> {
    if (inputs.length === 0) return [];
    const base = this.now().getTime();
    const ids: string[] = [];
    const rows = inputs.map((input, i) => {
      const id = this.genId();
      ids.push(id);
      return {
        id,
        threadId: input.threadId,
        role: input.role,
        content: input.content,
        tokenEstimate: input.tokenEstimate,
        createdAt: base + i,
      };
    });
    await this.db.insert(memoryMessages).values(rows);
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

  async appendObservation(input: MemoryObservationInput): Promise<string> {
    const id = this.genId();
    await this.db.insert(memoryObservations).values({
      id,
      threadId: input.threadId,
      sourceMessageRange: input.sourceMessageRange,
      observationText: input.observationText,
      observedAt: input.observedAt.getTime(),
      referencedAt: null,
      // docs/12 (P5) — persist the Observer-resolved salience; absent ⇒ column
      // default 0.5 (pg mirror of the sqlite adapter).
      ...(input.importance !== undefined ? { importance: input.importance } : {}),
      priority: input.priority ?? null,
      tags: input.tags ?? null,
    });
    return id;
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
  async listActiveReflectionScopes(accountId: string): Promise<ReflectionScope[]> {
    const rows = await this.db
      .selectDistinct({
        projectId: memoryReflections.projectId,
        resourceId: memoryReflections.resourceId,
        threadId: memoryReflections.threadId,
      })
      .from(memoryReflections)
      .where(and(eq(memoryReflections.ownerId, accountId), eq(memoryReflections.status, "active")));
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

  // Enqueue a background job. DEDUPE (D6): the partial unique index on OPEN
  // (pending/running) jobs owns the concurrency boundary; this method tries the
  // insert first, then reads the existing open row when another request won.
  async enqueueJob(input: MemoryJobEnqueueInput): Promise<string> {
    const scopeId = encodeScopeId(input.scope);
    const id = this.genId();
    const ts = this.now().getTime();
    const inserted = (await this.db.execute(sql`
      INSERT INTO memory_jobs (id, type, scope_id, status, error, created_at, updated_at)
      VALUES (${id}, ${input.type}, ${scopeId}, 'pending', NULL, ${ts}, ${ts})
      ON CONFLICT (type, scope_id) WHERE status IN ('pending', 'running') DO NOTHING
      RETURNING id
    `)) as { rows?: Array<{ id: string }> } | Array<{ id: string }>;
    const insertedRows = Array.isArray(inserted) ? inserted : (inserted.rows ?? []);
    if (insertedRows[0] !== undefined) return insertedRows[0].id;

    const existing = (await this.db.execute(sql`
      SELECT id FROM memory_jobs
       WHERE type = ${input.type}
         AND scope_id = ${scopeId}
         AND status IN ('pending', 'running')
       ORDER BY created_at ASC, id ASC
       LIMIT 1
    `)) as { rows?: Array<{ id: string }> } | Array<{ id: string }>;
    const existingRows = Array.isArray(existing) ? existing : (existing.rows ?? []);
    if (existingRows[0] !== undefined) return existingRows[0].id;

    throw new Error("memory job enqueue conflict without existing open row");
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
         SET status = 'running', updated_at = ${updatedAt}
       WHERE id IN (
         SELECT id FROM memory_jobs
          WHERE status = 'pending'
             OR (status = 'running' AND updated_at <= ${staleBefore})
          ORDER BY created_at ASC, id ASC
          LIMIT ${limit}
          FOR UPDATE SKIP LOCKED
       )
      RETURNING id, type, scope_id
    `)) as
      | { rows?: Array<{ id: string; type: string; scope_id: string }> }
      | Array<{
          id: string;
          type: string;
          scope_id: string;
        }>;
    const rows = Array.isArray(result) ? result : (result.rows ?? []);
    return rows.map((row) => ({
      jobId: row.id,
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
  async archiveObservations(input: { accountId: string; ids: string[]; now: Date }): Promise<void> {
    if (input.ids.length === 0) return;
    const nowMs = input.now.getTime();
    const ids = sql.join(
      input.ids.map((id) => sql`${id}`),
      sql`, `,
    );
    await this.db.execute(sql`
      UPDATE memory_observations
         SET status = 'archived', archived_at = ${nowMs}
       WHERE id IN (${ids})
         AND status = 'active'
         AND thread_id IN (
           SELECT id FROM memory_threads WHERE owner_id = ${input.accountId}
         )
    `);
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
  }): Promise<string[]> {
    const intervalCutoff = input.nowMs - input.triggerIntervalS * 1000;
    const result = (await this.db.execute(sql`
      SELECT mt.owner_id AS owner_id,
             (SELECT MAX(j.created_at) FROM memory_jobs j
               WHERE j.type = 'decay'
                 AND j.scope_id::jsonb ->> 'accountId' = mt.owner_id) AS last_sweep,
             COUNT(o.id) AS active_total,
             SUM(CASE WHEN o.observed_at > COALESCE(
               (SELECT MAX(j2.created_at) FROM memory_jobs j2
                 WHERE j2.type = 'decay'
                   AND j2.scope_id::jsonb ->> 'accountId' = mt.owner_id), 0)
               THEN 1 ELSE 0 END) AS new_since_sweep
        FROM memory_observations o
        JOIN memory_threads mt ON mt.id = o.thread_id
       WHERE o.status = 'active'
         AND mt.owner_id IS NOT NULL
       GROUP BY mt.owner_id
    `)) as unknown;
    const rows = (
      Array.isArray(result) ? result : ((result as { rows?: unknown[] }).rows ?? [])
    ) as Array<{
      owner_id: string;
      last_sweep: number | string | null;
      active_total: number | string;
      new_since_sweep: number | string | null;
    }>;
    return rows
      .filter((row) => {
        const activeTotal = Number(row.active_total);
        const newSince = Number(row.new_since_sweep ?? 0);
        const lastSweep = row.last_sweep === null ? null : Number(row.last_sweep);
        const countGate = newSince >= input.triggerObservations;
        const timeGate = lastSweep === null || lastSweep <= intervalCutoff;
        return activeTotal > 0 && (countGate || timeGate);
      })
      .map((row) => row.owner_id);
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
  }): Promise<void> {
    if (input.facts.length === 0) return;
    const nowMs = input.now.getTime();
    // docs/12 P6 (Codex review fix #3) — insert + supersede must be ATOMIC. The pg
    // adapter previously ran them as two un-wrapped statements: a crash AFTER the
    // insert but BEFORE the supersede left the new fact persisted while the old one
    // stayed active, and the retry hit `ON CONFLICT DO NOTHING` + `continue`, so the
    // stale fact was NEVER superseded. Wrapping the whole batch in ONE transaction
    // makes each insert+supersede pair all-or-nothing: a mid-batch failure rolls the
    // partial work back, and the content_hash unique index makes the retry's
    // re-insert idempotent so supersede runs again. Mirrors the sqlite adapter, which
    // already wraps the batch in `$sqlite.transaction`.
    await this.db.transaction(async (tx) => {
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
        if (insertedRows[0] === undefined) continue; // deduped → no supersede

        // Supersede narrows by the NEW fact's NON-NULL scope columns ONLY — the SAME
        // semantics as the listActiveFacts read path (Codex review fix; pg mirror of
        // the sqlite adapter). A null scope column on the new fact imposes NO
        // constraint: `(${"value"}::text IS NULL OR col = value)` short-circuits to
        // a no-op clause when the bound value is null.
        await tx.execute(sql`
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
      `);
      }
    });
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
    return rows.map((row) => ({
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
    }));
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
    const obs = (await this.db.execute(sql`
      UPDATE memory_observations
         SET status = 'pruned', observation_text = '[pruned]', tags = NULL
       WHERE status = 'archived'
         AND archived_at IS NOT NULL
         AND archived_at < ${input.archivedObservationsBeforeMs}
      RETURNING id
    `)) as unknown;
    const obsRows = (
      Array.isArray(obs) ? obs : ((obs as { rows?: unknown[] }).rows ?? [])
    ) as unknown[];
    const facts = (await this.db.execute(sql`
      DELETE FROM memory_facts
       WHERE expired_at IS NOT NULL
         AND expired_at < ${input.expiredFactsBeforeMs}
      RETURNING id
    `)) as unknown;
    const factRows = (
      Array.isArray(facts) ? facts : ((facts as { rows?: unknown[] }).rows ?? [])
    ) as unknown[];
    return { observationsDeleted: obsRows.length, factsDeleted: factRows.length };
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
  async getThreadMeta(input: {
    accountId: string;
    threadId: string;
  }): Promise<{ lastServedModel: string | null } | null> {
    const result = (await this.db.execute(sql`
      SELECT last_served_model
        FROM memory_threads
       WHERE id = ${input.threadId} AND owner_id = ${input.accountId}
    `)) as unknown;
    const rows = (
      Array.isArray(result) ? result : ((result as { rows?: unknown[] }).rows ?? [])
    ) as Array<{ last_served_model: string | null }>;
    const row = rows[0];
    return row === undefined ? null : { lastServedModel: row.last_served_model };
  }

  // Idle-flush sweep candidates — pg mirror of the sqlite adapter. Idleness =
  // MAX(memory_messages.created_at) ≤ idleBeforeMs (the last appended message,
  // NOT memory_threads.updated_at — ordinary turns append messages without
  // touching the thread row, so updated_at would mark an active thread idle).
  // Uncompacted = coverage FRONTIER (a message newer than the newest covered
  // message; range ends joined back to their message rows), NOT observed_at
  // (which would hide the kept-recent tail). project_id/resource_id ride along
  // for promotion. Terminates once the frontier catches up. jsonb ->> 1 reads
  // the range's lastId.
  async listIdleFlushCandidates(input: {
    idleBeforeMs: number;
    limit: number;
  }): Promise<
    Array<{ accountId: string; threadId: string; projectId?: string; resourceId?: string }>
  > {
    const result = (await this.db.execute(sql`
      SELECT t.owner_id AS owner_id, t.id AS thread_id,
             t.project_id AS project_id, t.resource_id AS resource_id,
             (SELECT MAX(m.created_at) FROM memory_messages m WHERE m.thread_id = t.id)
               AS last_activity
        FROM memory_threads t
       WHERE t.owner_id IS NOT NULL
         AND (SELECT MAX(m.created_at) FROM memory_messages m WHERE m.thread_id = t.id)
               <= ${input.idleBeforeMs}
         AND EXISTS (
           -- A message NOT covered by ANY observation's [first,last] range — the
           -- SAME interval semantics alreadyObservedMessageIds uses, over the
           -- SAME (created_at, id) order listMessages uses. Interval containment
           -- (not a global frontier) catches sparse gaps BEFORE later
           -- observations, and the full tuple handles same-millisecond ties.
           SELECT 1 FROM memory_messages m
            WHERE m.thread_id = t.id
              AND NOT EXISTS (
                SELECT 1 FROM memory_observations o
                JOIN memory_messages mf
                  ON mf.id = o.source_message_range ->> 0
                JOIN memory_messages ml
                  ON ml.id = o.source_message_range ->> 1
                 WHERE o.thread_id = t.id
                   AND (mf.created_at < m.created_at
                     OR (mf.created_at = m.created_at AND mf.id <= m.id))
                   AND (ml.created_at > m.created_at
                     OR (ml.created_at = m.created_at AND ml.id >= m.id))
              )
         )
       ORDER BY last_activity ASC
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
