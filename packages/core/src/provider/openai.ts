// OpenAI-compatible upstream client. Phase 0 = PASSTHROUGH ONLY: no protocol
// translation, no classification, no lanes, no fallback, no circuit breaker
// (all Phase 1/2). Framework-agnostic (no Hono). Credentials come only from the
// injected config (env-sourced) and are never logged or echoed. See docs/02.

import type { NativePassthroughInput } from "@helm/shared";
// Provider credential: EXACTLY ONE of a static `apiKey` or a dynamic
// `getAuthHeader` (issue #38 OAuth). The dynamic path also accepts:
//   - `onUnauthorized`: invoked once on an upstream 401 to force a token refresh
//     (the manager's invalidate), after which the request is retried exactly once
//     with the freshly fetched header (D2 — the retry lives here in the client,
//     not the executor, so the SAME request is replayed with the new token).
//   - `currentSecrets`: live access + refresh tokens, used by `scrub()` to strip
//     any echoed credential from an upstream error body (principle 7).
// Credentials are runtime-only: from env, never persisted/logged.
import { readChunkWithIdle, StreamStalledError } from "./stream-idle.js";

export interface ProviderConfig {
  baseUrl: string; // e.g. https://openrouter.ai/api/v1
  apiKey?: string; // static credential; mutually exclusive with getAuthHeader
  getAuthHeader?: () => Promise<string>; // dynamic "Bearer <token>" (OAuth)
  onUnauthorized?: () => void; // 401 hook (force refresh); only with getAuthHeader
  currentSecrets?: () => string[]; // live token set for redaction (OAuth)
  timeoutMs?: number; // default 60_000
  // Extra static headers merged into every request (issue #38). GitHub Copilot
  // requires editor identity headers (Copilot-Integration-Id, Editor-Version…) on
  // each chat call; this is the generic seam for them.
  extraHeaders?: () => Record<string, string>;
  // Per-request base URL resolver (issue #38). When set, the chat URL is computed
  // fresh on EACH request from this (so it tracks a rotating value) instead of the
  // static `baseUrl`. Copilot derives its API host from the current token's
  // `proxy-ep`, which changes when the short-lived Copilot token is re-minted.
  resolveBaseUrl?: () => Promise<string>;
  // Compatibility shim for OpenAI-compatible providers that have not adopted the
  // newer `developer` role. Disabled by default to keep true OpenAI passthrough.
  mapDeveloperRoleToSystem?: boolean;
  // Compatibility shim for OpenAI-compatible providers that stream reasoning as
  // choices[].delta.reasoning. Disabled by default to preserve byte forwarding.
  normalizeReasoningDeltaAlias?: boolean;
}

export interface OpenAIClientDeps {
  config: ProviderConfig;
  fetch?: typeof globalThis.fetch;
}

export type ChatCompletionRequest = Record<string, unknown>;
export type ChatCompletionResponse = Record<string, unknown>;
export type NativeProtocolProfile =
  | "anthropic_messages"
  | "codex_responses"
  | "generic_openai_responses"
  | "gemini";

