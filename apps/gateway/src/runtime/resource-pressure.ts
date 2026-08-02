import { readFile } from "node:fs/promises";
import { totalmem } from "node:os";
import { getHeapStatistics } from "node:v8";

const MIB = 1024 * 1024;

export interface ResourcePressureSample {
  effectiveTotalMemoryBytes?: number;
  availableMemoryBytes?: number;
  heapUsedBytes?: number;
  heapLimitBytes?: number;
  cgroupCurrentBytes?: number;
  cgroupMaxBytes?: number;
  memoryPsiFullAvg10?: number;
  ioPsiFullAvg10?: number;
}

export type ResourcePressureState = "pressured" | "healthy" | "neutral" | "unknown";

function finite(value: number | undefined): value is number {
  return value !== undefined && Number.isFinite(value) && value >= 0;
}

export function classifyResourcePressure(sample: ResourcePressureSample): ResourcePressureState {
  const total = sample.effectiveTotalMemoryBytes;
  const pauseAvailable = finite(total)
    ? Math.min(total * 0.8, Math.max(512 * MIB, total * 0.1))
    : 512 * MIB;
  const resumeAvailable = finite(total)
    ? Math.min(total * 0.9, pauseAvailable + Math.max(128 * MIB, total * 0.05))
    : 640 * MIB;
  const heapRatio =
    finite(sample.heapUsedBytes) && finite(sample.heapLimitBytes) && sample.heapLimitBytes > 0
      ? sample.heapUsedBytes / sample.heapLimitBytes
      : undefined;
  const cgroupRatio =
    finite(sample.cgroupCurrentBytes) && finite(sample.cgroupMaxBytes) && sample.cgroupMaxBytes > 0
      ? sample.cgroupCurrentBytes / sample.cgroupMaxBytes
      : undefined;
  const known = [
    sample.availableMemoryBytes,
    heapRatio,
    cgroupRatio,
    sample.memoryPsiFullAvg10,
    sample.ioPsiFullAvg10,
  ].some(finite);
  if (!known) return "unknown";
  if (
    (finite(sample.availableMemoryBytes) && sample.availableMemoryBytes < pauseAvailable) ||
    (finite(heapRatio) && heapRatio >= 0.7) ||
    (finite(cgroupRatio) && cgroupRatio >= 0.75) ||
    (finite(sample.memoryPsiFullAvg10) && sample.memoryPsiFullAvg10 >= 1) ||
    (finite(sample.ioPsiFullAvg10) && sample.ioPsiFullAvg10 >= 5)
  ) {
    return "pressured";
  }
  const healthy =
    (!finite(sample.availableMemoryBytes) || sample.availableMemoryBytes >= resumeAvailable) &&
    (!finite(heapRatio) || heapRatio <= 0.6) &&
    (!finite(cgroupRatio) || cgroupRatio <= 0.65) &&
    (!finite(sample.memoryPsiFullAvg10) || sample.memoryPsiFullAvg10 <= 0.2) &&
    (!finite(sample.ioPsiFullAvg10) || sample.ioPsiFullAvg10 <= 3);
  return healthy ? "healthy" : "neutral";
}

