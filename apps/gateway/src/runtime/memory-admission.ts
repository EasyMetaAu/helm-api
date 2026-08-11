import type { RuntimeMemoryCoordinator, RuntimeMemoryLease } from "@helm/core";
import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "../app.js";

/**
 * Request-body memory admission.
 *
 * There is no fixed per-request wire limit. A shared, live-headroom coordinator
 * bounds aggregate pending memory across HTTP, websocket ingress, and response
 * work, while lease bookkeeping also lets vacuum `pause()` + `waitForIdle()`.
 *
 * The other remaining rejection is **maintenance pause**: while vacuum (or any
 * caller) has paused admission, new acquires fail with `database_maintenance`
 * so in-flight leases can drain and `waitForIdle()` can complete.
 */

export type RequestAdmissionCause = "paused" | "capacity";

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
    readonly code: "database_maintenance" | "server_overloaded",
    message: string,
    readonly admission?: RequestAdmissionSnapshot,
  ) {
    super(message);
    this.name = "RequestAdmissionError";
  }
}

export function createBodyMemoryAdmission(options: {
  activeRequestBytes: number;
  capacityBytes?: () => number;
  jsonAmplification: number;
  minRequestChargeBytes?: number;
  coordinator?: RuntimeMemoryCoordinator;
}) {
  let reservedBytes = 0;
  let pendingBytes = 0;
  let paused = false;
  const idleWaiters: Array<() => void> = [];
  const resolveIdle = () => {
    if (reservedBytes !== 0) return;
    for (const resolve of idleWaiters.splice(0)) resolve();
  };
  // Estimate retained memory rather than treating wire bytes as heap bytes.
  const minRequestChargeBytes =
    options.minRequestChargeBytes ?? Math.max(1, Math.floor(options.activeRequestBytes * 0.01));
  const charge = (wireBytes: number): number =>
    Math.max(minRequestChargeBytes, Math.ceil(Math.max(0, wireBytes) * options.jsonAmplification));
  const capacityBytes = (): number =>
    Math.max(0, Math.floor(options.capacityBytes?.() ?? Number.MAX_SAFE_INTEGER));

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
      const shared = options.coordinator?.acquire(held);
      if (shared !== undefined && !shared.ok) return rejection("capacity", wireBytes, held);
      if (shared === undefined && pendingBytes + held > capacityBytes()) {
        return rejection("capacity", wireBytes, held);
      }
      reservedBytes += held;
      pendingBytes += held;
      let released = false;
      let isMaterialized = false;
      let current = held;
      let sharedLease: RuntimeMemoryLease | undefined =
        shared?.ok === true ? shared.lease : undefined;
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
            if (sharedLease !== undefined) {
              if (!sharedLease.resize(next).ok) {
                return {
                  ok: false as const,
                  admission: rejection("capacity", nextWireBytes, next).admission,
                };
              }
            } else if (next > current && pendingBytes - current + next > capacityBytes()) {
              return {
                ok: false as const,
                admission: rejection("capacity", nextWireBytes, next).admission,
              };
            }
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
            sharedLease?.release();
            sharedLease = undefined;
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
  if (admission?.cause === "capacity") {
    return new RequestAdmissionError(
      503,
      "server_overloaded",
      "request memory capacity is temporarily exhausted",
      admission,
    );
  }
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
        const resized = lease.resize(bytes);
        if (!resized.ok) {
          await reader.cancel().catch(() => {});
          throw requestAdmissionError(resized.admission);
        }
        chunks.push(next.value);
      }
    }
    const resized = lease.resize(bytes);
    if (!resized.ok) {
      throw requestAdmissionError(resized.admission);
    }
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
