import type { Protocol } from "./request/schema.js";

export interface NativePassthroughMutationLedger {
  model_rewritten?: { from: string | null; to: string };
  memory_appended?: boolean;
  headers_dropped?: string[];
  headers_overwritten?: string[];
  auth_replaced?: boolean;
  content_length_recomputed?: boolean;
  accept_encoding_forced_identity?: boolean;
  provider_profile_applied?: string | null;
  body_shims_applied?: string[];
  stream_reframed?: boolean;
  [key: string]: unknown;
}

export interface NativePassthroughCarrier {
  protocol: Extract<Protocol, "anthropic_messages" | "openai_responses" | "gemini">;
  body: Record<string, unknown>;
  raw_body?: string;
  headers: Record<string, string | string[]>;
  mutations: NativePassthroughMutationLedger;
}

export type NativePassthroughInput = NativePassthroughCarrier | Record<string, unknown>;

export function isNativePassthroughCarrier(value: unknown): value is NativePassthroughCarrier {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    (record.protocol === "anthropic_messages" ||
      record.protocol === "openai_responses" ||
      record.protocol === "gemini") &&
    record.body !== null &&
    typeof record.body === "object" &&
    !Array.isArray(record.body) &&
    record.headers !== null &&
    typeof record.headers === "object" &&
    !Array.isArray(record.headers) &&
    record.mutations !== null &&
    typeof record.mutations === "object" &&
    !Array.isArray(record.mutations)
  );
}

export function nativePassthroughBody(value: NativePassthroughInput): Record<string, unknown> {
  return isNativePassthroughCarrier(value) ? value.body : value;
}

export function nativePassthroughMutations(
  value: NativePassthroughInput,
): NativePassthroughMutationLedger | undefined {
  return isNativePassthroughCarrier(value) ? value.mutations : undefined;
}

export function appendMutationList(
  ledger: NativePassthroughMutationLedger,
  key: "headers_dropped" | "headers_overwritten" | "body_shims_applied",
  values: Iterable<string>,
): void {
  const next = new Set([...(ledger[key] ?? [])]);
  for (const value of values) {
    if (value.length > 0) next.add(value);
  }
  if (next.size > 0) ledger[key] = [...next].sort();
}

export function cloneCarrierWithBody(
  carrier: NativePassthroughCarrier,
  body: Record<string, unknown>,
  options: { preserveRawBody?: boolean } = {},
): NativePassthroughCarrier {
  return {
    ...carrier,
    body,
    ...(options.preserveRawBody === true ? {} : { raw_body: undefined }),
    mutations: { ...carrier.mutations },
  };
}

export function createNativePassthroughCarrier(args: {
  protocol: NativePassthroughCarrier["protocol"];
  body: Record<string, unknown>;
  rawBody?: string;
  headers: Record<string, string | string[]>;
}): NativePassthroughCarrier {
  return {
    protocol: args.protocol,
    body: args.body,
    ...(args.rawBody !== undefined ? { raw_body: args.rawBody } : {}),
    headers: args.headers,
    mutations: {},
  };
}
