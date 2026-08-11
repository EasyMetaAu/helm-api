import { randomUUID } from "node:crypto";
import { type DecisionRecord, DecisionRecordSchema } from "@helm/shared";
import { and, asc, count, desc, eq, gt, gte, inArray, lt, lte, type SQL, sql } from "drizzle-orm";
import { shapeTelemetryAggregate, shapeTelemetryKeyUsage } from "../aggregate-shape.js";
import { externalizeImages, type PayloadBlob, rehydrateImages } from "../payload-blobs.js";
import {
  decodePayloadTextChunks,
  decodePayloadValue,
  encodePayloadText,
  iteratePayloadTextChunks,
} from "../payload-codec.js";
import type {
  InsertPayloadInput,
  InsertTelemetryInput,
  RecentDecisionRecord,
  RequestPayload,
  RequestPayloadArchiveRow,
  RequestPayloadMeta,
  RequestPayloadPart,
  RequestPayloadPartRecord,
  SessionContinuationRecord,
  SessionEventHead,
  SessionRecord,
  SessionRevisionMetaRecord,
  SessionRevisionPage,
  SessionRevisionPageOptions,
  SessionRevisionRecord,
  TelemetryAggregate,
  TelemetryArchiveRow,
  TelemetryKeyUsage,
  TelemetryPage,
  TelemetryPageQuery,
  TelemetryStore,
  UpsertSessionRevisionInput,
} from "../ports.js";
import { PERSISTED_SESSION_MAX_REVISIONS } from "../ports.js";
import { selectStreamingSessionRevisions } from "../session-page.js";
import { likeContains } from "../sql-like.js";
import { denormalizedDecisionCost } from "../telemetry-cost.js";
import { runBatchedPrune, yieldToEventLoop } from "./batched-prune.js";
import type { SqliteDb } from "./migrate.js";
import {
  requestPayloads,
  sessionHeadEventHashes,
  sessionRevisionBodyChunks,
  sessionRevisions,
  sessions,
  telemetry,
} from "./schema.js";

type TelemetryRow = typeof telemetry.$inferSelect;
type SessionRevisionRow = typeof sessionRevisions.$inferSelect;
type SessionBodyChunkRow = typeof sessionRevisionBodyChunks.$inferSelect;
type SessionBodyChunkInsert = typeof sessionRevisionBodyChunks.$inferInsert;
type SessionBodyPart = "request_delta" | "request_envelope" | "response";
const SESSION_PRUNE_MARKER = "__helm_pruning__";
const SESSION_CHUNKS_PER_WRITE = 4;
const sessionRevisionWireBytes = sql<number>`
  length(CAST(${sessionRevisions.sessionRef} AS BLOB)) +
  length(CAST(${sessionRevisions.requestId} AS BLOB)) +
  coalesce(length(CAST(${sessionRevisions.parentRequestId} AS BLOB)), 0) +
  coalesce(
    ${sessionRevisions.bodyBytes},
    length(CAST(${sessionRevisions.requestDeltaJson} AS BLOB)) +
    length(CAST(${sessionRevisions.requestEnvelopeJson} AS BLOB)) +
    coalesce(length(CAST(${sessionRevisions.responseJson} AS BLOB)), 0)
  ) +
  coalesce(length(CAST(${sessionRevisions.responseId} AS BLOB)), 0) +
  length(CAST(${sessionRevisions.fidelity} AS BLOB)) + 64
`;

function decodeSessionRevisionRow(
  row: SessionRevisionRow,
  chunks: readonly SessionBodyChunkRow[] = [],
): SessionRevisionRecord {
  const { bodyBytes: _, requestBodyGeneration: __, responseBodyGeneration: ___, ...revision } = row;
  const body = (part: SessionBodyPart): string | null => {
    const selected = chunks
      .filter(
        (chunk) =>
          chunk.part === part &&
          chunk.generation ===
            (part === "response" ? row.responseBodyGeneration : row.requestBodyGeneration),
      )
      .sort((left, right) => left.chunkIndex - right.chunkIndex);
    return selected.length === 0 ? null : decodePayloadTextChunks(selected);
  };
  const chunkedDelta = body("request_delta");
  const chunkedEnvelope = body("request_envelope");
  const chunkedResponse = body("response");
  return {
    ...revision,
    requestDeltaJson:
      row.requestBodyGeneration === null
        ? (decodePayloadValue(row.requestDeltaJson) ?? "")
        : (chunkedDelta ?? ""),
    requestEnvelopeJson:
      row.requestBodyGeneration === null
        ? (decodePayloadValue(row.requestEnvelopeJson) ?? "")
        : (chunkedEnvelope ?? ""),
    responseJson:
      row.responseBodyGeneration === null ? decodePayloadValue(row.responseJson) : chunkedResponse,
  };
}

function* sessionBodyRows(
  input: UpsertSessionRevisionInput,
  parts: readonly SessionBodyPart[],
  generation: string,
): Generator<SessionBodyChunkInsert> {
  const text = {
    request_delta: input.requestDeltaJson,
    request_envelope: input.requestEnvelopeJson,
    response: input.responseJson,
  } as const;
  for (const part of parts) {
    const value = text[part];
    if (value === null) continue;
    for (const chunk of iteratePayloadTextChunks(value)) {
      yield {
        requestId: input.requestId,
        generation,
        part,
        chunkIndex: chunk.chunkIndex,
        codec: chunk.codec,
        rawBytes: chunk.rawBytes,
        bytes: chunk.bytes,
        createdAt: input.createdAt.getTime(),
      };
    }
  }
}

function boundedSessionPageLimit(options: SessionRevisionPageOptions): number {
  if (!Number.isSafeInteger(options.limit) || options.limit <= 0)
    throw new Error("session revision page limit must be a positive integer");
  if (!Number.isSafeInteger(options.maxBytes) || options.maxBytes < 0)
    throw new Error("session revision page maxBytes must be a non-negative integer");
  if (
    options.afterSequence !== undefined &&
    (!Number.isSafeInteger(options.afterSequence) || options.afterSequence < 0)
  )
    throw new Error("session revision page cursor must be a non-negative integer");
  return Math.min(options.limit, 500);
}

// SQLite adapter for the TelemetryStore port. Persists a redacted DecisionRecord
// as JSON text (SQLite has no native jsonb); denormalizes final_status/cost for
// querying. Stores api_key_id (key_id) only — never hash/plaintext. The adapter
// does not redact (that happens upstream) but stores nothing that could recover
// a plaintext key. See docs/02.
export class SqliteTelemetryStore implements TelemetryStore {
  constructor(
    private readonly db: SqliteDb,
    private readonly genId: () => string = randomUUID,
  ) {}

