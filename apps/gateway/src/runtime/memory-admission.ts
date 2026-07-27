import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "../app.js";

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
  const minRequestChargeBytes =
    options.minRequestChargeBytes ?? Math.max(1, Math.floor(options.activeRequestBytes * 0.01));
  const charge = (wireBytes: number): number =>
    Math.max(minRequestChargeBytes, Math.ceil(Math.max(0, wireBytes) * options.jsonAmplification));
  const heapCeilingBytes = Math.max(
    0,
    (options.heapLimitBytes ?? Number.POSITIVE_INFINITY) - (options.protectedHeapBytes ?? 0),
  );
  const readHeapUsedBytes = (): number | null => {
    const heapUsedBytes = options.heapUsedBytes?.();
    return heapUsedBytes !== undefined && Number.isFinite(heapUsedBytes) && heapUsedBytes >= 0
      ? heapUsedBytes
      : null;
  };
  const rejection = (
    cause: RequestAdmissionCause,
    wireBytes: number,
    requestedChargeBytes: number,
    heapUsedBytes = readHeapUsedBytes(),
  ) => ({
    ok: false as const,
    reason: cause === "wire_limit" ? ("too_large" as const) : ("busy" as const),
    cause,
    admission: {
      cause,
      wireBytes,
      requestedChargeBytes,
      activeReservedBytes: reservedBytes,
      activeCapacityBytes: options.activeRequestBytes,
      pendingBytes,
      heapUsedBytes,
      heapCeilingBytes: Number.isFinite(heapCeilingBytes) ? heapCeilingBytes : null,
    } satisfies RequestAdmissionSnapshot,
  });

  return {
    maxWireBytes: options.maxWireBytes,
    acquire(wireBytes: number) {
      let held = charge(wireBytes);
      if (paused) return rejection("paused", wireBytes, held);
      if (wireBytes > options.maxWireBytes) return rejection("wire_limit", wireBytes, held);
      if (reservedBytes + held > options.activeRequestBytes) {
        return rejection("active_capacity", wireBytes, held);
      }
      const heapUsedBytes = readHeapUsedBytes();
      if (heapUsedBytes !== null && heapUsedBytes + pendingBytes + held > heapCeilingBytes) {
        return rejection("live_heap", wireBytes, held, heapUsedBytes);
      }
      reservedBytes += held;
      pendingBytes += held;
      let released = false;
      let isMaterialized = false;
      return {
        ok: true as const,
        lease: {
          resize(nextWireBytes: number) {
            if (released) return rejection("released", nextWireBytes, charge(nextWireBytes));
            if (isMaterialized) {
              return rejection("materialized", nextWireBytes, charge(nextWireBytes));
            }
            const next = charge(nextWireBytes);
            if (nextWireBytes > options.maxWireBytes) {
              return rejection("wire_limit", nextWireBytes, next);
            }
            if (reservedBytes - held + next > options.activeRequestBytes) {
              return rejection("active_capacity", nextWireBytes, next);
            }
            const nextPendingBytes = pendingBytes - held + next;
            const heapUsedBytes = readHeapUsedBytes();
            if (heapUsedBytes !== null && heapUsedBytes + nextPendingBytes > heapCeilingBytes) {
              return rejection("live_heap", nextWireBytes, next, heapUsedBytes);
            }
            reservedBytes += next - held;
            pendingBytes = nextPendingBytes;
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

function admissionError(
  reason: "too_large" | "busy",
  maxWireBytes: number,
  admission?: RequestAdmissionSnapshot,
) {
  return reason === "too_large"
    ? new RequestAdmissionError(
        413,
        "request_too_large",
        `request body exceeds the runtime capacity limit of ${maxWireBytes} bytes`,
        admission,
      )
    : new RequestAdmissionError(
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
    throw admissionError(acquired.reason, admission.maxWireBytes, acquired.admission);
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
          throw admissionError(resized.reason, admission.maxWireBytes, resized.admission);
        }
        chunks.push(next.value);
      }
    }
    const resized = lease.resize(bytes);
    if (!resized.ok) {
      throw admissionError(resized.reason, admission.maxWireBytes, resized.admission);
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
