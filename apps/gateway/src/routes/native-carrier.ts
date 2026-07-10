import { createNativePassthroughCarrier, type NativePassthroughCarrier } from "@helm/shared";

export function headersFromRequest(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((value, key) => {
    out[key] = value;
  });
  return out;
}

export function nativeCarrierFromParsedBody(args: {
  protocol: NativePassthroughCarrier["protocol"];
  native: unknown;
  rawBody: string;
  headers: Headers | Record<string, string | string[]>;
}): NativePassthroughCarrier | null {
  if (args.native === null || typeof args.native !== "object" || Array.isArray(args.native)) {
    return null;
  }
  return createNativePassthroughCarrier({
    protocol: args.protocol,
    body: args.native as Record<string, unknown>,
    rawBody: args.rawBody,
    headers: args.headers instanceof Headers ? headersFromRequest(args.headers) : args.headers,
  });
}
