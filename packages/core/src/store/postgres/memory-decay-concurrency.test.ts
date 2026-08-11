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

// PGlite has one database session, so it cannot reproduce the two-connection
// READ COMMITTED race. Recording the real transaction SQL still proves the
// required serialization order: scope lock + job fence, archive, successor.
describe("PgMemoryStore decay/Reflector serialization", () => {
  it("locks and closes open Reflectors before archiving, then enqueues successors", async () => {
    const db = await createPgliteDb();
    try {
      let seq = 0;
      const store = new PgMemoryStore(
        db,
        () => `id-${++seq}`,
        () => new Date(2_000),
      );
      await store.ensureThread({ id: "thread", ownerId: "account", projectId: "project" });
      const observationId = await store.appendObservation({
        threadId: "thread",
        sourceMessageRange: ["m1", "m2"],
        observationText: "forget me",
        observedAt: new Date(1_000),
      });
      await store.enqueueJob({
        type: "reflector",
        scope: { accountId: "account", projectId: "project" },
      });

      const statements: string[] = [];
      const traceable = db as unknown as TraceablePgliteDb;
      traceable.session.options.logger = {
        logQuery(query) {
          statements.push(query.replace(/\s+/g, " ").trim().toLowerCase());
        },
      };

      await store.archiveObservations({
        accountId: "account",
        ids: [observationId],
        now: new Date(2_000),
      });

      const scopeLockAt = statements.findIndex((query) => query.includes("pg_advisory_xact_lock"));
      const jobFenceAt = statements.findIndex(
        (query) =>
          query.includes("update memory_jobs") &&
          query.includes("status = 'failed'") &&
          query.includes("status in ('pending', 'running')"),
      );
      const observationArchiveAt = statements.findIndex(
        (query) => query.includes("update memory_observations") && query.includes("archived_at"),
      );
      const reflectionArchiveAt = statements.findIndex(
        (query) =>
          query.includes("update memory_reflections") && query.includes("status = 'archived'"),
      );
      const successorAt = statements.findIndex(
        (query, index) => index > jobFenceAt && query.includes("insert into memory_jobs"),
      );

      expect(scopeLockAt).toBeGreaterThanOrEqual(0);
      expect(jobFenceAt).toBeGreaterThan(scopeLockAt);
      expect(observationArchiveAt).toBeGreaterThan(jobFenceAt);
      expect(reflectionArchiveAt).toBeGreaterThan(observationArchiveAt);
      expect(successorAt).toBeGreaterThan(reflectionArchiveAt);
    } finally {
      await db.$close();
    }
  });
});
