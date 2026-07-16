import { createHash } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { afterEach, describe, expect, it } from "vitest";
import { dedupMemoryPg } from "./dedup-memory-messages.js";

const sha256Hex = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

const clients: PGlite[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) await client.close();
});

async function seed(): Promise<PGlite> {
  const db = new PGlite();
  clients.push(db);
  await db.exec(`
    CREATE TABLE memory_threads (
      id TEXT PRIMARY KEY,
      message_count INTEGER NOT NULL DEFAULT 0,
      last_message_at BIGINT,
      observation_count INTEGER NOT NULL DEFAULT 0,
      last_observation_at BIGINT,
      created_at BIGINT NOT NULL,
      updated_at BIGINT NOT NULL
    );
    CREATE TABLE memory_messages (
      id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      token_estimate INTEGER NOT NULL,
      message_index INTEGER,
      created_at BIGINT NOT NULL,
      content_hash TEXT
    );
    CREATE UNIQUE INDEX uniq_memory_messages_thread_idx_role_hash
      ON memory_messages (thread_id, message_index, role, content_hash);
    CREATE TABLE memory_observations (
      id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      source_message_range JSONB NOT NULL,
      observation_text TEXT NOT NULL,
      observed_at BIGINT NOT NULL
    );
    CREATE TABLE memory_jobs (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      scope_id TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at BIGINT NOT NULL,
      updated_at BIGINT NOT NULL
    );
  `);
  await db.query("INSERT INTO memory_threads (id, created_at, updated_at) VALUES ('t1', 1, 1)");
  await db.query(
    `INSERT INTO memory_messages (id, thread_id, message_index, role, content, token_estimate, created_at, content_hash) VALUES
      ('h-y', 't1', NULL, 'user', 'y', 1, 1, NULL),
      ('h-x', 't1', NULL, 'user', 'x', 1, 2, NULL),
      ('app-x', 't1', 1, 'user', 'x', 1, 3, $1)`,
    [sha256Hex("x")],
  );
  await db.query(
    "INSERT INTO memory_observations (id, thread_id, source_message_range, observation_text, observed_at) VALUES ('o1', 't1', '[\"h-y\",\"h-x\"]', 'stale', 1)",
  );
  await db.query(
    "INSERT INTO memory_jobs (id, type, scope_id, status, created_at, updated_at) VALUES ('j-done', 'observer', 's1', 'done', 1, 1), ('j-pending', 'observer', 's2', 'pending', 1, 1)",
  );
  return db;
}

describe("dedupMemoryPg ops helper", () => {
  it("backfills hashes/indexes, deletes collisions, wipes observations, and prunes terminal jobs", async () => {
    const db = await seed();

    const out = await dedupMemoryPg(db, {});
    expect(out.backfilled).toBe(1);
    expect(out.deletedDuplicates).toBe(1);
    expect(out.wipedObservations).toBe(1);
    expect(out.prunedJobs).toBe(1);

    const y = await db.query<{ content_hash: string | null; message_index: number | null }>(
      "SELECT content_hash, message_index FROM memory_messages WHERE id='h-y'",
    );
    expect(y.rows[0]).toEqual({ content_hash: sha256Hex("y"), message_index: 0 });
    const xRows = await db.query<{ id: string }>(
      "SELECT id FROM memory_messages WHERE content='x' ORDER BY id",
    );
    expect(xRows.rows.map((r) => r.id)).toEqual(["app-x"]);
    const obs = await db.query<{ c: number }>("SELECT COUNT(*)::int AS c FROM memory_observations");
    expect(obs.rows[0]?.c).toBe(0);
    const jobs = await db.query<{ id: string }>("SELECT id FROM memory_jobs ORDER BY id");
    expect(jobs.rows.map((r) => r.id)).toEqual(["j-pending"]);

    const summary = await db.query<{
      message_count: number;
      last_message_at: number | null;
      observation_count: number;
      last_observation_at: number | null;
    }>(
      "SELECT message_count, last_message_at, observation_count, last_observation_at FROM memory_threads WHERE id='t1'",
    );
    expect(summary.rows[0]).toEqual({
      message_count: 2,
      last_message_at: 3,
      observation_count: 0,
      last_observation_at: null,
    });

    const second = await dedupMemoryPg(db, {});
    expect(second.deletedDuplicates).toBe(0);
    expect(second.wipedObservations).toBe(0);
    const summaryAfterSecondRun = await db.query(
      "SELECT message_count, last_message_at, observation_count, last_observation_at FROM memory_threads WHERE id='t1'",
    );
    expect(summaryAfterSecondRun.rows[0]).toEqual(summary.rows[0]);
  });
});
