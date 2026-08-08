import { and, eq, gt, ne } from "drizzle-orm";
import type { ResponsesRegistryRecord, ResponsesRegistryStore } from "../ports.js";
import type { SqliteDb } from "./migrate.js";
import { responsesRegistry } from "./schema.js";

type Row = typeof responsesRegistry.$inferSelect;

export class SqliteResponsesRegistryStore implements ResponsesRegistryStore {
  constructor(private readonly db: SqliteDb) {}

  async upsert(record: ResponsesRegistryRecord): Promise<void> {
    const row = this.row(record);
    this.db
      .insert(responsesRegistry)
      .values(row)
      .onConflictDoUpdate({ target: responsesRegistry.responseId, set: row })
      .run();
  }

  async insertIfAbsent(record: ResponsesRegistryRecord): Promise<boolean> {
    const result = this.db
      .insert(responsesRegistry)
      .values(this.row(record))
      .onConflictDoNothing({ target: responsesRegistry.responseId })
      .run();
    return result.changes > 0;
  }

  async prune(input: { nowMs: number; maxEntries: number; limit: number }): Promise<void> {
    const maxEntries = Math.max(1, Math.floor(input.maxEntries));
    const limit = Math.max(1, Math.floor(input.limit));
    this.db.transaction(() => {
      this.db.$sqlite
        .prepare(`DELETE FROM responses_registry WHERE response_id IN (
          SELECT response_id FROM responses_registry
          WHERE expires_at <= ? OR status = 'deleted' LIMIT ?
        )`)
        .run(input.nowMs, limit);
      this.db.$sqlite
        .prepare(`DELETE FROM responses_registry WHERE response_id IN (
          SELECT response_id FROM responses_registry
          ORDER BY created_at DESC, response_id DESC LIMIT ? OFFSET ?
        )`)
        .run(limit, maxEntries);
    });
  }

  async getOwnedLive(input: {
    responseId: string;
    accountId: string;
    keyId: string;
    nowMs: number;
  }): Promise<ResponsesRegistryRecord | null> {
    const row = this.db
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
      .get();
    return row ? this.record(row) : null;
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
