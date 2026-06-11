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
    "INSERT INTO memory_messages (id, thread_id, role, content, token_estimate, created_at, content_hash) VALUES (?, ?, ?, ?, 1, ?, ?)",
  );
  // Historical NULL-hash rows (pre-v21-backfill state).
  insMsg.run("h-y", "t1", "user", "y", 1, null); // unique → backfilled
  insMsg.run("h-x", "t1", "user", "x", 2, null); // collides with the hashed twin below
  // A row the running gateway already re-inserted post-migration WITH a hash.
  insMsg.run("app-x", "t1", "user", "x", 3, sha256Hex("x"));

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
      const yHash = (
        s.prepare("SELECT content_hash AS h FROM memory_messages WHERE id='h-y'").get() as {
          h: string | null;
        }
      ).h;
      expect(yHash).toBe(sha256Hex("y"));
      const xRows = s.prepare("SELECT id FROM memory_messages WHERE content='x'").all() as Array<{
        id: string;
      }>;
      expect(xRows.map((r) => r.id)).toEqual(["app-x"]); // only the hashed twin survives
      expect(
        (
          s
            .prepare("SELECT COUNT(*) AS c FROM memory_messages WHERE content_hash IS NULL")
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
      expect(out.vacuumed).toBe(true);
    } finally {
      s.close();
    }
  });
});
