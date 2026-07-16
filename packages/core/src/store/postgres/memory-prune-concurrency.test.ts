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
      const deleteAt = statements.findIndex((query) =>
        query.includes("delete from memory_messages"),
      );
      const repairAt = statements.findIndex(
        (query) => query.includes("update memory_threads as t") && query.includes("message_count"),
      );

      expect(lockAt).toBeGreaterThanOrEqual(0);
      expect(deleteAt).toBeGreaterThan(lockAt);
      expect(repairAt).toBeGreaterThan(deleteAt);
    } finally {
      await db.$close();
    }
  });
});
