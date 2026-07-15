import { describe, expect, it } from "vitest";
import {
  buildApplyBatchCliArgs,
  buildUtcWindows,
  DEFAULT_SUPERVISOR_THRESHOLDS,
  evaluatePreflight,
  evaluateRuntimeSafety,
  parseStructuredLogSignals,
  resetStageAfterSafetyStop,
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
    gatewayFaults: 0,
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

    const stableTwoGiBHost = healthySample({ memAvailableBytes: 588 * 1024 ** 2 });
    expect(evaluatePreflight([healthySample(), stableTwoGiBHost, healthySample()])).toMatchObject({
      safe: true,
      reasons: [],
    });

    const lowMemory = healthySample({ memAvailableBytes: 511 * 1024 ** 2 });
    const result = evaluatePreflight([healthySample(), lowMemory, healthySample()]);
    expect(result.safe).toBe(false);
    expect(result.reasons).toContain("sample 2: available memory below 512 MiB");
  });

  it("uses 75% CPU headroom and reports the configured CPU thresholds", () => {
    expect(DEFAULT_SUPERVISOR_THRESHOLDS.preflightCpuPercent).toBe(75);
    expect(DEFAULT_SUPERVISOR_THRESHOLDS.stopCpuPercent).toBe(75);

    const belowThreshold = healthySample({ helmCpuPercent: 74.99 });
    expect(evaluatePreflight([belowThreshold, belowThreshold, belowThreshold])).toMatchObject({
      safe: true,
      reasons: [],
    });

    const atDefaultThreshold = healthySample({ helmCpuPercent: 75 });
    expect(
      evaluatePreflight([atDefaultThreshold, atDefaultThreshold, atDefaultThreshold]).reasons,
    ).toContain("sample 1: Helm CPU at or above 75%");

    const atCustomThreshold = healthySample({ helmCpuPercent: 83 });
    const customThresholds = {
      ...DEFAULT_SUPERVISOR_THRESHOLDS,
      preflightCpuPercent: 83,
    };
    expect(
      evaluatePreflight([atCustomThreshold, atCustomThreshold, atCustomThreshold], customThresholds)
        .reasons,
    ).toContain("sample 1: Helm CPU at or above 83%");
  });

  it("stops immediately on hard limits and only on sustained CPU", () => {
    const initial = { highCpuSamples: 0, baselineRestarts: 0 };
    const firstCpu = evaluateRuntimeSafety(healthySample({ helmCpuPercent: 76 }), initial);
    expect(firstCpu.stop).toBe(false);
    expect(firstCpu.state.highCpuSamples).toBe(1);

    const secondCpu = evaluateRuntimeSafety(healthySample({ helmCpuPercent: 75 }), firstCpu.state);
    expect(secondCpu.stop).toBe(true);
    expect(secondCpu.reasons).toContain("Helm CPU sustained at or above 75%");

    const firstBoundaryCpu = evaluateRuntimeSafety(healthySample({ helmCpuPercent: 75 }), initial);
    const resetCpu = evaluateRuntimeSafety(
      healthySample({ helmCpuPercent: 74.99 }),
      firstBoundaryCpu.state,
    );
    const secondBoundaryCpu = evaluateRuntimeSafety(
      healthySample({ helmCpuPercent: 75 }),
      resetCpu.state,
    );
    expect(resetCpu.state.highCpuSamples).toBe(0);
    expect(secondBoundaryCpu).toMatchObject({
      stop: false,
      reasons: [],
      state: { highCpuSamples: 1 },
    });

    const customCpu = evaluateRuntimeSafety(
      healthySample({ helmCpuPercent: 82 }),
      { highCpuSamples: 1, baselineRestarts: 0 },
      { ...DEFAULT_SUPERVISOR_THRESHOLDS, stopCpuPercent: 82 },
    );
    expect(customCpu.reasons).toContain("Helm CPU sustained at or above 82%");

    const lowMemory = evaluateRuntimeSafety(
      healthySample({ memAvailableBytes: 383 * 1024 ** 2 }),
      initial,
    );
    expect(lowMemory.stop).toBe(true);
    expect(lowMemory.reasons).toContain("available memory below 384 MiB");
  });

  it("does not pause for health latency when the health status is 200", () => {
    const slowButHealthy = healthySample({ healthLatencyMs: 4_900 });

    expect(evaluatePreflight([slowButHealthy, slowButHealthy, slowButHealthy])).toMatchObject({
      safe: true,
      reasons: [],
    });
    expect(
      evaluateRuntimeSafety(slowButHealthy, { highCpuSamples: 0, baselineRestarts: 0 }),
    ).toMatchObject({ stop: false, reasons: [] });
  });

  it("observes all 5xx but scopes only explicit gateway-internal faults as blockers", () => {
    const signals = parseStructuredLogSignals(
      [
        JSON.stringify({
          trace_id: "normal-provider-failure",
          http_status: 502,
          message: "request.error",
          error_class: "all_providers_failed",
          fault_scope: "request",
        }),
        JSON.stringify({
          trace_id: "normal-provider-failure",
          status: 502,
          message: "request.completed",
          path: "/v1/responses",
        }),
        JSON.stringify({
          trace_id: "internal-reprice-failure",
          http_status: 500,
          message: "request.error",
          error_class: "upstream_error",
          fault_scope: "gateway_internal",
        }),
        JSON.stringify({
          trace_id: "internal-reprice-failure",
          status: 500,
          message: "request.completed",
          path: "/internal/pricing/reprice",
        }),
      ].join("\n"),
    );

    expect(signals).toEqual({
      fiveXx: 4,
      timeouts: 0,
      gatewayFaults: 1,
      sqliteBusy: 0,
    });
  });

  it("keeps unscoped/provider 5xx and timeouts observational while retaining SQLITE_BUSY", () => {
    const signals = parseStructuredLogSignals(
      [
        JSON.stringify({ status: 200, trace_id: "trace-502-timeout" }),
        JSON.stringify({
          trace_id: "normal-provider-failure",
          http_status: 502,
          message: "request.error",
          error_class: "all_providers_failed",
        }),
        JSON.stringify({
          trace_id: "normal-provider-failure",
          status: 502,
          message: "request.completed",
        }),
        JSON.stringify({ message: "stream.truncated", error_class: "timeout" }),
        JSON.stringify({ message: "write failed", error_class: "SQLITE_BUSY" }),
        "not-json",
      ].join("\n"),
    );

    expect(signals).toEqual({ fiveXx: 2, timeouts: 1, gatewayFaults: 0, sqliteBusy: 1 });
  });

  it("blocks only actionable fault signals, not ordinary 5xx or timeout observations", () => {
    const initial = { highCpuSamples: 0, baselineRestarts: 0 };
    const observations = healthySample({ fiveXx: 12, timeouts: 4 });
    expect(evaluatePreflight([observations, observations, observations])).toMatchObject({
      safe: true,
      reasons: [],
    });
    expect(evaluateRuntimeSafety(observations, initial)).toMatchObject({
      stop: false,
      reasons: [],
    });

    expect(evaluateRuntimeSafety(healthySample({ gatewayFaults: 1 }), initial).reasons).toContain(
      "new gateway-internal 5xx detected",
    );
    expect(evaluateRuntimeSafety(healthySample({ sqliteBusy: 1 }), initial).reasons).toContain(
      "new SQLITE_BUSY detected",
    );
  });

  it.each<[string, Partial<SupervisorSample>, string]>([
    ["host load", { load1: 1.5 }, "load1 at or above 1.5"],
    ["Helm memory", { helmMemoryPercent: 60 }, "Helm memory at or above 60%"],
    ["non-200 health", { healthStatus: 503 }, "health returned non-200"],
    ["WAL growth", { walBytes: 512 * 1024 ** 2 }, "WAL at or above 512 MiB"],
    ["low disk", { diskFreeBytes: 11 * 1024 ** 3 }, "disk free below 12 GiB"],
    ["container restart", { restarts: 1 }, "restart count changed"],
    ["OOM", { oomKilled: true }, "OOM flag is set"],
    ["gateway-internal fault", { gatewayFaults: 1 }, "new gateway-internal 5xx detected"],
    ["SQLite lock", { sqliteBusy: 1 }, "new SQLITE_BUSY detected"],
  ])("retains the %s runtime safety guard", (_name, overrides, expectedReason) => {
    const result = evaluateRuntimeSafety(healthySample(overrides), {
      highCpuSamples: 0,
      baselineRestarts: 0,
    });
    expect(result.stop).toBe(true);
    expect(result.reasons).toContain(expectedReason);
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

  it("resets both internal and reported stage progress after a safety stop", () => {
    expect(resetStageAfterSafetyStop()).toEqual({
      stageBatches: 0,
      recoveryRequired: true,
    });
  });

  it("skips the duplicate CLI health check after the supervisor sample passes", () => {
    const args = buildApplyBatchCliArgs({
      tool: "/app/historical-cost-reprice.js",
      databasePath: "/app/data/helm.db",
      pricingPath: "/app/config/pricing.yaml",
      stateDir: "/app/data/reprice",
      windowName: "2026-07-05",
      planSha256: "plan-sha256",
      maxWalBytes: 512 * 1024 ** 2,
      minFreeBytes: 12 * 1024 ** 3,
    });

    expect(args).toContain("--skip-health-check");
    expect(args).not.toContain("--health-url");
    expect(args).not.toContain("http://127.0.0.1:8080/healthz");
    expect(
      args.slice(args.indexOf("--max-wal-bytes"), args.indexOf("--max-wal-bytes") + 2),
    ).toEqual(["--max-wal-bytes", String(512 * 1024 ** 2)]);
    expect(
      args.slice(args.indexOf("--min-free-bytes"), args.indexOf("--min-free-bytes") + 2),
    ).toEqual(["--min-free-bytes", String(12 * 1024 ** 3)]);
  });
});