  private sessionPreparedStmts:
    | ReturnType<SqliteTelemetryStore["buildSessionWriteStmts"]>
    | undefined;
  private readonly sessionPrunes = new Map<string, Promise<number>>();

  private async stageSessionBodyChunks(
    input: UpsertSessionRevisionInput,
    parts: readonly SessionBodyPart[],
  ): Promise<string> {
    const db = this.db.$sqlite;
    const generation = this.genId();
    const insert = db.prepare(`INSERT INTO session_revision_body_chunks
      (request_id, generation, part, chunk_index, codec, raw_bytes, bytes, created_at)
      VALUES (@requestId, @generation, @part, @chunkIndex, @codec, @rawBytes, @bytes, @createdAt)`);
    const writeBatch = db.transaction((rows: readonly SessionBodyChunkInsert[]) => {
      for (const row of rows) insert.run(row);
    });
    const batch: SessionBodyChunkInsert[] = [];
    for (const row of sessionBodyRows(input, parts, generation)) {
      batch.push(row);
      if (batch.length < SESSION_CHUNKS_PER_WRITE) continue;
      writeBatch(batch);
      batch.length = 0;
      await yieldToEventLoop();
    }
    if (batch.length > 0) writeBatch(batch);
    return generation;
  }

  private chunksByRevisions(
    rows: readonly SessionRevisionRow[],
  ): Map<string, SessionBodyChunkRow[]> {
    const grouped = new Map<string, SessionBodyChunkRow[]>();
    const requestIds = rows.map((row) => row.requestId);
    const generations = rows.flatMap((row) =>
      [row.requestBodyGeneration, row.responseBodyGeneration].filter(
        (generation): generation is string => generation !== null,
      ),
    );
    if (requestIds.length === 0 || generations.length === 0) return grouped;
    const chunks = this.db
      .select()
      .from(sessionRevisionBodyChunks)
      .where(
        and(
          inArray(sessionRevisionBodyChunks.requestId, requestIds),
          inArray(sessionRevisionBodyChunks.generation, generations),
        ),
      )
      .orderBy(
        asc(sessionRevisionBodyChunks.requestId),
        asc(sessionRevisionBodyChunks.part),
        asc(sessionRevisionBodyChunks.chunkIndex),
      )
      .all();
    for (const row of chunks) {
      const existing = grouped.get(row.requestId) ?? [];
      existing.push(row);
      grouped.set(row.requestId, existing);
    }
    return grouped;
  }

  private async finishClaimedSessionPrune(sessionRef: string): Promise<number> {
    const active = this.sessionPrunes.get(sessionRef);
    if (active) return active;
    const db = this.db.$sqlite;
    const work = (async () => {
      const chunks = db.prepare(`DELETE FROM session_revision_body_chunks WHERE request_id IN (
          SELECT request_id FROM session_revisions WHERE session_ref = ?
          ORDER BY sequence, request_id LIMIT ?
        )`);
      const revisions = db.prepare(`DELETE FROM session_revisions WHERE request_id IN (
          SELECT request_id FROM session_revisions WHERE session_ref = ?
          ORDER BY sequence, request_id LIMIT ?
        )`);
      const pruneBatch = db.transaction((limit: number) => {
        chunks.run(sessionRef, limit);
        return revisions.run(sessionRef, limit).changes;
      });
      await runBatchedPrune(pruneBatch);
      return db
        .prepare(
          "DELETE FROM sessions WHERE session_ref = ? AND head_request_id = ? AND NOT EXISTS (SELECT 1 FROM session_revisions WHERE session_ref = ?)",
        )
        .run(sessionRef, SESSION_PRUNE_MARKER, sessionRef).changes;
    })();
    this.sessionPrunes.set(sessionRef, work);
    try {
      return await work;
    } finally {
      if (this.sessionPrunes.get(sessionRef) === work) this.sessionPrunes.delete(sessionRef);
    }
  }

  private async waitForClaimedSessionPrune(sessionRef: string): Promise<boolean> {
    const active = this.sessionPrunes.get(sessionRef);
    if (active) {
      await active;
      return true;
    }
    const claimed = this.db.$sqlite
      .prepare("SELECT 1 FROM sessions WHERE session_ref = ? AND head_request_id = ?")
      .get(sessionRef, SESSION_PRUNE_MARKER);
    if (!claimed) return false;
    await this.finishClaimedSessionPrune(sessionRef);
    return true;
  }

  private buildSessionWriteStmts() {
    const db = this.db.$sqlite;
    return {
      insert: db.prepare(
        `INSERT INTO session_revisions
           (request_id, session_ref, sequence, parent_request_id, retain_count,
            request_delta_json, request_envelope_json, body_bytes,
            request_body_generation, response_body_generation,
            response_id, response_json, fidelity, created_at)
         VALUES
           (@requestId, @sessionRef, @sequence, @parentRequestId, @retainCount,
            @requestDeltaJson, @requestEnvelopeJson, @bodyBytes,
            @requestBodyGeneration, @responseBodyGeneration,
            @responseId, @responseJson, @fidelity, @createdAt)`,
      ),
      updateResponse: db.prepare(
        `UPDATE session_revisions
            SET response_id = @responseId,
                response_json = '',
                body_bytes = @bodyBytes,
                response_body_generation = @responseBodyGeneration,
                fidelity = @fidelity
          WHERE request_id = @requestId`,
      ),
    };
  }
  private sessionWriteStmts() {
    if (!this.sessionPreparedStmts) this.sessionPreparedStmts = this.buildSessionWriteStmts();
    return this.sessionPreparedStmts;
  }

  // Build one telemetry row (fresh id + denormalized status/cost). Shared by the
  // single and batch inserts so they can never drift.
  private toRow(input: InsertTelemetryInput): typeof telemetry.$inferInsert {
    const usage = input.decision.usage;
    return {
      id: this.genId(),
      requestId: input.decision.request_id,
      apiKeyId: input.apiKeyId,
      decisionJson: JSON.stringify(input.decision),
      finalStatus: input.decision.final.status,
      // The decision total includes BOTH Layer-2 eval and served-attempt spend.
      // Re-summing attempts here silently dropped eval_usd from every dashboard.
      costUsd: denormalizedDecisionCost(input.decision),
      // Denormalized dashboard fields for cheap aggregation. NULL when the
      // gateway never stamped a field (forward-only / legacy rows).
      latencyTotalMs: input.decision.latency_total_ms,
      promptTokens: usage?.prompt_tokens ?? null,
      completionTokens: usage?.completion_tokens ?? null,
      cachedTokens: usage?.cached_tokens ?? null,
      cacheCreationTokens: usage?.cache_creation_tokens ?? null,
      servedModel: input.decision.final.provider_model ?? null,
      // Served-stream generation window (migration v25, true-TPS denominator). NULL
      // for non-streaming / un-stamped rows — they never count toward the avg rate.
      generationMs: input.decision.generation_ms ?? null,
      createdAt: input.createdAt,
    };
  }

