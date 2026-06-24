import { createHash } from "node:crypto";
import { once } from "node:events";
import { createWriteStream } from "node:fs";
import { mkdir, open, rename, rm, rmdir, stat, statfs, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createGzip } from "node:zlib";
import {
  ArchiveDiskFullError,
  type ArchivedTableResult,
  type ArchiveManifest,
  type ArchiveSink,
} from "./types.js";

export interface LocalVolumeSinkOptions {
  // Refuse to start a table archive when the volume's free space is below this many
  // bytes (pre-flight guard so we never wedge the disk mid-write — and never delete
  // after a doomed archive). Default 100 MB.
  minFreeBytes?: number;
}

// Default ArchiveSink: gzip-JSONL files on a mounted directory.
// Layout: <baseDir>/<runId>/<table>.jsonl.gz  + <baseDir>/<runId>/manifest.json
//
// Durability (the SRE requirements from the design panel):
//   1. pre-flight free-space check → throw ArchiveDiskFullError before any write;
//   2. write to a .tmp file, fsync it, THEN atomic-rename to the final name — so a
//      crash/partial write never leaves a half file the runner would trust;
//   3. sha256 is taken over the COMPRESSED bytes as they stream out, returned for
//      the runner's verify-before-delete check.
export class LocalVolumeSink implements ArchiveSink {
  private readonly minFreeBytes: number;
  constructor(
    private readonly baseDir: string,
    opts: LocalVolumeSinkOptions = {},
  ) {
    this.minFreeBytes = opts.minFreeBytes ?? 100 * 1024 * 1024;
  }

  async archiveTable(
    runId: string,
    table: string,
    rows: AsyncIterable<unknown>,
  ): Promise<ArchivedTableResult> {
    const dir = join(this.baseDir, runId);
    const finalPath = join(dir, `${table}.jsonl.gz`);
    const tmpPath = `${finalPath}.tmp`;
    await mkdir(dir, { recursive: true });

    const hash = createHash("sha256");
    let gz: ReturnType<typeof createGzip> | undefined;
    let out: ReturnType<typeof createWriteStream> | undefined;
    let rowCount = 0;
    try {
      // Pre-flight BEFORE opening any stream, so a disk-full archive never even
      // creates a .tmp; its throw is caught below (dir cleanup) like any other.
      await this.assertFreeSpace(dir);

      gz = createGzip();
      out = createWriteStream(tmpPath);
      // EventEmitter broadcasts each chunk to BOTH listeners: pipe feeds the file,
      // our listener feeds the hash — so the digest covers exactly the bytes on disk.
      gz.on("data", (chunk: Buffer) => hash.update(chunk));
      gz.pipe(out);

      for await (const row of rows) {
        if (!gz.write(`${JSON.stringify(row)}\n`)) await once(gz, "drain");
        rowCount++;
      }
      gz.end();
      await once(out, "finish");
      // fsync the data to disk before the rename (rename alone is not durable).
      const fd = await open(tmpPath, "r+");
      try {
        await fd.sync();
      } finally {
        await fd.close();
      }
      await rename(tmpPath, finalPath);
    } catch (err) {
      // Leave NO residue: drop the temp file, AND remove the run dir if THIS failure
      // left it empty — a non-recursive rmdir only deletes an empty dir, so a sibling
      // table's already-archived .gz keeps it. Without this, every failed/aborted
      // archive (the gzip-choke incident) orphaned an empty <runId>/ folder. Re-throw
      // so the runner skips the delete for this table (rows survive).
      gz?.destroy();
      out?.destroy();
      await rm(tmpPath, { force: true }).catch(() => {});
      await rmdir(dir).catch(() => {});
      throw err;
    }

    const { size } = await stat(finalPath);
    return { table, file: finalPath, rowCount, bytes: size, sha256: hash.digest("hex") };
  }

  async writeManifest(manifest: ArchiveManifest): Promise<void> {
    const dir = join(this.baseDir, manifest.runId);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");
  }

  // statfs is Node 18+; bavail*bsize = bytes available to an unprivileged process.
  private async assertFreeSpace(dir: string): Promise<void> {
    let free: number;
    try {
      const fsStat = await statfs(dir);
      free = fsStat.bavail * fsStat.bsize;
    } catch {
      // If we can't measure (some filesystems), don't block the archive.
      return;
    }
    if (free < this.minFreeBytes) {
      throw new ArchiveDiskFullError(
        `insufficient free space to archive: ${free} bytes free < ${this.minFreeBytes} required`,
      );
    }
  }
}
