import type { OAuthQuotaWindow } from "@helm/shared";

const MAX_GRPC_WEB_RESPONSE_BYTES = 1024 * 1024;
const WEEKLY_WINDOW_MINUTES = 7 * 24 * 60;
const MIN_WEEKLY_WINDOW_MS = 6 * 24 * 60 * 60_000;
const MAX_WEEKLY_WINDOW_MS = 8 * 24 * 60 * 60_000;

export interface XaiGrokCreditsRequestOptions {
  excludeLegacyMonthlyUsage?: boolean;
}

class ProtoReader {
  private offset = 0;

  constructor(private readonly bytes: Uint8Array) {}

  get done(): boolean {
    return this.offset === this.bytes.length;
  }

  varint(): bigint {
    let value = 0n;
    for (let index = 0; index < 10; index += 1) {
      if (this.offset >= this.bytes.length) throw new Error("truncated protobuf varint");
      const current = this.bytes[this.offset++];
      if (current === undefined) throw new Error("truncated protobuf varint");
      value |= BigInt(current & 0x7f) << BigInt(index * 7);
      if ((current & 0x80) === 0) {
        if (index === 9 && current > 1) throw new Error("protobuf varint overflow");
        return value;
      }
    }
    throw new Error("protobuf varint overflow");
  }

  tag(): { field: number; wire: number } {
    const raw = this.varint();
    const field = Number(raw >> 3n);
    const wire = Number(raw & 7n);
    if (!Number.isSafeInteger(field) || field <= 0) throw new Error("invalid protobuf field");
    return { field, wire };
  }

  bytesField(wire: number): Uint8Array {
    if (wire !== 2) throw new Error("invalid protobuf wire type");
    const length = Number(this.varint());
    if (!Number.isSafeInteger(length) || length < 0 || length > this.bytes.length - this.offset) {
      throw new Error("truncated protobuf field");
    }
    const value = this.bytes.subarray(this.offset, this.offset + length);
    this.offset += length;
    return value;
  }

  float32(wire: number): number {
    if (wire !== 5 || this.bytes.length - this.offset < 4) {
      throw new Error("invalid protobuf float field");
    }
    const value = new DataView(
      this.bytes.buffer,
      this.bytes.byteOffset + this.offset,
      4,
    ).getFloat32(0, true);
    this.offset += 4;
    return value;
  }

  skip(wire: number): void {
    if (wire === 0) {
      this.varint();
      return;
    }
    if (wire === 1) {
      this.advance(8);
      return;
    }
    if (wire === 2) {
      this.bytesField(2);
      return;
    }
    if (wire === 5) {
      this.advance(4);
      return;
    }
    throw new Error("unsupported protobuf wire type");
  }

  private advance(length: number): void {
    if (length > this.bytes.length - this.offset) throw new Error("truncated protobuf field");
    this.offset += length;
  }
}

function framed(payload: Uint8Array): Uint8Array {
  const frame = new Uint8Array(5 + payload.length);
  new DataView(frame.buffer).setUint32(1, payload.length, false);
  frame.set(payload, 5);
  return frame;
}

/** Build the unary gRPC-Web request body used by Grok's first-party usage page. */
export function buildXaiGrokCreditsRequest(options: XaiGrokCreditsRequestOptions = {}): Uint8Array {
  return framed(options.excludeLegacyMonthlyUsage ? Uint8Array.of(0x08, 0x01) : new Uint8Array());
}

function grpcDataPayload(body: Uint8Array): Uint8Array {
  if (body.length > MAX_GRPC_WEB_RESPONSE_BYTES) throw new Error("gRPC-Web response too large");
  let offset = 0;
  let data: Uint8Array | null = null;
  let phase: "data" | "trailer" | "done" = "data";
  while (offset < body.length) {
    if (phase === "done") throw new Error("gRPC-Web frame after final trailer");
    if (body.length - offset < 5) throw new Error("truncated gRPC-Web frame");
    const flag = body[offset];
    const length = new DataView(body.buffer, body.byteOffset + offset + 1, 4).getUint32(0, false);
    offset += 5;
    if (length > body.length - offset) throw new Error("truncated gRPC-Web frame");
    const payload = body.subarray(offset, offset + length);
    offset += length;
    if (flag === 0) {
      if (phase !== "data" || data !== null) throw new Error("unexpected gRPC-Web data frame");
      data = payload;
      phase = "trailer";
      continue;
    }
    if (flag === 0x80) {
      if (phase !== "trailer") throw new Error("unexpected gRPC-Web trailer frame");
      const trailers = new TextDecoder("utf-8", { fatal: true }).decode(payload);
      const statuses = trailers
        .split(/\r?\n/)
        .map((line) => /^grpc-status:\s*(\d+)\s*$/i.exec(line)?.[1])
        .filter((status): status is string => status !== undefined);
      if (statuses.length !== 1 || statuses[0] !== "0") {
        throw new Error("gRPC-Web trailer error");
      }
      phase = "done";
      continue;
    }
    throw new Error("unsupported gRPC-Web frame flag");
  }
  if (data === null || phase !== "done") throw new Error("incomplete unary gRPC-Web response");
  return data;
}

