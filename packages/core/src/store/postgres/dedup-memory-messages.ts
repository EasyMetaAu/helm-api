import { createHash } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import postgres from "postgres";

const BACKFILL_BATCH = 5000;

const sha256Hex = (s: string): string => createHash("sha256").update(s, "utf8").digest("hex");

export interface PgDedupOptions {
  dryRun?: boolean;
  log?: (line: string) => void;
}

export interface PgDedupSummary {
  backfilled: number;
  deletedDuplicates: number;
  wipedObservations: number;
  prunedJobs: number;
}

interface Queryable {
  unsafe?<T extends Record<string, unknown> = Record<string, unknown>>(
    query: string,
    args?: readonly unknown[],
  ): Promise<T[]>;
  query?<T extends Record<string, unknown> = Record<string, unknown>>(
    query: string,
    args?: readonly unknown[],
  ): Promise<{ rows: T[] }>;
}

async function rows<T extends Record<string, unknown> = Record<string, unknown>>(
  db: Queryable,
  query: string,
  args: readonly unknown[] = [],
): Promise<T[]> {
  if (db.unsafe !== undefined) return db.unsafe<T>(query, args);
  if (db.query !== undefined) return (await db.query<T>(query, args)).rows;
  throw new Error("unsupported postgres client");
}

function firstNumber(rows: Array<Record<string, unknown>>, key: string): number {
  const value = rows[0]?.[key];
  return typeof value === "number" ? value : Number(value ?? 0);
}

export async function dedupMemoryPg(
  db: Queryable,
  opts: PgDedupOptions = {},
): Promise<PgDedupSummary> {
  const dryRun = opts.dryRun === true;
  const log = opts.log ?? (() => {});
  const pendingRows = await rows<{ c: number | string }>(
    db,
    "SELECT COUNT(*) AS c FROM memory_messages WHERE content_hash IS NULL OR message_index IS NULL",
  );
  const pendingCount = Number(pendingRows[0]?.c ?? 0);
  log(`memory_messages needing index/hash backfill: ${pendingCount}`);

  const summary: PgDedupSummary = {
    backfilled: 0,
    deletedDuplicates: 0,
    wipedObservations: 0,
    prunedJobs: 0,
  };

  if (dryRun) {
    const obs = firstNumber(await rows(db, "SELECT COUNT(*) AS c FROM memory_observations"), "c");
    const jobs = firstNumber(
      await rows(db, "SELECT COUNT(*) AS c FROM memory_jobs WHERE status IN ('done','failed')"),
      "c",
    );
    log(
      `[dry-run] would backfill ${pendingCount} messages, wipe ${obs} observations, prune ${jobs} jobs`,
    );
    return summary;
  }

  for (;;) {
    const batch = await rows<{ id: string; content: string; message_index: number | string }>(
      db,
      `SELECT id, content, rn - 1 AS message_index
         FROM (
           SELECT id,
                  content,
                  ROW_NUMBER() OVER (PARTITION BY thread_id ORDER BY created_at ASC, id ASC) AS rn
             FROM memory_messages
         ) ranked
        WHERE id IN (
          SELECT id FROM memory_messages
           WHERE content_hash IS NULL OR message_index IS NULL
           ORDER BY thread_id ASC, created_at ASC, id ASC
           LIMIT $1
        )`,
      [BACKFILL_BATCH],
    );
    if (batch.length === 0) break;

    await rows(db, "BEGIN");
    try {
      for (const row of batch) {
        const conflict = await rows<{ id: string }>(
          db,
          `SELECT existing.id
             FROM memory_messages candidate
             JOIN memory_messages existing
               ON existing.thread_id = candidate.thread_id
              AND existing.message_index = $1
              AND existing.role = candidate.role
              AND existing.content_hash = $2
              AND existing.id <> candidate.id
            WHERE candidate.id = $3
            LIMIT 1`,
          [Number(row.message_index), sha256Hex(row.content), row.id],
        );
        if (conflict.length === 0) {
          const updated = await rows<{ id: string }>(
            db,
            `UPDATE memory_messages
                SET content_hash = $1, message_index = $2
              WHERE id = $3
              RETURNING id`,
            [sha256Hex(row.content), Number(row.message_index), row.id],
          );
          if (updated.length === 1) summary.backfilled += 1;
        }
        const deleted = await rows<{ id: string }>(
          db,
          `DELETE FROM memory_messages
            WHERE id = $1
              AND (content_hash IS NULL OR message_index IS NULL)
            RETURNING id`,
          [row.id],
        );
        summary.deletedDuplicates += deleted.length;
      }
      await rows(db, "COMMIT");
    } catch (err) {
      await rows(db, "ROLLBACK");
      throw err;
    }
  }

  const wiped = await rows<{ id: string }>(db, "DELETE FROM memory_observations RETURNING id");
  summary.wipedObservations = wiped.length;
  const pruned = await rows<{ id: string }>(
    db,
    "DELETE FROM memory_jobs WHERE status IN ('done','failed') RETURNING id",
  );
  summary.prunedJobs = pruned.length;
  log(
    `backfilled ${summary.backfilled} messages, deleted ${summary.deletedDuplicates} collision duplicates`,
  );
  log(`wiped ${summary.wipedObservations} observations (observer will rebuild)`);
  log(`pruned ${summary.prunedJobs} terminal jobs`);
  return summary;
}

async function withPgClient<T>(
  connectionString: string,
  fn: (db: Queryable) => Promise<T>,
): Promise<T> {
  const client = postgres(connectionString);
  try {
    return await fn(client as Queryable);
  } finally {
    await client.end();
  }
}

async function withPgliteClient<T>(dataDir: string, fn: (db: Queryable) => Promise<T>): Promise<T> {
  const client = new PGlite(dataDir);
  try {
    return await fn(client as unknown as Queryable);
  } finally {
    await client.close();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const dryRun = process.argv.includes("--dry-run");
  const pgliteDirIndex = process.argv.indexOf("--pglite-dir");
  const pgliteDir = pgliteDirIndex >= 0 ? process.argv[pgliteDirIndex + 1] : undefined;
  const urlArg = process.argv.find(
    (a, i) => i >= 2 && !a.startsWith("--") && (pgliteDirIndex < 0 || i !== pgliteDirIndex + 1),
  );
  if (!pgliteDir && !urlArg && !process.env.DATABASE_URL) {
    throw new Error("usage: pnpm memory:dedup:pg <postgres-url> [--dry-run]");
  }
  const run = pgliteDir
    ? withPgliteClient(pgliteDir, (db) =>
        dedupMemoryPg(db, { dryRun, log: (l) => console.log(`[dedup-memory-pg] ${l}`) }),
      )
    : withPgClient(urlArg ?? process.env.DATABASE_URL ?? "", (db) =>
        dedupMemoryPg(db, { dryRun, log: (l) => console.log(`[dedup-memory-pg] ${l}`) }),
      );
  const summary = await run;
  console.log(`[dedup-memory-pg] done ${JSON.stringify(summary)}`);
}
