import { randomUUID } from "node:crypto";
import { readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { LocalVolumeSink } from "./local-volume-sink.js";
import { ArchiveDiskFullError } from "./types.js";

async function* rowsOf(items: unknown[]): AsyncIterable<unknown> {
  for (const it of items) yield it;
}

describe("LocalVolumeSink", () => {
  let base: string;
  afterEach(async () => {
    if (base) await rm(base, { recursive: true, force: true });
  });

  it("writes verified gzip-JSONL, leaves no temp file, and round-trips on gunzip", async () => {
    base = join(tmpdir(), `helm-archive-${randomUUID()}`);
    const sink = new LocalVolumeSink(base);
    const rows = [
      { id: "a", v: 1 },
      { id: "b", v: 2, nested: { x: "y" } },
    ];
    const res = await sink.archiveTable("run1", "telemetry", rowsOf(rows));

    expect(res.rowCount).toBe(2);
    expect(res.bytes).toBeGreaterThan(0);
    expect(res.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(res.file).toBe(join(base, "run1", "telemetry.jsonl.gz"));

    // No leftover .tmp artifact.
    const dirEntries = await readdir(join(base, "run1"));
    expect(dirEntries).toEqual(["telemetry.jsonl.gz"]);

    // gunzip → JSONL → original rows.
    const buf = await readFile(res.file);
    const text = gunzipSync(buf).toString("utf8");
    const parsed = text
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(parsed).toEqual(rows);
  });

  it("refuses to write when free space is below the floor (no final artifact)", async () => {
    base = join(tmpdir(), `helm-archive-${randomUUID()}`);
    const sink = new LocalVolumeSink(base, { minFreeBytes: Number.MAX_SAFE_INTEGER });
    await expect(
      sink.archiveTable("run1", "telemetry", rowsOf([{ id: "a" }])),
    ).rejects.toBeInstanceOf(ArchiveDiskFullError);
    // The run dir may be created by the pre-flight mkdir, but no archive file exists.
    const entries = await readdir(join(base, "run1")).catch(() => []);
    expect(entries).toEqual([]);
  });

  it("removes the run dir when archiving fails mid-stream (no orphan empty folder)", async () => {
    base = join(tmpdir(), `helm-archive-${randomUUID()}`);
    const sink = new LocalVolumeSink(base);
    async function* boom(): AsyncIterable<unknown> {
      yield { id: "a" };
      throw new Error("stream blew up");
    }
    await expect(sink.archiveTable("run1", "telemetry", boom())).rejects.toThrow("stream blew up");
    // Bug A: the failed archive must leave NO empty <runId>/ folder behind.
    const entries = await readdir(base).catch(() => []);
    expect(entries).toEqual([]);
  });

  it("removes the run dir when the pre-flight space check fails (no orphan folder)", async () => {
    base = join(tmpdir(), `helm-archive-${randomUUID()}`);
    const sink = new LocalVolumeSink(base, { minFreeBytes: Number.MAX_SAFE_INTEGER });
    await expect(
      sink.archiveTable("run1", "telemetry", rowsOf([{ id: "a" }])),
    ).rejects.toBeInstanceOf(ArchiveDiskFullError);
    const entries = await readdir(base).catch(() => []);
    expect(entries).toEqual([]);
  });

  it("keeps a sibling table's archive when a later table in the same run fails", async () => {
    base = join(tmpdir(), `helm-archive-${randomUUID()}`);
    const sink = new LocalVolumeSink(base);
    await sink.archiveTable("run1", "telemetry", rowsOf([{ id: "a" }]));
    // A second table in the SAME run fails its pre-flight: the run dir must survive
    // (non-recursive rmdir won't delete it because telemetry.jsonl.gz is present).
    const tightSink = new LocalVolumeSink(base, { minFreeBytes: Number.MAX_SAFE_INTEGER });
    await expect(
      tightSink.archiveTable("run1", "payloads", rowsOf([{ id: "b" }])),
    ).rejects.toBeInstanceOf(ArchiveDiskFullError);
    const entries = await readdir(join(base, "run1"));
    expect(entries).toEqual(["telemetry.jsonl.gz"]);
  });

  it("writes a run manifest as readable JSON", async () => {
    base = join(tmpdir(), `helm-archive-${randomUUID()}`);
    const sink = new LocalVolumeSink(base);
    await sink.writeManifest({
      runId: "run1",
      createdAtMs: 123,
      tables: [
        { table: "telemetry", file: "x", rowCount: 2, bytes: 10, sha256: "deadbeef", cutoffMs: 99 },
      ],
    });
    const manifest = JSON.parse(await readFile(join(base, "run1", "manifest.json"), "utf8"));
    expect(manifest.runId).toBe("run1");
    expect(manifest.tables[0].table).toBe("telemetry");
    expect(manifest.tables[0].cutoffMs).toBe(99);
  });
});
