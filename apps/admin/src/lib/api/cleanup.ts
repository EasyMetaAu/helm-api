// Admin "Data cleanup" API client. Pure consumer of /admin/api/cleanup/* (the
// gateway owns all logic). Types mirror the core CleanupReport / archive shapes;
// duplicated here as UI-facing types only (admin must not import core).

export type CleanupTable =
  | 'telemetry'
  | 'request_payloads'
  | 'memory_messages'
  | 'oauth_usage'
  | 'memory_jobs'
  | 'memory_derived';

export interface CleanupTableReport {
  table: CleanupTable;
  archived: boolean;
  archivedRows: number;
  deletedRows: number;
  archiveFile?: string;
  sha256?: string;
  skipped?: boolean;
  error?: string;
}

export interface CleanupReport {
  runId: string;
  startedAtMs: number;
  finishedAtMs: number;
  ok: boolean;
  trigger: 'scheduled' | 'manual';
  tables: CleanupTableReport[];
}

export interface CleanupArchiveEntry {
  runId: string;
  file: string;
  bytes: number;
  modifiedMs: number;
}

export interface CleanupStatus {
  lastRun: CleanupReport | null;
  archives: CleanupArchiveEntry[];
}

const BASE = '/admin/api/cleanup';

async function asJson<T>(res: Response): Promise<T> {
  if (!res.ok) {
    let detail = '';
    try {
      detail = JSON.stringify(await res.json());
    } catch {
      // body not JSON; keep the status only
    }
    throw new Error(`cleanup api ${res.status}${detail ? `: ${detail}` : ''}`);
  }
  return (await res.json()) as T;
}

// GET /admin/api/cleanup -> last run report + downloadable archive list.
export async function getCleanupStatus(): Promise<CleanupStatus> {
  const res = await fetch(BASE, { headers: { accept: 'application/json' } });
  return asJson<CleanupStatus>(res);
}

// POST /admin/api/cleanup/run -> run one pass now; returns its report.
export async function runCleanupNow(): Promise<CleanupReport> {
  const res = await fetch(`${BASE}/run`, { method: 'POST' });
  return asJson<CleanupReport>(res);
}

// POST /admin/api/cleanup/vacuum -> reclaim on-disk space (sqlite VACUUM).
export async function vacuumDatabase(): Promise<void> {
  const res = await fetch(`${BASE}/vacuum`, { method: 'POST' });
  await asJson<{ ok: boolean }>(res);
}

// Download URL for one archive file (a browser navigation / <a download>).
export function archiveDownloadUrl(entry: CleanupArchiveEntry): string {
  return `${BASE}/archives/${encodeURIComponent(entry.runId)}/${encodeURIComponent(entry.file)}`;
}
