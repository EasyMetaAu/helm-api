import type { MemoryStore, OAuthUsageStore, TelemetryStore } from "../store/ports.js";
import type { ArchiveManifestTable, ArchiveSink } from "./archive/types.js";
import type { CleanupAction, CleanupTable } from "./cleanup-plan.js";

// Per-table outcome of a cleanup run (the admin "last run" report + audit ledger).
export interface CleanupTableReport {
  table: CleanupTable;
  archived: boolean; // were rows written to an archive file?
  archivedRows: number;
  deletedRows: number;
  archiveFile?: string;
  sha256?: string;
  // Set when the table was skipped without deleting: an unsupported adapter, or an
  // archive that failed (disk full / write error) so the rows were intentionally
  // NOT deleted. error carries the reason. The run is still "ok:false" on a real error.
  skipped?: boolean;
  error?: string;
}

export interface CleanupReport {
  runId: string;
  startedAtMs: number;
  finishedAtMs: number;
  ok: boolean; // false if any table errored (an archive write failure, a store throw)
  tables: CleanupTableReport[];
}

export interface CleanupRunnerDeps {
  actions: CleanupAction[];
  telemetry: TelemetryStore;
  memory: MemoryStore;
  oauthUsage: OAuthUsageStore;
  // Present only when archive-before-delete is enabled. When an action has
  // archive:true but this is absent, the runner SKIPS the delete (never deletes
  // training data unarchived) — fail-safe over-retention.
  archiveSink?: ArchiveSink;
  runId: string;
  now: () => number;
  pageSize?: number;
  log?: (line: string, meta?: object) => void;
}

// One table's store operations, resolved from the adapter (all optional — a store
// double may omit them, in which case the table is skipped, never force-deleted).
interface TableOps {
  archivable: boolean;
  countOlderThan?: (cutoff: number) => Promise<number>;
  select?: (cutoff: number, limit: number, after?: string) => Promise<Array<{ id: string }>>;
  prune?: (cutoff: number) => Promise<number>;
}

const DEFAULT_PAGE = 500;

// Execute a cleanup plan: per action, (optionally) archive the aged rows to a
// verified file, then delete them. CORE INVARIANT: a table's prune at the NORMAL
// window is reached only after its archive resolves successfully — if the sink throws
// (disk full, write error) the window delete is skipped and the rows survive. The ONE
// exception (review H3): rows older than action.safetyCutoffMs are pruned even when
// archive is unavailable/fails, so a persistently-broken sink can't grow the table
// without bound. Per-table fail-open: one table's failure never aborts the rest.
// Returns a structured report for the ledger.
export async function runCleanup(deps: CleanupRunnerDeps): Promise<CleanupReport> {
  const pageSize = deps.pageSize ?? DEFAULT_PAGE;
  const log = deps.log ?? (() => {});
  const startedAtMs = deps.now();
  const tables: CleanupTableReport[] = [];
  const manifestTables: ArchiveManifestTable[] = [];
  let ok = true;

  for (const action of deps.actions) {
    const ops = opsFor(action.table, deps);
    if (!ops?.prune) {
      log("cleanup.table.unsupported", { table: action.table });
      tables.push({
        table: action.table,
        archived: false,
        archivedRows: 0,
        deletedRows: 0,
        skipped: true,
      });
      continue;
    }

    try {
      let archivedRows = 0;
      let archiveFile: string | undefined;
      let sha256: string | undefined;

      if (action.archive) {
        // Archive-first table. If the sink or the archive read-helpers are missing,
        // do NOT delete (over-retain rather than lose unarchived training data).
        if (!deps.archiveSink || !ops.archivable || !ops.select || !ops.countOlderThan) {
          // Archive unavailable: over-retain within the window (don't lose unarchived
          // training data), but STILL prune past the hard safety horizon so growth is
          // bounded (H3). No horizon configured ⇒ legacy skip-delete behavior.
          const deletedRows =
            action.safetyCutoffMs !== undefined ? await ops.prune(action.safetyCutoffMs) : 0;
          log("cleanup.archive.unavailable_skip_delete", { table: action.table, deletedRows });
          tables.push({
            table: action.table,
            archived: false,
            archivedRows: 0,
            deletedRows,
            skipped: true,
            error: "archive unavailable",
          });
          continue;
        }
        const total = await ops.countOlderThan(action.cutoffMs);
        if (total > 0) {
          const select = ops.select;
          const res = await deps.archiveSink.archiveTable(
            deps.runId,
            action.table,
            pageRows(select, action.cutoffMs, pageSize),
          );
          archivedRows = res.rowCount;
          archiveFile = res.file;
          sha256 = res.sha256;
          manifestTables.push({ ...res, cutoffMs: action.cutoffMs });
        }
      }

      // Verified (or nothing to archive) → safe to delete.
      const deletedRows = await ops.prune(action.cutoffMs);
      tables.push({
        table: action.table,
        archived: archivedRows > 0,
        archivedRows,
        deletedRows,
        archiveFile,
        sha256,
      });
      log("cleanup.table.done", { table: action.table, archivedRows, deletedRows });
    } catch (err) {
      // Fail-open: record the error, NEVER let it abort the other tables. Because we
      // throw before reaching prune, the rows for THIS table are left intact at the
      // normal window. Still attempt a best-effort safety-horizon prune (H3) so a
      // persistently-failing sink can't grow the table without bound — fail-open
      // within fail-open (a failing safety prune is swallowed, not re-raised).
      ok = false;
      const message = err instanceof Error ? err.message : String(err);
      let deletedRows = 0;
      if (action.safetyCutoffMs !== undefined && ops.prune) {
        try {
          deletedRows = await ops.prune(action.safetyCutoffMs);
        } catch {
          /* safety prune is best-effort; keep the original archive error as the report */
        }
      }
      tables.push({
        table: action.table,
        archived: false,
        archivedRows: 0,
        deletedRows,
        skipped: true,
        error: message,
      });
      log("cleanup.table.failed", {
        table: action.table,
        error: message,
        safetyDeleted: deletedRows,
      });
    }
  }

  if (deps.archiveSink && manifestTables.length > 0) {
    try {
      await deps.archiveSink.writeManifest({
        runId: deps.runId,
        createdAtMs: startedAtMs,
        tables: manifestTables,
      });
    } catch (err) {
      log("cleanup.manifest.failed", { error: err instanceof Error ? err.message : String(err) });
    }
  }

  return { runId: deps.runId, startedAtMs, finishedAtMs: deps.now(), ok, tables };
}