export interface ProviderClient {
  nativeProtocolProfile?: NativeProtocolProfile;
  streamReframed?: boolean;
  chatCompletion(
    req: ChatCompletionRequest,
    opts?: { signal?: AbortSignal },
  ): Promise<ChatCompletionResponse>;
  chatCompletionStream(
    req: ChatCompletionRequest,
    opts?: { signal?: AbortSignal },
  ): AsyncIterable<string>;
  // Native protocol passthrough (issue #217, Phase 1). OPTIONAL so every existing
  // client and test double stays valid without change; the executor feature-detects
  // it. When present, it forwards the client's VERBATIM native body to the upstream
  // (NO OpenAI-Chat translation) and returns the upstream's native response
  // untranslated. Only same-protocol native clients (Anthropic→Anthropic in Phase 1)
  // implement it; the guard (canUseNativePassthrough) gates when it may be used.
  nativePassthrough?(
    request: NativePassthroughInput,
    opts?: { signal?: AbortSignal },
  ): Promise<Record<string, unknown>>;
  // Streaming native protocol passthrough (issue #217, Phase 2). The streaming sibling
  // of nativePassthrough: forwards the client's VERBATIM native body (which ALREADY
  // carries stream:true) to the upstream and BYTE-RELAYS the upstream SSE back without
  // translation — eliminating the SSE re-mapping state machine (principle 8) rather than
  // replacing it. OPTIONAL (feature-detected by the executor); only same-protocol native
  // clients implement it, gated by the same guard as nativePassthrough.
  nativePassthroughStream?(
    request: NativePassthroughInput,
    opts?: { signal?: AbortSignal },
  ): AsyncIterable<string>;
  countTokens?(
    req: ChatCompletionRequest,
    opts?: { signal?: AbortSignal },
  ): Promise<Record<string, unknown>>;
  responsesInputTokens?(
    req: ChatCompletionRequest,
    opts?: { signal?: AbortSignal },
  ): Promise<Record<string, unknown>>;
  responsesRetrieve?(
    responseId: string,
    opts?: { signal?: AbortSignal },
  ): Promise<Record<string, unknown>>;
  responsesDelete?(
    responseId: string,
    opts?: { signal?: AbortSignal },
  ): Promise<Record<string, unknown>>;
  responsesCancel?(
    responseId: string,
    opts?: { signal?: AbortSignal },
  ): Promise<Record<string, unknown>>;
  responsesInputItems?(
    responseId: string,
    opts?: { signal?: AbortSignal },
  ): Promise<Record<string, unknown>>;
  responsesCompact?(
    req: ChatCompletionRequest,
    opts?: { signal?: AbortSignal },
  ): Promise<Record<string, unknown>>;
}

// Upstream non-2xx / network error / timeout. The gateway maps this to an
// OpenAI-shaped error. providerRaw is redacted before logging by the caller.
export class UpstreamError extends Error {
  readonly errorClass: "upstream_error" | "timeout";
  readonly httpStatus: number;
  // Real upstream HTTP status (e.g. 429), preserved separately from the
  // client-facing `httpStatus` (which stays 502/504 for back-compat). null when
  // there is no upstream response status (timeout/network error). The executor
  // reads this for the `:free` 429-skip rule (docs/04, principle 5).
  readonly upstreamStatus: number | null;
  readonly providerRaw: unknown | null;
  constructor(
    errorClass: "upstream_error" | "timeout",
    message: string,
    providerRaw: unknown | null = null,
    upstreamStatus: number | null = null,
  ) {
    super(message);
    this.name = "UpstreamError";
    this.errorClass = errorClass;
    this.httpStatus = errorClass === "timeout" ? 504 : 502;
    this.upstreamStatus = upstreamStatus;
    this.providerRaw = providerRaw;
  }
}

const DEFAULT_TIMEOUT_MS = 60_000;

function nextSseFrameBoundary(buffer: string): { index: number; separator: string } | null {
  const lf = buffer.indexOf("\n\n");
  const crlf = buffer.indexOf("\r\n\r\n");
  if (lf === -1 && crlf === -1) return null;
  if (lf === -1) return { index: crlf, separator: "\r\n\r\n" };
  if (crlf === -1) return { index: lf, separator: "\n\n" };
  return crlf < lf ? { index: crlf, separator: "\r\n\r\n" } : { index: lf, separator: "\n\n" };
}

function normalizeOpenAIReasoningPayload(value: unknown): boolean {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const choices = (value as { choices?: unknown }).choices;
  if (!Array.isArray(choices)) return false;

  let changed = false;
  for (const choice of choices) {
    if (choice === null || typeof choice !== "object" || Array.isArray(choice)) continue;
    const delta = (choice as { delta?: unknown }).delta;
    if (delta === null || typeof delta !== "object" || Array.isArray(delta)) continue;
    const record = delta as Record<string, unknown>;
    if (!Object.hasOwn(record, "reasoning")) continue;
    if (!Object.hasOwn(record, "reasoning_content")) {
      record.reasoning_content = record.reasoning;
    }
    delete record.reasoning;
    changed = true;
  }
  return changed;
}

function normalizeReasoningDeltaFrame(frame: string): string {
  let changed = false;
  const lines = frame.split("\n").map((line) => {
    const hasCarriageReturn = line.endsWith("\r");
    const core = hasCarriageReturn ? line.slice(0, -1) : line;
    const match = /^data:\s*/.exec(core);
    if (!match) return line;

    const payload = core.slice(match[0].length);
    if (payload.trim() === "[DONE]") return line;

    let parsed: unknown;
    try {
      parsed = JSON.parse(payload);
    } catch {
      return line;
    }

    if (!normalizeOpenAIReasoningPayload(parsed)) return line;
    changed = true;
    return `${match[0]}${JSON.stringify(parsed)}${hasCarriageReturn ? "\r" : ""}`;
  });

  return changed ? lines.join("\n") : frame;
}

