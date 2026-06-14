import { lookup as nodeDnsLookup } from "node:dns/promises";
import https from "node:https";
import { Readable } from "node:stream";
import { type NativePassthroughInput, nativePassthroughBody } from "@helm/shared";
import { geminiTransformer } from "../protocol/gemini/gemini-transformer.js";
import type { GeminiSSEEvent } from "../protocol/gemini/gemini-types.js";
import { openaiTransformer } from "../protocol/openai.js";
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

// Remote-media fetcher. SEPARATE from the API `fetch` (which may route through the LLM
// proxy): media must connect to the EXACT address the SSRF guard validated, so the
// default implementation pins the connection to `pinnedAddress` (closes the DNS-
// rebinding window between validation and connection). Injectable for hermetic tests.
export type GeminiMediaFetch = (
  url: URL,
  init: { signal?: AbortSignal; pinnedAddress?: string },
) => Promise<Response>;

// Default media fetcher: node:https GET pinned to the pre-validated address via a
// custom `lookup`, with SNI/cert validation still bound to the real hostname. Does NOT
// follow redirects (the caller validates each hop). Global `fetch` cannot pin the
// connection IP without re-resolving, which is exactly the rebinding hole.
const pinnedHttpsMediaFetch: GeminiMediaFetch = (url, init) =>
  new Promise<Response>((resolve, reject) => {
    const pinned = init.pinnedAddress;
    const request = https.request(
      url,
      {
        method: "GET",
        servername: url.hostname,
        ...(init.signal !== undefined ? { signal: init.signal } : {}),
        ...(pinned !== undefined
          ? {
              lookup: (
                _hostname: string,
                _options: unknown,
                callback: (err: Error | null, address: string, family: number) => void,
              ) => callback(null, pinned, pinned.includes(":") ? 6 : 4),
            }
          : {}),
      },
      (res) => {
        const status = res.statusCode ?? 502;
        const headers = new Headers();
        for (const [key, value] of Object.entries(res.headers)) {
          if (typeof value === "string") headers.set(key, value);
          else if (Array.isArray(value)) headers.set(key, value.join(", "));
        }
        const hasBody = status !== 204 && status !== 304;
        const body = hasBody
          ? (Readable.toWeb(res) as unknown as ReadableStream<Uint8Array>)
          : null;
        resolve(new Response(body, { status, headers }));
      },
    );
    request.on("error", reject);
    request.end();
  });

// The protocol transformers declare `T | Promise<T>`; openai + gemini are synchronous.
// Assert that here so the translated path stays a simple sequence (mirrors execute.ts).
function expectSync<T>(value: T | Promise<T>, label: string): T {
  if (value !== null && typeof (value as Promise<T>).then === "function") {
    throw new UpstreamError("upstream_error", `${label} unexpectedly returned a Promise`);
  }
  return value as T;
}

// Translated path (cross-protocol, or passthrough disabled): an OpenAI-Chat IR request
// must reach a Gemini upstream and come back OpenAI-shaped. Compose the two
// transformers through the IR: OpenAI → IR → Gemini native (request), Gemini native →
// IR → OpenAI (response). Gemini carries the model in the URL, so it rides separately.
function openAIChatToGeminiBody(req: ChatCompletionRequest): {
  model: string;
  body: Record<string, unknown>;
} {
  const ir = expectSync(openaiTransformer.transformRequestOut(req), "OpenAI->IR");
  const native = expectSync(geminiTransformer.transformRequestIn(ir), "IR->Gemini") as Record<
    string,
    unknown
  >;
  return { model: String((req as Record<string, unknown>).model ?? ""), body: native };
}

function geminiResponseToOpenAIChat(json: unknown): ChatCompletionResponse {
  const ir = expectSync(geminiTransformer.transformResponseIn(json), "Gemini->IR");
  return expectSync(
    openaiTransformer.transformResponseOut(ir),
    "IR->OpenAI",
  ) as ChatCompletionResponse;
}

// Re-frame raw Gemini SSE bytes into parsed GenerateContent frames for transformStreamIn
// (which re-validates each via Zod). Buffers across non-frame-aligned chunks.
async function* parseGeminiStreamEvents(raw: AsyncIterable<string>): AsyncIterable<GeminiSSEEvent> {
  let buffer = "";
  const flushFrame = (frame: string): GeminiSSEEvent | null => {
    for (const line of frame.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      const payload = trimmed.slice("data:".length).trim();
      if (payload === "" || payload === "[DONE]") return null;
      try {
        return JSON.parse(payload) as GeminiSSEEvent;
      } catch {
        return null;
      }
    }
    return null;
  };
  for await (const chunk of raw) {
    buffer += chunk;
    let idx = buffer.indexOf("\n\n");
    while (idx !== -1) {
      const event = flushFrame(buffer.slice(0, idx));
      buffer = buffer.slice(idx + 2);
      if (event !== null) yield event;
      idx = buffer.indexOf("\n\n");
    }
  }
  const tail = flushFrame(buffer);
  if (tail !== null) yield tail;
}

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
  /** Override the remote-media fetcher (tests). Production uses the pinned node:https
   *  fetcher so the connection cannot re-resolve to a private host. */
  mediaFetch?: GeminiMediaFetch;
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

