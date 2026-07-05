import { randomUUID } from "node:crypto";
import { type DecisionRecord, DecisionRecordSchema } from "@helm/shared";
import { and, asc, count, desc, eq, gt, gte, inArray, lt, type SQL, sql } from "drizzle-orm";
import { shapeTelemetryAggregate, shapeTelemetryKeyUsage } from "../aggregate-shape.js";
import { externalizeImages, type PayloadBlob, rehydrateImages } from "../payload-blobs.js";
import type {
  InsertPayloadInput,
  InsertTelemetryInput,
  RecentDecisionRecord,
  RequestPayload,
  RequestPayloadArchiveRow,
  TelemetryAggregate,
  TelemetryArchiveRow,
  TelemetryKeyUsage,
  TelemetryPage,
  TelemetryPageQuery,
  TelemetryStore,
} from "../ports.js";
import { likeContains } from "../sql-like.js";
import type { PgDb } from "./migrate.js";
import { payloadBlobs, requestPayloads, telemetry } from "./schema.js";

// Sentinel left in the slimmed text by externalizeImages; we scan for these to
// know which blobs a stored payload references, so we can pre-fetch them before
// the SYNCHRONOUS rehydrateImages walk (pg reads are async — rehydrate is not).
const BLOB_SHA_RE = /helm-blob:sha256:([0-9a-f]{64})/g;

// The write surface shared by the top-level PgDb handle and a transaction handle:
// both expose `insert(...)`. Typing writePayloadTx against this (not PgDb) lets it
// accept the `tx` drizzle hands the transaction callback (a PgTransaction, which
// lacks the PgDb `$close` lifecycle hook) without an unsound cast.
type PgWriter = Pick<PgDb, "insert">;

type TelemetryRow = typeof telemetry.$inferSelect;

// Postgres adapter for the TelemetryStore port — the supabase implementation.
// Same contract as SqliteTelemetryStore, but async and storing the redacted
// DecisionRecord as native jsonb. Denormalizes final_status/cost for querying.
// Stores api_key_id (key_id) only — never hash/plaintext. createdAt is epoch ms
// (bigint) so the half-open window comparison matches the sqlite adapter exactly.
export class PgTelemetryStore implements TelemetryStore {
  constructor(
    private readonly db: PgDb,
    private readonly genId: () => string = randomUUID,
  ) {}

  // Build one telemetry row (fresh id + denormalized status/cost). Shared by the
  // single and batch inserts so they can never drift. jsonb stored natively.
  private toRow(input: InsertTelemetryInput): typeof telemetry.$inferInsert {
    const finalCost = input.decision.provider_attempts.reduce<number | null>((acc, a) => {
      if (a.cost_usd === null) return acc;
      return (acc ?? 0) + a.cost_usd;
    }, null);
    const usage = input.decision.usage;
    return {
      id: this.genId(),
      requestId: input.decision.request_id,
      apiKeyId: input.apiKeyId,
      decisionJson: input.decision,
      finalStatus: input.decision.final.status,
      costUsd: finalCost,
      // Denormalized dashboard fields for cheap aggregation. NULL when the
      // gateway never stamped a field (forward-only / legacy rows).
      latencyTotalMs: input.decision.latency_total_ms,
      promptTokens: usage?.prompt_tokens ?? null,
      completionTokens: usage?.completion_tokens ?? null,
      cachedTokens: usage?.cached_tokens ?? null,
      cacheCreationTokens: usage?.cache_creation_tokens ?? null,
      servedModel: input.decision.final.provider_model ?? null,
      // Served-stream generation window (pg migration v24, true-TPS denominator).
      // NULL for non-streaming / un-stamped rows — they never count toward the rate.
      generationMs: input.decision.generation_ms ?? null,
      createdAt: input.createdAt.getTime(),
    };
  }

  async insert(input: InsertTelemetryInput): Promise<{ id: string }> {
    const row = this.toRow(input);
    await this.db.insert(telemetry).values(row);
    return { id: row.id };
  }

  // Batch insert (perf): ONE multi-row statement. Postgres is async/non-blocking,
  // so the win is one round-trip + one txn instead of N. Empty array is a no-op.
  async insertMany(inputs: InsertTelemetryInput[]): Promise<void> {
    if (inputs.length === 0) return;
    await this.db.insert(telemetry).values(inputs.map((input) => this.toRow(input)));
  }

