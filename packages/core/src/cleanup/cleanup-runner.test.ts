import { describe, expect, it, vi } from "vitest";
import type { MemoryStore, OAuthUsageStore, TelemetryStore } from "../store/ports.js";
import type { ArchivedTableResult, ArchiveSink } from "./archive/types.js";
import { ArchiveDiskFullError } from "./archive/types.js";
import type { CleanupAction } from "./cleanup-plan.js";
import { runCleanup } from "./cleanup-runner.js";

function telemetryFake(over: Partial<TelemetryStore> = {}): TelemetryStore {
  return {
    countTelemetryOlderThan: vi.fn(async () => 3),
    selectTelemetryOlderThan: vi.fn(async (_c, _l, after?: string) =>
      after === undefined ? [{ id: "a" }, { id: "b" }, { id: "c" }] : [],
    ),
    pruneTelemetry: vi.fn(async () => 3),
    countPayloadsOlderThan: vi.fn(async () => 2),
    selectPayloadsOlderThan: vi.fn(async (_c, _l, after?: string) =>
      after === undefined ? [{ id: "p1" }, { id: "p2" }] : [],
    ),
    prunePayloads: vi.fn(async () => {}),
    ...over,
  } as unknown as TelemetryStore;
}

function memoryFake(over: Partial<MemoryStore> = {}): MemoryStore {
  return {
    countMessagesOlderThan: vi.fn(async () => 0),
    selectMessagesOlderThan: vi.fn(async () => []),
    pruneMessagesOlderThan: vi.fn(async () => 0),
    pruneFinishedJobsOlderThan: vi.fn(async () => 5),
    pruneExpiredMemory: vi.fn(async () => ({ observationsDeleted: 1, factsDeleted: 2 })),
    ...over,
  } as unknown as MemoryStore;
}

function usageFake(over: Partial<OAuthUsageStore> = {}): OAuthUsageStore {
  return { pruneUsageOlderThan: vi.fn(async () => 4), ...over } as unknown as OAuthUsageStore;
}

function sinkFake(over: Partial<ArchiveSink> = {}): ArchiveSink {
  return {
    archiveTable: vi.fn(
      async (_runId, table): Promise<ArchivedTableResult> => ({
        table,
        file: `/archive/${table}.jsonl.gz`,
        rowCount: 3,
        bytes: 100,
        sha256: "f".repeat(64),
      }),
    ),
    writeManifest: vi.fn(async () => {}),
    ...over,
  } as ArchiveSink;
}

const clock = () => {
  let t = 1000;
  return () => (t += 1);
};

describe("runCleanup", () => {
  it("INVARIANT: a failing archive sink means that table's prune is NEVER called", async () => {
    const telemetry = telemetryFake();
    const sink = sinkFake({
      archiveTable: vi.fn(async () => {
        throw new ArchiveDiskFullError("disk full");
      }),
    });
    const actions: CleanupAction[] = [{ table: "telemetry", cutoffMs: 500, archive: true }];

    const report = await runCleanup({
      actions,
      telemetry,
      memory: memoryFake(),
      oauthUsage: usageFake(),
      archiveSink: sink,
      runId: "run1",
      now: clock(),
    });

    expect(telemetry.pruneTelemetry).not.toHaveBeenCalled(); // the whole point
    expect(report.ok).toBe(false);
    expect(report.tables[0]?.error).toContain("disk full");
    expect(report.tables[0]?.deletedRows).toBe(0);
  });

  it("archive-first happy path: archives, then deletes, and writes a manifest", async () => {
    const telemetry = telemetryFake();
    const sink = sinkFake();
    const report = await runCleanup({
      actions: [{ table: "telemetry", cutoffMs: 500, archive: true }],
      telemetry,
      memory: memoryFake(),
      oauthUsage: usageFake(),
      archiveSink: sink,
      runId: "run1",
      now: clock(),
    });

    expect(sink.archiveTable).toHaveBeenCalledOnce();
    expect(telemetry.pruneTelemetry).toHaveBeenCalledWith(500);
    expect(sink.writeManifest).toHaveBeenCalledOnce();
    const row = report.tables[0];
    expect(row?.archived).toBe(true);
    expect(row?.archivedRows).toBe(3);
    expect(row?.deletedRows).toBe(3);
    expect(row?.sha256).toMatch(/^f{64}$/);
    expect(report.ok).toBe(true);
  });

  it("archive:true but NO sink → skips the delete (never deletes unarchived training data)", async () => {
    const telemetry = telemetryFake();
    const report = await runCleanup({
      actions: [{ table: "telemetry", cutoffMs: 500, archive: true }],
      telemetry,
      memory: memoryFake(),
      oauthUsage: usageFake(),
      // archiveSink omitted
      runId: "run1",
      now: clock(),
    });
    expect(telemetry.pruneTelemetry).not.toHaveBeenCalled();
    expect(report.tables[0]?.skipped).toBe(true);
  });

  it("delete-only tables prune without archiving (oauth_usage, memory_jobs, memory_derived)", async () => {
    const memory = memoryFake();
    const usage = usageFake();
    const report = await runCleanup({
      actions: [
        { table: "oauth_usage", cutoffMs: 100, archive: false },
        { table: "memory_jobs", cutoffMs: 200, archive: false },
        { table: "memory_derived", cutoffMs: 300, archive: false },
      ],
      telemetry: telemetryFake(),
      memory,
      oauthUsage: usage,
      runId: "run1",
      now: clock(),
    });
    expect(usage.pruneUsageOlderThan).toHaveBeenCalledWith(100);
    expect(memory.pruneFinishedJobsOlderThan).toHaveBeenCalledWith(200);
    expect(memory.pruneExpiredMemory).toHaveBeenCalledWith({
      archivedObservationsBeforeMs: 300,
      expiredFactsBeforeMs: 300,
    });
    // memory_derived deleted count = observationsDeleted + factsDeleted = 3
    expect(report.tables.find((x) => x.table === "memory_derived")?.deletedRows).toBe(3);
    expect(report.ok).toBe(true);
  });

  it("per-table fail-open: one table's throw does not abort the others", async () => {
    const telemetry = telemetryFake({
      pruneTelemetry: vi.fn(async () => {
        throw new Error("telemetry boom");
      }),
    });
    const usage = usageFake();
    const report = await runCleanup({
      actions: [
        { table: "telemetry", cutoffMs: 1, archive: false },
        { table: "oauth_usage", cutoffMs: 2, archive: false },
      ],
      telemetry,
      memory: memoryFake(),
      oauthUsage: usage,
      runId: "run1",
      now: clock(),
    });
    expect(report.ok).toBe(false);
    expect(usage.pruneUsageOlderThan).toHaveBeenCalledWith(2); // ran despite telemetry failure
  });

  it("unsupported adapter (no prune method) is skipped, not crashed", async () => {
    const report = await runCleanup({
      actions: [{ table: "oauth_usage", cutoffMs: 1, archive: false }],
      telemetry: telemetryFake(),
      memory: memoryFake(),
      oauthUsage: {} as unknown as OAuthUsageStore,
      runId: "run1",
      now: clock(),
    });
    expect(report.tables[0]?.skipped).toBe(true);
    expect(report.ok).toBe(true); // skip is not an error
  });
});
