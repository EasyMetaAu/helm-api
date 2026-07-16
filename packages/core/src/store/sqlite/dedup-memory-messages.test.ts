import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { dedupMemory } from "./dedup-memory-messages.js";
import { createSqliteDb } from "./migrate.js";

// Smoke test for the ops cleanup script against the REAL post-migration sqlite
// schema (createSqliteDb runs every migration incl. v21's content_hash + unique
// index). Seeds historical NULL-hash rows — including a collision twin the
// gateway could have re-inserted before the script runs — observations and jobs.

const sha256Hex = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

function seed() {
  const db = createSqliteDb(":memory:");
  const s = db.$sqlite;
  // memory_messages.thread_id has an FK to memory_threads — seed the thread.
  s.prepare("INSERT INTO memory_threads (id, created_at, updated_at) VALUES ('t1', 1, 1)").run();
  const insMsg = s.prepare(
    "INSERT INTO memory_messages (id, thread_id, message_index, role, content, token_estimate, created_at, content_hash) VALUES (?, ?, ?, ?, ?, 1, ?, ?)",
  );
  // Historical NULL-hash rows (pre-v21-backfill state).
  insMsg.run("h-y", "t1", null, "user", "y", 1, null); // unique -> backfilled
  insMsg.run("h-x", "t1", null, "user", "x", 2, null); // collides with the hashed twin below
  // A row the running gateway already re-inserted post-migration WITH a hash.
  insMsg.run("app-x", "t1", 1, "user", "x", 3, sha256Hex("x"));

  s.prepare(
    "INSERT INTO memory_observations (id, thread_id, source_message_range, observation_text, observed_at) VALUES (?, ?, ?, ?, ?)",
  ).run("o1", "t1", JSON.stringify(["h-y", "h-x"]), "stale obs", 1);

  const insJob = s.prepare(
    "INSERT INTO memory_jobs (id, type, scope_id, status, created_at, updated_at) VALUES (?, 'observer', ?, ?, 1, 1)",
  );
  insJob.run("j-done", "s1", "done");
  insJob.run("j-pending", "s2", "pending");
  return db;
}

describe("dedupMemory ops script", () => {
  it("dry-run makes no changes", () => {
    const db = seed();
    try {
      const out = dedupMemory(db.$sqlite, { dryRun: true });
      expect(out.backfilled).toBe(0);
      expect(
        (db.$sqlite.prepare("SELECT COUNT(*) AS c FROM memory_observations").get() as { c: number })
          .c,
      ).toBe(1);
    } finally {
      db.$sqlite.close();
    }
  });

  it("backfills hashes, drops collision duplicates, wipes observations, prunes terminal jobs", () => {
    const db = seed();
    const s = db.$sqlite;
    try {
      const out = dedupMemory(s, {});

      // "y" got a hash; the historical "x" duplicate (collides with app-x) was deleted.
      expect(out.backfilled).toBe(1);
      expect(out.deletedDuplicates).toBe(1);
      const yRow = s
        .prepare(
          "SELECT content_hash AS h, message_index AS idx FROM memory_messages WHERE id='h-y'",
        )
        .get() as {
        h: string | null;
        idx: number | null;
      };
      expect(yRow.h).toBe(sha256Hex("y"));
      expect(yRow.idx).toBe(0);
      const xRows = s.prepare("SELECT id FROM memory_messages WHERE content='x'").all() as Array<{
        id: string;
      }>;
      expect(xRows.map((r) => r.id)).toEqual(["app-x"]); // only the hashed twin survives
      expect(
        (
          s
            .prepare(
              "SELECT COUNT(*) AS c FROM memory_messages WHERE content_hash IS NULL OR message_index IS NULL",
            )
            .get() as { c: number }
        ).c,
      ).toBe(0);

      // Observations wiped, terminal jobs pruned, pending job kept.
      expect(out.wipedObservations).toBe(1);
      expect(
        (s.prepare("SELECT COUNT(*) AS c FROM memory_observations").get() as { c: number }).c,
      ).toBe(0);
      expect(out.prunedJobs).toBe(1);
      const jobs = s.prepare("SELECT id FROM memory_jobs").all() as Array<{ id: string }>;
      expect(jobs.map((j) => j.id)).toEqual(["j-pending"]);
      expect(
        s
          .prepare(
            `SELECT message_count, last_message_at, observation_count, last_observation_at
               FROM memory_threads WHERE id = 't1'`,
          )
          .get(),
      ).toEqual({
        message_count: 2,
        last_message_at: 3,
        observation_count: 0,
        last_observation_at: null,
      });
      expect(out.vacuumed).toBe(true);

      // Re-running maintenance must preserve the repaired summaries without
      // relying on the already-recorded schema migration to backfill again.
      const second = dedupMemory(s, {});
      expect(second.deletedDuplicates).toBe(0);
      expect(second.wipedObservations).toBe(0);
      expect(
        s
          .prepare(
            `SELECT message_count, last_message_at, observation_count, last_observation_at
               FROM memory_threads WHERE id = 't1'`,
          )
          .get(),
      ).toEqual({
        message_count: 2,
        last_message_at: 3,
        observation_count: 0,
        last_observation_at: null,
      });
    } finally {
      s.close();
    }
  });

  it("makes progress when a full selected batch only contains collision leftovers", () => {
    const db = createSqliteDb(":memory:");
    const s = db.$sqlite;
    try {
      s.prepare(
        "INSERT INTO memory_threads (id, created_at, updated_at) VALUES ('t1', 1, 1)",
      ).run();
      const ins = s.prepare(
        "INSERT INTO memory_messages (id, thread_id, message_index, role, content, token_estimate, created_at, content_hash) VALUES (?, 't1', ?, 'user', ?, 1, ?, ?)",
      );
      for (let i = 0; i < 5000; i += 1) {
        const content = `same-${i}`;
        ins.run(`null-${i}`, null, content, i, null);
      }
      for (let i = 0; i < 5000; i += 1) {
        const content = `same-${i}`;
        ins.run(`hashed-${i}`, i, content, 10_000 + i, sha256Hex(content));
      }

      const out = dedupMemory(s, {});
      expect(out.deletedDuplicates).toBe(5000);
      expect(
        (
          s
            .prepare(
              "SELECT COUNT(*) AS c FROM memory_messages WHERE content_hash IS NULL OR message_index IS NULL",
            )
            .get() as { c: number }
        ).c,
      ).toBe(0);
    } finally {
      s.close();
    }
  });
});
