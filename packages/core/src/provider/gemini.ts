import { lookup as nodeDnsLookup } from "node:dns/promises";
import { type NativePassthroughInput, nativePassthroughBody } from "@helm/shared";
import {
  type ChatCompletionRequest,
  type ChatCompletionResponse,
  type ProviderClient,
  UpstreamError,
} from "./openai.js";
import { readChunkWithIdle, StreamStalledError } from "./stream-idle.js";

// Resolve a hostname to its candidate addresses. Injectable so the SSRF guard can be
// tested hermetically (no real DNS) — production uses node:dns lookup(all).
export type HostnameLookup = (hostname: string) => Promise<string[]>;

const defaultDnsLookup: HostnameLookup = async (hostname) => {
  const results = await nodeDnsLookup(hostname, { all: true });
  return results.map((r) => r.address);
};

export interface GeminiClientConfig {
  baseUrl: string;
  apiKey?: string;
  getAuthHeader?: () => Promise<string>;
  onUnauthorized?: () => void;
  currentSecrets?: () => string[];
  timeoutMs?: number;
  remoteMediaFetch?: GeminiRemoteMediaFetchConfig;
}

export interface GeminiRemoteMediaFetchConfig {
  enabled: boolean;
  maxBytes?: number;
  timeoutMs?: number;
  maxRedirects?: number;
  allowedMimeTypes?: string[];
}

export interface GeminiClientDeps {
  config: GeminiClientConfig;
  fetch?: typeof globalThis.fetch;
  /** Override hostname resolution for the remote-media SSRF guard (tests). */
  dnsLookup?: HostnameLookup;
}

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_REMOTE_MEDIA_MAX_BYTES = 5_000_000;
const DEFAULT_REMOTE_MEDIA_TIMEOUT_MS = 5_000;
const DEFAULT_REMOTE_MEDIA_MAX_REDIRECTS = 2;
const REMOTE_IMAGE_PLACEHOLDER =
  /^\[remote image unsupported by Gemini nativeOut: (https:\/\/[^\]]+)\]$/;

function withTimeout(timeoutMs: number, external?: AbortSignal) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const signal = AbortSignal.any(external ? [ctrl.signal, external] : [ctrl.signal]);
  return {
    signal,
    isTimeout: () => ctrl.signal.aborted,
    isExternalAbort: () => external?.aborted ?? false,
    cleanup: () => clearTimeout(timer),
  };
}

function endpoint(baseUrl: string, model: string, operation: string): string {
  const base = baseUrl.replace(/\/+$/, "");
  const modelRoot = base.endsWith("/models") ? base : `${base}/models`;
  const modelPath = model
    .replace(/^\/+/, "")
    .replace(/^models\//, "")
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/");
  const query = operation === "streamGenerateContent" ? "?alt=sse" : "";
  return `${modelRoot}/${modelPath}:${operation}${query}`;
}

function bodyAndModel(input: NativePassthroughInput): {
  model: string;
  body: Record<string, unknown>;
} {
  const body = { ...nativePassthroughBody(input) };
  const model = body.model;
  if (typeof model !== "string" || model.length === 0) {
    throw new UpstreamError("upstream_error", "gemini native request requires model");
  }
  delete body.model;
  // `stream` is the gateway's InternalRequest switch; Gemini selects streaming by path.
  delete body.stream;
  return { model, body };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function mimeAllowed(mimeType: string, allowed: readonly string[] | undefined): boolean {
  if (allowed === undefined || allowed.length === 0) return true;
  return allowed.some((entry) => {
    if (entry.endsWith("/*")) return mimeType.startsWith(`${entry.slice(0, -2)}/`);
    return mimeType === entry;
  });
}

function remoteMediaSignal(timeoutMs: number, external?: AbortSignal) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  return {
    signal: AbortSignal.any(external ? [ctrl.signal, external] : [ctrl.signal]),
    cleanup: () => clearTimeout(timer),
  };
}

// —— SSRF guard for remote media fetch (P2-GEM-02). Remote fetch is opt-in, but once
// enabled a client-supplied URL must not be able to reach internal infrastructure
// (cloud metadata at 169.254.169.254, loopback, RFC1918, ULA/link-local v6, …). We
// reject literal private/reserved IPs AND resolve DNS names to catch a public name
// that points at a private address (rebinding). Re-checked on every redirect hop.

function parseIpv4Octets(host: string): [number, number, number, number] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (m === null) return null;
  const octets = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])] as const;
  if (octets.some((o) => o > 255)) return null;
  return [octets[0], octets[1], octets[2], octets[3]];
}

