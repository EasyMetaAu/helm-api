import { RuntimeSettingsSchema } from "@helm/shared";
import { describe, expect, it, vi } from "vitest";
import type { ConfigStore, MemoryStore, OAuthUsageStore, TelemetryStore } from "../store/ports.js";
import type { ArchiveSink } from "./archive/types.js";
import {
  CLEANUP_LAST_RUN_KEY,
  type RunCleanupPassDeps,
  readLastCleanupReport,
  runCleanupPass,
} from "./run-pass.js";

// Minimal RuntimeSettings (all cleanup categories off so buildCleanupPlan
// returns an empty actions list — runCleanup returns immediately with ok:true).
const BASE_SETTINGS = RuntimeSettingsSchema.parse({
  telemetry_cleanup_enabled: false,
  payloads_cleanup_enabled: false,
  memory_messages_cleanup_enabled: false,
  oauth_usage_cleanup_enabled: false,
  memory_jobs_cleanup_enabled: false,
  memory_derived_cleanup_enabled: false,
});

function telemetryFake(): TelemetryStore {
  return {
    pruneTelemetry: vi.fn(async () => 0),
    prunePayloads: vi.fn(async () => {}),
  } as unknown as TelemetryStore;
}

function memoryFake(): MemoryStore {
  return {
    pruneMessagesOlderThan: vi.fn(async () => 0),
    pruneFinishedJobsOlderThan: vi.fn(async () => 0),
    pruneExpiredMemory: vi.fn(async () => ({ observationsDeleted: 0, factsDeleted: 0 })),
  } as unknown as MemoryStore;
}

function usageFake(): OAuthUsageStore {
  return { pruneUsageOlderThan: vi.fn(async () => 0) } as unknown as OAuthUsageStore;
}

function configFake(over: Partial<ConfigStore> = {}): ConfigStore {
  return {
    get: vi.fn(async () => null),
    set: vi.fn(async () => {}),
    ...over,
  } as unknown as ConfigStore;
}

function makeDeps(over: Partial<RunCleanupPassDeps> = {}): RunCleanupPassDeps {
  return {
    settings: BASE_SETTINGS,
    telemetry: telemetryFake(),
    memory: memoryFake(),
    oauthUsage: usageFake(),
    config: configFake(),
    runId: "test-run-1",
    now: () => 1_000_000,
    trigger: "scheduled",
    log: vi.fn(),
    ...over,
  };
}

describe("runCleanupPass", () => {
  it("returns a StoredCleanupReport that merges report + trigger", async () => {
    const deps = makeDeps({ trigger: "manual" });
    const result = await runCleanupPass(deps);

    expect(result.trigger).toBe("manual");
    expect(result.runId).toBe("test-run-1");
    expect(result.ok).toBe(true);
    expect(Array.isArray(result.tables)).toBe(true);
  });

  it("persists the report to config_kv under CLEANUP_LAST_RUN_KEY", async () => {
    const config = configFake();
    const deps = makeDeps({ config, trigger: "scheduled" });
    await runCleanupPass(deps);

    expect(config.set).toHaveBeenCalledOnce();
    const [key, value] = (config.set as ReturnType<typeof vi.fn>).mock.calls[0] as [string, string];
    expect(key).toBe(CLEANUP_LAST_RUN_KEY);
    const parsed = JSON.parse(value) as { trigger: string; runId: string };
    expect(parsed.trigger).toBe("scheduled");
    expect(parsed.runId).toBe("test-run-1");
  });

  it("still returns the report if config.set throws (best-effort persist, never thrown)", async () => {
    const config = configFake({
      set: vi.fn(async () => {
        throw new Error("kv store down");
      }),
    });
    const log = vi.fn();
    const deps = makeDeps({ config, log });

    // Must not throw.
    const result = await runCleanupPass(deps);
    expect(result.ok).toBe(true);
    expect(log).toHaveBeenCalledWith(
      "cleanup.persist_report_failed",
      expect.objectContaining({ error: "kv store down" }),
    );
  });

  it("includes trigger 'manual' when deps.trigger is 'manual'", async () => {
    const deps = makeDeps({ trigger: "manual" });
    const result = await runCleanupPass(deps);
    expect(result.trigger).toBe("manual");
  });

  it("optional archiveSink is forwarded to runCleanup (no-op when sink is absent)", async () => {
    // With no archiveSink and no archive-enabled tables, should complete cleanly.
    const deps = makeDeps({ archiveSink: undefined });
    const result = await runCleanupPass(deps);
    expect(result.ok).toBe(true);
  });

  it("passes an archiveSink through to runCleanup when provided", async () => {
    const sink: ArchiveSink = {
      archiveTable: vi.fn(async () => ({
        table: "telemetry" as const,
        file: "/tmp/t.jsonl.gz",
        rowCount: 0,
        bytes: 0,
        sha256: "a".repeat(64),
      })),
      writeManifest: vi.fn(async () => {}),
    };
    const deps = makeDeps({ archiveSink: sink });
    const result = await runCleanupPass(deps);
    expect(result.ok).toBe(true);
    // sink was passed through — not called because no archive-enabled categories.
    expect(sink.archiveTable).not.toHaveBeenCalled();
  });

  it("log callback is optional — omitting it does not throw", async () => {
    const deps = makeDeps({ log: undefined });
    await expect(runCleanupPass(deps)).resolves.toBeDefined();
  });

  it("log callback receives persist_report_failed even when log is set", async () => {
    const config = configFake({
      set: vi.fn(async () => {
        throw new Error("boom");
      }),
    });
    const log = vi.fn();
    await runCleanupPass(makeDeps({ config, log }));
    expect(log).toHaveBeenCalledWith("cleanup.persist_report_failed", expect.any(Object));
  });

  it("coerces non-Error thrown values to string in the persist-failure log", async () => {
    // Covers the `String(err)` branch of `err instanceof Error ? ... : String(err)`.
    const config = configFake({
      set: vi.fn(async () => {
        // eslint-disable-next-line @typescript-eslint/only-throw-error
        throw "raw string error";
      }),
    });
    const log = vi.fn();
    await runCleanupPass(makeDeps({ config, log }));
    const meta = (log as ReturnType<typeof vi.fn>).mock.calls[0]?.[1] as { error: string };
    expect(meta?.error).toBe("raw string error");
  });
});

describe("readLastCleanupReport", () => {
  it("returns null when the key is absent", async () => {
    const config = configFake({ get: vi.fn(async () => null) });
    expect(await readLastCleanupReport(config)).toBeNull();
  });

  it("parses and returns a valid stored report", async () => {
    const stored = {
      runId: "run-xyz",
      startedAtMs: 1_000,
      finishedAtMs: 2_000,
      ok: true,
      tables: [],
      trigger: "scheduled",
    };
    const config = configFake({ get: vi.fn(async () => JSON.stringify(stored)) });
    const result = await readLastCleanupReport(config);
    expect(result).toMatchObject({ runId: "run-xyz", trigger: "scheduled" });
  });

  it("returns null when the stored value is malformed JSON", async () => {
    const config = configFake({ get: vi.fn(async () => "not-json{{{") });
    expect(await readLastCleanupReport(config)).toBeNull();
  });
});
