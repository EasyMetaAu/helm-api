import {
  acquireResponseWork,
  type ResponseWorkAdmission,
  ResponseWorkCapacityError,
  type ResponseWorkLease,
  runtimeResponseWorkAdmission,
} from "./response-work-admission.js";

/** A response body exceeded the caller's runtime-derived byte budget. */
export class ResponseBodyTooLargeError extends Error {
  readonly limitBytes: number;

  constructor(limitBytes: number) {
    super("upstream response exceeds the runtime memory budget");
    this.name = "ResponseBodyTooLargeError";
    this.limitBytes = limitBytes;
  }
}

function exceedsBudget(contentLength: string | null, maxBytes: number): boolean {
  if (maxBytes === 0) return false;
  if (contentLength === null || !/^\d+$/.test(contentLength)) return false;
  const bytes = Number(contentLength);
  return !Number.isSafeInteger(bytes) || bytes > maxBytes;
}

/**
 * Reads a unary upstream response without letting an untrusted body allocate past
 * the runtime-derived wire budget. Content-Length is only an early rejection; the
 * stream is always counted because it may be absent or dishonest.
 */
export async function readResponseTextWithinBudget(
  response: Response,
  maxBytes: number,
  admission: ResponseWorkAdmission = runtimeResponseWorkAdmission(),
): Promise<string> {
  return await consumeResponseTextWithinBudget(response, maxBytes, (text) => text, admission);
}

export async function consumeResponseTextWithinBudget<T>(
  response: Response,
  maxBytes: number,
  consume: (text: string) => T | Promise<T>,
  admission: ResponseWorkAdmission = runtimeResponseWorkAdmission(),
): Promise<T> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new Error("maxBytes must be a non-negative safe integer");
  }
  if (exceedsBudget(response.headers.get("content-length"), maxBytes)) {
    await response.body?.cancel().catch(() => {});
    throw new ResponseBodyTooLargeError(maxBytes);
  }

  const contentLength = response.headers.get("content-length");
  const declaredBytes =
    contentLength !== null && /^\d+$/.test(contentLength) ? Number(contentLength) : 0;
  let lease: ResponseWorkLease;
  try {
    lease = acquireResponseWork(admission, declaredBytes);
  } catch (error) {
    await response.body?.cancel().catch(() => {});
    throw error;
  }

  try {
    const reader = response.body?.getReader();
    if (reader === undefined) return await consume("");
    const chunks: Uint8Array[] = [];
    let totalBytes = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;
        totalBytes += value.byteLength;
        if (maxBytes > 0 && totalBytes > maxBytes) {
          await reader.cancel().catch(() => {});
          throw new ResponseBodyTooLargeError(maxBytes);
        }
        if (!lease.resize(totalBytes).ok) {
          await reader.cancel().catch(() => {});
          throw new ResponseWorkCapacityError(admission.capacityBytes);
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }

    const bytes = new Uint8Array(totalBytes);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return await consume(new TextDecoder().decode(bytes));
  } finally {
    lease.release();
  }
}

export async function consumeResponseBytesWithinBudget(
  response: Response,
  maxBytes: number,
  admission: ResponseWorkAdmission = runtimeResponseWorkAdmission(),
): Promise<Uint8Array> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new Error("maxBytes must be a non-negative safe integer");
  }
  if (exceedsBudget(response.headers.get("content-length"), maxBytes)) {
    await response.body?.cancel().catch(() => {});
    throw new ResponseBodyTooLargeError(maxBytes);
  }
  const contentLength = response.headers.get("content-length");
  const declaredBytes =
    contentLength !== null && /^\d+$/.test(contentLength) ? Number(contentLength) : 0;
  let lease: ResponseWorkLease;
  try {
    lease = acquireResponseWork(admission, declaredBytes);
  } catch (error) {
    await response.body?.cancel().catch(() => {});
    throw error;
  }
  try {
    const reader = response.body?.getReader();
    if (reader === undefined) return new Uint8Array();
    const chunks: Uint8Array[] = [];
    let totalBytes = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;
        totalBytes += value.byteLength;
        if (maxBytes > 0 && totalBytes > maxBytes) {
          await reader.cancel().catch(() => {});
          throw new ResponseBodyTooLargeError(maxBytes);
        }
        if (!lease.resize(totalBytes).ok) {
          await reader.cancel().catch(() => {});
          throw new ResponseWorkCapacityError(admission.capacityBytes);
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
    const bytes = new Uint8Array(totalBytes);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return bytes;
  } finally {
    lease.release();
  }
}