  async insert(input: InsertTelemetryInput): Promise<{ id: string }> {
    const row = this.toRow(input);
    this.db.insert(telemetry).values(row).run();
    return { id: row.id };
  }

  // Batch insert (perf): ONE multi-row statement = ONE commit on the synchronous
  // writer (vs N from a per-row loop). No conflict handling — telemetry rows are
  // append-only with unique ids.
  async insertMany(inputs: InsertTelemetryInput[]): Promise<void> {
    if (inputs.length === 0) return;
    this.db
      .insert(telemetry)
      .values(inputs.map((input) => this.toRow(input)))
      .run();
  }

  async upsertSessionRevision(input: UpsertSessionRevisionInput): Promise<void> {
    // A persisted marker makes a multi-batch prune crash-safe. Reactivation waits for
    // the expired capture to finish, then starts a fresh root instead of reviving a
    // partially deleted revision chain.
    let resumedAfterPrune = false;
    const at = input.createdAt;
    const atMs = at.getTime();
    const storedBytes = Buffer.byteLength(
      input.requestDeltaJson + input.requestEnvelopeJson + (input.responseJson ?? ""),
      "utf8",
    );
    for (;;) {
      resumedAfterPrune =
        (await this.waitForClaimedSessionPrune(input.sessionRef)) || resumedAfterPrune;
      const before = this.db
        .select({
          sessionRef: sessionRevisions.sessionRef,
          responseBodyStored: sql<number>`${sessionRevisions.responseJson} IS NOT NULL`,
        })
        .from(sessionRevisions)
        .where(eq(sessionRevisions.requestId, input.requestId))
        .get();
      if (before?.sessionRef !== undefined && before.sessionRef !== input.sessionRef)
        throw new Error("request session mismatch");
      if (before?.responseBodyStored || (before && input.responseJson === null)) return;
      const generation = await this.stageSessionBodyChunks(
        input,
        before
          ? ["response"]
          : input.responseJson === null
            ? ["request_delta", "request_envelope"]
            : ["request_delta", "request_envelope", "response"],
      );
      const admitted = this.db.$sqlite.transaction(() => {
        // The await above can yield after observing no claim. Recheck inside the
        // synchronous write transaction so a prune that claimed in that gap wins.
        const pruning = this.db.$sqlite
          .prepare("SELECT 1 FROM sessions WHERE session_ref = ? AND head_request_id = ?")
          .get(input.sessionRef, SESSION_PRUNE_MARKER);
        if (pruning) return false;
        this.db
          .insert(sessions)
          .values({
            sessionRef: input.sessionRef,
            accountId: input.accountId,
            apiKeyId: input.apiKeyId,
            source: input.source,
            externalSessionId: input.externalSessionId,
            createdAt: at,
            lastSeenAt: at,
          })
          .onConflictDoNothing()
          .run();

        const existing = this.db
          .select({
            requestId: sessionRevisions.requestId,
            sessionRef: sessionRevisions.sessionRef,
            responseBodyStored: sql<number>`${sessionRevisions.responseJson} IS NOT NULL`,
          })
          .from(sessionRevisions)
          .where(eq(sessionRevisions.requestId, input.requestId))
          .get();
        if (existing) {
          if (existing.sessionRef !== input.sessionRef) throw new Error("request session mismatch");
          const responseJson = input.responseJson;
          const responseBytes =
            responseJson !== null && !existing.responseBodyStored
              ? Buffer.byteLength(responseJson, "utf8")
              : 0;
          if (responseBytes === 0 || responseJson === null) return true;
          this.db
            .update(sessions)
            .set({
              storedBytes: sql`${sessions.storedBytes} + ${responseBytes}`,
              lastSeenAt: sql`max(${sessions.lastSeenAt}, ${atMs})`,
            })
            .where(eq(sessions.sessionRef, input.sessionRef))
            .run();
          this.sessionWriteStmts().updateResponse.run({
            requestId: input.requestId,
            responseId: input.responseId ?? null,
            bodyBytes: storedBytes,
            responseBodyGeneration: generation,
            fidelity: input.fidelity,
          });
          return true;
        }

        let parentRequestId = input.parentRequestId;
        if (parentRequestId !== null) {
          const parent = this.db
            .select({ sessionRef: sessionRevisions.sessionRef })
            .from(sessionRevisions)
            .where(eq(sessionRevisions.requestId, parentRequestId))
            .get();
          if ((!parent || parent.sessionRef !== input.sessionRef) && resumedAfterPrune) {
            parentRequestId = null;
          } else if (!parent || parent.sessionRef !== input.sessionRef) {
            throw new Error("session parent mismatch");
          }
        }

        const session = this.db
          .select({ revisionCount: sessions.revisionCount })
          .from(sessions)
          .where(eq(sessions.sessionRef, input.sessionRef))
          .get();
        if (!session) throw new Error("session row missing after insert");
        if (session.revisionCount >= PERSISTED_SESSION_MAX_REVISIONS) {
          throw new Error("session capture limit exceeded");
        }
        const sequence = session.revisionCount + 1;
        this.sessionWriteStmts().insert.run({
          requestId: input.requestId,
          sessionRef: input.sessionRef,
          sequence,
          parentRequestId,
          retainCount: input.retainCount,
          requestDeltaJson: "",
          requestEnvelopeJson: "",
          bodyBytes: storedBytes,
          requestBodyGeneration: generation,
          responseBodyGeneration: input.responseJson === null ? null : generation,
          responseId: input.responseId ?? null,
          responseJson: input.responseJson === null ? null : "",
          fidelity: input.fidelity,
          createdAt: atMs,
        });
        this.db
          .update(sessions)
          .set({
            headRequestId: input.requestId,
            revisionCount: sequence,
            storedBytes: sql`${sessions.storedBytes} + ${storedBytes}`,
            lastSeenAt: sql`max(${sessions.lastSeenAt}, ${atMs})`,
          })
          .where(eq(sessions.sessionRef, input.sessionRef))
          .run();
        if (input.eventHead) {
          this.db
            .insert(sessionHeadEventHashes)
            .values({
              sessionRef: input.sessionRef,
              requestId: input.requestId,
              ...input.eventHead,
            })
            .onConflictDoUpdate({
              target: sessionHeadEventHashes.sessionRef,
              set: { requestId: input.requestId, ...input.eventHead },
            })
            .run();
        } else {
          this.db
            .delete(sessionHeadEventHashes)
            .where(eq(sessionHeadEventHashes.sessionRef, input.sessionRef))
            .run();
        }
        return true;
      })();
      if (admitted) return;
      resumedAfterPrune = true;
      await this.finishClaimedSessionPrune(input.sessionRef);
    }
  }

