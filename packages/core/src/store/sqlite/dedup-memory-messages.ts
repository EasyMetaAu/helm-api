import { createHash } from "node:crypto";
import Database from "better-sqlite3";

// One-time production maintenance for the memory_messages re-ingestion bug
// (fix/memory-message-dedup). The v21 migration already (a) collapsed exact
// legacy duplicate rows and (b) added UNIQUE(thread_id, message_index, role,
// content_hash) on STARTUP — but historical rows keep message_index/content_hash
// NULL (no sha256 SQL fn in sqlite). This closes the loop on a live helm.db:
//
//   1. Backfill content_hash + message_index for historical incomplete rows (JS
//      sha256 + row_number over each thread's current order, zero-based; batched).
//   2. UPDATE OR IGNORE leaves a historical row whose key would collide with an
//      already-indexed/hashed twin incomplete; delete it in the same batch so the
//      loop always makes progress.
//   3. Wipe memory_observations — they were formed from the duplicate-laden data
//      (measured_retention ~0.6%); the observer rebuilds them on clean data.
//   4. Prune terminal (done/failed) memory_jobs.
//   5. VACUUM to reclaim the bloat.
//
// Lives under the sqlite adapter (not scripts/) so better-sqlite3 resolves; run
// via `pnpm memory:dedup <db>` (tsx) or the gateway image's own node inside the
// container. Idempotent + supports --dry-run. NEVER run at request time.

const BACKFILL_BATCH = 5000;

const sha256Hex = (s: string): string => createHash("sha256").update(s, "utf8").digest("hex");

export interface DedupOptions {
  dryRun?: boolean;
  log?: (line: string) => void;
}

export interface DedupSummary {
  backfilled: number;
  deletedDuplicates: number;
  wipedObservations: number;
  prunedJobs: number;
  vacuumed: boolean;
}

// Operate on an OPEN better-sqlite3 handle so tests can pass an in-memory DB.
export function dedupMemory(db: Database.Database, opts: DedupOptions = {}): DedupSummary {
  const dryRun = opts.dryRun === true;
  const log = opts.log ?? (() => {});

  const pendingCount = (
    db
      .prepare(
        "SELECT COUNT(*) AS c FROM memory_messages WHERE content_hash IS NULL OR message_index IS NULL",
      )
      .get() as {
      c: number;
    }
  ).c;
  log(`memory_messages needing index/hash backfill: ${pendingCount}`);

  const summary: DedupSummary = {
    backfilled: 0,
    deletedDuplicates: 0,
    wipedObservations: 0,
    prunedJobs: 0,
    vacuumed: false,
  };

  if (dryRun) {
    const obs = (db.prepare("SELECT COUNT(*) AS c FROM memory_observations").get() as { c: number })
      .c;
    const jobs = (
      db
        .prepare("SELECT COUNT(*) AS c FROM memory_jobs WHERE status IN ('done','failed')")
        .get() as { c: number }
    ).c;
    log(
      `[dry-run] would backfill ${pendingCount} messages, wipe ${obs} observations, prune ${jobs} jobs`,
    );
    return summary;
  }

  // 1+2. Backfill in batches. UPDATE OR IGNORE leaves a colliding historical row
  // incomplete; delete those leftovers within the same batch so progress cannot
  // stall on a full batch of collisions.
  const selectBatch = db.prepare(
    `SELECT id, content, rn - 1 AS message_index
       FROM (
         SELECT id,
                content,
                ROW_NUMBER() OVER (PARTITION BY thread_id ORDER BY created_at ASC, id ASC) AS rn
           FROM memory_messages
       )
      WHERE id IN (
        SELECT id FROM memory_messages
         WHERE content_hash IS NULL OR message_index IS NULL
         ORDER BY thread_id ASC, created_at ASC, id ASC
         LIMIT ?
      )`,
  );
  const update = db.prepare(
    "UPDATE OR IGNORE memory_messages SET content_hash = ?, message_index = ? WHERE id = ?",
  );
  const deleteIncomplete = db.prepare(
    "DELETE FROM memory_messages WHERE id = ? AND (content_hash IS NULL OR message_index IS NULL)",
  );
  for (;;) {
    const rows = selectBatch.all(BACKFILL_BATCH) as Array<{
      id: string;
      content: string;
      message_index: number;
    }>;
    if (rows.length === 0) break;
    const tx = db.transaction((batch: typeof rows) => {
      for (const r of batch) {
        const res = update.run(sha256Hex(r.content), r.message_index, r.id);
        if (res.changes === 1) summary.backfilled += 1;
        summary.deletedDuplicates += deleteIncomplete.run(r.id).changes;
      }
    });
    tx(rows);
  }
  log(
    `backfilled ${summary.backfilled} messages, deleted ${summary.deletedDuplicates} collision duplicates`,
  );

  // 3+4. Observations were built from duplicate-laden data, terminal jobs are
  // pure history, and v39's parent summaries must describe the post-maintenance
  // child rows. Keep all three changes atomic so an already-recorded migration
  // never leaves the Admin stats permanently stale after this command runs.
  db.transaction(() => {
    summary.wipedObservations = db.prepare("DELETE FROM memory_observations").run().changes;
    summary.prunedJobs = db
      .prepare("DELETE FROM memory_jobs WHERE status IN ('done','failed')")
      .run().changes;
    db.exec(`
      UPDATE memory_threads AS t
         SET message_count = (
               SELECT COUNT(*) FROM memory_messages m WHERE m.thread_id = t.id
             ),
             last_message_at = (
               SELECT MAX(m.created_at) FROM memory_messages m WHERE m.thread_id = t.id
             ),
             observation_count = 0,
             last_observation_at = NULL;
    `);
  })();
  log(`wiped ${summary.wipedObservations} observations (observer will rebuild)`);
  log(`pruned ${summary.prunedJobs} terminal jobs`);

  // 5. Reclaim space. VACUUM cannot run inside a transaction; it takes an
  // exclusive lock and rewrites the whole file — run during an idle window.
  db.exec("VACUUM");
  summary.vacuumed = true;
  log("vacuumed");

  return summary;
}

// CLI: `tsx packages/core/src/store/sqlite/dedup-memory-messages.ts <db-path> [--dry-run]`
// (or via the gateway image's node). Back up helm.db / -wal / -shm first.
if (import.meta.url === `file://${process.argv[1]}`) {
  const dbPath = process.argv.find((a, i) => i >= 2 && !a.startsWith("--")) ?? "./helm.db";
  const dryRun = process.argv.includes("--dry-run");
  const db = new Database(dbPath);
  db.pragma("busy_timeout = 10000");
  try {
    // eslint-disable-next-line no-console
    const summary = dedupMemory(db, { dryRun, log: (l) => console.log(`[dedup-memory] ${l}`) });
    // eslint-disable-next-line no-console
    console.log(`[dedup-memory] done ${JSON.stringify(summary)}`);
  } finally {
    db.close();
  }
}
