import { type NativePassthroughInput, nativePassthroughBody } from "@helm/shared";
import {
  type ChatCompletionRequest,
  type ChatCompletionResponse,
  type ProviderClient,
  UpstreamError,
} from "./openai.js";
import { readChunkWithIdle, StreamStalledError } from "./stream-idle.js";

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

async function fetchRemoteMediaInlineData(
  url: string,
  mimeHint: string | undefined,
  config: GeminiRemoteMediaFetchConfig,
  doFetch: typeof globalThis.fetch,
  external?: AbortSignal,
): Promise<{ mimeType: string; data: string }> {
  if (!url.startsWith("https://")) {
    throw new UpstreamError("upstream_error", "Gemini remote media fetch only allows https URLs");
  }
  const maxBytes = config.maxBytes ?? DEFAULT_REMOTE_MEDIA_MAX_BYTES;
  const timeoutMs = config.timeoutMs ?? DEFAULT_REMOTE_MEDIA_TIMEOUT_MS;
  const maxRedirects = config.maxRedirects ?? DEFAULT_REMOTE_MEDIA_MAX_REDIRECTS;
  let current = new URL(url);
  for (let redirect = 0; redirect <= maxRedirects; redirect += 1) {
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
): Promise<Record<string, unknown>> {
  if (config?.enabled !== true || !Array.isArray(body.contents)) return body;
  let changed = false;
  const contents = await Promise.all(
    body.contents.map(async (content) => {
      if (!isRecord(content) || !Array.isArray(content.parts)) return content;
      const parts = await Promise.all(
        content.parts.map(async (part) => {
          const out = await materializeGeminiPart(part, config, doFetch, signal);
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
