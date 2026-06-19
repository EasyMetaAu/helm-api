// Archive sink contract. The cleanup runner streams a table's to-be-deleted rows
// into a sink, which durably writes + verifies them BEFORE the runner issues any
// delete. The default LocalVolumeSink writes gzip-JSONL to a mounted directory; an
// S3 sink can implement the same interface later without touching the runner.

// Result of archiving ONE table within a run — the runner folds these into the
// run manifest and uses `sha256`/`rowCount` as the verify-before-delete proof.
export interface ArchivedTableResult {
  table: string;
  file: string; // path (or key) of the written archive object
  rowCount: number;
  bytes: number; // compressed size on disk
  sha256: string; // sha256 of the COMPRESSED bytes (integrity proof)
}

// One table entry in a run manifest. Mirrors ArchivedTableResult + the age cutoff
// the rows were selected by, so a future re-ingest knows exactly what it holds.
export interface ArchiveManifestTable extends ArchivedTableResult {
  cutoffMs: number;
}

export interface ArchiveManifest {
  runId: string;
  createdAtMs: number;
  tables: ArchiveManifestTable[];
}

// Thrown by a sink that cannot safely write (e.g. insufficient free disk). The
// runner treats it as "archive failed" → it does NOT delete that table's rows.
export class ArchiveDiskFullError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArchiveDiskFullError";
  }
}

export interface ArchiveSink {
  // Durably write one table's rows. MUST fsync + verify before resolving; on any
  // failure it MUST throw (and leave no partial final artifact) so the runner can
  // safely skip the delete. Rows are an async iterable so the runner can stream
  // keyset pages without holding the whole table in memory.
  archiveTable(
    runId: string,
    table: string,
    rows: AsyncIterable<unknown>,
  ): Promise<ArchivedTableResult>;
  // Persist the run manifest after all tables succeed. Best-effort metadata.
  writeManifest(manifest: ArchiveManifest): Promise<void>;
}
