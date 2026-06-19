import { createReadStream } from "node:fs";
import { basename } from "node:path";
import { Readable } from "node:stream";
import type { Hono } from "hono";
import type { AppEnv } from "../../app.js";
import type { AdminApiDeps } from "./deps.js";

// /admin/api/cleanup/* — the "Data cleanup" admin surface. Pure HTTP glue
// (Principle 1): every operation is delegated to deps.cleanup (wired in server.ts).
// All routes 503 when cleanup is not wired (e.g. unit tests with a partial deps).
export function registerCleanupRoutes(app: Hono<AppEnv>, deps: AdminApiDeps): void {
  // Status: the last run report + the list of downloadable archive files.
  app.get("/admin/api/cleanup", async (c) => {
    if (!deps.cleanup) return c.json({ error: "cleanup not available" }, 503);
    const [lastRun, archives] = await Promise.all([
      deps.cleanup.lastReport(),
      deps.cleanup.listArchives(),
    ]);
    return c.json({ lastRun, archives });
  });

  // Clean Now: run one pass immediately and return its report.
  app.post("/admin/api/cleanup/run", async (c) => {
    if (!deps.cleanup) return c.json({ error: "cleanup not available" }, 503);
    const report = await deps.cleanup.runNow();
    return c.json(report);
  });

  // Compact database: reclaim on-disk space (sqlite VACUUM; pg no-op).
  app.post("/admin/api/cleanup/vacuum", async (c) => {
    if (!deps.cleanup) return c.json({ error: "cleanup not available" }, 503);
    await deps.cleanup.vacuum();
    return c.json({ ok: true });
  });

  // Download one archive file (gzip-JSONL). The path is resolved + traversal-guarded
  // behind the seam; an unknown/escaping (runId,file) → 404.
  app.get("/admin/api/cleanup/archives/:runId/:file", async (c) => {
    if (!deps.cleanup) return c.json({ error: "cleanup not available" }, 503);
    const runId = c.req.param("runId");
    const file = c.req.param("file");
    const path = await deps.cleanup.resolveArchive(runId, file);
    if (path === null) return c.json({ error: "archive not found" }, 404);
    const webStream = Readable.toWeb(createReadStream(path)) as unknown as ReadableStream;
    return new Response(webStream, {
      headers: {
        "content-type": "application/gzip",
        "content-disposition": `attachment; filename="${basename(file)}"`,
      },
    });
  });
}
