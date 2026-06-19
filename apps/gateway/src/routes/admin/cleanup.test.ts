import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import type { AppEnv } from "../../app.js";
import { registerCleanupRoutes } from "./cleanup.js";
import type { AdminApiDeps, CleanupAccess } from "./deps.js";

function appWith(cleanup?: CleanupAccess): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  registerCleanupRoutes(app, { cleanup } as unknown as AdminApiDeps);
  return app;
}

const report = {
  runId: "r1",
  startedAtMs: 1,
  finishedAtMs: 2,
  ok: true,
  trigger: "manual" as const,
  tables: [{ table: "telemetry" as const, archived: true, archivedRows: 3, deletedRows: 3 }],
};

describe("cleanup admin routes", () => {
  it("GET /admin/api/cleanup returns last run + archive list", async () => {
    const cleanup: CleanupAccess = {
      runNow: vi.fn(),
      lastReport: vi.fn(async () => report),
      vacuum: vi.fn(),
      listArchives: vi.fn(async () => [
        { runId: "r1", file: "telemetry.jsonl.gz", bytes: 10, modifiedMs: 5 },
      ]),
      resolveArchive: vi.fn(),
    };
    const res = await appWith(cleanup).request("/admin/api/cleanup");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { lastRun: { runId: string }; archives: unknown[] };
    expect(body.lastRun.runId).toBe("r1");
    expect(body.archives).toHaveLength(1);
  });

  it("POST /admin/api/cleanup/run triggers a pass and returns the report", async () => {
    const runNow = vi.fn(async () => report);
    const cleanup = {
      runNow,
      lastReport: vi.fn(),
      vacuum: vi.fn(),
      listArchives: vi.fn(),
      resolveArchive: vi.fn(),
    };
    const res = await appWith(cleanup).request("/admin/api/cleanup/run", { method: "POST" });
    expect(res.status).toBe(200);
    expect(runNow).toHaveBeenCalledOnce();
    expect(((await res.json()) as { runId: string }).runId).toBe("r1");
  });

  it("POST /admin/api/cleanup/vacuum calls vacuum", async () => {
    const vacuum = vi.fn(async () => {});
    const cleanup = {
      runNow: vi.fn(),
      lastReport: vi.fn(),
      vacuum,
      listArchives: vi.fn(),
      resolveArchive: vi.fn(),
    };
    const res = await appWith(cleanup).request("/admin/api/cleanup/vacuum", { method: "POST" });
    expect(res.status).toBe(200);
    expect(vacuum).toHaveBeenCalledOnce();
  });

  it("download 404s an unknown archive (resolveArchive → null)", async () => {
    const cleanup = {
      runNow: vi.fn(),
      lastReport: vi.fn(),
      vacuum: vi.fn(),
      listArchives: vi.fn(),
      resolveArchive: vi.fn(async () => null),
    };
    const res = await appWith(cleanup).request("/admin/api/cleanup/archives/r1/nope.jsonl.gz");
    expect(res.status).toBe(404);
  });

  it("all routes 503 when cleanup is not wired", async () => {
    const app = appWith(undefined);
    expect((await app.request("/admin/api/cleanup")).status).toBe(503);
    expect((await app.request("/admin/api/cleanup/run", { method: "POST" })).status).toBe(503);
    expect((await app.request("/admin/api/cleanup/vacuum", { method: "POST" })).status).toBe(503);
  });
});
