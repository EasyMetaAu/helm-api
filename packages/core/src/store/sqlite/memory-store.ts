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
  inArray,
  isNotNull,
  isNull,
  like,
  lt,
  ne,
  type SQL,
  sql,
} from "drizzle-orm";
import { factContentHash } from "../../memory/forgetting/facts.js";
import { forgettingScore, type ScoreConfig } from "../../memory/forgetting/score.js";
import { sha256Hex } from "../../memory/message-hash.js";
import { reciprocalRankFusion } from "../../memory/recall/rrf.js";
import { decodePayloadValue, encodePayloadText } from "../payload-codec.js";
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
import { runBatchedPrune } from "./batched-prune.js";
import { listSqliteIdleFlushCandidates } from "./idle-flush-candidates.js";
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
const MEMORY_GZIP_MIN_BYTES = 256;

function encodeMemoryContent(content: string): string | Buffer {
  const bytes = Buffer.byteLength(content, "utf8");
  if (bytes < MEMORY_GZIP_MIN_BYTES) return content;
  const compressed = encodePayloadText(content);
  return compressed.length < bytes ? compressed : content;
}

function decodeMemoryContent(content: unknown): string {
  return decodePayloadValue(content) ?? "";
}

function dateOrNull(ms: number | null | undefined): Date | null {
  return ms === null || ms === undefined ? null : new Date(ms);
}

function countOf(row: { n?: number } | undefined): number {
  return row?.n ?? 0;
}

function sqliteMemoryJobScope(input: MemoryAdminStatsScope): {
  clauses: string[];
  args: unknown[];
} {
  const clauses: string[] = [];
  const args: unknown[] = [];
  if (input.accountId !== undefined) {
    clauses.push("json_extract(scope_id, '$.accountId') = ?");
    args.push(input.accountId);
  }
  if (input.projectId !== undefined) {
    clauses.push("json_extract(scope_id, '$.projectId') = ?");
    args.push(input.projectId);
  }
  if (input.resourceId !== undefined) {
    clauses.push("json_extract(scope_id, '$.resourceId') = ?");
    args.push(input.resourceId);
  }
  if (input.threadId !== undefined) {
    clauses.push("json_extract(scope_id, '$.threadId') = ?");
    args.push(input.threadId);
  }
  return { clauses, args };
}

function sqliteWhere(clauses: readonly string[]): string {
  return clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
}

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
    clauses.push(like(memoryFacts.factText, `%${input.search}%`));
  }
  return clauses;
}

// docs/14 — build a safe FTS5 MATCH expression from raw user text for the trigram
// index. Wrap the whole query as ONE phrase (escaping `"`→`""`) so FTS5 operators in
// user text (AND/OR/NOT/NEAR/quotes/column filters) can never cause a syntax error or
// unintended boolean logic. trigram needs ≥3 chars to match anything, so a shorter
// query returns null ⇒ the FTS leg is skipped (a vector leg, if any, still runs).
function toFtsMatch(queryText: string): string | null {
  const cleaned = queryText.replace(/\s+/g, " ").trim();
  if ([...cleaned].length < 3) return null;
  return `"${cleaned.replace(/"/g, '""')}"`;
}

// SQLite adapter for the MemoryStore port (docs/08). POST-MVP persistence floor:
// ensure threads + append raw messages only — no read/inject/compress here. The
// adapter owns dialect details (timestamps as epoch ms via Drizzle timestamp_ms)
// so core/ports stay DB-agnostic. Memory is a MIDDLEWARE: this store never reads
// or writes routing/lane state.
export class SqliteMemoryStore implements MemoryStore {
  readonly archiveObservationsEnqueuesReflectors = true as const;
  constructor(
    private readonly db: SqliteDb,
    private readonly genId: () => string = randomUUID,
    private readonly now: () => Date = () => new Date(),
  ) {}

  private preparedMessageInsert: ReturnType<SqliteMemoryStore["buildMessageInsert"]> | undefined;
  private buildMessageInsert() {
    return this.db.$sqlite.prepare(
      `INSERT INTO memory_messages
         (id, thread_id, message_index, role, content, token_estimate, created_at, content_hash)
       VALUES
         (@id, @threadId, @messageIndex, @role, @content, @tokenEstimate, @createdAt, @contentHash)
       ON CONFLICT(thread_id, message_index, role, content_hash) DO NOTHING`,
    );
  }
  private messageInsert() {
    if (!this.preparedMessageInsert) this.preparedMessageInsert = this.buildMessageInsert();
    return this.preparedMessageInsert;
  }

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

  private bumpThreadMessageActivity(threadId: string, count: number, lastAt: number): void {
    this.db.$sqlite
      .prepare(
        `UPDATE memory_threads
            SET message_count = message_count + ?,
                last_message_at = CASE
                  WHEN last_message_at IS NULL OR last_message_at < ? THEN ?
                  ELSE last_message_at
                END
          WHERE id = ?`,
      )
      .run(count, lastAt, lastAt, threadId);
  }

  async appendMessage(input: MemoryMessageInput): Promise<string> {
    const id = this.genId();
    const nowMs = this.now().getTime();
    // Idempotent ingest: a re-sent (thread_id, role, content) collapses to a
    // no-op via the v21 UNIQUE index (re-ingestion fix). Returned id is still
    // generated per call; on conflict it is inert (the row was left untouched).
    this.db.$sqlite.transaction(() => {
      const activity = this.db.$sqlite
        .prepare("SELECT last_message_at AS last_at FROM memory_threads WHERE id = ?")
        .get(input.threadId) as { last_at: number | null } | undefined;
      const createdAt = new Date(Math.max(nowMs, (activity?.last_at ?? nowMs - 1) + 1));
      const inserted = this.messageInsert().run({
        id,
        threadId: input.threadId,
        messageIndex: input.messageIndex ?? 0,
        role: input.role,
        content: encodeMemoryContent(input.content),
        tokenEstimate: input.tokenEstimate,
        createdAt: createdAt.getTime(),
        contentHash: sha256Hex(input.content),
      });
      // A dedup conflict has changes=0 and must not inflate the summary.
      if (inserted.changes > 0) {
        this.bumpThreadMessageActivity(input.threadId, 1, createdAt.getTime());
      }
    })();
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
      const activity = new Map<string, { count: number; lastAt: number }>();
      const nextAt = new Map<string, number>();
      inputs.forEach((input, i) => {
        const id = this.genId();
        ids.push(id);
        let createdAt = nextAt.get(input.threadId);
        if (createdAt === undefined) {
          const thread = this.db.$sqlite
            .prepare("SELECT last_message_at AS last_at FROM memory_threads WHERE id = ?")
            .get(input.threadId) as { last_at: number | null } | undefined;
          createdAt = Math.max(base, (thread?.last_at ?? base - 1) + 1);
        }
        nextAt.set(input.threadId, createdAt + 1);
        const inserted = this.messageInsert().run({
          id,
          threadId: input.threadId,
          messageIndex: input.messageIndex ?? i,
          role: input.role,
          content: encodeMemoryContent(input.content),
          tokenEstimate: input.tokenEstimate,
          createdAt,
          contentHash: sha256Hex(input.content),
        });
        if (inserted.changes > 0) {
          const current = activity.get(input.threadId);
          activity.set(input.threadId, {
            count: (current?.count ?? 0) + 1,
            lastAt: Math.max(current?.lastAt ?? createdAt, createdAt),
          });
        }
      });
      // One parent update per touched thread, not one per message in the turn.
      for (const [threadId, summary] of activity) {
        this.bumpThreadMessageActivity(threadId, summary.count, summary.lastAt);
      }
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
      .orderBy(asc(memoryMessages.createdAt), asc(memoryMessages.id))
      .all();
    return rows.map((row) => ({
      id: row.id,
      threadId: row.threadId,
      // Stored role is the IR-aligned enum; widen back to the shared union.
      role: row.role as RawMessage["role"],
      content: decodeMemoryContent(row.content),
      tokenEstimate: row.tokenEstimate,
      createdAt: row.createdAt,
    }));
  }

