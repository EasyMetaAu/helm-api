import { describe, expect, it } from "vitest";
import { buildXaiGrokCreditsRequest, parseXaiGrokCreditsResponse } from "./xai-quota.js";

const NOW_MS = 1_752_100_000_000;

const concat = (...parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
};

const byte = (...values: number[]): Uint8Array => Uint8Array.from(values);

function varint(value: number): Uint8Array {
  const bytes: number[] = [];
  let remaining = value;
  do {
    const next = remaining % 128;
    remaining = Math.floor(remaining / 128);
    bytes.push(next | (remaining > 0 ? 0x80 : 0));
  } while (remaining > 0);
  return byte(...bytes);
}

function message(field: number, value: Uint8Array): Uint8Array {
  return concat(varint(field * 8 + 2), varint(value.length), value);
}

function int64(field: number, value: number): Uint8Array {
  return concat(varint(field * 8), varint(value));
}

function float32(field: number, value: number): Uint8Array {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setFloat32(0, value, true);
  return concat(varint(field * 8 + 5), bytes);
}

function frame(flag: number, payload: Uint8Array): Uint8Array {
  const header = new Uint8Array(5);
  header[0] = flag;
  new DataView(header.buffer).setUint32(1, payload.length, false);
  return concat(header, payload);
}

function timestamp(seconds: number, nanos = 0): Uint8Array {
  return concat(int64(1, seconds), ...(nanos === 0 ? [] : [int64(2, nanos)]));
}

function response(
  input: {
    percent?: number;
    periodType?: number;
    startSeconds?: number;
    endSeconds?: number;
    nanos?: number;
  } = {},
): Uint8Array {
  const period = concat(
    int64(1, input.periodType ?? 2),
    message(2, timestamp(input.startSeconds ?? 1_752_000_000, input.nanos)),
    message(3, timestamp(input.endSeconds ?? 1_752_604_800)),
  );
  const config = concat(
    ...(input.percent === undefined ? [] : [float32(1, input.percent)]),
    message(8, period),
  );
  return concat(
    frame(0, message(1, config)),
    frame(0x80, new TextEncoder().encode("grpc-status: 0\r\n")),
  );
}

describe("buildXaiGrokCreditsRequest", () => {
  it("builds the observed framed request and omits an optional false field", () => {
    expect([...buildXaiGrokCreditsRequest({ excludeLegacyMonthlyUsage: true })]).toEqual([
      0, 0, 0, 0, 2, 8, 1,
    ]);
    expect([...buildXaiGrokCreditsRequest()]).toEqual([0, 0, 0, 0, 0]);
  });
});

describe("parseXaiGrokCreditsResponse", () => {
  it("maps a weekly current period to a normalized quota window", () => {
    expect(parseXaiGrokCreditsResponse(response({ percent: 12.5 }), NOW_MS)).toEqual([
      {
        key: "7d",
        usedPercent: 12.5,
        resetsAtMs: 1_752_604_800_000,
        windowMinutes: 10_080,
      },
    ]);
  });

  it("treats an omitted proto3 percentage as zero", () => {
    expect(parseXaiGrokCreditsResponse(response(), NOW_MS)[0]?.usedPercent).toBe(0);
  });

  it("preserves an upstream percentage above 100", () => {
    expect(parseXaiGrokCreditsResponse(response({ percent: 123.5 }), NOW_MS)[0]?.usedPercent).toBe(
      123.5,
    );
  });

  it("accepts a valid timestamp nanos component", () => {
    expect(parseXaiGrokCreditsResponse(response({ nanos: 500_000_000 }), NOW_MS)).toHaveLength(1);
  });

  it.each([
    ["a non-weekly period", response({ periodType: 1 })],
    ["a reversed period", response({ startSeconds: 1_752_604_800, endSeconds: 1_752_000_000 })],
    [
      "a stale current period",
      response({ startSeconds: 1_751_000_000, endSeconds: 1_751_604_800 }),
    ],
    ["invalid timestamp nanos", response({ nanos: 1_000_000_000 })],
    ["a malformed truncated frame", byte(0, 0, 0, 0, 2, 8)],
    ["a compressed data frame", frame(1, byte())],
    ["a response without a final trailer", response({ percent: 1 }).subarray(0, -21)],
    [
      "a trailer before its data frame",
      concat(response({ percent: 1 }).subarray(-21), response({ percent: 1 }).subarray(0, -21)),
    ],
    [
      "duplicate trailers",
      concat(response({ percent: 1 }), response({ percent: 1 }).subarray(-21)),
    ],
    [
      "conflicting statuses in one trailer",
      concat(
        response({ percent: 1 }).subarray(0, -21),
        frame(0x80, new TextEncoder().encode("grpc-status: 0\r\ngrpc-status: 16\r\n")),
      ),
    ],
    [
      "a non-zero gRPC trailer status",
      concat(
        response({ percent: 1 }).subarray(0, -21),
        frame(0x80, new TextEncoder().encode("grpc-status: 16\r\n")),
      ),
    ],
    [
      "a monthly span labelled as weekly",
      response({ startSeconds: 1_752_000_000, endSeconds: 1_754_592_000 }),
    ],
  ])("rejects %s", (_label, body) => {
    expect(parseXaiGrokCreditsResponse(body, NOW_MS)).toEqual([]);
  });

  it("rejects oversized responses before protobuf parsing", () => {
    expect(parseXaiGrokCreditsResponse(new Uint8Array(1024 * 1024 + 1), NOW_MS)).toEqual([]);
  });
});
