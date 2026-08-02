import { totalmem } from "node:os";
import { getHeapStatistics } from "node:v8";

const MIB = 1024 * 1024;

const JSON_AMPLIFICATION = 6;

export interface RuntimeMemoryBudget {
  heapLimitBytes: number;
  processLimitBytes: number;
  jsonAmplification: number;
  activeRequestBytes: number;
  responseWorkBytes: number;
  minRequestChargeBytes: number;
  writeQueueBytes: number;
  sessionCacheBytes: number;
  responseCaptureBytes: number;
  sseTailChars: number;
  sqlitePageCacheBytes: number;
  sqliteMaintenanceCacheBytes: number;
  websocketIngressBytes: number;
}

export interface RuntimeMemoryLease {
  resize(bytes: number): { ok: true } | { ok: false; capacityBytes: number };
  release(): void;
}

export interface RuntimeMemoryCoordinator {
  acquire(
    bytes: number,
  ): { ok: true; lease: RuntimeMemoryLease } | { ok: false; capacityBytes: number };
  readonly capacityBytes: number;
  readonly reservedBytes: number;
}

function normalizedBytes(bytes: number): number {
  return Number.isSafeInteger(bytes) && bytes >= 0 ? bytes : Number.MAX_SAFE_INTEGER;
}

export function createRuntimeMemoryCoordinator(options: {
  capacityBytes: () => number;
}): RuntimeMemoryCoordinator {
  let reservedBytes = 0;
  const capacityBytes = (): number => {
    const capacity = options.capacityBytes();
    return Number.isSafeInteger(capacity) && capacity >= 0 ? capacity : 0;
  };

  return {
    acquire(bytes) {
      let held = normalizedBytes(bytes);
      const capacity = capacityBytes();
      if (reservedBytes + held > capacity) {
        return { ok: false as const, capacityBytes: capacity };
      }
      reservedBytes += held;
      let released = false;
      return {
        ok: true as const,
        lease: {
          resize(nextBytes) {
            if (released) return { ok: false as const, capacityBytes: capacityBytes() };
            const next = normalizedBytes(nextBytes);
            if (next > held) {
              const capacity = capacityBytes();
              if (reservedBytes - held + next > capacity) {
                return { ok: false as const, capacityBytes: capacity };
              }
            }
            reservedBytes += next - held;
            held = next;
            return { ok: true as const };
          },
          release() {
            if (released) return;
            released = true;
            reservedBytes -= held;
          },
        },
      };
    },
    get capacityBytes() {
      return capacityBytes();
    },
    get reservedBytes() {
      return reservedBytes;
    },
  };
}

export function deriveSafeWorkingMemoryCapacity(input: {
  heapLimitBytes: number;
  heapUsedBytes: number;
  availableMemoryBytes: number;
  hostTotalMemoryBytes: number;
  constrainedMemoryBytes?: number;
  hostReserveMinBytes?: number;
  emergencyReserveBytes?: number;
  utilization?: number;
}): number {
  const hostReserveMinBytes = input.hostReserveMinBytes ?? 384 * MIB;
  const emergencyReserveBytes = input.emergencyReserveBytes ?? 128 * MIB;
  const utilization = input.utilization ?? 0.7;
  const constrainedMemoryBytes = input.constrainedMemoryBytes ?? 0;
  const hasConstrainedLimit =
    Number.isSafeInteger(constrainedMemoryBytes) && constrainedMemoryBytes > 0;
  const effectiveTotalMemoryBytes = hasConstrainedLimit
    ? Math.min(input.hostTotalMemoryBytes, constrainedMemoryBytes)
    : input.hostTotalMemoryBytes;
  const hostReserve = Math.max(
    hostReserveMinBytes,
    Math.min(1024 * MIB, Math.floor(effectiveTotalMemoryBytes * 0.05)),
  );
  const heapHeadroom = Math.max(
    0,
    input.heapLimitBytes - input.heapUsedBytes - emergencyReserveBytes,
  );
  const nativeHeadroom = Math.max(0, input.availableMemoryBytes - hostReserve);
  return Math.max(0, Math.floor(Math.min(heapHeadroom, nativeHeadroom) * utilization));
}