function nestedField(bytes: Uint8Array, wantedField: number): Uint8Array | null {
  const reader = new ProtoReader(bytes);
  let result: Uint8Array | null = null;
  while (!reader.done) {
    const { field, wire } = reader.tag();
    if (field === wantedField) result = reader.bytesField(wire);
    else reader.skip(wire);
  }
  return result;
}

function timestampMs(bytes: Uint8Array): number | null {
  const reader = new ProtoReader(bytes);
  let seconds: bigint | null = null;
  let nanos = 0n;
  while (!reader.done) {
    const { field, wire } = reader.tag();
    if (field === 1) {
      if (wire !== 0) throw new Error("invalid timestamp seconds");
      seconds = reader.varint();
    } else if (field === 2) {
      if (wire !== 0) throw new Error("invalid timestamp nanos");
      nanos = reader.varint();
    } else {
      reader.skip(wire);
    }
  }
  if (seconds === null || nanos < 0n || nanos >= 1_000_000_000n) return null;
  const milliseconds = seconds * 1000n + nanos / 1_000_000n;
  if (milliseconds > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  return Number(milliseconds);
}

interface CurrentPeriod {
  type: number;
  startMs: number;
  endMs: number;
}

function currentPeriod(bytes: Uint8Array): CurrentPeriod | null {
  const reader = new ProtoReader(bytes);
  let type = 0;
  let startMs: number | null = null;
  let endMs: number | null = null;
  while (!reader.done) {
    const { field, wire } = reader.tag();
    if (field === 1) {
      if (wire !== 0) throw new Error("invalid usage-period type");
      type = Number(reader.varint());
    } else if (field === 2) {
      startMs = timestampMs(reader.bytesField(wire));
    } else if (field === 3) {
      endMs = timestampMs(reader.bytesField(wire));
    } else {
      reader.skip(wire);
    }
  }
  return startMs === null || endMs === null ? null : { type, startMs, endMs };
}

function quotaWindow(config: Uint8Array, nowMs: number): OAuthQuotaWindow | null {
  const reader = new ProtoReader(config);
  let usedPercent = 0;
  let period: CurrentPeriod | null = null;
  while (!reader.done) {
    const { field, wire } = reader.tag();
    if (field === 1) usedPercent = reader.float32(wire);
    else if (field === 8) period = currentPeriod(reader.bytesField(wire));
    else reader.skip(wire);
  }
  if (
    !Number.isFinite(usedPercent) ||
    usedPercent < 0 ||
    period === null ||
    period.type !== 2 ||
    period.startMs >= period.endMs ||
    period.endMs - period.startMs < MIN_WEEKLY_WINDOW_MS ||
    period.endMs - period.startMs > MAX_WEEKLY_WINDOW_MS ||
    nowMs < period.startMs ||
    nowMs >= period.endMs
  ) {
    return null;
  }
  return {
    key: "7d",
    usedPercent,
    resetsAtMs: period.endMs,
    windowMinutes: WEEKLY_WINDOW_MINUTES,
  };
}

/**
 * Parse an untrusted unary gRPC-Web response from GetGrokCreditsConfig.
 * Malformed, stale, non-weekly, oversized, and non-zero-status responses fail open.
 */
export function parseXaiGrokCreditsResponse(
  body: Uint8Array,
  nowMs: number = Date.now(),
): OAuthQuotaWindow[] {
  if (!Number.isSafeInteger(nowMs)) return [];
  try {
    const response = grpcDataPayload(body);
    const config = nestedField(response, 1);
    if (config === null) return [];
    const window = quotaWindow(config, nowMs);
    return window === null ? [] : [window];
  } catch {
    return [];
  }
}
