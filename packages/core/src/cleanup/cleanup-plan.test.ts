import { type RuntimeSettings, RuntimeSettingsSchema } from "@helm/shared";
import { describe, expect, it } from "vitest";
import { buildCleanupPlan, type CleanupTable } from "./cleanup-plan.js";

const NOW = 1_000_000_000_000; // fixed epoch ms
const DAY = 86_400_000;

// Full settings = schema defaults, overlaid per test.
function settings(over: Partial<RuntimeSettings> = {}): RuntimeSettings {
  return { ...RuntimeSettingsSchema.parse({}), ...over };
}

describe("buildCleanupPlan", () => {
  it("ignores the master switch — that gates the SCHEDULE, so manual runs still plan", () => {
    // cleanup_enabled only governs the scheduled sweep (enforced at the scheduler
    // tick). buildCleanupPlan reflects the per-category toggles regardless, so the
    // manual "Clean now" button works even when automatic cleanup is off.
    const off = buildCleanupPlan(settings({ cleanup_enabled: false }), NOW);
    const on = buildCleanupPlan(settings({ cleanup_enabled: true }), NOW);
    expect(off).toEqual(on);
    expect(off.length).toBeGreaterThan(0);
  });

  it("an all-categories-off plan is empty regardless of the master switch", () => {
    const plan = buildCleanupPlan(
      settings({
        cleanup_enabled: false,
        telemetry_cleanup_enabled: false,
        payloads_cleanup_enabled: false,
        oauth_usage_cleanup_enabled: false,
        memory_jobs_cleanup_enabled: false,
        memory_messages_cleanup_enabled: false,
        memory_derived_cleanup_enabled: false,
      }),
      NOW,
    );
    expect(plan).toEqual([]);
  });

  it("default settings sweep the ON categories with their windows; opt-in ones are absent", () => {
    const plan = buildCleanupPlan(settings(), NOW);
    const byTable = new Map(plan.map((a) => [a.table, a] as const));
    // Defaults ON: telemetry(90), payloads(reuse 30), oauth_usage(180), memory_jobs(30).
    expect(byTable.get("telemetry")?.cutoffMs).toBe(NOW - 90 * DAY);
    expect(byTable.get("request_payloads")?.cutoffMs).toBe(NOW - 30 * DAY);
    expect(byTable.get("oauth_usage")?.cutoffMs).toBe(NOW - 180 * DAY);
    expect(byTable.get("memory_jobs")?.cutoffMs).toBe(NOW - 30 * DAY);
    // Defaults OFF: raw + derived memory require opt-in.
    expect(byTable.has("memory_messages")).toBe(false);
    expect(byTable.has("memory_derived")).toBe(false);
  });

  it("only the training/audit tables carry archive=true, and only when the archive switch is on", () => {
    const on = buildCleanupPlan(settings({ memory_messages_cleanup_enabled: true }), NOW);
    const archived = new Set(on.filter((a) => a.archive).map((a) => a.table));
    expect(archived).toEqual(
      new Set<CleanupTable>(["telemetry", "request_payloads", "memory_messages"]),
    );
    // oauth_usage / memory_jobs are delete-only regardless.
    expect(on.find((a) => a.table === "oauth_usage")?.archive).toBe(false);
    expect(on.find((a) => a.table === "memory_jobs")?.archive).toBe(false);

    const off = buildCleanupPlan(settings({ cleanup_archive_enabled: false }), NOW);
    expect(off.every((a) => a.archive === false)).toBe(true);
  });

  it("a disabled category contributes no action", () => {
    const plan = buildCleanupPlan(settings({ telemetry_cleanup_enabled: false }), NOW);
    expect(plan.some((a) => a.table === "telemetry")).toBe(false);
  });
});