export function deriveRuntimeMemoryBudget(input: {
  heapLimitBytes: number;
  constrainedMemoryBytes?: number;
  rssBytes?: number;
  heapTotalBytes?: number;
  availableMemoryBytes?: number;
}): RuntimeMemoryBudget {
  if (!Number.isFinite(input.heapLimitBytes) || input.heapLimitBytes <= 0) {
    throw new Error("heapLimitBytes must be positive");
  }
  const constrained = input.constrainedMemoryBytes ?? 0;
  const hasConstrainedLimit = Number.isSafeInteger(constrained) && constrained > 0;
  const rssBytes =
    Number.isFinite(input.rssBytes) && (input.rssBytes ?? -1) >= 0
      ? Math.floor(input.rssBytes ?? 0)
      : 0;
  const availableMemoryBytes = input.availableMemoryBytes ?? 0;
  const hasAvailableMemory = Number.isFinite(availableMemoryBytes) && availableMemoryBytes > 0;
  const processLimitBytes = hasConstrainedLimit
    ? constrained
    : hasAvailableMemory
      ? rssBytes + availableMemoryBytes
      : input.heapLimitBytes;
  const allocationLimitBytes = Math.min(input.heapLimitBytes, processLimitBytes);
  const activeRequestBytes = Math.floor(allocationLimitBytes * 0.2);
  const responseWorkBytes = Math.floor(allocationLimitBytes * 0.2);
  const writeQueueBytes = Math.floor(allocationLimitBytes * 0.08);
  const sessionCacheBytes = Math.floor(allocationLimitBytes * 0.04);
  const responseCaptureBytes = Math.floor(allocationLimitBytes * 0.06);
  const sqlitePageCacheBytes = Math.floor(processLimitBytes * 0.03);
  const sqliteMaintenanceCacheBytes = Math.floor(sqlitePageCacheBytes / 4);
  const hasNativeMeasurement = hasConstrainedLimit || hasAvailableMemory;
  const heapTotalBytes = Math.min(
    rssBytes,
    Number.isFinite(input.heapTotalBytes) && (input.heapTotalBytes ?? -1) >= 0
      ? Math.floor(input.heapTotalBytes ?? 0)
      : 0,
  );
  const managedHeapBytes =
    activeRequestBytes +
    responseWorkBytes +
    writeQueueBytes +
    sessionCacheBytes +
    responseCaptureBytes;
  // A normal unconstrained process can still grow to V8's real heap ceiling. In
  // a tighter cgroup where V8 reports a larger host-derived ceiling, reserve the
  // gateway's explicitly managed heap budget instead of falsely consuming the
  // entire cgroup and reducing native capacity to zero.
  const heapReservationCeilingBytes =
    input.heapLimitBytes <= processLimitBytes ? input.heapLimitBytes : managedHeapBytes;
  const futureHeapGrowthBytes = Math.max(0, heapReservationCeilingBytes - heapTotalBytes);
  const availableProcessBytes = Math.max(0, processLimitBytes - rssBytes);
  // Raw websocket frames live outside the JS heap until `ws` emits `message`.
  // Reserve measured native headroom after current non-heap RSS and the SQLite
  // caches that may still grow. If the runtime exposes neither a cgroup limit nor
  // available memory, retain the prior heap-derived capacity instead of treating
  // an unknown limit as genuine zero headroom.
  const websocketIngressBytes = hasNativeMeasurement
    ? Math.max(
        0,
        Math.floor(
          availableProcessBytes -
            futureHeapGrowthBytes -
            sqlitePageCacheBytes -
            sqliteMaintenanceCacheBytes,
        ),
      )
    : activeRequestBytes;
  return {
    heapLimitBytes: input.heapLimitBytes,
    processLimitBytes,
    jsonAmplification: JSON_AMPLIFICATION,
    activeRequestBytes,
    responseWorkBytes,
    minRequestChargeBytes: Math.max(1, Math.floor(activeRequestBytes * 0.01)),
    writeQueueBytes,
    sessionCacheBytes,
    responseCaptureBytes,
    sseTailChars: Math.max(1, Math.floor(responseCaptureBytes * 0.0004)),
    sqlitePageCacheBytes,
    sqliteMaintenanceCacheBytes,
    websocketIngressBytes,
  };
}

let detected: RuntimeMemoryBudget | undefined;

export function runtimeMemoryBudget(): RuntimeMemoryBudget {
  const memory = process.memoryUsage();
  detected ??= deriveRuntimeMemoryBudget({
    heapLimitBytes: getHeapStatistics().heap_size_limit,
    constrainedMemoryBytes: process.constrainedMemory(),
    rssBytes: memory.rss,
    heapTotalBytes: memory.heapTotal,
    availableMemoryBytes: process.availableMemory(),
  });
  return detected;
}

/** Live process/cgroup-aware capacity. It scales with the machine and current
 * pressure; it is an operation budget, never a cumulative Session byte limit. */
export function runtimeSafeWorkingMemoryCapacity(): number {
  const heap = getHeapStatistics();
  const memory = process.memoryUsage();
  return deriveSafeWorkingMemoryCapacity({
    heapLimitBytes: heap.heap_size_limit,
    heapUsedBytes: memory.heapUsed,
    availableMemoryBytes: process.availableMemory(),
    hostTotalMemoryBytes: totalmem(),
    constrainedMemoryBytes: process.constrainedMemory(),
  });
}

let runtimeCoordinator: RuntimeMemoryCoordinator | undefined;

export function runtimeMemoryCoordinator(): RuntimeMemoryCoordinator {
  runtimeCoordinator ??= createRuntimeMemoryCoordinator({
    capacityBytes: runtimeSafeWorkingMemoryCapacity,
  });
  return runtimeCoordinator;
}
