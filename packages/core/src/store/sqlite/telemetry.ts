import { randomUUID } from "node:crypto";
import { type DecisionRecord, DecisionRecordSchema } from "@helm/shared";
import { and, asc, count, desc, eq, gt, gte, lt, type SQL, sql } from "drizzle-orm";
import { shapeTelemetryAggregate, shapeTelemetryKeyUsage } from "../aggregate-shape.js";
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
import type { SqliteDb } from "./migrate.js";
import { requestPayloads, telemetry } from "./schema.js";

type TelemetryRow = typeof telemetry.$inferSelect;

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

  // Build one telemetry row (fresh id + denormalized status/cost). Shared by the
  // single and batch inserts so they can never drift.
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
      decisionJson: JSON.stringify(input.decision),
      finalStatus: input.decision.final.status,
      costUsd: finalCost,
      // Denormalized token counts + served model (migration v22) for cheap
      // aggregation. NULL when the gateway never stamped usage (forward-only).
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
    if (query.decidedBy !== undefined) {
      conds.push(
        sql`json_extract(${telemetry.decisionJson}, '$.classifier.decided_by') = ${query.decidedBy}`,
      );
    }
    if (query.lane !== undefined) {
      conds.push(
        sql`json_extract(${telemetry.decisionJson}, '$.lane.selected_lane') = ${query.lane}`,
      );
    }
    if (query.model !== undefined) {
      const pat = likeContains(query.model);
      conds.push(
        sql`(json_extract(${telemetry.decisionJson}, '$.requested_model') LIKE ${pat} ESCAPE '\\' OR json_extract(${telemetry.decisionJson}, '$.final.model_alias') LIKE ${pat} ESCAPE '\\')`,
      );
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
        avgLatencyMs: sql<
          number | null
        >`AVG(json_extract(${telemetry.decisionJson}, '$.latency_total_ms'))`,
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

  // Full-payload capture. Upsert by request_id so the stream path can write the
  // request first then backfill the assembled response. Verbatim bytes — no
  // redaction (the table holds no plaintext key; see schema/ports comments).
  // Upsert one payload row (request first, then response backfill — same key).
  private upsertPayload(input: InsertPayloadInput): void {
    this.db
      .insert(requestPayloads)
      .values({
        requestId: input.requestId,
        requestJson: input.requestJson,
        responseJson: input.responseJson,
        upstreamRequestJson: input.upstreamRequestJson ?? null,
        createdAt: input.createdAt,
      })
      .onConflictDoUpdate({
        target: requestPayloads.requestId,
        set: {
          requestJson: input.requestJson,
          responseJson: input.responseJson,
          upstreamRequestJson: input.upstreamRequestJson ?? null,
          createdAt: input.createdAt,
        },
      })
      .run();
  }

  async insertPayload(input: InsertPayloadInput): Promise<void> {
    this.upsertPayload(input);
  }

  // Batch payload upsert (perf): all rows in ONE transaction = ONE commit. Reuses
  // the single-row upsert so the per-row conflict semantics are identical.
  async insertPayloads(inputs: InsertPayloadInput[]): Promise<void> {
    if (inputs.length === 0) return;
    const run = this.db.$sqlite.transaction(() => {
      for (const input of inputs) this.upsertPayload(input);
    });
    run();
  }

  async getPayload(requestId: string): Promise<RequestPayload | null> {
    const row = this.db
      .select()
      .from(requestPayloads)
      .where(eq(requestPayloads.requestId, requestId))
      .get();
    if (!row) return null;
    return {
      requestId: row.requestId,
      requestJson: row.requestJson,
      responseJson: row.responseJson,
      upstreamRequestJson: row.upstreamRequestJson ?? null,
      createdAt: row.createdAt, // timestamp_ms mode → Date
    };
  }

  // Retention auto-prune: drop rows strictly older than the cutoff. The
  // created_at index keeps this cheap enough to call opportunistically.
  async prunePayloads(olderThanMs: number): Promise<void> {
    this.db
      .delete(requestPayloads)
      .where(lt(requestPayloads.createdAt, new Date(olderThanMs)))
      .run();
  }

  // Telemetry retention prune — the decision table's equivalent of prunePayloads
  // (it had none before, hence unbounded growth). Strict lower bound on created_at.
  async pruneTelemetry(olderThanMs: number): Promise<number> {
    const res = this.db
      .delete(telemetry)
      .where(lt(telemetry.createdAt, new Date(olderThanMs)))
      .run();
    return res.changes;
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
        requestJson: r.requestJson,
        responseJson: r.responseJson,
        upstreamRequestJson: r.upstreamRequestJson ?? null,
        createdAt: r.createdAt.getTime(),
      }));
  }

  // Row -> DecisionRecord. Re-validates through the shared schema so a corrupted
  // row surfaces loudly rather than leaking a malformed shape.
  private toDecision(row: TelemetryRow): DecisionRecord {
    return DecisionRecordSchema.parse(JSON.parse(row.decisionJson));
  }
}
