import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { PgMemoryStore } from "./memory-store.js";
import { createPgliteDb } from "./migrate.js";

interface TraceablePgliteDb {
  session: {
    options: {
      logger?: { logQuery(query: string, params: unknown[]): void };
    };
  };
}

// PGlite is an embedded, single-session PostgreSQL engine, so it cannot recreate
// a two-connection READ COMMITTED snapshot race. The strongest deterministic
// regression here executes the real prune transaction and records Drizzle's SQL:
// the affected parent rows must be locked before either DELETE or summary repair.
describe("PgMemoryStore prune summary serialization", () => {
  it("locks affected parent rows before deleting and recomputing message summaries", async () => {
    const db = await createPgliteDb();
    try {
      let seq = 0;
      const store = new PgMemoryStore(
        db,
        () => `id-${++seq}`,
        () => new Date(1_000),
      );
      await store.ensureThread({ id: "t", ownerId: "a" });
      await store.appendMessage({
        threadId: "t",
        role: "user",
        content: "old",
        tokenEstimate: 1,
      });
      await db.execute(
        sql.raw(
          "UPDATE memory_threads SET observer_frontier_at = 2000, observer_frontier_id = 'id-1' WHERE id = 't'",
        ),
      );

      const statements: string[] = [];
      const traceable = db as unknown as TraceablePgliteDb;
      traceable.session.options.logger = {
        logQuery(query) {
          statements.push(query.replace(/\s+/g, " ").trim().toLowerCase());
        },
      };

      expect(await store.pruneMessagesOlderThan(2_000)).toBe(1);

      const lockAt = statements.findIndex(
        (query) =>
          query.includes("from memory_threads t") &&
          query.includes("join _helm_pruned_message_threads") &&
          query.includes("order by t.id") &&
          query.includes("for update"),
      );
      const boundedThreadDiscovery = statements.find(
        (query) =>
          query.includes("_helm_pruned_message_threads") &&
          query.includes("with doomed") &&
          query.includes("limit"),
      );
      const deleteAt = statements.findIndex((query) =>
        query.includes("delete from memory_messages"),
      );
      const repairAt = statements.findIndex(
        (query) => query.includes("update memory_threads as t") && query.includes("message_count"),
      );

      expect(lockAt).toBeGreaterThanOrEqual(0);
      expect(boundedThreadDiscovery).toBeDefined();
      expect(deleteAt).toBeGreaterThan(lockAt);
      expect(repairAt).toBeGreaterThan(deleteAt);
    } finally {
      await db.$close();
    }
  });

  it("repairs every bounded thread batch instead of only the last one", async () => {
    const db = await createPgliteDb();
    try {
      const store = new PgMemoryStore(db);
      await store.ensureThread({ id: "a", ownerId: "owner" });
      await store.ensureThread({ id: "b", ownerId: "owner" });
      await db.execute(
        sql.raw(`
        INSERT INTO memory_messages
          (id, thread_id, message_index, role, content, token_estimate, created_at, content_hash)
        SELECT 'a-' || g, 'a', g, 'user', 'old', 1, g, 'hash-a-' || g
          FROM generate_series(1, 1000) AS g
      `),
      );
      await db.execute(
        sql.raw(`
        INSERT INTO memory_messages
          (id, thread_id, message_index, role, content, token_estimate, created_at, content_hash)
        VALUES ('b-1', 'b', 1, 'user', 'old', 1, 1001, 'hash-b-1')
      `),
      );
      await db.execute(
        sql.raw(`
        UPDATE memory_threads SET message_count = 1000, last_message_at = 1000,
          observer_frontier_at = 2000, observer_frontier_id = 'a-999' WHERE id = 'a'
      `),
      );
      await db.execute(
        sql.raw(`
        UPDATE memory_threads SET message_count = 1, last_message_at = 1001,
          observer_frontier_at = 2000, observer_frontier_id = 'b-1' WHERE id = 'b'
      `),
      );

      expect(await store.pruneMessagesOlderThan(3_000)).toBe(1001);
      const result = (await db.execute(
        sql.raw("SELECT id, message_count FROM memory_threads ORDER BY id"),
      )) as unknown;
      const rows = (
        Array.isArray(result) ? result : ((result as { rows?: unknown[] }).rows ?? [])
      ) as Array<{
        id: string;
        message_count: number | string;
      }>;
      expect(rows.map((row) => [row.id, Number(row.message_count)])).toEqual([
        ["a", 0],
        ["b", 0],
      ]);
    } finally {
      await db.$close();
    }
  });
});
