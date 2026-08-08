import { and, eq, gt, ne, sql } from "drizzle-orm";
import type { ResponsesRegistryRecord, ResponsesRegistryStore } from "../ports.js";
import type { PgDb } from "./migrate.js";
import { responsesRegistry } from "./schema.js";

type Row = typeof responsesRegistry.$inferSelect;

export class PgResponsesRegistryStore implements ResponsesRegistryStore {
  constructor(private readonly db: PgDb) {}

  async upsert(record: ResponsesRegistryRecord): Promise<void> {
    const row = this.row(record);
    await this.db
      .insert(responsesRegistry)
      .values(row)
      .onConflictDoUpdate({ target: responsesRegistry.responseId, set: row });
  }

  async insertIfAbsent(record: ResponsesRegistryRecord): Promise<boolean> {
    const rows = await this.db
      .insert(responsesRegistry)
      .values(this.row(record))
      .onConflictDoNothing()
      .returning();
    return rows.length > 0;
  }

  async prune(input: { nowMs: number; maxEntries: number; limit: number }): Promise<void> {
    const maxEntries = Math.max(1, Math.floor(input.maxEntries));
    const limit = Math.max(1, Math.floor(input.limit));
    await this.db.transaction(async (tx) => {
      await tx.execute(sql`
        DELETE FROM responses_registry WHERE response_id IN (
          SELECT response_id FROM responses_registry
          WHERE expires_at <= ${input.nowMs} OR status = 'deleted'
          LIMIT ${limit}
        )
      `);
      await tx.execute(sql`
        DELETE FROM responses_registry WHERE response_id IN (
          SELECT response_id FROM responses_registry
          ORDER BY created_at DESC, response_id DESC
          LIMIT ${limit} OFFSET ${maxEntries}
        )
      `);
    });
  }

  async getOwnedLive(input: {
    responseId: string;
    accountId: string;
    keyId: string;
    nowMs: number;
  }): Promise<ResponsesRegistryRecord | null> {
    const rows = await this.db
      .select()
      .from(responsesRegistry)
      .where(
        and(
          eq(responsesRegistry.responseId, input.responseId),
          eq(responsesRegistry.accountId, input.accountId),
          eq(responsesRegistry.keyId, input.keyId),
          gt(responsesRegistry.expiresAt, input.nowMs),
          ne(responsesRegistry.status, "deleted"),
        ),
      )
      .limit(1);
    return rows[0] ? this.record(rows[0]) : null;
  }

  private row(record: ResponsesRegistryRecord): Row {
    return {
      ...record,
      providerAccount: record.providerAccount ?? null,
      selectedLane: record.selectedLane ?? null,
    };
  }

  private record(row: Row): ResponsesRegistryRecord {
    return {
      ...row,
      providerProtocol: row.providerProtocol as ResponsesRegistryRecord["providerProtocol"],
    };
  }
}
