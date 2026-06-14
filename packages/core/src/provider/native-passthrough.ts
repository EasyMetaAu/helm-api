import {
  appendMutationList,
  isNativePassthroughCarrier,
  type NativePassthroughCarrier,
  type NativePassthroughInput,
} from "@helm/shared";

// Client-header handling is FORWARD-BY-DEFAULT (for fingerprint fidelity) MINUS the
// exclusions below — an allowlist-by-exclusion, not a strict allowlist. The
// load-bearing guarantee (principle 7) is that the Helm credential, cookies, and
// obviously secret-shaped headers NEVER leave the gateway; provider auth replaces the
// upstream credential. Limitation by design: the secret detection in
// `isUnsafeClientHeader` is shape-based, so a generic secret header that matches none
// of these shapes (e.g. `x-functions-key`) can still ride to the upstream. That is
// acceptable because the only passthrough upstreams are trusted first-party providers
// (Anthropic / ChatGPT), and broadening to a bare `*-key` would wrongly drop legitimate
// headers (`idempotency-key`, beta/feature keys, …). Keep the shapes tight + explicit.
const DENY_HEADERS = new Set([
  "authorization",
  "proxy-authorization",
  "x-api-key",
  "x-cr-api-key",
  "host",
  "content-length",
  "connection",
  "keep-alive",
  "proxy-connection",
  "transfer-encoding",
  "te",
  "trailer",
  "upgrade",
  "sec-websocket-key",
  "sec-websocket-version",
  "sec-websocket-extensions",
  "sec-websocket-protocol",
]);

function isUnsafeClientHeader(lower: string): boolean {
  if (lower.startsWith("x-helm-") || DENY_HEADERS.has(lower)) return true;
  if (lower === "cookie" || lower === "set-cookie") return true;
  if (lower.includes("authorization")) return true;
  if (lower === "apikey" || lower === "api-key" || lower.endsWith("-apikey")) return true;
  if (lower.endsWith("-api-key")) return true;
  if (lower === "auth" || lower.endsWith("-auth") || lower.includes("-auth-")) return true;
  if (lower === "token" || lower.endsWith("-token") || lower.includes("-token-")) return true;
  if (lower === "secret" || lower.endsWith("-secret") || lower.includes("-secret-")) return true;
  if (lower === "credential" || lower.endsWith("-credential") || lower.includes("-credential-")) {
    return true;
  }
  return false;
}

export interface PreparedNativePassthroughRequest {
  body: Record<string, unknown>;
  bodyText: string;
  headers: Record<string, string>;
  carrier: NativePassthroughCarrier | null;
}

function headerValueToString(value: string | string[]): string {
  return Array.isArray(value) ? value.join(", ") : value;
}

function setHeader(headers: Record<string, string>, key: string, value: string): string | null {
  const lower = key.toLowerCase();
  for (const existing of Object.keys(headers)) {
    if (existing.toLowerCase() === lower) {
      if (existing !== key) {
        delete headers[existing];
      }
      headers[key] = value;
      return existing;
    }
  }
  headers[key] = value;
  return null;
}

function getHeader(headers: Record<string, string>, key: string): string | undefined {
  const lower = key.toLowerCase();
  const found = Object.keys(headers).find((name) => name.toLowerCase() === lower);
  return found ? headers[found] : undefined;
}

function stripHeader(headers: Record<string, string>, key: string): void {
  const lower = key.toLowerCase();
  for (const existing of Object.keys(headers)) {
    if (existing.toLowerCase() === lower) delete headers[existing];
  }
}

function mergeCsvHeader(
  clientValue: string | undefined,
  providerValue: string | undefined,
): string {
  const values = new Set<string>();
  for (const raw of [clientValue, providerValue]) {
    if (!raw) continue;
    for (const part of raw.split(",")) {
      const token = part.trim();
      if (token.length > 0) values.add(token);
    }
  }
  return [...values].join(", ");
}

export function prepareNativePassthroughRequest(
  input: NativePassthroughInput,
  providerHeaders: Record<string, string>,
  options: {
    mergeHeaders?: string[];
    forceAcceptEncodingIdentity?: boolean;
    preserveClientHeaders?: string[];
    providerProfileApplied?: string;
  } = {},
): PreparedNativePassthroughRequest {
  const carrier = isNativePassthroughCarrier(input) ? input : null;
  const body = carrier ? carrier.body : (input as Record<string, unknown>);
  const ledger = carrier?.mutations;
  const headers: Record<string, string> = {};
  const dropped: string[] = [];

  if (carrier) {
    for (const [key, value] of Object.entries(carrier.headers)) {
      const lower = key.toLowerCase();
      if (isUnsafeClientHeader(lower)) {
        dropped.push(lower);
        continue;
      }
      headers[key] = headerValueToString(value);
    }
  }

  if (options.forceAcceptEncodingIdentity === true) {
    const previous = getHeader(headers, "accept-encoding");
    setHeader(headers, "accept-encoding", "identity");
    if (previous !== "identity" && ledger) ledger.accept_encoding_forced_identity = true;
  }

  const overwritten: string[] = [];
  const mergeHeaders = new Set((options.mergeHeaders ?? []).map((h) => h.toLowerCase()));
  const preserveClientHeaders = new Set(
    (
      options.preserveClientHeaders ?? [
        "accept",
        "accept-language",
        "originator",
        "session_id",
        "user-agent",
        "x-client-request-id",
        "x-session-id",
      ]
    ).map((h) => h.toLowerCase()),
  );
  for (const [key, providerValue] of Object.entries(providerHeaders)) {
    const lower = key.toLowerCase();
    const clientValue = getHeader(headers, key);
    const nextValue = mergeHeaders.has(lower)
      ? mergeCsvHeader(clientValue, providerValue)
      : clientValue !== undefined && preserveClientHeaders.has(lower)
        ? clientValue
        : providerValue;
    setHeader(headers, key, nextValue);
    if (clientValue !== undefined && nextValue !== clientValue) overwritten.push(lower);
    if ((lower === "authorization" || lower === "x-api-key") && ledger) {
      ledger.auth_replaced = true;
    }
  }

  stripHeader(headers, "content-length");
  if (dropped.includes("content-length") && ledger) ledger.content_length_recomputed = true;

  if (ledger) {
    appendMutationList(ledger, "headers_dropped", dropped);
    appendMutationList(ledger, "headers_overwritten", overwritten);
    if (options.providerProfileApplied !== undefined) {
      ledger.provider_profile_applied = options.providerProfileApplied;
    }
  }

  return {
    body,
    bodyText: carrier?.raw_body ?? JSON.stringify(body),
    headers,
    carrier,
  };
}