function isBlockedIpv4([a, b]: [number, number, number, number]): boolean {
  if (a === 0) return true; // 0.0.0.0/8 "this network"
  if (a === 10) return true; // RFC1918
  if (a === 127) return true; // loopback
  if (a === 169 && b === 254) return true; // link-local (incl. 169.254.169.254 metadata)
  if (a === 172 && b >= 16 && b <= 31) return true; // RFC1918
  if (a === 192 && b === 168) return true; // RFC1918
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT (RFC6598)
  if (a === 192 && b === 0) return true; // 192.0.0/24 IETF + 192.0.2/24 TEST-NET-1
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
  if (a >= 224) return true; // multicast (224/4), reserved (240/4), broadcast
  return false;
}

function isBlockedIpv6(host: string): boolean {
  const lower = host.toLowerCase();
  if (lower === "::1" || lower === "::") return true; // loopback / unspecified
  if (/^f[cd]/.test(lower)) return true; // fc00::/7 unique-local
  if (/^fe[89ab]/.test(lower)) return true; // fe80::/10 link-local
  // IPv4-mapped (::ffff:a.b.c.d) — validate the embedded v4 address.
  const mapped = /(?:^|:)((?:\d{1,3}\.){3}\d{1,3})$/.exec(lower);
  const v4 = mapped?.[1] !== undefined ? parseIpv4Octets(mapped[1]) : null;
  return v4 !== null && isBlockedIpv4(v4);
}

function isIpLiteral(host: string): boolean {
  return parseIpv4Octets(host) !== null || host.includes(":");
}

function isBlockedIp(host: string): boolean {
  const v4 = parseIpv4Octets(host);
  if (v4 !== null) return isBlockedIpv4(v4);
  if (host.includes(":")) return isBlockedIpv6(host);
  return false; // not an IP literal
}

function isBlockedHostname(host: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, "");
  return h === "localhost" || h.endsWith(".localhost");
}

async function assertPublicHttpsTarget(target: URL, lookup: HostnameLookup): Promise<void> {
  if (target.protocol !== "https:") {
    throw new UpstreamError("upstream_error", "Gemini remote media fetch only allows https URLs");
  }
  const host = target.hostname.replace(/^\[|\]$/g, ""); // URL keeps IPv6 in brackets
  if (isIpLiteral(host)) {
    if (isBlockedIp(host)) {
      throw new UpstreamError(
        "upstream_error",
        "Gemini remote media fetch blocked a private or reserved address",
      );
    }
    return;
  }
  if (isBlockedHostname(host)) {
    throw new UpstreamError("upstream_error", "Gemini remote media fetch blocked a local hostname");
  }
  let addresses: string[];
  try {
    addresses = await lookup(host);
  } catch {
    // Unresolvable host → the fetch itself cannot reach anything; let it fail naturally.
    return;
  }
  for (const address of addresses) {
    if (isBlockedIp(address)) {
      throw new UpstreamError(
        "upstream_error",
        "Gemini remote media host resolved to a private or reserved address",
      );
    }
  }
}

