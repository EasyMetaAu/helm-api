import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "../app.js";

/**
 * Request-body memory admission.
 *
 * Capacity, live-heap and per-request wire gates are intentionally disabled:
 * they used heuristic reservations that rejected healthy traffic. Lease
 * bookkeeping remains so vacuum can `pause()` + `waitForIdle()`.
 *
 * The other remaining rejection is **maintenance pause**: while vacuum (or any
 * caller) has paused admission, new acquires fail with `database_maintenance`
 * so in-flight leases can drain and `waitForIdle()` can complete.
 */

export type RequestAdmissionCause = "paused";

export interface RequestAdmissionSnapshot {
  cause: RequestAdmissionCause;
  wireBytes: number;
  requestedChargeBytes: number;
  activeReservedBytes: number;
  pendingBytes: number;
}

export class RequestAdmissionError extends Error {
  constructor(
    readonly status: 503,
    readonly code: "database_maintenance",
    message: string,
    readonly admission?: RequestAdmissionSnapshot,
  ) {
    super(message);
    this.name = "RequestAdmissionError";
  }
}

export function createBodyMemoryAdmission(options: {
  activeRequestBytes: number;
  jsonAmplification: number;
  minRequestChargeBytes?: number;
}) {
  let reservedBytes = 0;
  let pendingBytes = 0;
  let paused = false;
  const idleWaiters: Array<() => void> = [];
  const resolveIdle = () => {
    if (reservedBytes !== 0) return;
    for (const resolve of idleWaiters.splice(0)) resolve();
  };
  // Capacity-derived charge remains bookkeeping only. It never rejects work.
  const minRequestChargeBytes =
    options.minRequestChargeBytes ?? Math.max(1, Math.floor(options.activeRequestBytes * 0.01));
  const charge = (wireBytes: number): number =>
    Math.max(minRequestChargeBytes, Math.ceil(Math.max(0, wireBytes) * options.jsonAmplification));

  const rejection = (
    cause: RequestAdmissionCause,
    wireBytes: number,
    requestedChargeBytes: number,
  ) =>
    ({
      ok: false as const,
      reason: "busy" as const,
      cause,
      admission: {
        cause,
        wireBytes,
        requestedChargeBytes,
        activeReservedBytes: reservedBytes,
        pendingBytes,
      } satisfies RequestAdmissionSnapshot,
    }) as const;

  return {
    acquire(wireBytes: number) {
      const held = charge(wireBytes);
      if (paused) return rejection("paused", wireBytes, held);
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

export function requestAdmissionError(admission?: RequestAdmissionSnapshot) {
  return new RequestAdmissionError(
    503,
    "database_maintenance",
    "database maintenance in progress",
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
    throw requestAdmissionError(acquired.admission);
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
