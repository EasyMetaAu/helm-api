import { createRequire } from "node:module";
import { resolve } from "node:path";
import { Worker } from "node:worker_threads";
import type Database from "better-sqlite3";

export interface IdleFlushCandidateInput {
  idleBeforeMs: number;
  idleAfterMs?: number;
  limit: number;
}

interface IdleFlushCandidateRow {
  owner_id: string;
  thread_id: string;
  project_id: string | null;
  resource_id: string | null;
}

export interface IdleFlushCandidate {
  accountId: string;
  threadId: string;
  projectId?: string;
  resourceId?: string;
}

const DEFAULT_WORKER_TIMEOUT_MS = 30_000;
const fileScans = new WeakMap<Database.Database, Promise<IdleFlushCandidate[]>>();

const candidateSql = `WITH candidates AS (
  SELECT t.owner_id AS owner_id, t.id AS thread_id,
         t.project_id AS project_id, t.resource_id AS resource_id,
         t.last_message_at AS last_activity
    FROM memory_threads t
   WHERE t.owner_id IS NOT NULL
     AND last_activity IS NOT NULL
     AND last_activity <= ?
     AND (? IS NULL OR last_activity >= ?)
     AND EXISTS (
       SELECT 1 FROM memory_messages m
        WHERE m.thread_id = t.id
          AND (
            t.observer_frontier_at IS NULL OR
            m.created_at > t.observer_frontier_at OR
            (m.created_at = t.observer_frontier_at AND m.id > t.observer_frontier_id)
          )
     )
),
ranked AS (
  SELECT *,
         ROW_NUMBER() OVER (
           PARTITION BY owner_id, COALESCE(project_id, ''), COALESCE(resource_id, '')
           ORDER BY last_activity ASC, thread_id ASC
         ) AS scope_rank
    FROM candidates
)
SELECT owner_id, thread_id, project_id, resource_id
  FROM ranked
 ORDER BY scope_rank ASC, last_activity ASC, thread_id ASC
 LIMIT ?`;

const workerSource = `
const { parentPort, workerData } = require("node:worker_threads");
const Database = require(workerData.betterSqlite3Path);

const message = (error) => error instanceof Error ? error.message : String(error);
let result;
let sqlite;
try {
  sqlite = new Database(workerData.databasePath, { fileMustExist: true, readonly: true });
  sqlite.pragma("busy_timeout = 5000");
  sqlite.pragma("query_only = ON");
  sqlite.pragma("temp_store = FILE");
  sqlite.pragma("cache_size = -8192");
  result = { ok: true, rows: sqlite.prepare(workerData.sql).all(...workerData.params) };
} catch (error) {
  result = { ok: false, error: message(error) };
}
if (sqlite) {
  try { sqlite.close(); } catch (error) {
    if (result && result.ok) result = { ok: false, error: "sqlite close failed: " + message(error) };
  }
}
parentPort.postMessage(result);
`;

function params(input: IdleFlushCandidateInput): [number, number | null, number | null, number] {
  return [input.idleBeforeMs, input.idleAfterMs ?? null, input.idleAfterMs ?? null, input.limit];
}

function mapRows(rows: IdleFlushCandidateRow[]): IdleFlushCandidate[] {
  return rows.map((row) => ({
    accountId: row.owner_id,
    threadId: row.thread_id,
    ...(row.project_id !== null ? { projectId: row.project_id } : {}),
    ...(row.resource_id !== null ? { resourceId: row.resource_id } : {}),
  }));
}

function runFileScan(
  databasePath: string,
  input: IdleFlushCandidateInput,
  timeoutMs: number,
): Promise<IdleFlushCandidateRow[]> {
  const betterSqlite3Path = createRequire(import.meta.url).resolve("better-sqlite3");
  return new Promise((resolvePromise, rejectPromise) => {
    const worker = new Worker(workerSource, {
      eval: true,
      workerData: {
        betterSqlite3Path,
        databasePath,
        sql: candidateSql,
        params: params(input),
      },
    });
    let settled = false;
    const rejectOnce = (error: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      rejectPromise(error);
    };
    const resolveOnce = (rows: IdleFlushCandidateRow[]): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolvePromise(rows);
    };
    const timeout = setTimeout(() => {
      if (settled) return;
      rejectOnce(new Error(`sqlite idle-flush worker timed out after ${timeoutMs}ms`));
      void worker.terminate();
    }, timeoutMs);
    timeout.unref();
    worker.once(
      "message",
      (value: { ok?: boolean; rows?: IdleFlushCandidateRow[]; error?: string }) => {
        if (value?.ok && Array.isArray(value.rows)) resolveOnce(value.rows);
        else rejectOnce(new Error(value?.error ?? "sqlite idle-flush worker failed"));
      },
    );
    worker.once("error", rejectOnce);
    worker.once("exit", (code) => {
      if (!settled)
        rejectOnce(new Error(`sqlite idle-flush worker exited before reporting: ${code}`));
    });
  });
}

export function listSqliteIdleFlushCandidates(
  sqlite: Database.Database,
  input: IdleFlushCandidateInput,
  options: { workerTimeoutMs?: number } = {},
): Promise<IdleFlushCandidate[]> {
  if (sqlite.name === ":memory:" || sqlite.name === "") {
    return Promise.resolve(
      mapRows(sqlite.prepare(candidateSql).all(...params(input)) as IdleFlushCandidateRow[]),
    );
  }
  const active = fileScans.get(sqlite);
  if (active !== undefined) return active;
  const timeoutMs = options.workerTimeoutMs ?? DEFAULT_WORKER_TIMEOUT_MS;
  const scan = runFileScan(resolve(sqlite.name), input, timeoutMs)
    .then(mapRows)
    .finally(() => {
      if (fileScans.get(sqlite) === scan) fileScans.delete(sqlite);
    });
  fileScans.set(sqlite, scan);
  return scan;
}