  async getSessionByRef(sessionRef: string): Promise<SessionRecord | null> {
    const row = this.db.select().from(sessions).where(eq(sessions.sessionRef, sessionRef)).get();
    const head = row
      ? this.db
          .select()
          .from(sessionHeadEventHashes)
          .where(eq(sessionHeadEventHashes.sessionRef, sessionRef))
          .get()
      : undefined;
    return row
      ? {
          sessionRef: row.sessionRef,
          accountId: row.accountId,
          apiKeyId: row.apiKeyId,
          source: row.source,
          externalSessionId: row.externalSessionId,
          createdAt: row.createdAt,
          lastSeenAt: row.lastSeenAt,
          headRequestId: row.headRequestId,
          revisionCount: row.revisionCount,
          storedBytes: row.storedBytes,
          eventHead:
            head && head.requestId === row.headRequestId
              ? {
                  requestId: head.requestId,
                  eventKey: head.eventKey as SessionEventHead["eventKey"],
                  eventCount: head.eventCount,
                  eventHash: head.eventHash,
                }
              : null,
        }
      : null;
  }

  async listSessionsByRefs(sessionRefs: readonly string[]): Promise<SessionRecord[]> {
    if (sessionRefs.length === 0) return [];
    return this.db
      .select()
      .from(sessions)
      .where(inArray(sessions.sessionRef, [...sessionRefs]))
      .all()
      .map((row) => ({ ...row, eventHead: null }));
  }

  async listSessionRevisions(sessionRef: string): Promise<SessionRevisionRecord[]> {
    const rows = this.db
      .select()
      .from(sessionRevisions)
      .where(eq(sessionRevisions.sessionRef, sessionRef))
      .orderBy(asc(sessionRevisions.sequence))
      .all();
    const chunks = this.chunksByRevisions(rows);
    return rows.map((row) => decodeSessionRevisionRow(row, chunks.get(row.requestId)));
  }

  async listSessionRevisionsPage(
    sessionRef: string,
    options: SessionRevisionPageOptions,
  ): Promise<SessionRevisionPage> {
    const limit = boundedSessionPageLimit(options);
    const afterSequence = options.afterSequence ?? 0;
    const metadata = this.db
      .select({
        sequence: sessionRevisions.sequence,
        bytes: sessionRevisionWireBytes,
        legacyBinary: sql<number>`${sessionRevisions.bodyBytes} IS NULL AND (
          typeof(${sessionRevisions.requestDeltaJson}) = 'blob' OR
          typeof(${sessionRevisions.requestEnvelopeJson}) = 'blob' OR
          typeof(${sessionRevisions.responseJson}) = 'blob'
        )`,
      })
      .from(sessionRevisions)
      .where(
        and(
          eq(sessionRevisions.sessionRef, sessionRef),
          gt(sessionRevisions.sequence, afterSequence),
        ),
      )
      .orderBy(asc(sessionRevisions.sequence))
      .limit(limit + 1)
      .all();
    const selected: number[] = [];
    let usedBytes = 0;
    for (const row of metadata.slice(0, limit)) {
      const bytes = Number(row.bytes);
      if (
        row.legacyBinary ||
        !Number.isSafeInteger(bytes) ||
        bytes < 0 ||
        usedBytes + bytes > options.maxBytes
      ) {
        return { revisions: [], nextSequence: null, limited: true };
      }
      selected.push(row.sequence);
      usedBytes += bytes;
    }
    if (selected.length === 0) return { revisions: [], nextSequence: null, limited: false };
    const revisions = this.db
      .select()
      .from(sessionRevisions)
      .where(
        and(
          eq(sessionRevisions.sessionRef, sessionRef),
          inArray(sessionRevisions.sequence, selected),
        ),
      )
      .orderBy(asc(sessionRevisions.sequence))
      .all();
    const chunks = this.chunksByRevisions(revisions);
    return {
      revisions: revisions.map((row) => decodeSessionRevisionRow(row, chunks.get(row.requestId))),
      nextSequence: metadata.length > selected.length ? (selected.at(-1) ?? null) : null,
      limited: false,
    };
  }

  // Streaming variant for client-side rebuild: soft byte ceiling, always ≥1 row per
  // page, cursor always advances. See the port doc for why this differs from the
  // all-or-nothing listSessionRevisionsPage.
  async streamSessionRevisionsPage(
    sessionRef: string,
    options: SessionRevisionPageOptions,
  ): Promise<SessionRevisionPage> {
    const limit = boundedSessionPageLimit(options);
    const afterSequence = options.afterSequence ?? 0;
    const metadata = this.db
      .select({ sequence: sessionRevisions.sequence, bytes: sessionRevisionWireBytes })
      .from(sessionRevisions)
      .where(
        and(
          eq(sessionRevisions.sessionRef, sessionRef),
          gt(sessionRevisions.sequence, afterSequence),
        ),
      )
      .orderBy(asc(sessionRevisions.sequence))
      .limit(limit + 1)
      .all();
    const selected = selectStreamingSessionRevisions(metadata, limit, options.maxBytes);
    if (selected.length === 0) return { revisions: [], nextSequence: null, limited: false };
    const revisions = this.db
      .select()
      .from(sessionRevisions)
      .where(
        and(
          eq(sessionRevisions.sessionRef, sessionRef),
          inArray(sessionRevisions.sequence, selected),
        ),
      )
      .orderBy(asc(sessionRevisions.sequence))
      .all();
    const chunks = this.chunksByRevisions(revisions);
    // More rows remain iff the store held any sequence beyond the last one we returned.
    const lastSelected = selected.at(-1) ?? null;
    const hasMore = metadata.some((row) => row.sequence > (lastSelected ?? 0));
    return {
      revisions: revisions.map((row) => decodeSessionRevisionRow(row, chunks.get(row.requestId))),
      nextSequence: hasMore ? lastSelected : null,
      limited: false,
    };
  }

  async findSessionRequestIdByResponseId(
    sessionRef: string,
    responseId: string,
  ): Promise<SessionContinuationRecord | null> {
    const row = this.db
      .select({
        requestId: sessionRevisions.requestId,
        responseBodyStored: sql<number>`${sessionRevisions.responseJson} IS NOT NULL`,
      })
      .from(sessionRevisions)
      .where(
        and(
          eq(sessionRevisions.sessionRef, sessionRef),
          eq(sessionRevisions.responseId, responseId),
        ),
      )
      .get();
    return row
      ? { requestId: row.requestId, responseBodyStored: Boolean(row.responseBodyStored) }
      : null;
  }