async function fetchRemoteMediaInlineData(
  url: string,
  mimeHint: string | undefined,
  config: GeminiRemoteMediaFetchConfig,
  doFetch: typeof globalThis.fetch,
  lookup: HostnameLookup,
  external?: AbortSignal,
): Promise<{ mimeType: string; data: string }> {
  const maxBytes = config.maxBytes ?? DEFAULT_REMOTE_MEDIA_MAX_BYTES;
  const timeoutMs = config.timeoutMs ?? DEFAULT_REMOTE_MEDIA_TIMEOUT_MS;
  const maxRedirects = config.maxRedirects ?? DEFAULT_REMOTE_MEDIA_MAX_REDIRECTS;
  let current = new URL(url);
  for (let redirect = 0; redirect <= maxRedirects; redirect += 1) {
    // SSRF guard: validate https + reject private/reserved targets on EVERY hop,
    // before any bytes are sent — the original URL and each redirect destination.
    await assertPublicHttpsTarget(current, lookup);
    const t = remoteMediaSignal(timeoutMs, external);
    let res: Response;
    try {
      res = await doFetch(current, { method: "GET", redirect: "manual", signal: t.signal });
    } catch (err) {
      if (t.signal.aborted && external?.aborted !== true) {
        throw new UpstreamError("timeout", "Gemini remote media fetch timed out");
      }
      throw err;
    } finally {
      t.cleanup();
    }
    if (res.status >= 300 && res.status < 400 && res.headers.get("location") !== null) {
      await res.body?.cancel().catch(() => {});
      const next = new URL(res.headers.get("location") as string, current);
      if (next.protocol !== "https:") {
        throw new UpstreamError("upstream_error", "Gemini remote media redirect must stay https");
      }
      current = next;
      continue;
    }
    if (!res.ok) {
      throw new UpstreamError("upstream_error", `remote media fetch returned ${res.status}`);
    }
    const contentLength = res.headers.get("content-length");
    if (contentLength !== null && Number(contentLength) > maxBytes) {
      await res.body?.cancel().catch(() => {});
      throw new UpstreamError("upstream_error", "remote media exceeds configured max_bytes");
    }
    const mimeType =
      (res.headers.get("content-type") ?? mimeHint ?? "application/octet-stream")
        .split(";")[0]
        ?.trim()
        .toLowerCase() ?? "application/octet-stream";
    if (!mimeAllowed(mimeType, config.allowedMimeTypes)) {
      await res.body?.cancel().catch(() => {});
      throw new UpstreamError(
        "upstream_error",
        `remote media mime type is not allowed: ${mimeType}`,
      );
    }
    const bytes = Buffer.from(await res.arrayBuffer());
    if (bytes.byteLength > maxBytes) {
      throw new UpstreamError("upstream_error", "remote media exceeds configured max_bytes");
    }
    return { mimeType, data: bytes.toString("base64") };
  }
  throw new UpstreamError("upstream_error", "remote media exceeded redirect limit");
}

async function materializeGeminiPart(
  part: unknown,
  config: GeminiRemoteMediaFetchConfig,
  doFetch: typeof globalThis.fetch,
  lookup: HostnameLookup,
  signal?: AbortSignal,
): Promise<{ part: unknown; changed: boolean }> {
  if (!isRecord(part)) return { part, changed: false };
  if (isRecord(part.fileData) && typeof part.fileData.fileUri === "string") {
    const fileData = part.fileData as Record<string, unknown>;
    const fileUri = part.fileData.fileUri;
    if (fileUri.startsWith("https://")) {
      const inlineData = await fetchRemoteMediaInlineData(
        fileUri,
        typeof fileData.mimeType === "string" ? fileData.mimeType : undefined,
        config,
        doFetch,
        lookup,
        signal,
      );
      return { part: { ...part, fileData: undefined, inlineData }, changed: true };
    }
  }
  if (typeof part.text === "string") {
    const match = REMOTE_IMAGE_PLACEHOLDER.exec(part.text);
    if (match?.[1] !== undefined) {
      const inlineData = await fetchRemoteMediaInlineData(
        match[1],
        "image/png",
        config,
        doFetch,
        lookup,
        signal,
      );
      return { part: { inlineData }, changed: true };
    }
  }
  return { part, changed: false };
}

export async function materializeGeminiRemoteMediaBody(
  body: Record<string, unknown>,
  config: GeminiRemoteMediaFetchConfig | undefined,
  doFetch: typeof globalThis.fetch,
  signal?: AbortSignal,
  lookup: HostnameLookup = defaultDnsLookup,
): Promise<Record<string, unknown>> {
  if (config?.enabled !== true || !Array.isArray(body.contents)) return body;
  let changed = false;
  const contents = await Promise.all(
    body.contents.map(async (content) => {
      if (!isRecord(content) || !Array.isArray(content.parts)) return content;
      const parts = await Promise.all(
        content.parts.map(async (part) => {
          const out = await materializeGeminiPart(part, config, doFetch, lookup, signal);
          if (out.changed) changed = true;
          return out.part;
        }),
      );
      return parts === content.parts ? content : { ...content, parts };
    }),
  );
  return changed ? { ...body, contents } : body;
}

