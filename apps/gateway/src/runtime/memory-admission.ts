import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "../app.js";

/**
 * Request-body memory admission used to reject work when active capacity or live
 * heap was exhausted. Lukin disabled that gate: the gateway accepts every body
 * and lets the process/cgroup decide how much work it can carry.
 *
 * Lease bookkeeping remains so maintenance `waitForIdle()` still drains in-flight
 * reads, and so existing release guards keep working. Acquire/resize never fail
 * for capacity, heap, wire size, or pause.
 */

export type RequestAdmissionCause =
  | "wire_limit"
  | "paused"
  | "active_capacity"
  | "live_heap"
  | "materialized"
  | "released";

export interface RequestAdmissionSnapshot {
  cause: RequestAdmissionCause;
  wireBytes: number;
  requestedChargeBytes: number;
  activeReservedBytes: number;
  activeCapacityBytes: number;
  pendingBytes: number;
  heapUsedBytes: number | null;
  heapCeilingBytes: number | null;
}

export class RequestAdmissionError extends Error {
  constructor(
    readonly status: 413 | 503,
    readonly code: "request_too_large" | "server_overloaded",
    message: string,
    readonly admission?: RequestAdmissionSnapshot,
  ) {
    super(message);
    this.name = "RequestAdmissionError";
  }
}

const UNLIMITED_WIRE_BYTES = Number.MAX_SAFE_INTEGER;

export function createBodyMemoryAdmission(options: {
  activeRequestBytes: number;
  maxWireBytes: number;
  jsonAmplification: number;
  minRequestChargeBytes?: number;
  heapLimitBytes?: number;
  protectedHeapBytes?: number;
  heapUsedBytes?: () => number;
}) {
  let reservedBytes = 0;
  let pendingBytes = 0;
  const idleWaiters: Array<() => void> = [];
  const resolveIdle = () => {
    if (reservedBytes !== 0) return;
    for (const resolve of idleWaiters.splice(0)) resolve();
  };
  // Options are retained for call-site compatibility and optional bookkeeping only.
  const minRequestChargeBytes =
    options.minRequestChargeBytes ?? Math.max(1, Math.floor(options.activeRequestBytes * 0.01));
  const charge = (wireBytes: number): number =>
    Math.max(minRequestChargeBytes, Math.ceil(Math.max(0, wireBytes) * options.jsonAmplification));
  void options.maxWireBytes;
  void options.heapLimitBytes;
  void options.protectedHeapBytes;
  void options.heapUsedBytes;

  return {
    /** Unlimited: WebSocket maxPayload and callers must not size-reject. */
    maxWireBytes: UNLIMITED_WIRE_BYTES,
    acquire(wireBytes: number) {
      let held = charge(wireBytes);
      reservedBytes += held;
      pendingBytes += held;
      let released = false;
      let isMaterialized = false;
      return {
        ok: true as const,
        lease: {
          resize(nextWireBytes: number) {
            if (released || isMaterialized) {
              return { ok: true as const };
            }
            const next = charge(nextWireBytes);
            reservedBytes += next - held;
            pendingBytes += next - held;
            held = next;
            return { ok: true as const };
          },
          materialized() {
            if (released || isMaterialized) return;
            isMaterialized = true;
            pendingBytes -= held;
          },
          release() {
            if (released) return;
            released = true;
            reservedBytes -= held;
            if (!isMaterialized) pendingBytes -= held;
            resolveIdle();
          },
        },
      };
    },
    /** No-op: admission is never paused for capacity reasons. */
    pause() {},
    resume() {},
    waitForIdle(): Promise<void> {
      if (reservedBytes === 0) return Promise.resolve();
      return new Promise((resolve) => idleWaiters.push(resolve));
    },
    get reservedBytes() {
      return reservedBytes;
    },
    get pendingBytes() {
      return pendingBytes;
    },
  };
}

export type BodyMemoryAdmission = ReturnType<typeof createBodyMemoryAdmission>;

export function memoryAdmissionReleaseGuard(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    try {
      await next();
    } finally {
      c.get("requestMemoryRelease")?.();
    }
  };
}

declare module "hono" {
  interface ContextVariableMap {
    requestMemoryRelease?: (() => void) | undefined;
  }
}

export async function readAdmittedRequestBody(
  request: Request,
  admission: BodyMemoryAdmission,
): Promise<{ text: string; bytes: Uint8Array; materialized: () => void; release: () => void }> {
  const declared = Number(request.headers.get("content-length"));
  const initialBytes =
    request.headers.has("transfer-encoding") || !Number.isFinite(declared) || declared < 0
      ? 0
      : declared;
  const { lease } = admission.acquire(initialBytes);
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    const reader = request.body?.getReader();
    if (reader) {
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        bytes += next.value.byteLength;
        lease.resize(bytes);
        chunks.push(next.value);
      }
    }
    lease.resize(bytes);
    const body = Buffer.concat(chunks, bytes);
    return {
      text: body.toString("utf8"),
      bytes: body,
      materialized: lease.materialized,
      release: lease.release,
    };
  } catch (error) {
    lease.release();
    throw error;
  }
}