  async getSessionRevisionMeta(requestId: string): Promise<SessionRevisionMetaRecord | null> {
    const row = this.db
      .select({
        requestId: sessionRevisions.requestId,
        sessionRef: sessionRevisions.sessionRef,
        responseBodyStored: sql<number>`${sessionRevisions.responseJson} IS NOT NULL`,
        sequence: sessionRevisions.sequence,
        fidelity: sessionRevisions.fidelity,
        createdAt: sessionRevisions.createdAt,
      })
      .from(sessionRevisions)
      .where(eq(sessionRevisions.requestId, requestId))
      .get();
    if (!row) return null;
    const recovery = this.db
      .select({
        bytes: sql<number | null>`CASE
          WHEN sum(CASE WHEN ${sessionRevisions.bodyBytes} IS NULL AND (
            typeof(${sessionRevisions.requestDeltaJson}) = 'blob' OR
            typeof(${sessionRevisions.requestEnvelopeJson}) = 'blob' OR
            typeof(${sessionRevisions.responseJson}) = 'blob'
          ) THEN 1 ELSE 0 END) > 0 THEN NULL
          ELSE sum(${sessionRevisionWireBytes})
        END`,
      })
      .from(sessionRevisions)
      .where(
        and(
          eq(sessionRevisions.sessionRef, row.sessionRef),
          lte(sessionRevisions.sequence, row.sequence),
        ),
      )
      .get();
    const recoveryWireBytes = Number(recovery?.bytes);
    return {
      requestId: row.requestId,
      sessionRef: row.sessionRef,
      responseBodyStored: Boolean(row.responseBodyStored),
      recoveryWireBytes:
        recovery?.bytes !== null &&
        Number.isSafeInteger(recoveryWireBytes) &&
        recoveryWireBytes >= 0
          ? recoveryWireBytes
          : null,
      fidelity: row.fidelity,
      createdAt: row.createdAt,
    };
  }

  async pruneInactiveSessions(olderThanMs: number): Promise<number> {
    const db = this.db.$sqlite;
    let deletedSessions = 0;
    for (;;) {
      const candidate = db
        .prepare(`SELECT session_ref AS sessionRef FROM sessions
          WHERE last_seen_at < ? ORDER BY last_seen_at, session_ref LIMIT 1`)
        .get(olderThanMs) as { sessionRef: string } | undefined;
      if (!candidate) break;
      const claimed = db
        .prepare(
          "UPDATE sessions SET head_request_id = ? WHERE session_ref = ? AND last_seen_at < ?",
        )
        .run(SESSION_PRUNE_MARKER, candidate.sessionRef, olderThanMs);
      if (claimed.changes === 0) continue;
      deletedSessions += await this.finishClaimedSessionPrune(candidate.sessionRef);
      await yieldToEventLoop();
    }
    const orphanChunks = db.prepare(`DELETE FROM session_revision_body_chunks WHERE rowid IN (
      SELECT chunks.rowid FROM session_revision_body_chunks AS chunks
      WHERE chunks.created_at < ? AND NOT EXISTS (
        SELECT 1 FROM session_revisions AS revisions
        WHERE revisions.request_id = chunks.request_id
          AND (
            (chunks.part = 'response' AND revisions.response_body_generation = chunks.generation)
            OR
            (chunks.part <> 'response' AND revisions.request_body_generation = chunks.generation)
          )
      )
      ORDER BY chunks.created_at, chunks.request_id, chunks.generation,
               chunks.part, chunks.chunk_index LIMIT ?
    )`);
    await runBatchedPrune((limit) => orphanChunks.run(Date.now() - 86_400_000, limit).changes);
    return deletedSessions;
  }

  async queryRecent(limit: number): Promise<RecentDecisionRecord[]> {
    return this.db
      .select()
      .from(telemetry)
      .orderBy(desc(telemetry.createdAt))
      .limit(limit)
      .all()
      .map((r) => ({ record: this.toDecision(r), createdAt: r.createdAt }));
  }

  // Filtered + paginated Debug list. `final_status` is the denormalized column;
  // `decided_by`/`lane`/`model` are pulled from the JSON-TEXT blob via json_extract
  // (no native jsonb in SQLite). Same WHERE drives both the page and the total, so
  // "Page X of Y" stays consistent with the rows shown.
  async queryPage(query: TelemetryPageQuery): Promise<TelemetryPage> {
    const where = this.pageWhere(query);
    const rows = this.db
      .select()
      .from(telemetry)
      .where(where)
      .orderBy(desc(telemetry.createdAt))
      .limit(query.limit)
      .offset(query.offset)
      .all()
      .map((r) => ({ record: this.toDecision(r), createdAt: r.createdAt, apiKeyId: r.apiKeyId }));
    const totalRow = this.db.select({ value: count() }).from(telemetry).where(where).get();
    return { rows, total: totalRow?.value ?? 0 };
  }

  // Build the shared WHERE for queryPage (rows + count). Undefined filters are
  // dropped; an empty list yields `and()` === undefined (no filter). LIKE matches
  // are escaped (sql-like) so a user-typed `%` is a literal, not a wildcard.
  private pageWhere(query: TelemetryPageQuery): SQL | undefined {
    const conds: SQL[] = [];
    if (query.startMs !== undefined) conds.push(gte(telemetry.createdAt, new Date(query.startMs)));
    if (query.endMs !== undefined) conds.push(lt(telemetry.createdAt, new Date(query.endMs)));
    if (query.status !== undefined) conds.push(eq(telemetry.finalStatus, query.status));
    if (query.apiKeyId !== undefined) conds.push(eq(telemetry.apiKeyId, query.apiKeyId));
    if (query.sessionRef !== undefined)
      conds.push(
        sql`json_extract(${telemetry.decisionJson}, '$.session.ref') = ${query.sessionRef}`,
      );
    // lane + decided_by hit the migration-v30 generated columns (indexed) instead
    // of json_extract — an index seek, no per-row JSON parse.
    if (query.decidedBy !== undefined) conds.push(sql`decided_by = ${query.decidedBy}`);
    if (query.lane !== undefined) conds.push(sql`lane = ${query.lane}`);
    // Broad operator search: requested model, served alias, or selected
    // lane/channel. `model_search` is a generated lowercase concat indexed by the
    // admin migrations, so wide windows scan a small index value instead of
    // parsing decision_json for every candidate row.
    if (query.model !== undefined) {
      const pat = likeContains(query.model.toLowerCase());
      conds.push(sql`model_search LIKE ${pat} ESCAPE '\\'`);
    }
    return and(...conds);
  }