export function createGeminiClient(deps: GeminiClientDeps): ProviderClient {
  const doFetch = deps.fetch ?? globalThis.fetch;
  const dnsLookup = deps.dnsLookup ?? defaultDnsLookup;
  const cfg = deps.config;
  const timeoutMs = cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const hasStatic = cfg.apiKey !== undefined;
  const hasDynamic = cfg.getAuthHeader !== undefined;
  if (hasStatic === hasDynamic) {
    throw new Error("gemini client requires exactly one of `apiKey` or `getAuthHeader`");
  }

  async function headers(): Promise<Record<string, string>> {
    const h: Record<string, string> = { "Content-Type": "application/json" };
    if (cfg.getAuthHeader !== undefined) h.Authorization = await cfg.getAuthHeader();
    else h["x-goog-api-key"] = cfg.apiKey as string;
    return h;
  }

  function scrub(raw: unknown): unknown {
    if (raw === null) return raw;
    const secrets = cfg.currentSecrets ? cfg.currentSecrets() : [];
    if (cfg.apiKey !== undefined) secrets.push(cfg.apiKey);
    const replace = (value: string): { value: string; changed: boolean } => {
      let v = value;
      let changed = false;
      for (const secret of secrets) {
        if (secret.length < 4) continue;
        if (v.includes(secret)) {
          v = v.split(secret).join("[redacted]");
          changed = true;
        }
      }
      return { value: v, changed };
    };
    if (typeof raw === "string") return replace(raw).value;
    if (typeof raw !== "object") return raw;
    const { value, changed } = replace(JSON.stringify(raw));
    return changed ? JSON.parse(value) : raw;
  }

  async function request(
    operation: "generateContent" | "streamGenerateContent" | "countTokens",
    input: NativePassthroughInput,
    external?: AbortSignal,
  ): Promise<Response> {
    const { model, body } = bodyAndModel(input);
    const t = withTimeout(timeoutMs, external);
    try {
      const materializedBody = await materializeGeminiRemoteMediaBody(
        body,
        cfg.remoteMediaFetch,
        doFetch,
        t.signal,
        dnsLookup,
      );
      return await doFetch(endpoint(cfg.baseUrl, model, operation), {
        method: "POST",
        headers: await headers(),
        body: JSON.stringify(materializedBody),
        signal: t.signal,
      });
    } catch (err) {
      if (t.isTimeout() && !t.isExternalAbort()) {
        throw new UpstreamError("timeout", "upstream request timed out");
      }
      throw err;
    } finally {
      t.cleanup();
    }
  }

  async function requestWithAuthRetry(
    operation: "generateContent" | "streamGenerateContent" | "countTokens",
    input: NativePassthroughInput,
    external?: AbortSignal,
  ): Promise<Response> {
    const res = await request(operation, input, external);
    if (res.status === 401 && cfg.onUnauthorized !== undefined) {
      await res.body?.cancel().catch(() => {});
      cfg.onUnauthorized();
      return await request(operation, input, external);
    }
    return res;
  }

  async function errorFromResponse(res: Response): Promise<UpstreamError> {
    const providerRaw = await res
      .text()
      .then((text) => {
        try {
          return JSON.parse(text) as unknown;
        } catch {
          return text;
        }
      })
      .catch(() => null)
      .then(scrub);
    return new UpstreamError(
      "upstream_error",
      `upstream returned ${res.status}`,
      providerRaw,
      res.status,
    );
  }

  async function* readRawSSE(res: Response): AsyncGenerator<string> {
    const body = res.body;
    if (!body) return;
    const reader = body.getReader();
    const decoder = new TextDecoder();
    try {
      while (true) {
        let read: { done: boolean; value?: Uint8Array };
        try {
          read = await readChunkWithIdle(reader, timeoutMs);
        } catch (err) {
          if (err instanceof StreamStalledError) throw new UpstreamError("timeout", err.message);
          throw err;
        }
        if (read.done) break;
        if (read.value) yield decoder.decode(read.value, { stream: true });
      }
    } finally {
      reader.releaseLock();
    }
  }

  return {
    nativeProtocolProfile: "gemini",

    async chatCompletion(): Promise<ChatCompletionResponse> {
      throw new UpstreamError("upstream_error", "gemini client requires native passthrough");
    },

    chatCompletionStream(): AsyncIterable<string> {
      throw new UpstreamError("upstream_error", "gemini client requires native passthrough");
    },

    async nativePassthrough(input, opts) {
      const res = await requestWithAuthRetry("generateContent", input, opts?.signal);
      if (!res.ok) throw await errorFromResponse(res);
      return (await res.json()) as Record<string, unknown>;
    },

    async *nativePassthroughStream(input, opts) {
      const res = await requestWithAuthRetry("streamGenerateContent", input, opts?.signal);
      if (!res.ok) throw await errorFromResponse(res);
      yield* readRawSSE(res);
    },

    async countTokens(req: ChatCompletionRequest, opts) {
      const res = await requestWithAuthRetry("countTokens", req, opts?.signal);
      if (!res.ok) throw await errorFromResponse(res);
      return (await res.json()) as Record<string, unknown>;
    },
  };
}