export function createResourcePressureGate(options: {
  sample: () => Promise<ResourcePressureSample | null>;
  now?: () => number;
  recoveryMs?: number;
  minSampleIntervalMs?: number;
  log?: (message: string, fields: Record<string, unknown>) => void;
}) {
  const now = options.now ?? Date.now;
  const recoveryMs = options.recoveryMs ?? 60_000;
  const minSampleIntervalMs = options.minSampleIntervalMs ?? 5_000;
  const log = options.log ?? (() => {});
  let blocked = false;
  let recoverySince: number | null = null;
  let lastSampleAt = Number.NEGATIVE_INFINITY;
  let lastState: ResourcePressureState = "unknown";
  let inFlight: Promise<ResourcePressureState> | null = null;
  let unavailableLogged = false;

  const sampleState = async (): Promise<ResourcePressureState> => {
    if (inFlight) return inFlight;
    const at = now();
    if (at - lastSampleAt < minSampleIntervalMs) return lastState;
    inFlight = (async () => {
      let sample: ResourcePressureSample | null = null;
      try {
        sample = await options.sample();
      } catch {
        sample = null;
      }
      lastState = sample === null ? "unknown" : classifyResourcePressure(sample);
      lastSampleAt = now();
      return lastState;
    })();
    try {
      return await inFlight;
    } finally {
      inFlight = null;
    }
  };

  const decide = async (requireHealthy: boolean): Promise<boolean> => {
    const at = now();
    const state = await sampleState();
    if (state === "unknown") {
      if (!unavailableLogged) {
        unavailableLogged = true;
        log("resource_pressure.sample_unavailable", {});
      }
      return !blocked && !requireHealthy;
    }
    unavailableLogged = false;
    if (state === "pressured") {
      recoverySince = null;
      if (!blocked) {
        blocked = true;
        log("resource_pressure.background_paused", {});
      }
      return false;
    }
    if (!blocked) return requireHealthy ? state === "healthy" : true;
    if (state !== "healthy") {
      recoverySince = null;
      return false;
    }
    recoverySince ??= at;
    if (at - recoverySince < recoveryMs) return false;
    blocked = false;
    recoverySince = null;
    log("resource_pressure.background_resumed", {});
    return true;
  };

  return {
    shouldRun: () => decide(false),
    shouldRunHeavy: () => decide(true),
  };
}

function number(text: string | null): number | undefined {
  if (text === null || text.trim() === "max") return undefined;
  const value = Number(text.trim());
  return Number.isFinite(value) && value >= 0 ? value : undefined;
}

function fullAvg10(text: string | null): number | undefined {
  const match = text?.match(/^full\s+avg10=([0-9.]+)/m);
  return match ? number(match[1] ?? null) : undefined;
}

async function defaultReadText(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
}

export async function readResourcePressureSample(
  options: {
    readText?: (path: string) => Promise<string | null>;
    availableMemory?: () => number;
    totalMemory?: () => number;
    constrainedMemory?: () => number;
    heap?: () => { used: number; limit: number };
  } = {},
): Promise<ResourcePressureSample> {
  const readText = options.readText ?? defaultReadText;
  const [cgroupMemoryPsi, cgroupIoPsi, hostMemoryPsi, hostIoPsi, cgroupCurrent, cgroupMax] =
    await Promise.all([
      readText("/sys/fs/cgroup/memory.pressure"),
      readText("/sys/fs/cgroup/io.pressure"),
      readText("/proc/pressure/memory"),
      readText("/proc/pressure/io"),
      readText("/sys/fs/cgroup/memory.current"),
      readText("/sys/fs/cgroup/memory.max"),
    ]);
  const hostTotal = (options.totalMemory ?? totalmem)();
  const constrained = (options.constrainedMemory ?? (() => process.constrainedMemory()))();
  const effectiveTotal = constrained > 0 ? Math.min(hostTotal, constrained) : hostTotal;
  const heap = (
    options.heap ??
    (() => {
      const statistics = getHeapStatistics();
      return { used: process.memoryUsage().heapUsed, limit: statistics.heap_size_limit };
    })
  )();
  return {
    effectiveTotalMemoryBytes: effectiveTotal,
    availableMemoryBytes: (options.availableMemory ?? (() => process.availableMemory()))(),
    heapUsedBytes: heap.used,
    heapLimitBytes: heap.limit,
    cgroupCurrentBytes: number(cgroupCurrent),
    cgroupMaxBytes: number(cgroupMax),
    memoryPsiFullAvg10: fullAvg10(cgroupMemoryPsi ?? hostMemoryPsi),
    ioPsiFullAvg10: fullAvg10(cgroupIoPsi ?? hostIoPsi),
  };
}

export function createRuntimeResourcePressureGate(
  log: (message: string, fields: Record<string, unknown>) => void,
) {
  return createResourcePressureGate({ sample: readResourcePressureSample, log });
}