  async queryRecent(limit: number): Promise<RecentDecisionRecord[]> {
    const rows = await this.db
      .select()
      .from(telemetry)
      .orderBy(desc(telemetry.createdAt))
      .limit(limit);
    // createdAt is stored as epoch ms (bigint) here — wrap it back to a Date so
    // the port contract matches the sqlite adapter exactly.
    return rows.map((r) => ({ record: this.toDecision(r), createdAt: new Date(r.createdAt) }));
  }

  // Filtered + paginated Debug list. `final_status` is the denormalized column;
  // `decided_by`/`lane`/`model` are read from native jsonb via the ->/->> path
  // operators. createdAt is epoch-ms bigint, so the window compares ms numbers
  // directly (matching the sqlite adapter's [startMs, endMs) semantics). Same WHERE
  // drives the page and the total so "Page X of Y" stays consistent.
  async queryPage(query: TelemetryPageQuery): Promise<TelemetryPage> {
    const where = this.pageWhere(query);
    const rows = await this.db
      .select()
      .from(telemetry)
      .where(where)
      .orderBy(desc(telemetry.createdAt))
      .limit(query.limit)
      .offset(query.offset);
    const totalRows = await this.db.select({ value: count() }).from(telemetry).where(where);
    return {
      rows: rows.map((r) => ({
        record: this.toDecision(r),
        createdAt: new Date(r.createdAt),
        apiKeyId: r.apiKeyId,
      })),
      total: totalRows[0]?.value ?? 0,
    };
  }

  // Shared WHERE for queryPage (rows + count). Undefined filters dropped; empty →
  // and() === undefined (no filter). ILIKE patterns are escaped (sql-like) so a
  // user-typed `%`/`_` is literal, not a wildcard.
  private pageWhere(query: TelemetryPageQuery): SQL | undefined {
    const conds: SQL[] = [];
    if (query.startMs !== undefined) conds.push(gte(telemetry.createdAt, query.startMs));
    if (query.endMs !== undefined) conds.push(lt(telemetry.createdAt, query.endMs));
    if (query.status !== undefined) conds.push(eq(telemetry.finalStatus, query.status));
    if (query.apiKeyId !== undefined) conds.push(eq(telemetry.apiKeyId, query.apiKeyId));
    // lane + decided_by hit the migration-v29 STORED generated columns (indexed)
    // instead of a jsonb extract — an index seek, no per-row jsonb scan.
    if (query.decidedBy !== undefined) conds.push(sql`decided_by = ${query.decidedBy}`);
    if (query.lane !== undefined) conds.push(sql`lane = ${query.lane}`);
    // Broad operator search: requested model, served alias, or selected
    // lane/channel. This backs the admin "Requested model / lane" box.
    if (query.model !== undefined) {
      const pat = likeContains(query.model);
      conds.push(
        sql`(${telemetry.decisionJson} ->> 'requested_model' ILIKE ${pat} ESCAPE '\\' OR ${telemetry.decisionJson} -> 'final' ->> 'model_alias' ILIKE ${pat} ESCAPE '\\' OR lane ILIKE ${pat} ESCAPE '\\')`,
      );
    }
    return and(...conds);
  }

  async getByRequestId(requestId: string): Promise<DecisionRecord | null> {
    const rows = await this.db
      .select()
      .from(telemetry)
      .where(eq(telemetry.requestId, requestId))
      .limit(1);
    const row = rows[0];
    return row ? this.toDecision(row) : null;
  }

  // Narrow single-column lookup of the recorded key_id (replay identity rebuild).
  // Selects only api_key_id so it never deserializes the decision blob.
  async getApiKeyId(requestId: string): Promise<string | null> {
    const rows = await this.db
      .select({ apiKeyId: telemetry.apiKeyId })
      .from(telemetry)
      .where(eq(telemetry.requestId, requestId))
      .limit(1);
    return rows[0]?.apiKeyId ?? null;
  }

  // Narrow single-column lookup of the recorded createdAt (detail header time).
  // Selects only created_at so it never deserializes the decision blob.
  async getCreatedAt(requestId: string): Promise<Date | null> {
    const rows = await this.db
      .select({ createdAt: telemetry.createdAt })
      .from(telemetry)
      .where(eq(telemetry.requestId, requestId))
      .limit(1);
    // createdAt is stored as epoch ms (bigint) here — wrap it back to a Date so
    // the port contract is identical across adapters.
    const ms = rows[0]?.createdAt;
    return ms === undefined ? null : new Date(ms);
  }