  async listObserverMessagesPage(input: {
    threadId: string;
    accountId: string;
    limit: number;
    maxBytes: number;
    maxTokens: number;
  }): Promise<MemoryObserverPage> {
    type MetaRow = {
      id: string;
      thread_id: string;
      role: RawMessage["role"];
      token_estimate: number;
      created_at: number;
      content_hash: string | null;
      stored_bytes: number;
    };
    const thread = this.db.$sqlite
      .prepare(
        `SELECT observer_frontier_at AS frontier_at, observer_frontier_id AS frontier_id
           FROM memory_threads WHERE id = ? AND owner_id = ?`,
      )
      .get(input.threadId, input.accountId) as
      | { frontier_at: number | null; frontier_id: string | null }
      | undefined;
    if (thread === undefined) {
      return { messages: [], expectedFrontier: null, nextCursor: null, hasMore: false };
    }
    const expectedFrontier =
      thread.frontier_at === null || thread.frontier_id === null
        ? null
        : { createdAtMs: thread.frontier_at, id: thread.frontier_id };
    const rowLimit = Math.max(1, Math.floor(input.limit));
    const rows = this.db.$sqlite
      .prepare(
        `SELECT id, thread_id, role, token_estimate, created_at, content_hash,
                length(content) AS stored_bytes
           FROM memory_messages
          WHERE thread_id = ?
            AND (? IS NULL OR created_at > ? OR (created_at = ? AND id > ?))
          ORDER BY created_at, id
          LIMIT ?`,
      )
      .all(
        input.threadId,
        expectedFrontier?.createdAtMs ?? null,
        expectedFrontier?.createdAtMs ?? 0,
        expectedFrontier?.createdAtMs ?? 0,
        expectedFrontier?.id ?? "",
        rowLimit + 1,
      ) as MetaRow[];
    const selected: Array<MetaRow & { oversized: boolean }> = [];
    let tokens = 0;
    let bytes = 0;
    for (const row of rows.slice(0, rowLimit)) {
      const rowBytes = Math.max(row.stored_bytes, row.token_estimate * 4);
      const oversized = row.token_estimate > input.maxTokens || rowBytes > input.maxBytes;
      if (
        selected.length > 0 &&
        (tokens + row.token_estimate > input.maxTokens || bytes + rowBytes > input.maxBytes)
      ) {
        break;
      }
      selected.push({ ...row, oversized });
      if (!oversized) {
        tokens += row.token_estimate;
        bytes += rowBytes;
      }
      if (oversized) break;
    }
    const safeIds = selected.filter((row) => !row.oversized).map((row) => row.id);
    const selectedIds = selected.map((row) => row.id);
    const coveredMessageIds =
      selectedIds.length === 0
        ? []
        : (
            this.db.$sqlite
              .prepare(
                `SELECT m.id
                   FROM memory_messages m
                  WHERE m.id IN (${selectedIds.map(() => "?").join(",")})
                    AND EXISTS (
                      SELECT 1
                        FROM memory_observations o
                        JOIN memory_messages first_message
                          ON first_message.id = json_extract(o.source_message_range, '$[0]')
                         AND first_message.thread_id = o.thread_id
                        JOIN memory_messages last_message
                          ON last_message.id = json_extract(o.source_message_range, '$[1]')
                         AND last_message.thread_id = o.thread_id
                       WHERE o.thread_id = m.thread_id
                         AND (
                           ((first_message.created_at, first_message.id) <= (m.created_at, m.id)
                            AND (m.created_at, m.id) <= (last_message.created_at, last_message.id))
                           OR
                           ((last_message.created_at, last_message.id) <= (m.created_at, m.id)
                            AND (m.created_at, m.id) <= (first_message.created_at, first_message.id))
                         )
                    )`,
              )
              .all(...selectedIds) as Array<{ id: string }>
          ).map((row) => row.id);
    const contentById = new Map<string, unknown>();
    if (safeIds.length > 0) {
      const placeholders = safeIds.map(() => "?").join(",");
      const contentRows = this.db.$sqlite
        .prepare(`SELECT id, content FROM memory_messages WHERE id IN (${placeholders})`)
        .all(...safeIds) as Array<{ id: string; content: unknown }>;
      for (const row of contentRows) contentById.set(row.id, row.content);
    }
    const messages = selected.map((row) => ({
      id: row.id,
      threadId: row.thread_id,
      role: row.role,
      content: row.oversized
        ? `[oversized ${row.role} message omitted; sha256=${row.content_hash ?? "unknown"}]`
        : decodeMemoryContent(contentById.get(row.id)),
      tokenEstimate: row.oversized ? 32 : row.token_estimate,
      createdAt: new Date(row.created_at),
    }));
    const last = selected.at(-1);
    const nextCursor = last === undefined ? null : { createdAtMs: last.created_at, id: last.id };
    return {
      messages,
      coveredMessageIds,
      expectedFrontier,
      nextCursor,
      hasMore: selected.length < rows.length,
    };
  }

  // Persist one compressed observation. tags are JSON-encoded (SQLite has no
  // native array); the source range tuple is JSON text too — dialect quirk owned
  // here so core/ports stay DB-agnostic.
  async appendObservation(input: MemoryObservationInput): Promise<string> {
    const id = this.genId();
    this.db.$sqlite.transaction(() => {
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
      this.db.$sqlite
        .prepare(
          `UPDATE memory_threads
              SET observation_count = observation_count + 1,
                  last_observation_at = CASE
                    WHEN last_observation_at IS NULL OR last_observation_at < ? THEN ?
                    ELSE last_observation_at
                  END
            WHERE id = ?`,
        )
        .run(input.observedAt.getTime(), input.observedAt.getTime(), input.threadId);
    })();
    return id;
  }