// Page a table's eligible rows via its keyset cursor, yielding one row at a time so
// the sink streams without holding the whole table in memory.
async function* pageRows(
  select: (cutoff: number, limit: number, after?: string) => Promise<Array<{ id: string }>>,
  cutoff: number,
  pageSize: number,
): AsyncIterable<unknown> {
  let after: string | undefined;
  for (;;) {
    const page = await select(cutoff, pageSize, after);
    if (page.length === 0) return;
    for (const row of page) yield row;
    const last = page[page.length - 1];
    if (page.length < pageSize || !last) return;
    after = last.id;
  }
}

// Resolve a table to its concrete store operations. Archive helpers + prune are all
// optional on the ports; a missing prune ⇒ the runner skips the table.
function opsFor(table: CleanupTable, deps: CleanupRunnerDeps): TableOps | null {
  const t = deps.telemetry;
  const m = deps.memory;
  const u = deps.oauthUsage;
  switch (table) {
    case "telemetry":
      return {
        archivable: true,
        countOlderThan: t.countTelemetryOlderThan?.bind(t),
        select: t.selectTelemetryOlderThan?.bind(t),
        prune: t.pruneTelemetry?.bind(t),
      };
    case "request_payloads":
      // prunePayloads returns void → wrap with a pre-count so the report has a number.
      return {
        archivable: true,
        countOlderThan: t.countPayloadsOlderThan?.bind(t),
        select: t.selectPayloadsOlderThan?.bind(t),
        prune: t.countPayloadsOlderThan
          ? async (cutoff: number) => {
              const n = await (t.countPayloadsOlderThan as (c: number) => Promise<number>)(cutoff);
              await t.prunePayloads(cutoff);
              return n;
            }
          : undefined,
      };
    case "memory_messages":
      return {
        archivable: true,
        countOlderThan: m.countMessagesOlderThan?.bind(m),
        select: m.selectMessagesOlderThan?.bind(m),
        prune: m.pruneMessagesOlderThan?.bind(m),
      };
    case "oauth_usage":
      return { archivable: false, prune: u.pruneUsageOlderThan?.bind(u) };
    case "memory_jobs":
      return { archivable: false, prune: m.pruneFinishedJobsOlderThan?.bind(m) };
    case "memory_derived":
      // Reuse the forgetting hard-delete (archived observations + expired facts).
      return {
        archivable: false,
        prune: m.pruneExpiredMemory
          ? async (cutoff: number) => {
              const r = await (
                m.pruneExpiredMemory as NonNullable<MemoryStore["pruneExpiredMemory"]>
              )({ archivedObservationsBeforeMs: cutoff, expiredFactsBeforeMs: cutoff });
              return r.observationsDeleted + r.factsDeleted;
            }
          : undefined,
      };
    default: {
      const exhaustive: never = table;
      return exhaustive;
    }
  }
}
