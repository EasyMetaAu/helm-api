import { readdir, stat } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import type { CleanupArchiveEntry } from "./deps.js";

// Filesystem seam for the LocalVolumeSink archive directory. Kept OUT of the route
// (Principle 1: routes are HTTP glue) and out of core (this is gateway infra for the
// local-volume sink specifically). Exposes a safe listing + a path resolver with a
// traversal guard so a download request can never escape the archive directory.

export interface ArchiveFsAccess {
  listArchives(): Promise<CleanupArchiveEntry[]>;
  resolveArchive(runId: string, file: string): Promise<string | null>;
}

// Reject any segment that could traverse out of the archive dir. runId/file are
// single path segments — no separators, no "..", no absolute paths.
function isSafeSegment(seg: string): boolean {
  return (
    seg.length > 0 && !seg.includes("/") && !seg.includes("\\") && seg !== ".." && !isAbsolute(seg)
  );
}

export function createArchiveFsAccess(archiveDir: string): ArchiveFsAccess {
  const root = resolve(archiveDir);
  return {
    async listArchives(): Promise<CleanupArchiveEntry[]> {
      let runDirs: string[];
      try {
        runDirs = await readdir(root);
      } catch {
        return []; // dir not created yet (no run has archived anything)
      }
      const entries: CleanupArchiveEntry[] = [];
      for (const runId of runDirs) {
        if (!isSafeSegment(runId)) continue;
        let files: string[];
        try {
          files = await readdir(join(root, runId));
        } catch {
          continue;
        }
        for (const file of files) {
          if (!file.endsWith(".jsonl.gz")) continue;
          try {
            const s = await stat(join(root, runId, file));
            entries.push({ runId, file, bytes: s.size, modifiedMs: s.mtimeMs });
          } catch {
            // skip a file that vanished between readdir and stat
          }
        }
      }
      // Newest first.
      entries.sort((a, b) => b.modifiedMs - a.modifiedMs);
      return entries;
    },

    async resolveArchive(runId: string, file: string): Promise<string | null> {
      if (!isSafeSegment(runId) || !isSafeSegment(file)) return null;
      if (!file.endsWith(".jsonl.gz")) return null;
      const path = resolve(root, runId, file);
      // Defense in depth: the resolved path MUST stay under the archive root.
      if (path !== join(root, runId, file)) return null;
      if (!path.startsWith(`${root}/`)) return null;
      try {
        const s = await stat(path);
        return s.isFile() ? path : null;
      } catch {
        return null;
      }
    },
  };
}