  async appendObservationAndAdvanceFrontier(input: {
    accountId: string;
    observation: MemoryObservationInput;
    expectedFrontier: MemoryObserverCursor | null;
    nextFrontier: MemoryObserverCursor;
  }): Promise<string | null> {
    const id = this.genId();
    const db = this.db.$sqlite;
    const committed = db.transaction(() => {
      const current = db
        .prepare(
          `SELECT observer_frontier_at AS frontier_at, observer_frontier_id AS frontier_id
             FROM memory_threads WHERE id = ? AND owner_id = ?`,
        )
        .get(input.observation.threadId, input.accountId) as
        | { frontier_at: number | null; frontier_id: string | null }
        | undefined;
      const expected = input.expectedFrontier;
      if (
        current === undefined ||
        current.frontier_at !== (expected?.createdAtMs ?? null) ||
        current.frontier_id !== (expected?.id ?? null)
      ) {
        return false;
      }
      db.prepare(
        `INSERT INTO memory_observations (
           id, thread_id, source_message_range, observation_text, observed_at,
           referenced_at, priority, tags, importance
         ) VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?)`,
      ).run(
        id,
        input.observation.threadId,
        JSON.stringify(input.observation.sourceMessageRange),
        input.observation.observationText,
        input.observation.observedAt.getTime(),
        input.observation.priority ?? null,
        input.observation.tags === undefined ? null : JSON.stringify(input.observation.tags),
        input.observation.importance ?? 0.5,
      );
      db.prepare(
        `UPDATE memory_threads
            SET observer_frontier_at = ?, observer_frontier_id = ?,
                observation_count = observation_count + 1,
                last_observation_at = CASE
                  WHEN last_observation_at IS NULL OR last_observation_at < ? THEN ?
                  ELSE last_observation_at END
          WHERE id = ? AND owner_id = ?`,
      ).run(
        input.nextFrontier.createdAtMs,
        input.nextFrontier.id,
        input.observation.observedAt.getTime(),
        input.observation.observedAt.getTime(),
        input.observation.threadId,
        input.accountId,
      );
      return true;
    })();
    return committed ? id : null;
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
    const db = this.db.$sqlite;
    const committed = db.transaction(() => {
      const currentJob = db
        .prepare(
          `SELECT id FROM memory_jobs
            WHERE id = ? AND type = 'observer' AND scope_id = ? AND status = 'running'
              AND lease_generation = ?`,
        )
        .get(input.job.id, jobScopeId, input.job.leaseGeneration) as { id: string } | undefined;
      if (currentJob === undefined) return false;
      const current = db
        .prepare(
          `SELECT observer_frontier_at AS frontier_at, observer_frontier_id AS frontier_id
             FROM memory_threads WHERE id = ? AND owner_id = ?`,
        )
        .get(threadId, input.accountId) as
        | { frontier_at: number | null; frontier_id: string | null }
        | undefined;
      const expected = input.expectedFrontier;
      if (
        current === undefined ||
        current.frontier_at !== (expected?.createdAtMs ?? null) ||
        current.frontier_id !== (expected?.id ?? null)
      ) {
        return false;
      }
      if (input.action === "observe" && id !== null) {
        db.prepare(
          `INSERT INTO memory_observations (
             id, thread_id, source_message_range, observation_text, observed_at,
             referenced_at, priority, tags, importance
           ) VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?)`,
        ).run(
          id,
          threadId,
          JSON.stringify(input.observation.sourceMessageRange),
          input.observation.observationText,
          input.observation.observedAt.getTime(),
          input.observation.priority ?? null,
          input.observation.tags === undefined ? null : JSON.stringify(input.observation.tags),
          input.observation.importance ?? 0.5,
        );
        db.prepare(
          `UPDATE memory_threads
              SET observer_frontier_at = ?, observer_frontier_id = ?,
                  observation_count = observation_count + 1,
                  last_observation_at = CASE
                    WHEN last_observation_at IS NULL OR last_observation_at < ? THEN ?
                    ELSE last_observation_at END
            WHERE id = ? AND owner_id = ?`,
        ).run(
          input.nextFrontier.createdAtMs,
          input.nextFrontier.id,
          input.observation.observedAt.getTime(),
          input.observation.observedAt.getTime(),
          threadId,
          input.accountId,
        );
      } else {
        db.prepare(
          `UPDATE memory_threads SET observer_frontier_at = ?, observer_frontier_id = ?
            WHERE id = ? AND owner_id = ?`,
        ).run(input.nextFrontier.createdAtMs, input.nextFrontier.id, threadId, input.accountId);
      }
      const finished = db
        .prepare(
          `UPDATE memory_jobs SET status = 'done', error = NULL, updated_at = ?
            WHERE id = ? AND type = 'observer' AND scope_id = ? AND status = 'running'
              AND lease_generation = ?`,
        )
        .run(this.now().getTime(), input.job.id, jobScopeId, input.job.leaseGeneration);
      if (finished.changes !== 1) throw new Error("observer job fence changed during commit");
      if (successorId !== null && successorScopeId !== null) {
        const ts = this.now().getTime();
        const inserted = db
          .prepare(
            `INSERT OR IGNORE INTO memory_jobs
               (id, type, scope_id, status, error, created_at, updated_at)
             VALUES (?, 'observer', ?, 'pending', NULL, ?, ?)`,
          )
          .run(successorId, successorScopeId, ts, ts);
        if (inserted.changes !== 1) {
          const existing = db
            .prepare(
              `SELECT id FROM memory_jobs
                WHERE type = 'observer' AND scope_id = ? AND status IN ('pending', 'running')
                LIMIT 1`,
            )
            .get(successorScopeId) as { id: string } | undefined;
          if (existing === undefined) throw new Error("observer successor enqueue conflict");
        }
      }
      return true;
    })();
    return committed ? { observationId: id } : null;
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

  async listActiveObservationsBounded(
    scope: ReflectionScope,
    limit: number,
  ): Promise<Observation[]> {
    const where = observationScopeWhere(scope);
    if (where === null) return [];
    const rows = this.db
      .select()
      .from(memoryObservations)
      .where(
        and(where, eq(memoryObservations.status, "active"), isNull(memoryObservations.expiredAt)),
      )
      .orderBy(desc(memoryObservations.observedAt), desc(memoryObservations.id))
      .limit(Math.max(1, Math.floor(limit)))
      .all()
      .reverse();
    return rows.map((row) => ({
      id: row.id,
      threadId: row.threadId,
      sourceMessageRange: JSON.parse(row.sourceMessageRange) as [string, string],
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
        : sql`pow(0.5, max(0, (${score.nowMs} - COALESCE(${memoryObservations.referencedAt}, ${memoryObservations.observedAt})) / 1000.0) / ${score.half_life_s}) * (min(max(${memoryObservations.importance}, ${score.importance_floor}), ${score.importance_ceil}) + ${score.access_weight} * ln(1 + ${memoryObservations.referenceCount}))`;
    const rows = this.db
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
      .offset(input.offset)
      .all();
    return rows.map((row) => ({
      id: row.id,
      threadId: row.threadId,
      sourceMessageRange: JSON.parse(row.sourceMessageRange) as [string, string],
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
    const scoreOrder =
      score === undefined
        ? "o.observed_at DESC, o.id DESC"
        : `pow(0.5, max(0, (? - COALESCE(o.referenced_at, o.observed_at)) / 1000.0) / ?)
             * (min(max(o.importance, ?), ?) + ? * ln(1 + o.reference_count)) DESC,
           o.observed_at DESC, o.id DESC`;
    const scoreArgs =
      score === undefined
        ? []
        : [
            score.nowMs,
            score.half_life_s,
            score.importance_floor,
            score.importance_ceil,
            score.access_weight,
          ];
    const rows = this.db.$sqlite
      .prepare(
        `WITH live AS (
           SELECT key, CAST(value AS INTEGER) AS n FROM json_each(?)
         ), candidates AS MATERIALIZED (
           SELECT o.id,
                  json_extract(o.source_message_range, '$[0]') AS start_id,
                  json_extract(o.source_message_range, '$[1]') AS end_id
             FROM memory_observations o
             JOIN memory_threads t ON t.id = o.thread_id AND t.owner_id = ?
            WHERE o.thread_id = ? AND o.status = 'active' AND o.expired_at IS NULL
            ORDER BY ${scoreOrder}
            LIMIT ?
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
             JOIN memory_messages s ON s.id = c.start_id AND s.thread_id = ?
             JOIN memory_messages e ON e.id = c.end_id AND e.thread_id = ?
         ), bounded AS MATERIALIZED (
           SELECT e.* FROM endpoints e
            WHERE (
              SELECT COUNT(*) FROM (
                SELECT 1 FROM memory_messages m
                 WHERE m.thread_id = ?
                   AND (m.created_at, m.id) >= (e.first_at, e.first_id)
                   AND (m.created_at, m.id) <= (e.last_at, e.last_id)
                 ORDER BY m.created_at, m.id
                 LIMIT ?
              ) covered_limit
            ) <= ?
         )
         SELECT b.id FROM bounded b
          WHERE NOT EXISTS (
              SELECT 1 FROM memory_messages m
              LEFT JOIN live l ON l.key = m.content_hash
               WHERE m.thread_id = ?
                 AND (m.created_at, m.id) >= (b.first_at, b.first_id)
                 AND (m.created_at, m.id) <= (b.last_at, b.last_id)
               GROUP BY m.content_hash, l.n
              HAVING m.content_hash IS NULL OR l.n IS NULL OR l.n < COUNT(*)
            )`,
      )
      .all(
        live,
        input.accountId,
        input.threadId,
        ...scoreArgs,
        candidateLimit,
        input.threadId,
        input.threadId,
        input.threadId,
        maxCoverageMessages + 1,
        maxCoverageMessages,
        input.threadId,
      ) as Array<{
      id: string;
    }>;
    return new Set(rows.map((row) => row.id));
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
  async listActiveReflectionScopes(accountId: string, limit = 512): Promise<ReflectionScope[]> {
    const rows = this.db.$sqlite
      .prepare(
        `SELECT DISTINCT project_id, resource_id, thread_id
           FROM memory_reflections
          WHERE owner_id = ? AND status = 'active'
          ORDER BY project_id, resource_id, thread_id
          LIMIT ?`,
      )
      .all(accountId, Math.max(1, Math.floor(limit))) as Array<{
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

  private hasCurrentJobLease(job: { id: string; leaseGeneration: number }): boolean {
    return (
      this.db.$sqlite
        .prepare(
          "SELECT 1 FROM memory_jobs WHERE id = ? AND status = 'running' AND lease_generation = ?",
        )
        .get(job.id, job.leaseGeneration) !== undefined
    );
  }

  async commitReflectionJob(
    jobId: string,
    input: MemoryReflectionJobCommitInput,
  ): Promise<MemoryReflectionJobCommitResult | null> {
    const db = this.db.$sqlite;
    return db.transaction(() => {
      const scopeId = encodeScopeId(input.target);
      const claimed = db
        .prepare(
          `UPDATE memory_jobs
              SET status = 'done', error = NULL, updated_at = ?
            WHERE id = ? AND type = 'reflector' AND scope_id = ? AND status = 'running'
              AND lease_generation = ?
          RETURNING id`,
        )
        .get(input.now.getTime(), jobId, scopeId, input.leaseGeneration) as
        | { id: string }
        | undefined;
      if (claimed === undefined) return null;

      const facts = this.reconcileFactsSync({
        accountId: input.target.accountId,
        scope: {
          ...(input.target.projectId !== undefined ? { projectId: input.target.projectId } : {}),
          ...(input.target.resourceId !== undefined ? { resourceId: input.target.resourceId } : {}),
          ...(input.target.threadId !== undefined ? { threadId: input.target.threadId } : {}),
        },
        facts: input.facts,
        now: input.now,
      });

      let reflectionId: string | null = null;
      if (input.reflection.action === "archive") {
        this.db
          .update(memoryReflections)
          .set({ status: "archived" })
          .where(and(reflectionScopeWhere(input.target), eq(memoryReflections.status, "active")))
          .run();
      } else if (input.reflection.action === "upsert") {
        reflectionId = this.genId();
        this.db
          .insert(memoryReflections)
          .values({
            id: reflectionId,
            ownerId: input.target.accountId,
            projectId: input.target.projectId ?? null,
            resourceId: input.target.resourceId ?? null,
            threadId: input.target.threadId ?? null,
            reflectionText: input.reflection.reflectionText,
            version: input.reflection.version,
            tokenEstimate: input.reflection.tokenEstimate,
            updatedAt: input.reflection.updatedAt,
          })
          .run();
      }
      return { reflectionId, facts };
    })();
  }

  // Update a background job's lifecycle status (+ optional error on failure).
  async updateJobStatus(
    jobId: string,
    status: MemoryJobStatus,
    error?: string,
    leaseGeneration?: number,
  ): Promise<void> {
    this.db
      .update(memoryJobs)
      .set({ status, error: error ?? null, updatedAt: this.now() })
      .where(
        leaseGeneration === undefined
          ? eq(memoryJobs.id, jobId)
          : and(
              eq(memoryJobs.id, jobId),
              eq(memoryJobs.status, "running"),
              eq(memoryJobs.leaseGeneration, leaseGeneration),
            ),
      )
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
            SET status = 'running', updated_at = ?, lease_generation = lease_generation + 1
          WHERE id IN (
            SELECT id FROM memory_jobs
             WHERE status = 'pending'
                OR (status = 'running' AND updated_at <= ?)
             ORDER BY created_at ASC, id ASC
             LIMIT ?
          )
        RETURNING id, type, scope_id, lease_generation`,
      )
      .all(updatedAt, staleBefore, limit) as Array<{
      id: string;
      type: string;
      scope_id: string;
      lease_generation: number;
    }>;
    return rows.map((row) => ({
      jobId: row.id,
      leaseGeneration: row.lease_generation,
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
    factIds?: string[];
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
    // docs/14 — recalled facts get the same reinforcement bump. memory_facts carry
    // owner_id directly (no thread join), so guard on owner_id like reflections.
    if (input.factIds !== undefined && input.factIds.length > 0) {
      const placeholders = input.factIds.map(() => "?").join(", ");
      this.db.$sqlite
        .prepare(
          `UPDATE memory_facts
              SET reference_count = reference_count + 1, referenced_at = ?
            WHERE id IN (${placeholders})
              AND owner_id = ?`,
        )
        .run(nowMs, ...input.factIds, input.accountId);
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
  async archiveObservations(input: {
    accountId: string;
    ids: string[];
    now: Date;
    job?: { id: string; leaseGeneration: number };
  }): Promise<boolean> {
    if (input.ids.length === 0) return true;
    const placeholders = input.ids.map(() => "?").join(", ");
    const db = this.db.$sqlite;
    return db.transaction(() => {
      if (input.job !== undefined && !this.hasCurrentJobLease(input.job)) return false;
      const rows = db
        .prepare(
          `SELECT DISTINCT t.project_id, t.resource_id, t.id AS thread_id
             FROM memory_observations o
             JOIN memory_threads t ON t.id = o.thread_id
            WHERE o.id IN (${placeholders})
              AND o.status = 'active' AND t.owner_id = ?`,
        )
        .all(...input.ids, input.accountId) as Array<{
        project_id: string | null;
        resource_id: string | null;
        thread_id: string;
      }>;
      db.prepare(
        `UPDATE memory_observations
            SET status = 'archived', archived_at = ?
          WHERE id IN (${placeholders})
            AND status = 'active'
            AND thread_id IN (
              SELECT id FROM memory_threads WHERE owner_id = ?
            )`,
      ).run(input.now.getTime(), ...input.ids, input.accountId);

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
      for (const [scopeId, target] of scopes) {
        db.prepare(
          `UPDATE memory_reflections
              SET status = 'archived'
            WHERE owner_id = ?
              AND project_id IS ? AND resource_id IS ? AND thread_id IS ?
              AND status = 'active'`,
        ).run(
          target.accountId,
          target.projectId ?? null,
          target.resourceId ?? null,
          target.threadId ?? null,
        );
        db.prepare(
          `UPDATE memory_jobs
              SET status = 'failed', error = 'superseded by observation archive', updated_at = ?
            WHERE type = 'reflector' AND scope_id = ? AND status = 'running'`,
        ).run(input.now.getTime(), scopeId);
        db.prepare(
          `INSERT OR IGNORE INTO memory_jobs
             (id, type, scope_id, status, error, created_at, updated_at)
           VALUES (?, 'reflector', ?, 'pending', NULL, ?, ?)`,
        ).run(this.genId(), scopeId, input.now.getTime(), input.now.getTime());
      }
      return true;
    })();
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
    limit?: number;
  }): Promise<string[]> {
    const intervalCutoff = input.nowMs - input.triggerIntervalS * 1000;
    const limit = input.limit === undefined ? 100 : Math.max(0, input.limit);
    if (limit === 0) return [];
    const rows = this.db.$sqlite
      .prepare(
        `WITH decay_sweeps AS MATERIALIZED (
           SELECT json_extract(scope_id, '$.accountId') AS owner_id,
                  MAX(created_at) AS last_sweep
             FROM memory_jobs
            WHERE type = 'decay'
            GROUP BY json_extract(scope_id, '$.accountId')
         )
         SELECT mt.owner_id AS owner_id,
                ds.last_sweep AS last_sweep,
                COUNT(o.id) AS active_total,
                SUM(CASE WHEN o.observed_at > COALESCE(ds.last_sweep, 0)
                  THEN 1 ELSE 0 END) AS new_since_sweep
           FROM memory_observations o
           JOIN memory_threads mt ON mt.id = o.thread_id
           LEFT JOIN decay_sweeps ds ON ds.owner_id = mt.owner_id
          WHERE o.status = 'active'
            AND mt.owner_id IS NOT NULL
           GROUP BY mt.owner_id, ds.last_sweep
          HAVING COUNT(o.id) > 0
             AND (
               SUM(CASE WHEN o.observed_at > COALESCE(ds.last_sweep, 0) THEN 1 ELSE 0 END) >= ?
               OR ds.last_sweep IS NULL
               OR ds.last_sweep <= ?
             )
          ORDER BY mt.owner_id
          LIMIT ?`,
      )
      .all(input.triggerObservations, intervalCutoff, limit) as Array<{
      owner_id: string;
      last_sweep: number | null;
      active_total: number;
      new_since_sweep: number;
    }>;
    return rows.map((row) => row.owner_id);
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
  private reconcileFactsSync(input: {
    accountId: string;
    scope: { projectId?: string; resourceId?: string; threadId?: string };
    facts: MemoryFactInput[];
    now: Date;
    job?: { id: string; leaseGeneration: number };
  }): MemoryFactReconcileResult {
    if (input.facts.length === 0) return { insertedIds: [], supersededIds: [], resurrectedIds: [] };
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
    // Resurrect-on-re-ingest: a manual delete soft-prunes the fact but keeps its
    // content_hash, so the UNIQUE(owner_id, content_hash) index would otherwise
    // suppress every re-extraction of it forever. On a dedup hit we look the row up
    // and, if it is NOT live (pruned/archived), REACTIVATE it instead of skipping.
    const selectByHash = this.db.$sqlite.prepare(
      `SELECT id, status FROM memory_facts WHERE owner_id = ? AND content_hash = ?`,
    );
    // Re-scope on resurrect (Codex review fix): the (owner_id, content_hash) unique
    // index is ACCOUNT-GLOBAL, so a fact re-stated under a DIFFERENT project/resource/
    // thread dedup-hits the old row. Reactivating without re-scoping would revive it at
    // the STALE scope, and the inject read (scoped by project/resource/thread) would
    // never surface it — the fact "comes back" but stays invisible. The re-ingest's
    // scope is authoritative for where the fact should now live, so overwrite the scope
    // columns too. Same-scope re-statement (the common case) is a no-op rewrite.
    const reactivate = this.db.$sqlite.prepare(
      `UPDATE memory_facts
          SET status = 'active', expired_at = NULL, invalid_at = NULL, valid_from = ?, updated_at = ?,
              project_id = ?, resource_id = ?, thread_id = ?
        WHERE id = ?`,
    );
    // The whole batch is atomic: a partial ingest must not leave a fact inserted
    // without its supersede applied (or vice versa). Returns the ids inserted +
    // superseded + resurrected (docs/13 — the MCP `memory_add` tool echoes them).
    const runBatch = this.db.$sqlite.transaction((facts: MemoryFactInput[]) => {
      if (input.job !== undefined && !this.hasCurrentJobLease(input.job)) {
        return { insertedIds: [], supersededIds: [], resurrectedIds: [], accepted: false };
      }
      const insertedIds: string[] = [];
      const supersededIds: string[] = [];
      const resurrectedIds: string[] = [];
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
        } else {
          // Dedup hit (res.changes === 0): the (owner_id, content_hash) row exists.
          // If it is NOT live (pruned by a manual delete, or archived), reactivate
          // it — a re-observed fact returns rather than staying permanently
          // suppressed. A live duplicate (active + expired_at IS NULL) is left as a
          // true idempotent no-op (status NOT in the resurrect set).
          const existing = selectByHash.get(ownerId, f.contentHash) as
            | { id: string; status: string }
            | undefined;
          if (
            existing !== undefined &&
            (existing.status === "pruned" || existing.status === "archived")
          ) {
            reactivate.run(
              f.validFrom.getTime(),
              nowMs,
              projectId,
              resourceId,
              threadId,
              existing.id,
            );
            resurrectedIds.push(existing.id);
            // The resurrected row is now the subject's live fact — supersede older
            // same-subject siblings exactly as a fresh insert would (id <> its own).
            const superseded = supersede.all(
              nowMs,
              f.validFrom.getTime(),
              nowMs,
              ownerId,
              f.subjectKey,
              f.validFrom.getTime(),
              existing.id,
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
      }
      return { insertedIds, supersededIds, resurrectedIds };
    });
    return runBatch(input.facts);
  }

  async insertFactsReconciled(input: {
    accountId: string;
    scope: { projectId?: string; resourceId?: string; threadId?: string };
    facts: MemoryFactInput[];
    now: Date;
    job?: { id: string; leaseGeneration: number };
  }): Promise<MemoryFactReconcileResult> {
    return this.reconcileFactsSync(input);
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
        : sql`pow(0.5, max(0, (${score.nowMs} - COALESCE(${memoryFacts.referencedAt}, ${memoryFacts.createdAt})) / 1000.0) / ${score.half_life_s}) * (min(max(${memoryFacts.importance}, ${score.importance_floor}), ${score.importance_ceil}) + ${score.access_weight} * ln(1 + ${memoryFacts.referenceCount}))`;
    return this.db
      .select()
      .from(memoryFacts)
      .where(and(...clauses) as SQL)
      .orderBy(
        scoreOrder === undefined ? desc(memoryFacts.validFrom) : desc(scoreOrder),
        desc(memoryFacts.validFrom),
        desc(memoryFacts.id),
      )
      .limit(input.limit)
      .all()
      .map(sqliteRowToFact);
  }

  // =========================================================================
  // docs/13 — Memory ADMIN + MCP management surface (facts + reflections).
  // =========================================================================

  // Admin "By Scope" view. Distinct (account, project, resource, thread) groups
  // holding live facts and/or an active reflection, with per-tier counts + newest
  // updatedAt. facts ⊎ reflections via a UNION of grouped subqueries (SQLite has
  // no FULL OUTER JOIN); reflections guarded owner_id IS NOT NULL (nullable
  // column). An optional accountId narrows to one tenant.
  async listMemoryScopes(input: {
    accountId?: string;
    limit: number;
    offset: number;
  }): Promise<{ rows: MemoryScopeSummary[]; total: number }> {
    const acct = input.accountId ?? null;
    const aggregateSql = `SELECT owner_id AS accountId, project_id AS projectId,
                resource_id AS resourceId,
                thread_id AS threadId,
                SUM(fc) AS factCount, SUM(rc) AS reflectionCount, MAX(lu) AS lastUpdated,
                COUNT(*) OVER() AS total
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
          GROUP BY owner_id, project_id, resource_id, thread_id`;
    const rows = this.db.$sqlite
      .prepare(
        `${aggregateSql}
          ORDER BY lastUpdated DESC, accountId ASC,
                   CASE WHEN projectId IS NULL THEN 0 ELSE 1 END, projectId ASC,
                   CASE WHEN resourceId IS NULL THEN 0 ELSE 1 END, resourceId ASC,
                   CASE WHEN threadId IS NULL THEN 0 ELSE 1 END, threadId ASC
          LIMIT ? OFFSET ?`,
      )
      .all(acct, acct, acct, acct, input.limit, input.offset) as Array<{
      accountId: string;
      projectId: string | null;
      resourceId: string | null;
      threadId: string | null;
      factCount: number;
      reflectionCount: number;
      lastUpdated: number | null;
      total: number;
    }>;
    const total =
      rows[0]?.total ??
      (input.offset === 0 && input.limit > 0
        ? 0
        : (
            this.db.$sqlite
              .prepare(`SELECT COUNT(*) AS total FROM (${aggregateSql}) scopes`)
              .get(acct, acct, acct, acct) as { total: number }
          ).total);
    return {
      rows: rows.map((r) => ({
        accountId: r.accountId,
        projectId: r.projectId,
        resourceId: r.resourceId,
        threadId: r.threadId,
        factCount: r.factCount,
        reflectionCount: r.reflectionCount,
        lastUpdated: r.lastUpdated !== null ? new Date(r.lastUpdated) : null,
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
    const threadArgs = [
      accountId,
      accountId,
      projectId,
      projectId,
      resourceId,
      resourceId,
      threadId,
      threadId,
    ];
    const itemArgs = [
      accountId,
      accountId,
      projectId,
      projectId,
      resourceId,
      resourceId,
      threadId,
      threadId,
    ];
    const threadWhere = `
      (? IS NULL OR t.owner_id = ?)
      AND (? IS NULL OR t.project_id = ?)
      AND (? IS NULL OR t.resource_id = ?)
      AND (? IS NULL OR t.id = ?)
    `;
    const itemWhere = `
      (? IS NULL OR owner_id = ?)
      AND (? IS NULL OR project_id = ?)
      AND (? IS NULL OR resource_id = ?)
      AND (? IS NULL OR thread_id = ?)
    `;
    const jobScope = sqliteMemoryJobScope(input);
    // Raw message/observation bodies live in child tables that grow into millions
    // of rows. Their count/latest activity is maintained on memory_threads, so this
    // one narrow parent aggregation replaces the former three synchronous scans.
    const threadActivity = (
      noScopeFilter
        ? this.db.$sqlite
            .prepare(
              `SELECT COUNT(*) AS n,
                      COALESCE(SUM(message_count), 0) AS messages,
                      COALESCE(SUM(observation_count), 0) AS observations,
                      MAX(last_message_at) AS lastMessageAt,
                      MAX(last_observation_at) AS lastObservationAt
                 FROM memory_threads`,
            )
            .get()
        : this.db.$sqlite
            .prepare(
              `SELECT COUNT(*) AS n,
                      COALESCE(SUM(t.message_count), 0) AS messages,
                      COALESCE(SUM(t.observation_count), 0) AS observations,
                      MAX(t.last_message_at) AS lastMessageAt,
                      MAX(t.last_observation_at) AS lastObservationAt
                 FROM memory_threads t
                WHERE ${threadWhere}`,
            )
            .get(...threadArgs)
    ) as
      | {
          n: number;
          messages: number;
          observations: number;
          lastMessageAt: number | null;
          lastObservationAt: number | null;
        }
      | undefined;
    const facts = (
      noScopeFilter
        ? this.db.$sqlite
            .prepare(
              `SELECT COUNT(*) AS n,
                SUM(CASE WHEN status = 'active' AND expired_at IS NULL THEN 1 ELSE 0 END) AS active,
                MAX(updated_at) AS lastAt
           FROM memory_facts`,
            )
            .get()
        : this.db.$sqlite
            .prepare(
              `SELECT COUNT(*) AS n,
                SUM(CASE WHEN status = 'active' AND expired_at IS NULL THEN 1 ELSE 0 END) AS active,
                MAX(updated_at) AS lastAt
           FROM memory_facts
          WHERE ${itemWhere}`,
            )
            .get(...itemArgs)
    ) as { n: number; active: number | null; lastAt: number | null } | undefined;
    const reflections = (
      noScopeFilter
        ? this.db.$sqlite
            .prepare(
              `SELECT COUNT(*) AS n,
                SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) AS active,
                MAX(updated_at) AS lastAt
           FROM memory_reflections`,
            )
            .get()
        : this.db.$sqlite
            .prepare(
              `SELECT COUNT(*) AS n,
                SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) AS active,
                MAX(updated_at) AS lastAt
           FROM memory_reflections
          WHERE ${itemWhere}`,
            )
            .get(...itemArgs)
    ) as { n: number; active: number | null; lastAt: number | null } | undefined;
    const jobWhereSql = sqliteWhere(jobScope.clauses);
    const queueRows = this.db.$sqlite
      .prepare(
        `SELECT status, COUNT(*) AS n
           FROM memory_jobs
          ${jobWhereSql}
          GROUP BY status`,
      )
      .all(...jobScope.args) as Array<{ status: string; n: number }>;
    const queue = { pending: 0, running: 0, done: 0, failed: 0 };
    for (const row of queueRows) {
      if (row.status === "pending") queue.pending = row.n;
      else if (row.status === "running") queue.running = row.n;
      else if (row.status === "done") queue.done = row.n;
      else if (row.status === "failed") queue.failed = row.n;
    }
    const jobScalar = (
      expr: string,
      status: MemoryJobStatus,
      extraClause?: string,
      extraArgs: readonly unknown[] = [],
    ): number | null => {
      const clauses = ["status = ?", ...jobScope.clauses];
      const args: unknown[] = [status, ...jobScope.args];
      if (extraClause !== undefined) {
        clauses.push(extraClause);
        args.push(...extraArgs);
      }
      const row = this.db.$sqlite
        .prepare(`SELECT ${expr} AS value FROM memory_jobs ${sqliteWhere(clauses)}`)
        .get(...args) as { value: number | null } | undefined;
      return row?.value ?? null;
    };
    const queueTimes = {
      oldestPendingAt: jobScalar("MIN(created_at)", "pending"),
      oldestRunningAt: jobScalar("MIN(updated_at)", "running"),
      newestDoneAt: jobScalar("MAX(updated_at)", "done"),
      newestFailedAt: jobScalar("MAX(updated_at)", "failed"),
      staleRunning:
        jobScalar("COUNT(*)", "running", "updated_at <= ?", [
          input.now.getTime() - RUNNING_LEASE_MS,
        ]) ?? 0,
    };
    const byType = this.db.$sqlite
      .prepare(
        `SELECT type, status, COUNT(*) AS count
           FROM memory_jobs
          ${jobWhereSql}
          GROUP BY type, status
          ORDER BY type ASC, status ASC`,
      )
      .all(...jobScope.args) as Array<{ type: string; status: string; count: number }>;
    return {
      generatedAt: input.now,
      scope: {
        ...(input.accountId !== undefined ? { accountId: input.accountId } : {}),
        ...(input.projectId !== undefined ? { projectId: input.projectId } : {}),
        ...(input.resourceId !== undefined ? { resourceId: input.resourceId } : {}),
        ...(input.threadId !== undefined ? { threadId: input.threadId } : {}),
      },
      storage: {
        threads: countOf(threadActivity),
        messages: threadActivity?.messages ?? 0,
        observations: threadActivity?.observations ?? 0,
        facts: countOf(facts),
        activeFacts: facts?.active ?? 0,
        reflections: countOf(reflections),
        activeReflections: reflections?.active ?? 0,
      },
      queue: {
        ...queue,
        open: queue.pending + queue.running,
        staleRunning: queueTimes?.staleRunning ?? 0,
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
    status?: FactListStatus;
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

  // docs/14 / docs/12 P8 — HYBRID relevance retrieval over memory_facts. Up to three
  // ranked lists fused with RRF: FTS5(trigram) full-text, sqlite-vec KNN (only when a
  // query embedding is given AND the extension loaded AND the vec table matches — else
  // skipped, fail-open), and the forgetting score over the candidate union. Account-
  // scoped + active-only; a superseded/archived/expired fact never surfaces.
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
    // Over-fetch per signal so RRF has room to find consensus; final cap is input.limit.
    const candidateLimit = Math.max(input.limit * 5, 50);

    // Account + active + scope guard, shared by both raw legs (mf = memory_facts).
    const scopeSql = ["mf.owner_id = ?", "mf.status = 'active'", "mf.expired_at IS NULL"];
    const scopeArgs: unknown[] = [input.accountId];
    if (input.projectId !== undefined) {
      scopeSql.push("mf.project_id = ?");
      scopeArgs.push(input.projectId);
    }
    if (input.resourceId !== undefined) {
      scopeSql.push("mf.resource_id = ?");
      scopeArgs.push(input.resourceId);
    }
    if (input.threadId !== undefined) {
      scopeSql.push("mf.thread_id = ?");
      scopeArgs.push(input.threadId);
    }
    const scopeWhere = scopeSql.join(" AND ");

    // ── FTS leg (trigram) ──
    const ftsIds: string[] = [];
    const match = toFtsMatch(input.queryText);
    if (match !== null) {
      const rows = this.db.$sqlite
        .prepare(
          `SELECT mf.id AS id
             FROM memory_facts_fts ff
             JOIN memory_facts mf ON mf.rowid = ff.rowid
            WHERE memory_facts_fts MATCH ?
              AND ${scopeWhere}
            ORDER BY bm25(memory_facts_fts)
            LIMIT ?`,
        )
        .all(match, ...scopeArgs, candidateLimit) as Array<{ id: string }>;
      for (const r of rows) ftsIds.push(r.id);
    }

    // ── LIKE fallback ── when the FTS leg yields NO candidates — a sub-trigram query
    // (the 2-char CJK "成本" that trigram can't index, so toFtsMatch returned null) or a
    // genuine FTS miss — a substring scan restores exact short-literal recall (parity
    // with memory_search), so short queries never regress to empty. Same scope guard.
    if (ftsIds.length === 0) {
      const cleaned = input.queryText.replace(/\s+/g, " ").trim();
      if (cleaned.length > 0) {
        const rows = this.db.$sqlite
          .prepare(
            `SELECT mf.id AS id
               FROM memory_facts mf
              WHERE ${scopeWhere}
                AND mf.fact_text LIKE ?
              ORDER BY mf.updated_at DESC
              LIMIT ?`,
          )
          .all(...scopeArgs, `%${cleaned}%`, candidateLimit) as Array<{ id: string }>;
        for (const r of rows) ftsIds.push(r.id);
      }
    }

    // ── vector leg (sqlite-vec KNN) ── only with an embedding AND the extension
    // loaded. The KNN lives in a subquery (pure vec0 form), then joins memory_facts
    // for the scope/active guard. Wrapped in try/catch: a missing vec table or a dim
    // mismatch degrades to FTS+score (fail-open), never throws.
    const vecIds: string[] = [];
    if (input.queryEmbedding !== undefined && this.db.$vecLoaded) {
      try {
        const qbuf = new Uint8Array(
          input.queryEmbedding.buffer,
          input.queryEmbedding.byteOffset,
          input.queryEmbedding.byteLength,
        );
        const rows = this.db.$sqlite
          .prepare(
            `SELECT mf.id AS id
               FROM (
                 SELECT fact_rowid, distance FROM memory_facts_vec
                  WHERE embedding MATCH ? AND k = ?
               ) v
               JOIN memory_facts mf ON mf.rowid = v.fact_rowid
              WHERE ${scopeWhere}
              ORDER BY v.distance`,
          )
          .all(qbuf, candidateLimit, ...scopeArgs) as Array<{ id: string }>;
        for (const r of rows) vecIds.push(r.id);
      } catch {
        // vec table absent / dim mismatch → skip the vector leg (fail-open).
      }
    }

    // Candidate union; nothing matched ⇒ empty (the tool reports "no hits").
    const candidateIds = [...new Set([...ftsIds, ...vecIds])];
    if (candidateIds.length === 0) return [];

    // Materialize via Drizzle (camelCase rows → Fact); only candidates, so cheap.
    const factById = new Map<string, Fact>();
    for (const row of this.db
      .select()
      .from(memoryFacts)
      .where(inArray(memoryFacts.id, candidateIds))
      .all()) {
      factById.set(row.id, sqliteRowToFact(row));
    }

    // Forgetting-score ranked list over the candidate union (fact-tier fallback_ts =
    // created_at, docs/12). A decayed fact ranks low in retrieval too.
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

    // RRF-fuse the three ranked lists, take top-K, return full facts in fused order.
    return reciprocalRankFusion([ftsIds, vecIds, scoreIds])
      .map((r) => factById.get(r.id))
      .filter((f): f is Fact => f !== undefined)
      .slice(0, input.limit);
  }

  // docs/14 — embedding write sink (the background embedding job). Account-guarded: a
  // fact not owned by accountId is skipped (never a cross-tenant write). Persists the
  // vector + model + dim onto memory_facts, and when sqlite-vec is loaded mirrors it
  // into the vec0 KNN table (lazily created at the right dim). Idempotent.
  async setFactEmbeddings(input: {
    accountId: string;
    items: Array<{ factId: string; embedding: Float32Array; model: string; dim: number }>;
    job?: { id: string; leaseGeneration: number };
  }): Promise<boolean> {
    if (input.items.length === 0) return true;
    const selectRowid = this.db.$sqlite.prepare(
      "SELECT rowid AS rowid FROM memory_facts WHERE id = ? AND owner_id = ?",
    );
    const updateEmbedding = this.db.$sqlite.prepare(
      "UPDATE memory_facts SET embedding = ?, embedding_model = ?, embedding_dim = ? WHERE rowid = ?",
    );
    const run = this.db.$sqlite.transaction(() => {
      if (input.job !== undefined && !this.hasCurrentJobLease(input.job)) return false;
      for (const it of input.items) {
        const row = selectRowid.get(it.factId, input.accountId) as { rowid: number } | undefined;
        if (row === undefined) continue;
        const buf = new Uint8Array(
          it.embedding.buffer,
          it.embedding.byteOffset,
          it.embedding.byteLength,
        );
        updateEmbedding.run(buf, it.model, it.dim, row.rowid);
        if (this.db.$vecLoaded && this.ensureVecTable(it.dim)) {
          // vec0 sync is BEST-EFFORT: a failure here must not roll back the BLOB write
          // above (the fact stays FTS+score findable and re-embed retries).
          try {
            const rid = BigInt(row.rowid);
            this.db.$sqlite.prepare("DELETE FROM memory_facts_vec WHERE fact_rowid = ?").run(rid);
            this.db.$sqlite
              .prepare("INSERT INTO memory_facts_vec(fact_rowid, embedding) VALUES (?, ?)")
              .run(rid, buf);
          } catch {
            // skip vec sync for this row
          }
        }
      }
      return true;
    });
    return run();
  }

  // docs/14 — the embedding job's read half. ACTIVE facts with no embedding, or one
  // from a different model OR a different dim (IS NOT is NULL-safe: an unembedded row
  // has model/dim NULL, which IS NOT <model>/<dim> → included). Oldest-first, capped.
  async listFactsNeedingEmbedding(input: {
    accountId: string;
    model: string;
    dim: number;
    limit: number;
  }): Promise<Array<{ id: string; factText: string }>> {
    return this.db.$sqlite
      .prepare(
        `SELECT id AS id, fact_text AS factText
           FROM memory_facts
          WHERE owner_id = ?
            AND status = 'active'
            AND expired_at IS NULL
            AND (embedding IS NULL OR embedding_model IS NOT ? OR embedding_dim IS NOT ?)
          ORDER BY created_at ASC
          LIMIT ?`,
      )
      .all(input.accountId, input.model, input.dim, input.limit) as Array<{
      id: string;
      factText: string;
    }>;
  }

  // Lazily create the vec0 KNN table at the embedding dimension (the migration can't —
  // FLOAT[dim] needs the runtime dim). Returns false when the extension isn't loaded or
  // dim is invalid. A changed dim (model swap) rebuilds the table; the embedding job
  // re-embeds the rest. dim is a trusted integer (config-validated); guarded anyway.
  private vecDim: number | null = null;
  private ensureVecTable(dim: number): boolean {
    if (!this.db.$vecLoaded) return false;
    if (!Number.isInteger(dim) || dim <= 0) return false;
    if (this.vecDim === dim) return true;
    if (this.vecDim !== null && this.vecDim !== dim) {
      this.db.$sqlite.exec("DROP TABLE IF EXISTS memory_facts_vec");
    }
    this.db.$sqlite.exec(
      `CREATE VIRTUAL TABLE IF NOT EXISTS memory_facts_vec USING vec0(fact_rowid INTEGER PRIMARY KEY, embedding FLOAT[${dim}])`,
    );
    this.vecDim = dim;
    return true;
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
    // docs/14 — a TEXT edit invalidates the stored vector. Clear the embedding columns
    // + drop the vec0 row so the fact re-embeds on the next embedding job and is NEVER
    // ranked by a stale vector (Codex review). The embedding columns live outside the
    // Drizzle schema (raw migration v28), so this is a raw clear. `set.factText` is set
    // only when the text actually changed.
    if (set.factText !== undefined) {
      const rowidRow = this.db.$sqlite
        .prepare("SELECT rowid AS rowid FROM memory_facts WHERE id = ? AND owner_id = ?")
        .get(input.id, input.accountId) as { rowid: number } | undefined;
      if (rowidRow !== undefined) {
        this.db.$sqlite
          .prepare(
            "UPDATE memory_facts SET embedding = NULL, embedding_model = NULL, embedding_dim = NULL WHERE rowid = ?",
          )
          .run(rowidRow.rowid);
        if (this.db.$vecLoaded) {
          try {
            this.db.$sqlite
              .prepare("DELETE FROM memory_facts_vec WHERE fact_rowid = ?")
              .run(BigInt(rowidRow.rowid));
          } catch {
            // vec table absent → nothing to drop.
          }
        }
      }
    }
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

  // Operator delete — TWO-STAGE on the resolved row's status (docs/13):
  //   • active  → SOFT delete: archive EVERY active version of its scope (not just
  //     the one id). upsertReflection appends versions WITHOUT archiving the old
  //     ones, so a scope can hold several active versions and getReflection returns
  //     the highest; archiving only one id would let injection fall back to the
  //     next. Archive all active versions → getReflection(scope) returns null and
  //     injection stops, but the rows SURVIVE so the operator can still see them.
  //   • archived → HARD delete: a second delete on an already-archived row purges
  //     EVERY archived version of that scope. (Previously this returned false →
  //     the admin "Delete" button 404'd "reflection not found" on archived rows,
  //     leaving them undeletable.) Purging the whole scope — not just the one id —
  //     keeps latestPerScope from resurfacing an older archived version as a
  //     "zombie" row right after the operator deletes the visible one.
  // false only for an unknown/cross-tenant id (genuine not-found).
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
      const res = this.db
        .update(memoryReflections)
        .set({ status: "archived" })
        .where(and(reflectionScopeWhere(scope), eq(memoryReflections.status, "active")))
        .run();
      return res.changes > 0;
    }
    const res = this.db
      .delete(memoryReflections)
      .where(and(reflectionScopeWhere(scope), ne(memoryReflections.status, "active")))
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
    const db = this.db.$sqlite;
    const observationsBatch = db.prepare(`UPDATE memory_observations
      SET status = 'pruned', observation_text = '[pruned]', tags = NULL
      WHERE id IN (
        SELECT id FROM memory_observations
        WHERE status = 'archived' AND archived_at IS NOT NULL AND archived_at < ?
        ORDER BY archived_at, id LIMIT ?
      )`);
    const observationsDeleted = await runBatchedPrune(
      (limit) => observationsBatch.run(input.archivedObservationsBeforeMs, limit).changes,
    );
    // Facts carry NO coverage role → a true hard DELETE is correct (the only
    // DELETE in the forgetting system). expired_at IS NOT NULL keeps live facts.
    const factsBatch = db.prepare(`DELETE FROM memory_facts WHERE id IN (
      SELECT id FROM memory_facts
      WHERE expired_at IS NOT NULL AND expired_at < ?
      ORDER BY expired_at, id LIMIT ?
    )`);
    const factsDeleted = await runBatchedPrune(
      (limit) => factsBatch.run(input.expiredFactsBeforeMs, limit).changes,
    );
    return { observationsDeleted, factsDeleted };
  }

  // ——— Cleanup/archival (raw transcript + job log) ———
  async countMessagesOlderThan(olderThanMs: number): Promise<number> {
    const row = this.db
      .select({ value: count() })
      .from(memoryMessages)
      .where(
        and(
          lt(memoryMessages.createdAt, new Date(olderThanMs)),
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
      )
      .get();
    return row?.value ?? 0;
  }

  async selectMessagesOlderThan(
    olderThanMs: number,
    limit: number,
    afterId?: string,
  ): Promise<MemoryMessageArchiveRow[]> {
    const conds: SQL[] = [
      lt(memoryMessages.createdAt, new Date(olderThanMs)),
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
        content: decodeMemoryContent(r.content),
        tokenEstimate: r.tokenEstimate,
        messageIndex: r.messageIndex ?? null,
        contentHash: r.contentHash ?? null,
        createdAt: r.createdAt.getTime(),
      }));
  }

  async pruneMessagesOlderThan(olderThanMs: number): Promise<number> {
    // Keep the summary exact in the SAME transaction. A TEMP key table avoids
    // returning every deleted body row to JS and lets one set-based UPDATE repair
    // only affected threads after the delete (including the new MAX timestamp).
    const db = this.db.$sqlite;
    db.exec(`CREATE TEMP TABLE IF NOT EXISTS _helm_pruned_message_threads (
      thread_id TEXT PRIMARY KEY
    ) WITHOUT ROWID;`);
    const pruneBatch = db.transaction((limit: number) => {
      db.exec("DELETE FROM _helm_pruned_message_threads");
      db.prepare(
        `INSERT OR IGNORE INTO _helm_pruned_message_threads (thread_id)
         SELECT DISTINCT thread_id FROM memory_messages WHERE id IN (
           SELECT m.id FROM memory_messages m
           JOIN memory_threads t ON t.id = m.thread_id
           WHERE m.created_at < ? AND t.observer_frontier_at IS NOT NULL
             AND (m.created_at < t.observer_frontier_at OR
                  (m.created_at = t.observer_frontier_at AND m.id <= t.observer_frontier_id))
           ORDER BY m.created_at, m.id LIMIT ?
         )`,
      ).run(olderThanMs, limit);
      const res = db
        .prepare(
          `DELETE FROM memory_messages WHERE id IN (
             SELECT m.id FROM memory_messages m
             JOIN memory_threads t ON t.id = m.thread_id
             WHERE m.created_at < ? AND t.observer_frontier_at IS NOT NULL
               AND (m.created_at < t.observer_frontier_at OR
                    (m.created_at = t.observer_frontier_at AND m.id <= t.observer_frontier_id))
             ORDER BY m.created_at, m.id LIMIT ?
           )`,
        )
        .run(olderThanMs, limit);
      db.exec(`
        UPDATE memory_threads AS t
           SET message_count = (
                 SELECT COUNT(*) FROM memory_messages m WHERE m.thread_id = t.id
               ),
               last_message_at = (
                 SELECT MAX(m.created_at) FROM memory_messages m WHERE m.thread_id = t.id
               )
         WHERE t.id IN (SELECT thread_id FROM _helm_pruned_message_threads);
        DELETE FROM _helm_pruned_message_threads;
      `);
      return res.changes;
    });
    return runBatchedPrune(pruneBatch);
  }

  async pruneFinishedJobsOlderThan(olderThanMs: number): Promise<number> {
    const batch = this.db.$sqlite.prepare(`DELETE FROM memory_jobs WHERE id IN (
      SELECT id FROM memory_jobs
      WHERE status IN ('done', 'failed') AND updated_at < ?
      ORDER BY updated_at, id LIMIT ?
    )`);
    return runBatchedPrune((limit) => batch.run(olderThanMs, limit).changes);
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
  async getThreadMeta(input: { accountId: string; threadId: string }): Promise<{
    lastServedModel: string | null;
    messageCount: number;
    observationCount: number;
  } | null> {
    const row = this.db.$sqlite
      .prepare(
        `SELECT last_served_model AS last_served_model,
                message_count AS message_count,
                observation_count AS observation_count
           FROM memory_threads
          WHERE id = ? AND owner_id = ?`,
      )
      .get(input.threadId, input.accountId) as
      | { last_served_model: string | null; message_count: number; observation_count: number }
      | undefined;
    return row === undefined
      ? null
      : {
          lastServedModel: row.last_served_model,
          messageCount: row.message_count,
          observationCount: row.observation_count,
        };
  }

  async getObservationCount(scope: ReflectionScope): Promise<number> {
    const where = observationScopeWhere(scope);
    if (where === null) return 0;
    return (
      this.db
        .select({ n: sql<number>`count(*)` })
        .from(memoryObservations)
        .where(
          and(where, eq(memoryObservations.status, "active"), isNull(memoryObservations.expiredAt)),
        )
        .get()?.n ?? 0
    );
  }

  // Idle-flush sweep candidates: threads quiet since `idleBeforeMs` that still
  // have UNCOMPACTED history. Idleness = MAX(memory_messages.created_at) ≤
  // idleBeforeMs — the thread's last appended message, NOT memory_threads.
  // updated_at (ordinary turns append messages without touching the thread row,
  // so updated_at would mark an active thread idle and compact it mid-chat).
  // "Uncompacted" uses the SAME interval order as listMessages/Observer:
  // message_index first, then created_at/id as the legacy tie-break. This is
  // load-bearing: source_message_range is produced from observer order, so using
  // created_at/id alone can resurrect fully-covered historical rows as eternal
  // false candidates. project_id/resource_id ride along so the observer can
  // promote the resulting observation to the project/resource reflection.
  // Candidates are interleaved by owner+project+resource, so one stale project
  // backlog cannot monopolize the worker's small per-tick page. File-backed
  // databases run this global scan in a Worker so better-sqlite3 cannot block the
  // gateway event loop; in-memory test stores keep the same SQL inline.
  async listIdleFlushCandidates(input: {
    idleBeforeMs: number;
    idleAfterMs?: number;
    limit: number;
  }): Promise<
    Array<{ accountId: string; threadId: string; projectId?: string; resourceId?: string }>
  > {
    return listSqliteIdleFlushCandidates(this.db.$sqlite, input);
  }
}
