import { describe, expect, it, vi } from "vitest";
import type {
  MemoryMessageArchiveRow,
  MemoryStore,
  OAuthUsageStore,
  RequestPayloadArchiveRow,
  TelemetryArchiveRow,
  TelemetryStore,
} from "../store/ports.js";
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
  it("a failing archive sink with NO safety horizon leaves the table's prune uncalled (legacy over-retain)", async () => {
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

  it("a failing archive sink WITH a safety horizon still prunes past the horizon (H3)", async () => {
    const telemetry = telemetryFake();
    const sink = sinkFake({
      archiveTable: vi.fn(async () => {
        throw new ArchiveDiskFullError("disk full");
      }),
    });
    const report = await runCleanup({
      actions: [{ table: "telemetry", cutoffMs: 500, archive: true, safetyCutoffMs: 100 }],
      telemetry,
      memory: memoryFake(),
      oauthUsage: usageFake(),
      archiveSink: sink,
      runId: "run1",
      now: clock(),
    });
    // Bounded growth: prune runs at the SAFETY cutoff (100), never the window cutoff (500).
    expect(telemetry.pruneTelemetry).toHaveBeenCalledWith(100);
    expect(telemetry.pruneTelemetry).not.toHaveBeenCalledWith(500);
    expect(report.ok).toBe(false); // the archive error is still surfaced
    expect(report.tables[0]?.error).toContain("disk full");
    expect(report.tables[0]?.deletedRows).toBe(3);
  });

  it("archive unavailable (no sink) WITH a safety horizon still prunes past the horizon (H3)", async () => {
    const telemetry = telemetryFake();
    const report = await runCleanup({
      actions: [{ table: "telemetry", cutoffMs: 500, archive: true, safetyCutoffMs: 100 }],
      telemetry,
      memory: memoryFake(),
      oauthUsage: usageFake(),
      // archiveSink omitted
      runId: "run1",
      now: clock(),
    });
    expect(telemetry.pruneTelemetry).toHaveBeenCalledWith(100);
    expect(telemetry.pruneTelemetry).not.toHaveBeenCalledWith(500);
    expect(report.tables[0]?.skipped).toBe(true);
    expect(report.tables[0]?.deletedRows).toBe(3);
  });

  it("a safety prune that itself throws is swallowed; the archive error is still reported (H3)", async () => {
    const telemetry = telemetryFake({
      pruneTelemetry: vi.fn(async () => {
        throw new Error("prune boom");
      }),
    });
    const sink = sinkFake({
      archiveTable: vi.fn(async () => {
        throw new ArchiveDiskFullError("disk full");
      }),
    });
    const report = await runCleanup({
      actions: [{ table: "telemetry", cutoffMs: 500, archive: true, safetyCutoffMs: 100 }],
      telemetry,
      memory: memoryFake(),
      oauthUsage: usageFake(),
      archiveSink: sink,
      runId: "run1",
      now: clock(),
    });
    expect(report.ok).toBe(false);
    expect(report.tables[0]?.error).toContain("disk full"); // original error, not "prune boom"
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

  it("a failing writeManifest is swallowed (manifest write is best-effort)", async () => {
    // Lines 175-176: writeManifest catch — a manifest write failure must not set ok=false
    // or prevent the function from returning. The archive-first path succeeded; the
    // manifest is a convenience ledger, not a correctness gate.
    const telemetry = telemetryFake();
    const sink = sinkFake({
      writeManifest: vi.fn(async () => {
        throw new Error("disk full");
      }),
    });
    const log = vi.fn();
    const report = await runCleanup({
      actions: [{ table: "telemetry", cutoffMs: 500, archive: true }],
      telemetry,
      memory: memoryFake(),
      oauthUsage: usageFake(),
      archiveSink: sink,
      runId: "run1",
      now: clock(),
      log,
    });
    // The prune still happened (archive succeeded, only manifest failed).
    expect(telemetry.pruneTelemetry).toHaveBeenCalledWith(500);
    expect(report.ok).toBe(true); // manifest failure does not set ok=false
    expect(log).toHaveBeenCalledWith(
      "cleanup.manifest.failed",
      expect.objectContaining({ error: "disk full" }),
    );
  });

  it("request_payloads: prune wrapper counts first then deletes, returning the pre-count", async () => {
    // Lines 216-227: the request_payloads opsFor branch wraps prunePayloads (void→number)
    // by pre-counting with countPayloadsOlderThan, then calling prunePayloads.
    const telemetry = telemetryFake({
      // countPayloadsOlderThan returns 7 → that should be the reported deletedRows.
      countPayloadsOlderThan: vi.fn(async () => 7),
      selectPayloadsOlderThan: vi.fn(async () => []),
    });
    const report = await runCleanup({
      actions: [{ table: "request_payloads", cutoffMs: 200, archive: false }],
      telemetry,
      memory: memoryFake(),
      oauthUsage: usageFake(),
      runId: "run1",
      now: clock(),
    });
    // countPayloadsOlderThan is called once (in prune wrapper), prunePayloads once.
    expect(telemetry.countPayloadsOlderThan).toHaveBeenCalledWith(200);
    expect(telemetry.prunePayloads).toHaveBeenCalledWith(200);
    const row = report.tables[0];
    expect(row?.table).toBe("request_payloads");
    expect(row?.deletedRows).toBe(7);
    expect(report.ok).toBe(true);
  });

  it("request_payloads with archive=true: archives then prune-wraps (count+delete)", async () => {
    // Also exercises the archive-first path for request_payloads (select + archiveTable),
    // then the prune wrapper for the delete step.
    const telemetry = telemetryFake({
      countPayloadsOlderThan: vi.fn(async () => 2),
      // Only `id` matters for the keyset paging loop under test.
      selectPayloadsOlderThan: vi.fn(async (_c, _l, after?: string) =>
        after === undefined ? ([{ id: "p1" }, { id: "p2" }] as RequestPayloadArchiveRow[]) : [],
      ),
    });
    const sink = sinkFake();
    const report = await runCleanup({
      actions: [{ table: "request_payloads", cutoffMs: 300, archive: true }],
      telemetry,
      memory: memoryFake(),
      oauthUsage: usageFake(),
      archiveSink: sink,
      runId: "run1",
      now: clock(),
    });
    expect(sink.archiveTable).toHaveBeenCalledOnce();
    // prune wrapper: count was 2 (for the pre-count), prunePayloads called once.
    expect(telemetry.prunePayloads).toHaveBeenCalledWith(300);
    expect(report.ok).toBe(true);
  });

  it("memory_messages archive-first: archives then prunes via pruneMessagesOlderThan", async () => {
    // Lines 229-234: memory_messages case in opsFor — an archive=true action for messages.
    const memory = memoryFake({
      countMessagesOlderThan: vi.fn(async () => 5),
      selectMessagesOlderThan: vi.fn(async (_c, _l, after?: string) =>
        after === undefined ? ([{ id: "m1" }, { id: "m2" }] as MemoryMessageArchiveRow[]) : [],
      ),
      pruneMessagesOlderThan: vi.fn(async () => 5),
    });
    const sink = sinkFake();
    const report = await runCleanup({
      actions: [{ table: "memory_messages", cutoffMs: 400, archive: true }],
      telemetry: telemetryFake(),
      memory,
      oauthUsage: usageFake(),
      archiveSink: sink,
      runId: "run1",
      now: clock(),
    });
    expect(sink.archiveTable).toHaveBeenCalledOnce();
    expect(memory.pruneMessagesOlderThan).toHaveBeenCalledWith(400);
    expect(report.tables[0]?.deletedRows).toBe(5);
    expect(report.ok).toBe(true);
  });

  it("memory_derived: skipped (deletedRows=0) when pruneExpiredMemory is absent", async () => {
    // Line 250: the `undefined` branch of memory_derived's opsFor — no prune method
    // means opsFor returns { archivable: false, prune: undefined }, which causes the
    // runner to push a skipped table report (same path as oauth_usage missing prune).
    const memory = memoryFake({
      pruneExpiredMemory: undefined,
    });
    const report = await runCleanup({
      actions: [{ table: "memory_derived", cutoffMs: 100, archive: false }],
      telemetry: telemetryFake(),
      memory,
      oauthUsage: usageFake(),
      runId: "run1",
      now: clock(),
    });
    expect(report.tables[0]?.skipped).toBe(true);
    expect(report.ok).toBe(true);
  });

  it("request_payloads: skipped when countPayloadsOlderThan is absent (no prune method)", async () => {
    // Line 226: the `: undefined` branch — when the telemetry adapter has no
    // countPayloadsOlderThan, opsFor returns prune=undefined → the table is skipped.
    const telemetry = telemetryFake({
      countPayloadsOlderThan: undefined,
    });
    const report = await runCleanup({
      actions: [{ table: "request_payloads", cutoffMs: 200, archive: false }],
      telemetry,
      memory: memoryFake(),
      oauthUsage: usageFake(),
      runId: "run1",
      now: clock(),
    });
    expect(report.tables[0]?.skipped).toBe(true);
    expect(report.ok).toBe(true);
  });

  it("pageRows pages through multiple result pages via keyset cursor", async () => {
    // Lines 191-197: the multi-page continuation in pageRows — the `after` variable
    // is advanced when a full page is returned, and the loop terminates when the
    // next page is empty. Exercise this via a real archive-first run with pageSize=1
    // (two rows → two pages + one empty page to terminate).
    //
    // NOTE: the default sinkFake.archiveTable ignores the async iterable — we need
    // a sink that actually consumes it so the generator runs and calls select().
    const telemetry = telemetryFake({
      countTelemetryOlderThan: vi.fn(async () => 2),
      selectTelemetryOlderThan: vi.fn(
        async (_c: number, _l: number, after?: string): Promise<TelemetryArchiveRow[]> => {
          if (after === undefined) return [{ id: "row1" }] as TelemetryArchiveRow[]; // page 1 (full → continue)
          if (after === "row1") return [{ id: "row2" }] as TelemetryArchiveRow[]; // page 2 (full → continue)
          return []; // page 3 (empty → stop)
        },
      ),
    });
    const sink = sinkFake({
      archiveTable: vi.fn(
        async (_runId, table, rows: AsyncIterable<unknown>): Promise<ArchivedTableResult> => {
          // Consume the iterable so pageRows actually runs its loop.
          // biome-ignore lint/suspicious/noExplicitAny: consuming async iterable
          for await (const _r of rows as AsyncIterable<any>) {
            // drain
          }
          return {
            table,
            file: `/archive/${table}.jsonl.gz`,
            rowCount: 2,
            bytes: 50,
            sha256: "a".repeat(64),
          };
        },
      ),
    });
    const report = await runCleanup({
      actions: [{ table: "telemetry", cutoffMs: 500, archive: true }],
      telemetry,
      memory: memoryFake(),
      oauthUsage: usageFake(),
      archiveSink: sink,
      runId: "run1",
      now: clock(),
      pageSize: 1, // force single-row pages to exercise the keyset loop
    });
    expect(report.ok).toBe(true);
    // selectTelemetryOlderThan: called for page1, page2, page3 (empty terminator).
    expect(telemetry.selectTelemetryOlderThan).toHaveBeenCalledTimes(3);
  });
});
