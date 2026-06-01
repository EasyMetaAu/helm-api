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
import type { PgDb } from "./migrate.js";
import { requestPayloads, telemetry } from "./schema.js";

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

  async insert(input: InsertTelemetryInput): Promise<{ id: string }> {
    const id = this.genId();
    const finalCost = input.decision.provider_attempts.reduce<number | null>((acc, a) => {
      if (a.cost_usd === null) return acc;
      return (acc ?? 0) + a.cost_usd;
    }, null);
    await this.db.insert(telemetry).values({
      id,
      requestId: input.decision.request_id,
      apiKeyId: input.apiKeyId,
      decisionJson: input.decision,
      finalStatus: input.decision.final.status,
      costUsd: finalCost,
      createdAt: input.createdAt.getTime(),
    });
    return { id };
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

  async getByRequestId(requestId: string): Promise<DecisionRecord | null> {
    const rows = await this.db
      .select()
      .from(telemetry)
      .where(eq(telemetry.requestId, requestId))
      .limit(1);
    const row = rows[0];
    return row ? this.toDecision(row) : null;
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

  // Full-payload capture. Upsert by request_id; verbatim bytes (TEXT), no
  // redaction. createdAt stored as epoch-ms bigint to match the sqlite adapter.
  async insertPayload(input: InsertPayloadInput): Promise<void> {
    await this.db
      .insert(requestPayloads)
      .values({
        requestId: input.requestId,
        requestJson: input.requestJson,
        responseJson: input.responseJson,
        createdAt: input.createdAt.getTime(),
      })
      .onConflictDoUpdate({
        target: requestPayloads.requestId,
        set: {
          requestJson: input.requestJson,
          responseJson: input.responseJson,
          createdAt: input.createdAt.getTime(),
        },
      });
  }

  async getPayload(requestId: string): Promise<RequestPayload | null> {
    const rows = await this.db
      .select()
      .from(requestPayloads)
      .where(eq(requestPayloads.requestId, requestId))
      .limit(1);
    const row = rows[0];
    if (!row) return null;
    return {
      requestId: row.requestId,
      requestJson: row.requestJson,
      responseJson: row.responseJson,
      createdAt: new Date(row.createdAt), // epoch-ms bigint → Date
    };
  }

  // Retention auto-prune: drop rows strictly older than the cutoff (epoch ms).
  async prunePayloads(olderThanMs: number): Promise<void> {
    await this.db.delete(requestPayloads).where(lt(requestPayloads.createdAt, olderThanMs));
  }

  // Row -> DecisionRecord. Re-validates through the shared schema so a corrupted
  // row surfaces loudly rather than leaking a malformed shape. jsonb is already
  // parsed by the driver — feed it straight to the schema.
  private toDecision(row: TelemetryRow): DecisionRecord {
    return DecisionRecordSchema.parse(row.decisionJson);
  }
}
