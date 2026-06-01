import { randomUUID } from "node:crypto";
import { type DecisionRecord, DecisionRecordSchema } from "@helm/shared";
import { and, asc, desc, eq, gte, lt } from "drizzle-orm";
import type {
  InsertPayloadInput,
  InsertTelemetryInput,
  RecentDecisionRecord,
  RequestPayload,
  TelemetryStore,
} from "../ports.js";
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

  async insert(input: InsertTelemetryInput): Promise<{ id: string }> {
    const id = this.genId();
    const finalCost = input.decision.provider_attempts.reduce<number | null>((acc, a) => {
      if (a.cost_usd === null) return acc;
      return (acc ?? 0) + a.cost_usd;
    }, null);
    this.db
      .insert(telemetry)
      .values({
        id,
        requestId: input.decision.request_id,
        apiKeyId: input.apiKeyId,
        decisionJson: JSON.stringify(input.decision),
        finalStatus: input.decision.final.status,
        costUsd: finalCost,
        createdAt: input.createdAt,
      })
      .run();
    return { id };
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

  async getByRequestId(requestId: string): Promise<DecisionRecord | null> {
    const row = this.db.select().from(telemetry).where(eq(telemetry.requestId, requestId)).get();
    return row ? this.toDecision(row) : null;
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
  async insertPayload(input: InsertPayloadInput): Promise<void> {
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