// Validates the target and returns the PINNED address the connection must use. For an
// IP literal that is the literal itself; for a DNS name it is the first validated
// resolved address (so the media fetch connects to exactly what we vetted — no second
// resolution that a rebinding response could redirect to a private host). Returns
// undefined only when the host is unresolvable (the fetch then fails naturally).
async function assertPublicHttpsTarget(
  target: URL,
  lookup: HostnameLookup,
): Promise<string | undefined> {
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
    return host;
  }
  if (isBlockedHostname(host)) {
    throw new UpstreamError("upstream_error", "Gemini remote media fetch blocked a local hostname");
  }
  let addresses: string[];
  try {
    addresses = await lookup(host);
  } catch {
    // Unresolvable host → the fetch itself cannot reach anything; let it fail naturally.
    return undefined;
  }
  for (const address of addresses) {
    if (isBlockedIp(address)) {
      throw new UpstreamError(
        "upstream_error",
        "Gemini remote media host resolved to a private or reserved address",
      );
    }
  }
  return addresses[0];
}

// Read a response body with a HARD byte cap enforced WHILE streaming (abort once the
// limit is crossed — never allocate an unbounded buffer) and a per-chunk idle timeout,
// so a missing/lying Content-Length or a slow/endless body cannot exhaust memory or hang.
async function readBodyWithLimit(
  res: Response,
  maxBytes: number,
  idleTimeoutMs: number,
): Promise<Buffer> {
  const reader = res.body?.getReader();
  if (reader === undefined) return Buffer.alloc(0);
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    while (true) {
      let read: { done: boolean; value?: Uint8Array };
      try {
        read = await readChunkWithIdle(reader, idleTimeoutMs);
      } catch (err) {
        if (err instanceof StreamStalledError) {
          throw new UpstreamError("timeout", "Gemini remote media fetch stalled");
        }
        throw err;
      }
      if (read.done) break;
      if (read.value !== undefined) {
        total += read.value.byteLength;
        if (total > maxBytes) {
          await reader.cancel().catch(() => {});
          throw new UpstreamError("upstream_error", "remote media exceeds configured max_bytes");
        }
        chunks.push(Buffer.from(read.value));
      }
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks);
}

async function fetchRemoteMediaInlineData(
  url: string,
  mimeHint: string | undefined,
  config: GeminiRemoteMediaFetchConfig,
  mediaFetch: GeminiMediaFetch,
  lookup: HostnameLookup,
  external?: AbortSignal,
): Promise<{ mimeType: string; data: string }> {
  const maxBytes = config.maxBytes ?? DEFAULT_REMOTE_MEDIA_MAX_BYTES;
  const timeoutMs = config.timeoutMs ?? DEFAULT_REMOTE_MEDIA_TIMEOUT_MS;
  const maxRedirects = config.maxRedirects ?? DEFAULT_REMOTE_MEDIA_MAX_REDIRECTS;
  let current = new URL(url);
  for (let redirect = 0; redirect <= maxRedirects; redirect += 1) {
    // SSRF guard: validate https + reject private/reserved targets on EVERY hop,
    // before any bytes are sent — the original URL and each redirect destination —
    // and pin the connection to the exact validated address.
    const pinnedAddress = await assertPublicHttpsTarget(current, lookup);
    const t = remoteMediaSignal(timeoutMs, external);
    let res: Response;
    try {
      res = await mediaFetch(current, { signal: t.signal, pinnedAddress });
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
    const bytes = await readBodyWithLimit(res, maxBytes, timeoutMs);
    return { mimeType, data: bytes.toString("base64") };
  }
  throw new UpstreamError("upstream_error", "remote media exceeded redirect limit");
}

async function materializeGeminiPart(
  part: unknown,
  config: GeminiRemoteMediaFetchConfig,
  mediaFetch: GeminiMediaFetch,
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
        mediaFetch,
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
        mediaFetch,
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
  mediaFetch: GeminiMediaFetch,
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
          const out = await materializeGeminiPart(part, config, mediaFetch, lookup, signal);
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
  const mediaFetch = deps.mediaFetch ?? pinnedHttpsMediaFetch;
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
        mediaFetch,
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

    // Translated path (#251 review P1): a non-Gemini client routed here, or native
    // passthrough disabled. Translate OpenAI-Chat → Gemini → OpenAI via the
    // transformers instead of failing — mirrors the anthropic client's translated path.
    async chatCompletion(req, opts) {
      const { model, body } = openAIChatToGeminiBody(req);
      const res = await requestWithAuthRetry("generateContent", { ...body, model }, opts?.signal);
      if (!res.ok) throw await errorFromResponse(res);
      return geminiResponseToOpenAIChat(await res.json());
    },

    async *chatCompletionStream(req, opts) {
      const { model, body } = openAIChatToGeminiBody(req);
      const res = await requestWithAuthRetry(
        "streamGenerateContent",
        { ...body, model },
        opts?.signal,
      );
      if (!res.ok) throw await errorFromResponse(res);
      // Gemini native SSE → IR chunks → OpenAI SSE strings. IRChunk IS the OpenAI
      // chat.completion.chunk, so the pipeline's parseOpenAISSE consumes these directly.
      for await (const chunk of geminiTransformer.transformStreamIn(
        parseGeminiStreamEvents(readRawSSE(res)),
      )) {
        yield `data: ${JSON.stringify(chunk)}\n\n`;
      }
      yield "data: [DONE]\n\n";
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
