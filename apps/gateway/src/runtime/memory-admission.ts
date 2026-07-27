import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "../app.js";

/**
 * Request-body memory admission.
 *
 * Capacity / live-heap / wire-size gates are intentionally disabled: the gateway
 * accepts every body and lets the process/cgroup decide how much work it can
 * carry. Lease bookkeeping remains so vacuum can `pause()` + `waitForIdle()`.
 *
 * The only remaining rejection is **maintenance pause**: while vacuum (or any
 * caller) has paused admission, new acquires fail with `server_overloaded` so
 * in-flight leases can drain and `waitForIdle()` can complete.
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
  let paused = false;
  const idleWaiters: Array<() => void> = [];
  const resolveIdle = () => {
    if (reservedBytes !== 0) return;
    for (const resolve of idleWaiters.splice(0)) resolve();
  };
  // Historical options retained for call-site compatibility / bookkeeping only.
  // They do not enforce capacity, heap, or wire limits.
  const minRequestChargeBytes =
    options.minRequestChargeBytes ?? Math.max(1, Math.floor(options.activeRequestBytes * 0.01));
  const charge = (wireBytes: number): number =>
    Math.max(minRequestChargeBytes, Math.ceil(Math.max(0, wireBytes) * options.jsonAmplification));
  void options.maxWireBytes;
  void options.heapLimitBytes;
  void options.protectedHeapBytes;
  void options.heapUsedBytes;

  const pauseRejection = (wireBytes: number, requestedChargeBytes: number) =>
    ({
      ok: false as const,
      reason: "busy" as const,
      cause: "paused" as const,
      admission: {
        cause: "paused" as const,
        wireBytes,
        requestedChargeBytes,
        activeReservedBytes: reservedBytes,
        activeCapacityBytes: options.activeRequestBytes,
        pendingBytes,
        heapUsedBytes: null,
        heapCeilingBytes: null,
      } satisfies RequestAdmissionSnapshot,
    }) as const;

  return {
    /** Unlimited: WebSocket maxPayload and callers must not size-reject. */
    maxWireBytes: UNLIMITED_WIRE_BYTES,
    acquire(wireBytes: number) {
      const held = charge(wireBytes);
      if (paused) return pauseRejection(wireBytes, held);
      reservedBytes += held;
      pendingBytes += held;
      let released = false;
      let isMaterialized = false;
      let current = held;
      return {
        ok: true as const,
        lease: {
          resize(nextWireBytes: number) {
            if (released || isMaterialized) {
              return { ok: true as const };
            }
            // In-flight leases may still grow while maintenance is paused so the
            // current body/frame can finish; only *new* acquires are rejected.
            const next = charge(nextWireBytes);
            reservedBytes += next - current;
            pendingBytes += next - current;
            current = next;
            return { ok: true as const };
          },
          materialized() {
            if (released || isMaterialized) return;
            isMaterialized = true;
            pendingBytes -= current;
          },
          release() {
            if (released) return;
            released = true;
            reservedBytes -= current;
            if (!isMaterialized) pendingBytes -= current;
            resolveIdle();
          },
        },
      };
    },
    /** Maintenance only: block new acquires so waitForIdle can drain. */
    pause() {
      paused = true;
    },
    resume() {
      paused = false;
    },
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

/** Thrown only when admission is paused for maintenance (not capacity). */
function pauseError(admission?: RequestAdmissionSnapshot) {
  return new RequestAdmissionError(
    503,
    "server_overloaded",
    "request memory capacity is temporarily exhausted",
    admission,
  );
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
  const acquired = admission.acquire(initialBytes);
  if (!acquired.ok) {
    await request.body?.cancel().catch(() => {});
    throw pauseError(acquired.admission);
  }
  const { lease } = acquired;
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