  async getByRequestId(requestId: string): Promise<DecisionRecord | null> {
    const row = this.db.select().from(telemetry).where(eq(telemetry.requestId, requestId)).get();
    return row ? this.toDecision(row) : null;
  }

  // Narrow single-column lookup of the recorded key_id (replay identity rebuild).
  // Selects only api_key_id so it never deserializes the decision blob.
  async getApiKeyId(requestId: string): Promise<string | null> {
    const row = this.db
      .select({ apiKeyId: telemetry.apiKeyId })
      .from(telemetry)
      .where(eq(telemetry.requestId, requestId))
      .get();
    return row?.apiKeyId ?? null;
  }

  // Narrow single-column lookup of the recorded createdAt (detail header time).
  // Selects only created_at so it never deserializes the decision blob.
  async getCreatedAt(requestId: string): Promise<Date | null> {
    const row = this.db
      .select({ createdAt: telemetry.createdAt })
      .from(telemetry)
      .where(eq(telemetry.requestId, requestId))
      .get();
    return row?.createdAt ?? null;
  }

  // POST-MVP Agentic Signals (docs/02): records whose createdAt is in
  // [startMs, endMs). Half-open so adjacent windows never overlap → the
  // background collector's re-runs stay idempotent. Read-only; never on the
  // request path. createdAt is stored as epoch-ms (timestamp_ms) → compare ms.
  async queryWindow(startMs: number, endMs: number): Promise<DecisionRecord[]> {
    return this.db
      .select()
      .from(telemetry)
      .where(
        and(gte(telemetry.createdAt, new Date(startMs)), lt(telemetry.createdAt, new Date(endMs))),
      )
      .orderBy(asc(telemetry.createdAt))
      .all()
      .map((r) => this.toDecision(r));
  }

  async countWindow(startMs: number, endMs: number): Promise<number> {
    return (
      this.db
        .select({ n: sql<number>`count(*)` })
        .from(telemetry)
        .where(
          and(
            gte(telemetry.createdAt, new Date(startMs)),
            lt(telemetry.createdAt, new Date(endMs)),
          ),
        )
        .get()?.n ?? 0
    );
  }

  // Dashboard token-accounting aggregate (admin homepage). THREE SQL queries —
  // headline totals, a per-bucket time series, a per-served-model breakdown — all
  // SUM/COUNT/GROUP BY over the denormalized token columns (never row-by-row JS).
  // Token sums are COALESCE'd to 0; cost/latency stay nullable (honest "not
  // measured"). Bucketing is integer division on epoch-ms with the window size +
  // tz offset INLINED via sql.raw (so both dialects do INTEGER division — a bound JS
  // number could be typed float in pg and break the bucket floor). `tzOffsetMinutes`
  // shifts the floor into the client's LOCAL day/hour (shift-floor-unshift): the
  // dividend `createdAt + offsetMs` stays positive for every real timestamp, so
  // sqlite/pg truncation == floor. Ordering is done in the shared shaper (JS) so it
  // can't drift between sqlite and pg. Read-only.
  async aggregate(
    startMs: number,
    endMs: number,
    bucket: "hour" | "day",
    tzOffsetMinutes = 0,
    keyId?: string,
  ): Promise<TelemetryAggregate> {
    // Optional per-key scope (detail page): the same window WHERE, plus an
    // api_key_id equality when keyId is given. `and()` drops the undefined arm, so
    // the global dashboard path is byte-identical to before.
    const where = and(
      gte(telemetry.createdAt, new Date(startMs)),
      lt(telemetry.createdAt, new Date(endMs)),
      keyId !== undefined ? eq(telemetry.apiKeyId, keyId) : undefined,
    );
    const bucketMs = sql.raw(String(bucket === "hour" ? 3_600_000 : 86_400_000));
    const offset = sql.raw(`(${tzOffsetMinutes * 60_000})`);
    const bucketStart = sql<number>`((${telemetry.createdAt} + ${offset}) / ${bucketMs}) * ${bucketMs} - ${offset}`;

    const totals = this.db
      .select({
        requests: count(),
        okCount: sql<number>`SUM(CASE WHEN ${telemetry.finalStatus} = 'ok' THEN 1 ELSE 0 END)`,
        errorCount: sql<number>`SUM(CASE WHEN ${telemetry.finalStatus} = 'error' THEN 1 ELSE 0 END)`,
        totalCostUsd: sql<number | null>`SUM(${telemetry.costUsd})`,
        promptTokens: sql<number>`COALESCE(SUM(${telemetry.promptTokens}), 0)`,
        completionTokens: sql<number>`COALESCE(SUM(${telemetry.completionTokens}), 0)`,
        cachedTokens: sql<number>`COALESCE(SUM(${telemetry.cachedTokens}), 0)`,
        cacheCreationTokens: sql<number>`COALESCE(SUM(${telemetry.cacheCreationTokens}), 0)`,
        avgLatencyMs: sql<number | null>`AVG(${telemetry.latencyTotalMs})`,
        // True-TPS aggregate ratio inputs. The CASE keeps numerator + denominator on
        // the SAME rows (streaming rows with a measured window, generation_ms > 0), so
        // a non-streaming completion never inflates the rate. The shaper divides them.
        tpsCompletionTokens: sql<number>`COALESCE(SUM(CASE WHEN ${telemetry.generationMs} > 0 THEN ${telemetry.completionTokens} ELSE 0 END), 0)`,
        tpsGenerationMs: sql<number>`COALESCE(SUM(CASE WHEN ${telemetry.generationMs} > 0 THEN ${telemetry.generationMs} ELSE 0 END), 0)`,
      })
      .from(telemetry)
      .where(where)
      .get();

    const series = this.db
      .select({
        bucketStartMs: bucketStart,
        requests: count(),
        promptTokens: sql<number>`COALESCE(SUM(${telemetry.promptTokens}), 0)`,
        completionTokens: sql<number>`COALESCE(SUM(${telemetry.completionTokens}), 0)`,
        cachedTokens: sql<number>`COALESCE(SUM(${telemetry.cachedTokens}), 0)`,
        cacheCreationTokens: sql<number>`COALESCE(SUM(${telemetry.cacheCreationTokens}), 0)`,
        totalCostUsd: sql<number | null>`SUM(${telemetry.costUsd})`,
      })
      .from(telemetry)
      .where(where)
      .groupBy(bucketStart)
      .all();

    const byModel = this.db
      .select({
        servedModel: telemetry.servedModel,
        requests: count(),
        promptTokens: sql<number>`COALESCE(SUM(${telemetry.promptTokens}), 0)`,
        completionTokens: sql<number>`COALESCE(SUM(${telemetry.completionTokens}), 0)`,
        totalTokens: sql<number>`COALESCE(SUM(${telemetry.promptTokens}), 0) + COALESCE(SUM(${telemetry.completionTokens}), 0)`,
        totalCostUsd: sql<number | null>`SUM(${telemetry.costUsd})`,
      })
      .from(telemetry)
      .where(where)
      .groupBy(telemetry.servedModel)
      .all();

    return shapeTelemetryAggregate(totals, series, byModel);
  }

