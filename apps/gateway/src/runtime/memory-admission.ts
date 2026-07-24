import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "../app.js";

export class RequestAdmissionError extends Error {
  constructor(
    readonly status: 413 | 503,
    readonly code: "request_too_large" | "server_overloaded",
    message: string,
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
  const exceedsLiveHeap = (nextReservedBytes: number): boolean => {
    const heapUsedBytes = options.heapUsedBytes?.();
    return (
      heapUsedBytes !== undefined &&
      Number.isFinite(heapUsedBytes) &&
      heapUsedBytes >= 0 &&
      heapUsedBytes + nextReservedBytes > heapCeilingBytes
    );
  };
  const rejection = (wireBytes: number) =>
    wireBytes > options.maxWireBytes
      ? { ok: false as const, reason: "too_large" as const }
      : { ok: false as const, reason: "busy" as const };

  return {
    maxWireBytes: options.maxWireBytes,
    acquire(wireBytes: number) {
      if (paused) return { ok: false as const, reason: "busy" as const };
      let held = charge(wireBytes);
      if (
        wireBytes > options.maxWireBytes ||
        reservedBytes + held > options.activeRequestBytes ||
        exceedsLiveHeap(reservedBytes + held)
      ) {
        return rejection(wireBytes);
      }
      reservedBytes += held;
      let released = false;
      return {
        ok: true as const,
        lease: {
          resize(nextWireBytes: number) {
            if (released) return { ok: false as const, reason: "busy" as const };
            const next = charge(nextWireBytes);
            if (
              nextWireBytes > options.maxWireBytes ||
              reservedBytes - held + next > options.activeRequestBytes ||
              exceedsLiveHeap(reservedBytes - held + next)
            ) {
              return rejection(nextWireBytes);
            }
            reservedBytes += next - held;
            held = next;
            return { ok: true as const };
          },
          release() {
            if (released) return;
            released = true;
            reservedBytes -= held;
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

function admissionError(reason: "too_large" | "busy", maxWireBytes: number) {
  return reason === "too_large"
    ? new RequestAdmissionError(
        413,
        "request_too_large",
        `request body exceeds the runtime capacity limit of ${maxWireBytes} bytes`,
      )
    : new RequestAdmissionError(
        503,
        "server_overloaded",
        "request memory capacity is temporarily exhausted",
      );
}

export async function readAdmittedRequestBody(
  request: Request,
  admission: BodyMemoryAdmission,
): Promise<{ text: string; release: () => void }> {
  const declared = Number(request.headers.get("content-length"));
  const initialBytes =
    request.headers.has("transfer-encoding") || !Number.isFinite(declared) || declared < 0
      ? 0
      : declared;
  const acquired = admission.acquire(initialBytes);
  if (!acquired.ok) {
    await request.body?.cancel().catch(() => {});
    throw admissionError(acquired.reason, admission.maxWireBytes);
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
          throw admissionError(resized.reason, admission.maxWireBytes);
        }
        chunks.push(next.value);
      }
    }
    const resized = lease.resize(bytes);
    if (!resized.ok) throw admissionError(resized.reason, admission.maxWireBytes);
    return {
      text: Buffer.concat(chunks).toString("utf8"),
      release: lease.release,
    };
  } catch (error) {
    lease.release();
    throw error;
  }
}
