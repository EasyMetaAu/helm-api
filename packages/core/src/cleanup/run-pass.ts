import type { RuntimeSettings } from "@helm/shared";
import type { ConfigStore, MemoryStore, OAuthUsageStore, TelemetryStore } from "../store/ports.js";
import type { ArchiveSink } from "./archive/types.js";
import { buildCleanupPlan } from "./cleanup-plan.js";
import { type CleanupReport, runCleanup } from "./cleanup-runner.js";

// config_kv key holding the LATEST cleanup run's report (the admin "last run" panel
// reads it). A single-snapshot ledger — simpler than a dedicated table and adequate
// for "when did cleanup last run and what did it remove". The whole record is small.
export const CLEANUP_LAST_RUN_KEY = "cleanup_last_run";

export type CleanupTrigger = "scheduled" | "manual";

export interface StoredCleanupReport extends CleanupReport {
  trigger: CleanupTrigger;
}

export interface RunCleanupPassDeps {
  settings: RuntimeSettings;
  telemetry: TelemetryStore;
  memory: MemoryStore;
  oauthUsage: OAuthUsageStore;
  config: ConfigStore;
  archiveSink?: ArchiveSink;
  runId: string;
  now: () => number;
  trigger: CleanupTrigger;
  log?: (line: string, meta?: object) => void;
}

// One full cleanup pass — the SINGLE entry point shared by the scheduled tick and
// the manual "Clean Now" button. Builds the plan from the LIVE settings, runs it,
// and persists the report snapshot to config_kv (best-effort — a persist failure is
// logged, never thrown). Returns the report (with the trigger) for the caller.
export async function runCleanupPass(deps: RunCleanupPassDeps): Promise<StoredCleanupReport> {
  const actions = buildCleanupPlan(deps.settings, deps.now());
  const report = await runCleanup({
    actions,
    telemetry: deps.telemetry,
    memory: deps.memory,
    oauthUsage: deps.oauthUsage,
    archiveSink: deps.archiveSink,
    runId: deps.runId,
    now: deps.now,
    log: deps.log,
  });
  const stored: StoredCleanupReport = { ...report, trigger: deps.trigger };
  try {
    await deps.config.set(CLEANUP_LAST_RUN_KEY, JSON.stringify(stored));
  } catch (err) {
    deps.log?.("cleanup.persist_report_failed", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
  return stored;
}

// Read the last persisted run report (null if cleanup has never run). The admin
// status endpoint surfaces this.
export async function readLastCleanupReport(
  config: ConfigStore,
): Promise<StoredCleanupReport | null> {
  const raw = await config.get(CLEANUP_LAST_RUN_KEY);
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as StoredCleanupReport;
  } catch {
    return null;
  }
}