  // Per-key usage rollup (the /admin/keys list "Usage" column). ONE GROUP BY
  // api_key_id over the denormalized columns — the whole list in a single query, no
  // N+1. COUNT/SUM with COALESCE'd token sums (empty = real 0); cost stays nullable
  // (no priced row → "not measured", distinct from a measured 0). The shared shaper
  // coerces + sorts (requests desc) so the order is identical to the pg adapter.
  async usageByKey(startMs: number, endMs: number): Promise<TelemetryKeyUsage[]> {
    const rows = this.db
      .select({
        apiKeyId: telemetry.apiKeyId,
        requests: count(),
        errorCount: sql<number>`SUM(CASE WHEN ${telemetry.finalStatus} = 'error' THEN 1 ELSE 0 END)`,
        totalCostUsd: sql<number | null>`SUM(${telemetry.costUsd})`,
        totalTokens: sql<number>`COALESCE(SUM(${telemetry.promptTokens}), 0) + COALESCE(SUM(${telemetry.completionTokens}), 0)`,
      })
      .from(telemetry)
      .where(
        and(gte(telemetry.createdAt, new Date(startMs)), lt(telemetry.createdAt, new Date(endMs))),
      )
      .groupBy(telemetry.apiKeyId)
      .all();
    return shapeTelemetryKeyUsage(rows);
  }

  // ── Full-payload capture (verbatim client request + assembled response) ──────
  //
  // Two transforms keep what was 6-7 MB/row (the prod 14 GB) small WITHOUT losing
  // any fidelity — getPayload reverses both, so the admin view and the replay path
  // (which both read through getPayload) see the exact original body:
  //   1. externalizeImages → base64 images become content-addressed payload_blobs
  //      rows, deduped by sha256 (Claude Code re-sends the same image every turn).
  //      Each blob's created_at is TOUCHED on every write so an in-use image always
  //      outlives the same-cutoff prune that drops its referencing payload rows.
  //   2. encodePayloadText → gzip the remaining (image-stripped) JSON text.
  // Stored via raw SQL because the gzip bytes are a BLOB in a TEXT-affinity column
  // (legacy rows stay TEXT and read back verbatim — see payload-codec.ts). Upsert
  // by request_id: the stream path writes the request first, then backfills.
  private preparedStmts: ReturnType<SqliteTelemetryStore["buildPayloadStmts"]> | undefined;
  private buildPayloadStmts() {
    const db = this.db.$sqlite;
    return {
      put: db.prepare(
        `INSERT INTO request_payloads (request_id, request_json, response_json, upstream_request_json, created_at)
         VALUES (@id, @req, @resp, @up, @ts)
         ON CONFLICT(request_id) DO UPDATE SET
           request_json = excluded.request_json,
           response_json = excluded.response_json,
           upstream_request_json = excluded.upstream_request_json,
           created_at = excluded.created_at`,
      ),
      putBlob: db.prepare(
        `INSERT INTO payload_blobs (sha256, bytes, mime, size, created_at)
         VALUES (@sha, @bytes, @mime, @size, @ts)
         ON CONFLICT(sha256) DO UPDATE SET created_at = excluded.created_at`,
      ),
      get: db.prepare(
        `SELECT request_json AS req, response_json AS resp, upstream_request_json AS up, created_at AS ts
         FROM request_payloads WHERE request_id = ?`,
      ),
      getMeta: db.prepare(
        `SELECT
           request_id AS id,
           request_json IS NOT NULL AS hasReq,
           response_json IS NOT NULL AS hasResp,
           upstream_request_json IS NOT NULL AS hasUp,
           created_at AS ts
         FROM request_payloads WHERE request_id = ?`,
      ),
      getRequestPart: db.prepare(
        `SELECT request_id AS id, request_json AS value, created_at AS ts
         FROM request_payloads WHERE request_id = ?`,
      ),
      getResponsePart: db.prepare(
        `SELECT request_id AS id, response_json AS value, created_at AS ts
         FROM request_payloads WHERE request_id = ?`,
      ),
      getUpstreamPart: db.prepare(
        `SELECT request_id AS id, upstream_request_json AS value, created_at AS ts
         FROM request_payloads WHERE request_id = ?`,
      ),
      getBlob: db.prepare("SELECT bytes FROM payload_blobs WHERE sha256 = ?"),
    };
  }
  private stmts() {
    if (!this.preparedStmts) this.preparedStmts = this.buildPayloadStmts();
    return this.preparedStmts;
  }

  // Externalize images out of one column, accumulating blobs (deduped across all
  // three columns of the row), then gzip the slimmed text. NULL stays NULL.
  private encodeColumn(s: string | null, blobs: Map<string, PayloadBlob>): Buffer | null {
    if (s === null) return null;
    const ext = externalizeImages(s);
    for (const b of ext.blobs) if (!blobs.has(b.sha256)) blobs.set(b.sha256, b);
    return encodePayloadText(ext.json);
  }

  // gunzip (if gzipped) then restore externalized images. Reused by getPayload and
  // the archive scan so both yield the verbatim original body.
  private decodeColumn = (v: unknown): string | null => {
    const text = decodePayloadValue(v);
    return text === null ? null : rehydrateImages(text, this.fetchBlob);
  };

  private fetchBlob = (sha: string): Uint8Array | null => {
    const r = this.stmts().getBlob.get(sha) as { bytes: Buffer } | undefined;
    return r?.bytes ?? null;
  };

  private writePayloadRaw(input: InsertPayloadInput): void {
    const blobs = new Map<string, PayloadBlob>();
    const req = this.encodeColumn(input.requestJson, blobs);
    const resp = this.encodeColumn(input.responseJson, blobs);
    const up = this.encodeColumn(input.upstreamRequestJson ?? null, blobs);
    const ts = input.createdAt.getTime();
    this.stmts().put.run({ id: input.requestId, req, resp, up, ts });
    for (const b of blobs.values()) {
      this.stmts().putBlob.run({
        sha: b.sha256,
        bytes: Buffer.from(b.bytes),
        mime: b.mime,
        size: b.bytes.length,
        ts,
      });
    }
  }

