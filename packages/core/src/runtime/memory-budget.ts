import { getHeapStatistics } from "node:v8";

const JSON_AMPLIFICATION = 6;

export interface RuntimeMemoryBudget {
  heapLimitBytes: number;
  processLimitBytes: number;
  jsonAmplification: number;
  activeRequestBytes: number;
  responseWorkBytes: number;
  maxWireBytes: number;
  minRequestChargeBytes: number;
  writeQueueBytes: number;
  sessionCacheBytes: number;
  responseCaptureBytes: number;
  sseTailChars: number;
  sqlitePageCacheBytes: number;
  sqliteMaintenanceCacheBytes: number;
  websocketIngressBytes: number;
  websocketMaxPayloadBytes: number;
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
  const hasConstrainedLimit = Number.isFinite(constrained) && constrained > 0;
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
  const maxWireBytes = Math.floor(activeRequestBytes / JSON_AMPLIFICATION);
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
    maxWireBytes,
    minRequestChargeBytes: Math.max(1, Math.floor(activeRequestBytes * 0.01)),
    writeQueueBytes,
    sessionCacheBytes,
    responseCaptureBytes,
    sseTailChars: Math.max(1, Math.floor(responseCaptureBytes * 0.0004)),
    sqlitePageCacheBytes,
    sqliteMaintenanceCacheBytes,
    websocketIngressBytes,
    websocketMaxPayloadBytes: Math.min(maxWireBytes, websocketIngressBytes),
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
