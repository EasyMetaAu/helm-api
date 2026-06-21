import type { RuntimeSettings } from "@helm/shared";

// The set of tables the cleanup system knows how to sweep. Category C (api_keys,
// oauth_tokens, config_kv) is deliberately absent — durable identity/secrets/config
// are never auto-cleaned. "memory_derived" is the observations+facts retention pass
// (reuses MemoryStore.pruneExpiredMemory); the rest map 1:1 to a physical table.
export type CleanupTable =
  | "telemetry"
  | "request_payloads"
  | "memory_messages"
  | "oauth_usage"
  | "memory_jobs"
  | "memory_derived";

// One unit of work the runner executes: delete rows in `table` older than
// `cutoffMs` (strict lower bound, epoch ms), archiving them first when `archive`.
// `archive` is only ever true for tables that have a training/audit value AND have
// archive helpers wired (telemetry, request_payloads, memory_messages); it already
// folds in the global cleanup_archive_enabled switch so the runner needn't re-check.
export interface CleanupAction {
  table: CleanupTable;
  cutoffMs: number;
  archive: boolean;
  // Hard safety horizon (epoch ms, OLDER than cutoffMs), set only for archive
  // actions. If archiving is unavailable or the sink fails, the runner still prunes
  // rows older than THIS so a persistently-failing sink can't grow the table without
  // bound (review H3). Absent ⇒ the legacy over-retain-on-archive-failure behavior.
  safetyCutoffMs?: number;
}

const DAY_MS = 86_400_000;

// Multiplier on the retention window for the hard safety-horizon prune (H3): when
// archive-before-delete can't run, rows older than window × this are deleted anyway.
const SAFETY_MULTIPLE = 2;

// Pure: (settings, now) -> the ordered list of cleanup actions. No I/O, no clock —
// the caller injects nowMs so this is fully deterministic and unit-testable. Each
// enabled CATEGORY contributes one action with its own age cutoff; only the three
// training/audit tables carry archive=true (and only when the archive switch is on).
//
// The plan deliberately does NOT consult `cleanup_enabled` — that master switch
// gates only the SCHEDULED sweep (enforced at the scheduler tick). The manual
// "Clean now" button builds + runs this plan even when the schedule is off, so an
// operator can disable automatic cleanup yet still clean on demand. The per-category
// toggles remain the source of truth for WHAT gets cleaned in either path.
export function buildCleanupPlan(settings: RuntimeSettings, nowMs: number): CleanupAction[] {
  const archive = settings.cleanup_archive_enabled;
  const cutoff = (days: number) => nowMs - days * DAY_MS;
  const actions: CleanupAction[] = [];

  // Archive actions also carry a safety horizon (2× window) so a failing/absent sink
  // can't grow the table without bound (H3); non-archive paths prune at cutoffMs and
  // are already bounded, so they omit it.
  const archiveAction = (table: CleanupTable, days: number): CleanupAction => ({
    table,
    cutoffMs: cutoff(days),
    archive,
    ...(archive ? { safetyCutoffMs: cutoff(days * SAFETY_MULTIPLE) } : {}),
  });

  if (settings.telemetry_cleanup_enabled) {
    actions.push(archiveAction("telemetry", settings.telemetry_retention_days));
  }
  if (settings.payloads_cleanup_enabled) {
    // Window REUSES payload_retention_days (single source of truth with the legacy knob).
    actions.push(archiveAction("request_payloads", settings.payload_retention_days));
  }
  if (settings.memory_messages_cleanup_enabled) {
    actions.push(archiveAction("memory_messages", settings.memory_messages_retention_days));
  }
  if (settings.oauth_usage_cleanup_enabled) {
    // Delete-only (observability counters, no training value).
    actions.push({
      table: "oauth_usage",
      cutoffMs: cutoff(settings.oauth_usage_retention_days),
      archive: false,
    });
  }
  if (settings.memory_jobs_cleanup_enabled) {
    actions.push({
      table: "memory_jobs",
      cutoffMs: cutoff(settings.memory_jobs_retention_days),
      archive: false,
    });
  }
  if (settings.memory_derived_cleanup_enabled) {
    actions.push({
      table: "memory_derived",
      cutoffMs: cutoff(settings.memory_derived_retention_days),
      archive: false,
    });
  }
  return actions;
}
