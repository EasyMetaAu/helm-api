import { createHash } from "node:crypto";
import Database from "better-sqlite3";

// One-time production maintenance for the memory_messages re-ingestion bug
// (fix/memory-message-dedup). The v21 migration already (a) collapsed exact
// duplicate rows and (b) added UNIQUE(thread_id, role, content_hash) on STARTUP —
// but historical rows keep content_hash = NULL (no sha256 SQL fn in sqlite). This
// closes the loop on a live helm.db:
//
//   1. Backfill content_hash for every historical NULL-hash row (JS sha256,
//      batched). UPDATE OR IGNORE: a historical row whose hash would collide with
//      an already-hashed twin (one the running gateway re-inserted between the
//      migration and this run) is left NULL …
//   2. … then deleted — a NULL-hash row that survives backfill is, by definition,
//      a duplicate of a hashed row.
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

  const nullCount = (
    db.prepare("SELECT COUNT(*) AS c FROM memory_messages WHERE content_hash IS NULL").get() as {
      c: number;
    }
  ).c;
  log(`memory_messages with NULL content_hash: ${nullCount}`);

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
      `[dry-run] would backfill ${nullCount} hashes, wipe ${obs} observations, prune ${jobs} jobs`,
    );
    return summary;
  }

  // 1+2. Backfill in batches. UPDATE OR IGNORE leaves a colliding historical row
  // NULL; we delete those leftovers afterwards (they duplicate a hashed twin).
  const selectBatch = db.prepare(
    "SELECT id, content FROM memory_messages WHERE content_hash IS NULL LIMIT ?",
  );
  const update = db.prepare("UPDATE OR IGNORE memory_messages SET content_hash = ? WHERE id = ?");
  for (;;) {
    const rows = selectBatch.all(BACKFILL_BATCH) as Array<{ id: string; content: string }>;
    if (rows.length === 0) break;
    const tx = db.transaction((batch: typeof rows) => {
      for (const r of batch) {
        const res = update.run(sha256Hex(r.content), r.id);
        if (res.changes === 1) summary.backfilled += 1;
      }
    });
    tx(rows);
    if (rows.length < BACKFILL_BATCH) break;
  }
  summary.deletedDuplicates = db
    .prepare("DELETE FROM memory_messages WHERE content_hash IS NULL")
    .run().changes;
  log(
    `backfilled ${summary.backfilled} hashes, deleted ${summary.deletedDuplicates} leftover duplicates`,
  );

  // 3. Observations were built from duplicate-laden data — let the observer rebuild.
  summary.wipedObservations = db.prepare("DELETE FROM memory_observations").run().changes;
  log(`wiped ${summary.wipedObservations} observations (observer will rebuild)`);

  // 4. Terminal jobs are pure history; drop them.
  summary.prunedJobs = db
    .prepare("DELETE FROM memory_jobs WHERE status IN ('done','failed')")
    .run().changes;
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