// Merge the caller's signal (client disconnect) with a timeout signal. Returns
// the combined signal plus a marker so the caller can distinguish a timeout
// abort (-> UpstreamError(timeout)) from a client abort (-> rethrow AbortError).
function withTimeout(timeoutMs: number, external?: AbortSignal) {
  const timeoutController = new AbortController();
  const timer = setTimeout(() => timeoutController.abort(), timeoutMs);
  const signals = [timeoutController.signal];
  if (external) signals.push(external);
  // AbortSignal.any is available in Node 20+/22+.
  const signal = AbortSignal.any(signals);
  return {
    signal,
    isTimeout: () => timeoutController.signal.aborted,
    isExternalAbort: () => external?.aborted ?? false,
    cleanup: () => clearTimeout(timer),
  };
}

export function createOpenAIClient(deps: OpenAIClientDeps): ProviderClient {
  const doFetch = deps.fetch ?? globalThis.fetch;
  const cfg = deps.config;
  const timeoutMs = cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  // The chat endpoint. Static by default; recomputed per request when
  // resolveBaseUrl is set (Copilot's host comes from the rotating token).
  async function chatUrl(): Promise<string> {
    const base = cfg.resolveBaseUrl ? await cfg.resolveBaseUrl() : cfg.baseUrl;
    return `${base}/chat/completions`;
  }

  // Fail-closed credential guard (principle 2): EXACTLY ONE of static apiKey or
  // dynamic getAuthHeader. A client built with both / neither cannot resolve an
  // unambiguous auth header, so refuse construction rather than silently pick one.
  const hasStatic = cfg.apiKey !== undefined;
  const hasDynamic = cfg.getAuthHeader !== undefined;
  if (hasStatic === hasDynamic) {
    throw new Error("provider client requires exactly one of `apiKey` or `getAuthHeader`");
  }

  // Per-request auth header. Static path returns the constant key; dynamic path
  // awaits the (possibly refreshed) OAuth token so two requests separated by a
  // refresh carry different Bearers (acceptance criterion 3).
  async function authHeader(): Promise<string> {
    if (cfg.getAuthHeader !== undefined) return await cfg.getAuthHeader();
    return `Bearer ${cfg.apiKey}`;
  }

  async function headers(): Promise<Record<string, string>> {
    return {
      Authorization: await authHeader(),
      "Content-Type": "application/json",
      ...(cfg.extraHeaders ? cfg.extraHeaders() : {}),
    };
  }

  function prepareRequest(req: ChatCompletionRequest): ChatCompletionRequest {
    if (!cfg.mapDeveloperRoleToSystem || !Array.isArray(req.messages)) return req;
    let changed = false;
    const messages = req.messages.map((message) => {
      if (
        message !== null &&
        typeof message === "object" &&
        !Array.isArray(message) &&
        (message as { role?: unknown }).role === "developer"
      ) {
        changed = true;
        return { ...message, role: "system" };
      }
      return message;
    });
    return changed ? { ...req, messages } : req;
  }

  // Strip any echoed credential from an upstream error body before it is carried
  // in UpstreamError.providerRaw (defense in depth; redact() is the main gate).
  // Static path scrubs the apiKey; OAuth path scrubs every LIVE token (access +
  // refresh). Empty / very-short secrets are skipped so an empty token never
  // replaces the whole body and a 1-char token never over-redacts.
  function scrub(raw: unknown): unknown {
    if (raw === null) return raw;
    const secrets = cfg.currentSecrets ? cfg.currentSecrets() : [];
    if (cfg.apiKey !== undefined) secrets.push(cfg.apiKey);
    const replaceSecrets = (value: string): { value: string; changed: boolean } => {
      let redacted = value;
      let changed = false;
      for (const secret of secrets) {
        // Skip empty/too-short secrets: an empty string would blow the body away,
        // and a single character would redact unrelated content.
        if (secret.length < 4) continue;
        if (redacted.includes(secret)) {
          redacted = redacted.split(secret).join("[redacted]");
          changed = true;
        }
      }
      return { value: redacted, changed };
    };

    if (typeof raw === "string") return replaceSecrets(raw).value;
    if (typeof raw !== "object") return raw;

    const { value, changed } = replaceSecrets(JSON.stringify(raw));
    return changed ? JSON.parse(value) : raw;
  }

  async function request(
    req: ChatCompletionRequest,
    external: AbortSignal | undefined,
  ): Promise<Response> {
    const t = withTimeout(timeoutMs, external);
    try {
      return await doFetch(await chatUrl(), {
        method: "POST",
        headers: await headers(),
        body: JSON.stringify(prepareRequest(req)),
        signal: t.signal,
      });
    } catch (err) {
      if (t.isTimeout() && !t.isExternalAbort()) {
        throw new UpstreamError("timeout", "upstream request timed out");
      }
      // Client abort is NOT a provider fault — rethrow as-is for the caller.
      throw err;
    } finally {
      t.cleanup();
    }
  }

  // Issue the request, applying the OAuth 401 single-retry (D2): on a 401 with an
  // onUnauthorized hook, force a token refresh and replay the SAME request exactly
  // once with the new header. `allowRetry` is false on the replay so a persistent
  // 401 falls through to the normal error path (one retry, never a loop). Returns
  // the Response with res.ok already true OR a non-401 / exhausted-retry error res.
  async function requestWithAuthRetry(
    req: ChatCompletionRequest,
    external: AbortSignal | undefined,
  ): Promise<Response> {
    const res = await request(req, external);
    if (res.status === 401 && cfg.onUnauthorized !== undefined) {
      // Discard the 401 body (it may echo the credential) before refreshing.
      await res.body?.cancel().catch(() => {});
      cfg.onUnauthorized();
      return await request(req, external); // exactly one retry with the new token
    }
    return res;
  }

  async function errorFromResponse(res: Response): Promise<UpstreamError> {
    const providerRaw = await res
      .json()
      .catch(() => null)
      .then(scrub);
    return new UpstreamError(
      "upstream_error",
      `upstream returned ${res.status}`,
      providerRaw,
      res.status,
    );
  }

  return {
    ...(cfg.normalizeReasoningDeltaAlias ? { streamReframed: true } : {}),

    async chatCompletion(req, opts) {
      const res = await requestWithAuthRetry(req, opts?.signal);
      if (!res.ok) throw await errorFromResponse(res);
      return (await res.json()) as ChatCompletionResponse;
    },

    async *chatCompletionStream(req, opts) {
      // 401-retry happens here, BEFORE getReader() / any chunk is yielded, so the
      // SSE stream is replayed cleanly from the start (principle 8 — no duplicated
      // or half-emitted events).
      const res = await requestWithAuthRetry(req, opts?.signal);
      if (!res.ok) throw await errorFromResponse(res);
      const body = res.body;
      if (!body) return;
      const reader = body.getReader();
      const decoder = new TextDecoder();
      let pendingFrame = "";
      try {
        while (true) {
          // Inter-chunk liveness: `withTimeout` already cleared once headers
          // arrived, so without this a stream that wedges mid-flight hangs forever.
          // Reuse `timeoutMs` as the max silence between chunks (a healthy stream
          // keeps emitting; only a real stall trips it). Pre-first-chunk it is a
          // normal fallback-eligible failure; after, it terminates the response.
          const { done, value } = await readChunkWithIdle(reader, timeoutMs);
          if (done) break;
          if (!value) continue;
          const chunk = decoder.decode(value, { stream: true });
          if (!cfg.normalizeReasoningDeltaAlias) {
            yield chunk;
            continue;
          }
          pendingFrame += chunk;
          while (true) {
            const boundary = nextSseFrameBoundary(pendingFrame);
            if (!boundary) break;
            const frame = pendingFrame.slice(0, boundary.index);
            pendingFrame = pendingFrame.slice(boundary.index + boundary.separator.length);
            yield `${normalizeReasoningDeltaFrame(frame)}${boundary.separator}`;
          }
        }
        if (cfg.normalizeReasoningDeltaAlias && pendingFrame.length > 0) {
          yield normalizeReasoningDeltaFrame(pendingFrame);
        }
      } catch (err) {
        if (err instanceof StreamStalledError) {
          throw new UpstreamError("timeout", err.message);
        }
        throw err;
      } finally {
        reader.releaseLock();
      }
    },
  };
}