  // POST-MVP Agentic Signals (docs/02): records whose createdAt is in
  // [startMs, endMs). Half-open so adjacent windows never overlap → re-collects
  // stay idempotent. createdAt stored as epoch ms (bigint) → compare ms directly.
  async queryWindow(startMs: number, endMs: number): Promise<DecisionRecord[]> {
    const rows = await this.db
      .select()
      .from(telemetry)
      .where(and(gte(telemetry.createdAt, startMs), lt(telemetry.createdAt, endMs)))
      .orderBy(asc(telemetry.createdAt));
    return rows.map((r) => this.toDecision(r));
  }

  // Dashboard token-accounting aggregate — pg mirror of the sqlite adapter. Same
  // three SUM/COUNT/GROUP BY queries and the SAME integer-division bucketing (the
  // window size + tz offset are inlined via sql.raw so pg does bigint INTEGER
  // division, matching sqlite exactly — contract-tested). `tzOffsetMinutes` shifts
  // the floor into the client's LOCAL day/hour (shift-floor-unshift; dividend stays
  // positive so truncation == floor). createdAt is epoch-ms bigint (compared as
  // numbers, like queryWindow). avg latency reads the jsonb decision via ->> + cast.
  // pg SUM()/bucket exprs return bigint as STRING; the shared shaper coerces with
  // Number() and owns the (dialect-independent) ordering. Read-only.
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
      gte(telemetry.createdAt, startMs),
      lt(telemetry.createdAt, endMs),
      keyId !== undefined ? eq(telemetry.apiKeyId, keyId) : undefined,
    );
    const bucketMs = sql.raw(String(bucket === "hour" ? 3_600_000 : 86_400_000));
    const offset = sql.raw(`(${tzOffsetMinutes * 60_000})`);
    const bucketStart = sql<number>`((${telemetry.createdAt} + ${offset}) / ${bucketMs}) * ${bucketMs} - ${offset}`;

    const totalsRows = await this.db
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
        // True-TPS aggregate ratio inputs (mirror of the sqlite adapter). The CASE
        // restricts BOTH sums to streaming rows with a measured window so the rate is
        // never diluted by a non-streaming completion; the shaper divides them.
        tpsCompletionTokens: sql<number>`COALESCE(SUM(CASE WHEN ${telemetry.generationMs} > 0 THEN ${telemetry.completionTokens} ELSE 0 END), 0)`,
        tpsGenerationMs: sql<number>`COALESCE(SUM(CASE WHEN ${telemetry.generationMs} > 0 THEN ${telemetry.generationMs} ELSE 0 END), 0)`,
      })
      .from(telemetry)
      .where(where);

    const series = await this.db
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
      .groupBy(bucketStart);

    const byModel = await this.db
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
      .groupBy(telemetry.servedModel);

    return shapeTelemetryAggregate(totalsRows[0], series, byModel);
  }

  // Per-key usage rollup — pg mirror of the sqlite adapter. ONE GROUP BY api_key_id
  // over the denormalized columns; pg returns COUNT/SUM as STRINGS, so the shared
  // shaper coerces with Number() and owns the (requests desc) ordering. createdAt is
  // epoch-ms bigint, compared as numbers (matching the window semantics elsewhere).
  async usageByKey(startMs: number, endMs: number): Promise<TelemetryKeyUsage[]> {
    const rows = await this.db
      .select({
        apiKeyId: telemetry.apiKeyId,
        requests: count(),
        errorCount: sql<number>`SUM(CASE WHEN ${telemetry.finalStatus} = 'error' THEN 1 ELSE 0 END)`,
        totalCostUsd: sql<number | null>`SUM(${telemetry.costUsd})`,
        totalTokens: sql<number>`COALESCE(SUM(${telemetry.promptTokens}), 0) + COALESCE(SUM(${telemetry.completionTokens}), 0)`,
      })
      .from(telemetry)
      .where(and(gte(telemetry.createdAt, startMs), lt(telemetry.createdAt, endMs)))
      .groupBy(telemetry.apiKeyId);
    return shapeTelemetryKeyUsage(rows);
  }

  // ── Full-payload capture (verbatim client request + assembled response) ──────
  //
  // The base64 images Claude Code re-sends every turn were the bulk of the prod DB.
  // externalizeImages pulls each one into a content-addressed payload_blobs row
  // (deduped by sha256, deduped AGAIN across the three columns of a single row),
  // leaving only a sentinel in the stored text. getPayload reverses it, so the
  // admin view and the replay path (both read through getPayload) see the exact
  // original body. UNLIKE the sqlite adapter we do NOT gzip the slimmed text — pg's
  // TOAST auto-compresses large text values, so a manual gzip would be redundant
  // (and would defeat TOAST's own compression). The payload row + its blobs commit
  // atomically (a half-written row would fail to rehydrate). createdAt is epoch-ms
  // bigint to match the sqlite value space.

  // Externalize images out of one column, accumulating blobs (deduped across all
  // three columns of the row). NULL stays NULL. Returns the slimmed text.
  private externalizeColumn(s: string | null, blobs: Map<string, PayloadBlob>): string | null {
    if (s === null) return null;
    const ext = externalizeImages(s);
    for (const b of ext.blobs) if (!blobs.has(b.sha256)) blobs.set(b.sha256, b);
    return ext.json;
  }

  // Write one payload row + its blobs inside the given transaction handle. blobs
  // upsert by sha256, TOUCHING created_at on every reference so an in-use image
  // always outlives the same-cutoff prune that drops its referencing payload rows.
  private async writePayloadTx(tx: PgWriter, input: InsertPayloadInput): Promise<void> {
    const blobs = new Map<string, PayloadBlob>();
    const req = this.externalizeColumn(input.requestJson, blobs) ?? input.requestJson;
    const resp = this.externalizeColumn(input.responseJson, blobs);
    const up = this.externalizeColumn(input.upstreamRequestJson ?? null, blobs);
    const ts = input.createdAt.getTime();
    await tx
      .insert(requestPayloads)
      .values({
        requestId: input.requestId,
        requestJson: req,
        responseJson: resp,
        upstreamRequestJson: up,
        createdAt: ts,
      })
      .onConflictDoUpdate({
        target: requestPayloads.requestId,
        set: {
          requestJson: req,
          responseJson: resp,
          upstreamRequestJson: up,
          createdAt: ts,
        },
      });
    for (const b of blobs.values()) {
      await tx
        .insert(payloadBlobs)
        .values({
          sha256: b.sha256,
          bytes: Buffer.from(b.bytes),
          mime: b.mime,
          size: b.bytes.length,
          createdAt: ts,
        })
        .onConflictDoUpdate({ target: payloadBlobs.sha256, set: { createdAt: ts } });
    }
  }

  async insertPayload(input: InsertPayloadInput): Promise<void> {
    await this.db.transaction(async (tx) => this.writePayloadTx(tx, input));
  }

  // Batch payload upsert (perf): all rows in ONE transaction. Per-row upsert keeps
  // the conflict semantics identical to insertPayload. Empty array is a no-op.
  async insertPayloads(inputs: InsertPayloadInput[]): Promise<void> {
    if (inputs.length === 0) return;
    await this.db.transaction(async (tx) => {
      for (const input of inputs) await this.writePayloadTx(tx, input);
    });
  }

  // Restore the externalized images: scan the stored columns for blob sentinels,
  // pre-fetch the referenced bytes (one async query), then run the SYNCHRONOUS
  // rehydrate walk against that in-memory map. fail-open: a missing blob leaves the
  // sentinel in place (rehydrateImages keeps it) rather than throwing.
  private async rehydrateColumns(
    cols: Array<string | null>,
  ): Promise<(text: string | null) => string | null> {
    const shas = new Set<string>();
    for (const c of cols) {
      if (c === null) continue;
      for (const m of c.matchAll(BLOB_SHA_RE)) shas.add(m[1] as string);
    }
    const byteMap = new Map<string, Uint8Array>();
    if (shas.size > 0) {
      const rows = await this.db
        .select({ sha256: payloadBlobs.sha256, bytes: payloadBlobs.bytes })
        .from(payloadBlobs)
        .where(inArray(payloadBlobs.sha256, [...shas]));
      // pg/pglite return BYTEA as a Buffer (already a Uint8Array).
      for (const r of rows) byteMap.set(r.sha256, r.bytes);
    }
    const fetchBlob = (sha: string): Uint8Array | null => byteMap.get(sha) ?? null;
    return (text) => (text === null ? null : rehydrateImages(text, fetchBlob));
  }

  async getPayload(requestId: string): Promise<RequestPayload | null> {
    const rows = await this.db
      .select()
      .from(requestPayloads)
      .where(eq(requestPayloads.requestId, requestId))
      .limit(1);
    const row = rows[0];
    if (!row) return null;
    const decode = await this.rehydrateColumns([
      row.requestJson,
      row.responseJson,
      row.upstreamRequestJson,
    ]);
    return {
      requestId: row.requestId,
      requestJson: decode(row.requestJson) ?? "",
      responseJson: decode(row.responseJson),
      upstreamRequestJson: decode(row.upstreamRequestJson) ?? null,
      createdAt: new Date(row.createdAt), // epoch-ms bigint → Date
    };
  }

  // Retention auto-prune: drop rows strictly older than the cutoff (epoch ms), then
  // the same-cutoff blob prune. Safe because an in-use image's created_at is touched
  // on every referencing write, so blob.created_at >= every surviving payload's
  // created_at → a kept payload never references a pruned blob.
  async prunePayloads(olderThanMs: number): Promise<void> {
    await this.db.delete(requestPayloads).where(lt(requestPayloads.createdAt, olderThanMs));
    await this.db.delete(payloadBlobs).where(lt(payloadBlobs.createdAt, olderThanMs));
  }

  // Telemetry retention prune — the decision table's equivalent of prunePayloads
  // (it had none before). Strict lower bound on created_at (epoch ms).
  async pruneTelemetry(olderThanMs: number): Promise<number> {
    const rows = await this.db
      .delete(telemetry)
      .where(lt(telemetry.createdAt, olderThanMs))
      .returning();
    return rows.length;
  }

  async countTelemetryOlderThan(olderThanMs: number): Promise<number> {
    const rows = await this.db
      .select({ value: count() })
      .from(telemetry)
      .where(lt(telemetry.createdAt, olderThanMs));
    return rows[0]?.value ?? 0;
  }

  // Keyset page (id-ordered) of to-be-archived telemetry rows. createdAt is
  // already epoch-ms bigint here, so no Date conversion.
  async selectTelemetryOlderThan(
    olderThanMs: number,
    limit: number,
    afterId?: string,
  ): Promise<TelemetryArchiveRow[]> {
    const conds: SQL[] = [lt(telemetry.createdAt, olderThanMs)];
    if (afterId !== undefined) conds.push(gt(telemetry.id, afterId));
    const rows = await this.db
      .select()
      .from(telemetry)
      .where(and(...conds))
      .orderBy(asc(telemetry.id))
      .limit(limit);
    return rows.map((r) => ({
      id: r.id,
      requestId: r.requestId,
      apiKeyId: r.apiKeyId,
      createdAt: r.createdAt,
      decision: this.toDecision(r),
    }));
  }

  async countPayloadsOlderThan(olderThanMs: number): Promise<number> {
    const rows = await this.db
      .select({ value: count() })
      .from(requestPayloads)
      .where(lt(requestPayloads.createdAt, olderThanMs));
    return rows[0]?.value ?? 0;
  }

  // Keyset page of to-be-archived payloads (requestId is the primary key/cursor).
  async selectPayloadsOlderThan(
    olderThanMs: number,
    limit: number,
    afterId?: string,
  ): Promise<RequestPayloadArchiveRow[]> {
    const conds: SQL[] = [lt(requestPayloads.createdAt, olderThanMs)];
    if (afterId !== undefined) conds.push(gt(requestPayloads.requestId, afterId));
    const rows = await this.db
      .select()
      .from(requestPayloads)
      .where(and(...conds))
      .orderBy(asc(requestPayloads.requestId))
      .limit(limit);
    // Columns hold sentinels for externalized images — rehydrate each row back to
    // the verbatim original body for the archive (same as getPayload).
    const out: RequestPayloadArchiveRow[] = [];
    for (const r of rows) {
      const decode = await this.rehydrateColumns([
        r.requestJson,
        r.responseJson,
        r.upstreamRequestJson,
      ]);
      out.push({
        id: r.requestId,
        requestId: r.requestId,
        requestJson: decode(r.requestJson) ?? "",
        responseJson: decode(r.responseJson),
        upstreamRequestJson: decode(r.upstreamRequestJson) ?? null,
        createdAt: r.createdAt,
      });
    }
    return out;
  }

  // Row -> DecisionRecord. Re-validates through the shared schema so a corrupted
  // row surfaces loudly rather than leaking a malformed shape. jsonb is already
  // parsed by the driver — feed it straight to the schema.
  private toDecision(row: TelemetryRow): DecisionRecord {
    return DecisionRecordSchema.parse(row.decisionJson);
  }
}
