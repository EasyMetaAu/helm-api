import { randomUUID } from "node:crypto";
import { type DecisionRecord, DecisionRecordSchema } from "@helm/shared";
import { and, asc, count, desc, eq, gte, lt, type SQL, sql } from "drizzle-orm";
import type {
  InsertPayloadInput,
  InsertTelemetryInput,
  RecentDecisionRecord,
  RequestPayload,
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
    return {
      id: this.genId(),
      requestId: input.decision.request_id,
      apiKeyId: input.apiKeyId,
      decisionJson: JSON.stringify(input.decision),
      finalStatus: input.decision.final.status,
      costUsd: finalCost,
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
      .map((r) => ({ record: this.toDecision(r), createdAt: r.createdAt }));
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
        createdAt: input.createdAt,
      })
      .onConflictDoUpdate({
        target: requestPayloads.requestId,
        set: {
          requestJson: input.requestJson,
          responseJson: input.responseJson,
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

  // Row -> DecisionRecord. Re-validates through the shared schema so a corrupted
  // row surfaces loudly rather than leaking a malformed shape.
  private toDecision(row: TelemetryRow): DecisionRecord {
    return DecisionRecordSchema.parse(JSON.parse(row.decisionJson));
  }
}
