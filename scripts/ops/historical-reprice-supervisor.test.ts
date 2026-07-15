import { describe, expect, it } from "vitest";
import {
  buildUtcWindows,
  DEFAULT_SUPERVISOR_THRESHOLDS,
  evaluatePreflight,
  evaluateRuntimeSafety,
  parseStructuredLogSignals,
  type SupervisorSample,
  shouldRunPreflight,
} from "./historical-reprice-supervisor.js";

function healthySample(overrides: Partial<SupervisorSample> = {}): SupervisorSample {
  return {
    capturedAt: "2026-07-15T00:00:00.000Z",
    load1: 0.4,
    memAvailableBytes: 900 * 1024 ** 2,
    helmCpuPercent: 20,
    helmMemoryPercent: 40,
    healthStatus: 200,
    healthLatencyMs: 40,
    walBytes: 100 * 1024 ** 2,
    diskFreeBytes: 20 * 1024 ** 3,
    restarts: 0,
    oomKilled: false,
    fiveXx: 0,
    timeouts: 0,
    sqliteBusy: 0,
    ...overrides,
  };
}

describe("historical reprice supervisor", () => {
  it("builds chronological UTC windows and clamps the final partial day", () => {
    const windows = buildUtcWindows(
      Date.parse("2026-06-30T00:00:00Z"),
      Date.parse("2026-07-02T05:28:46Z"),
    );

    expect(windows).toEqual([
      {
        name: "2026-06-30",
        fromMs: Date.parse("2026-06-30T00:00:00Z"),
        toMs: Date.parse("2026-07-01T00:00:00Z"),
      },
      {
        name: "2026-07-01",
        fromMs: Date.parse("2026-07-01T00:00:00Z"),
        toMs: Date.parse("2026-07-02T00:00:00Z"),
      },
      {
        name: "2026-07-02",
        fromMs: Date.parse("2026-07-02T00:00:00Z"),
        toMs: Date.parse("2026-07-02T05:28:46Z"),
      },
    ]);
  });

  it("requires three clean headroom samples before starting", () => {
    expect(evaluatePreflight([healthySample(), healthySample()])).toEqual({
      safe: false,
      reasons: ["need 3 preflight samples, got 2"],
    });

    expect(evaluatePreflight([healthySample(), healthySample(), healthySample()])).toEqual({
      safe: true,
      reasons: [],
    });

    const lowMemory = healthySample({ memAvailableBytes: 767 * 1024 ** 2 });
    const result = evaluatePreflight([healthySample(), lowMemory, healthySample()]);
    expect(result.safe).toBe(false);
    expect(result.reasons).toContain("sample 2: available memory below 768 MiB");
  });

  it("stops immediately on hard limits and only on sustained CPU or health latency", () => {
    const initial = { highCpuSamples: 0, slowHealthSamples: 0, baselineRestarts: 0 };
    const firstCpu = evaluateRuntimeSafety(healthySample({ helmCpuPercent: 65 }), initial);
    expect(firstCpu.stop).toBe(false);
    expect(firstCpu.state.highCpuSamples).toBe(1);

    const secondCpu = evaluateRuntimeSafety(healthySample({ helmCpuPercent: 61 }), firstCpu.state);
    expect(secondCpu.stop).toBe(true);
    expect(secondCpu.reasons).toContain("Helm CPU sustained at or above 60%");

    const firstSlow = evaluateRuntimeSafety(healthySample({ healthLatencyMs: 700 }), initial);
    expect(firstSlow.stop).toBe(false);
    const secondSlow = evaluateRuntimeSafety(
      healthySample({ healthLatencyMs: 550 }),
      firstSlow.state,
    );
    expect(secondSlow.reasons).toContain("health latency consecutively above 500 ms");

    const lowMemory = evaluateRuntimeSafety(
      healthySample({ memAvailableBytes: 639 * 1024 ** 2 }),
      initial,
    );
    expect(lowMemory.stop).toBe(true);
    expect(lowMemory.reasons).toContain("available memory below 640 MiB");
  });

  it("parses structured failures without mistaking trace identifiers for status codes", () => {
    const signals = parseStructuredLogSignals(
      [
        JSON.stringify({ status: 200, trace_id: "trace-502-timeout" }),
        JSON.stringify({ http_status: 502, message: "request.error" }),
        JSON.stringify({ status: 503, message: "request.completed" }),
        JSON.stringify({ message: "stream.truncated", error_class: "timeout" }),
        JSON.stringify({ message: "write failed", error_class: "SQLITE_BUSY" }),
        "not-json",
      ].join("\n"),
    );

    expect(signals).toEqual({ fiveXx: 2, timeouts: 1, sqliteBusy: 1 });
  });

  it("keeps production stop thresholds stricter than CLI hard limits", () => {
    expect(DEFAULT_SUPERVISOR_THRESHOLDS.preflightWalBytes).toBeLessThan(
      DEFAULT_SUPERVISOR_THRESHOLDS.stopWalBytes,
    );
    expect(DEFAULT_SUPERVISOR_THRESHOLDS.preflightDiskBytes).toBeGreaterThan(
      DEFAULT_SUPERVISOR_THRESHOLDS.stopDiskBytes,
    );
  });

  it("runs preflight once per stage instead of before every atomic batch", () => {
    expect(shouldRunPreflight(0, false)).toBe(true);
    expect(shouldRunPreflight(1, false)).toBe(false);
    expect(shouldRunPreflight(49, false)).toBe(false);
    expect(shouldRunPreflight(12, true)).toBe(true);
  });
});