  async insertPayload(input: InsertPayloadInput): Promise<void> {
    // Payload row + its blobs commit atomically (a half-written row would fail to
    // rehydrate). better-sqlite3 nests via savepoints, so this is safe inside the
    // batch transaction below too.
    this.db.$sqlite.transaction(() => this.writePayloadRaw(input))();
  }

  // Batch payload upsert (perf): all rows in ONE transaction = ONE commit.
  async insertPayloads(inputs: InsertPayloadInput[]): Promise<void> {
    if (inputs.length === 0) return;
    this.db.$sqlite.transaction(() => {
      for (const input of inputs) this.writePayloadRaw(input);
    })();
  }

  async getPayload(requestId: string): Promise<RequestPayload | null> {
    const row = this.stmts().get.get(requestId) as
      | { req: unknown; resp: unknown; up: unknown; ts: number }
      | undefined;
    if (!row) return null;
    return {
      requestId,
      requestJson: this.decodeColumn(row.req) ?? "",
      responseJson: this.decodeColumn(row.resp),
      upstreamRequestJson: this.decodeColumn(row.up),
      createdAt: new Date(row.ts),
    };
  }

  async getPayloadMeta(requestId: string): Promise<RequestPayloadMeta | null> {
    const row = this.stmts().getMeta.get(requestId) as
      | { id: string; hasReq: number; hasResp: number; hasUp: number; ts: number }
      | undefined;
    if (!row) return null;
    return {
      requestId: row.id,
      createdAt: new Date(row.ts),
      parts: {
        request: row.hasReq === 1,
        response: row.hasResp === 1,
        upstreamRequest: row.hasUp === 1,
      },
    };
  }

  async getPayloadPart(
    requestId: string,
    part: RequestPayloadPart,
  ): Promise<RequestPayloadPartRecord | null> {
    const stmt =
      part === "request"
        ? this.stmts().getRequestPart
        : part === "response"
          ? this.stmts().getResponsePart
          : this.stmts().getUpstreamPart;
    const row = stmt.get(requestId) as { id: string; value: unknown; ts: number } | undefined;
    if (!row) return null;
    return {
      requestId: row.id,
      part,
      json: this.decodeColumn(row.value),
      createdAt: new Date(row.ts),
    };
  }

  // Retention auto-prune: drop rows strictly older than the cutoff. The
  // created_at index keeps this cheap enough to call opportunistically.
  async prunePayloads(olderThanMs: number): Promise<void> {
    const db = this.db.$sqlite;
    const payloadBatch = db.prepare(`DELETE FROM request_payloads WHERE request_id IN (
      SELECT request_id FROM request_payloads WHERE created_at < ?
      ORDER BY created_at, request_id LIMIT ?
    )`);
    await runBatchedPrune((limit) => payloadBatch.run(olderThanMs, limit).changes);
    // Same-cutoff blob prune. Safe because an in-use image's created_at is touched
    // on every referencing write, so blob.created_at >= every surviving payload's
    // created_at → a kept payload never references a pruned blob.
    const blobBatch = db.prepare(`DELETE FROM payload_blobs WHERE sha256 IN (
      SELECT sha256 FROM payload_blobs WHERE created_at < ?
      ORDER BY created_at, sha256 LIMIT ?
    )`);
    await runBatchedPrune((limit) => blobBatch.run(olderThanMs, limit).changes);
  }

  // Telemetry retention prune — the decision table's equivalent of prunePayloads
  // (it had none before, hence unbounded growth). Strict lower bound on created_at.
  async pruneTelemetry(olderThanMs: number): Promise<number> {
    const batch = this.db.$sqlite.prepare(`DELETE FROM telemetry WHERE id IN (
      SELECT id FROM telemetry WHERE created_at < ? ORDER BY created_at, id LIMIT ?
    )`);
    return runBatchedPrune((limit) => batch.run(olderThanMs, limit).changes);
  }

  async countTelemetryOlderThan(olderThanMs: number): Promise<number> {
    const row = this.db
      .select({ value: count() })
      .from(telemetry)
      .where(lt(telemetry.createdAt, new Date(olderThanMs)))
      .get();
    return row?.value ?? 0;
  }

  // Keyset page (id-ordered) of to-be-archived telemetry rows. `afterId` is the
  // previous page's last id; excludes rows up to and including it.
  async selectTelemetryOlderThan(
    olderThanMs: number,
    limit: number,
    afterId?: string,
  ): Promise<TelemetryArchiveRow[]> {
    const conds: SQL[] = [lt(telemetry.createdAt, new Date(olderThanMs))];
    if (afterId !== undefined) conds.push(gt(telemetry.id, afterId));
    return this.db
      .select()
      .from(telemetry)
      .where(and(...conds))
      .orderBy(asc(telemetry.id))
      .limit(limit)
      .all()
      .map((r) => ({
        id: r.id,
        requestId: r.requestId,
        apiKeyId: r.apiKeyId,
        createdAt: r.createdAt.getTime(),
        decision: this.toDecision(r),
      }));
  }

  async countPayloadsOlderThan(olderThanMs: number): Promise<number> {
    const row = this.db
      .select({ value: count() })
      .from(requestPayloads)
      .where(lt(requestPayloads.createdAt, new Date(olderThanMs)))
      .get();
    return row?.value ?? 0;
  }

  // Keyset page of to-be-archived payloads. request_payloads' primary key is
  // requestId, so that doubles as the stable archive cursor.
  async selectPayloadsOlderThan(
    olderThanMs: number,
    limit: number,
    afterId?: string,
  ): Promise<RequestPayloadArchiveRow[]> {
    const conds: SQL[] = [lt(requestPayloads.createdAt, new Date(olderThanMs))];
    if (afterId !== undefined) conds.push(gt(requestPayloads.requestId, afterId));
    return this.db
      .select()
      .from(requestPayloads)
      .where(and(...conds))
      .orderBy(asc(requestPayloads.requestId))
      .limit(limit)
      .all()
      .map((r) => ({
        id: r.requestId,
        requestId: r.requestId,
        // Columns may be gzip BLOBs with externalized images (new rows) or verbatim
        // TEXT (legacy) — decode both back to the original body for the archive.
        requestJson: this.decodeColumn(r.requestJson) ?? "",
        responseJson: this.decodeColumn(r.responseJson),
        upstreamRequestJson: this.decodeColumn(r.upstreamRequestJson ?? null),
        createdAt: r.createdAt.getTime(),
      }));
  }

  // Row -> DecisionRecord. Re-validates through the shared schema so a corrupted
  // row surfaces loudly rather than leaking a malformed shape.
  private toDecision(row: TelemetryRow): DecisionRecord {
    return DecisionRecordSchema.parse(JSON.parse(row.decisionJson));
  }
}
