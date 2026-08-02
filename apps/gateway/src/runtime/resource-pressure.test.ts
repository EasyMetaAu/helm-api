import { describe, expect, it, vi } from "vitest";
import {
  classifyResourcePressure,
  createResourcePressureGate,
  type ResourcePressureSample,
  readResourcePressureSample,
} from "./resource-pressure.js";

const MIB = 1024 * 1024;

function healthy(): ResourcePressureSample {
  return {
    effectiveTotalMemoryBytes: 2_048 * MIB,
    availableMemoryBytes: 900 * MIB,
    heapUsedBytes: 300 * MIB,
    heapLimitBytes: 800 * MIB,
    cgroupCurrentBytes: 700 * MIB,
    cgroupMaxBytes: 1_500 * MIB,
    memoryPsiFullAvg10: 0,
    ioPsiFullAvg10: 0,
  };
}

describe("resource pressure gate", () => {
  it("classifies any high memory or I/O signal as pressured", () => {
    expect(classifyResourcePressure({ ...healthy(), ioPsiFullAvg10: 10 })).toBe("pressured");
    expect(classifyResourcePressure({ ...healthy(), memoryPsiFullAvg10: 1 })).toBe("pressured");
    expect(classifyResourcePressure({ ...healthy(), availableMemoryBytes: 400 * MIB })).toBe(
      "pressured",
    );
  });

  it("pauses immediately and resumes only after a continuous healthy window", async () => {
    let now = 0;
    let sample: ResourcePressureSample = { ...healthy(), ioPsiFullAvg10: 20 };
    const log = vi.fn();
    const gate = createResourcePressureGate({
      sample: async () => sample,
      now: () => now,
      recoveryMs: 60_000,
      minSampleIntervalMs: 0,
      log,
    });

    expect(await gate.shouldRun()).toBe(false);
    sample = healthy();
    expect(await gate.shouldRun()).toBe(false);
    now = 59_999;
    expect(await gate.shouldRun()).toBe(false);
    now = 60_000;
    expect(await gate.shouldRun()).toBe(true);
    expect(log.mock.calls.map((call) => call[0])).toEqual([
      "resource_pressure.background_paused",
      "resource_pressure.background_resumed",
    ]);
  });

  it("resets recovery on renewed pressure and holds state when sampling fails", async () => {
    let now = 0;
    let sample: ResourcePressureSample | null = { ...healthy(), ioPsiFullAvg10: 20 };
    const gate = createResourcePressureGate({
      sample: async () => sample,
      now: () => now,
      recoveryMs: 60_000,
      minSampleIntervalMs: 0,
    });

    expect(await gate.shouldRun()).toBe(false);
    sample = healthy();
    await gate.shouldRun();
    now = 30_000;
    sample = { ...healthy(), ioPsiFullAvg10: 20 };
    expect(await gate.shouldRun()).toBe(false);
    sample = null;
    now = 120_000;
    expect(await gate.shouldRun()).toBe(false);
  });

  it("fails open when every sensor is unavailable at startup", async () => {
    const log = vi.fn();
    const gate = createResourcePressureGate({
      sample: async () => null,
      now: () => 0,
      minSampleIntervalMs: 0,
      log,
    });

    expect(await gate.shouldRun()).toBe(true);
    expect(await gate.shouldRun()).toBe(true);
    expect(log).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith("resource_pressure.sample_unavailable", {});
  });

  it("fails closed for heavy maintenance unless the sample is healthy", async () => {
    let sample: ResourcePressureSample | null = null;
    const gate = createResourcePressureGate({
      sample: async () => sample,
      now: () => 0,
      minSampleIntervalMs: 0,
    });

    expect(await gate.shouldRunHeavy()).toBe(false);
    sample = { ...healthy(), ioPsiFullAvg10: 4 };
    expect(await gate.shouldRunHeavy()).toBe(false);
    sample = healthy();
    expect(await gate.shouldRunHeavy()).toBe(true);
  });

  it("shares an in-flight sample between concurrent consumers", async () => {
    let resolveSample = (_sample: ResourcePressureSample | null) => {};
    const sample = vi.fn(
      () =>
        new Promise<ResourcePressureSample | null>((resolve) => {
          resolveSample = resolve;
        }),
    );
    const gate = createResourcePressureGate({ sample, now: () => 0 });

    const first = gate.shouldRun();
    const second = gate.shouldRun();
    resolveSample({ ...healthy(), ioPsiFullAvg10: 20 });
    expect(await Promise.all([first, second])).toEqual([false, false]);
    expect(sample).toHaveBeenCalledTimes(1);
  });

  it("reads cgroup and PSI scalars without treating max as a byte value", async () => {
    const files = new Map([
      [
        "/sys/fs/cgroup/memory.pressure",
        "some avg10=1.00 avg60=0 avg300=0 total=1\nfull avg10=0.25 avg60=0 avg300=0 total=1\n",
      ],
      [
        "/sys/fs/cgroup/io.pressure",
        "some avg10=2.00 avg60=0 avg300=0 total=1\nfull avg10=3.50 avg60=0 avg300=0 total=1\n",
      ],
      ["/sys/fs/cgroup/memory.current", "1234\n"],
      ["/sys/fs/cgroup/memory.max", "max\n"],
    ]);
    const sample = await readResourcePressureSample({
      readText: async (path) => files.get(path) ?? null,
      availableMemory: () => 8_000,
      totalMemory: () => 10_000,
      constrainedMemory: () => 0,
      heap: () => ({ used: 2_000, limit: 6_000 }),
    });

    expect(sample).toMatchObject({
      availableMemoryBytes: 8_000,
      effectiveTotalMemoryBytes: 10_000,
      heapUsedBytes: 2_000,
      heapLimitBytes: 6_000,
      cgroupCurrentBytes: 1_234,
      memoryPsiFullAvg10: 0.25,
      ioPsiFullAvg10: 3.5,
    });
    expect(sample?.cgroupMaxBytes).toBeUndefined();
  });
});
