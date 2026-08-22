// OpenAI-compatible upstream client. Phase 0 = PASSTHROUGH ONLY: no protocol
// translation, no classification, no lanes, no fallback, no circuit breaker
// (all Phase 1/2). Framework-agnostic (no Hono). Credentials come only from the
// injected config (env-sourced) and are never logged or echoed. See docs/02.

import { Buffer } from "node:buffer";
import {
  type NativePassthroughInput,
  VideoGenerationResponseSchema,
  VideoRetrieveResponseSchema,
} from "@helm/shared";
import { createSSEIncompleteFrameGuard, nextSSEFrameBoundary } from "../protocol/streaming.js";
import {
  consumeResponseBytesWithinBudget,
  consumeResponseTextWithinBudget,
  ResponseBodyTooLargeError,
} from "../runtime/bounded-response.js";
import {
  type ResponseWorkAdmission,
  ResponseWorkCapacityError,
  runtimeResponseWorkAdmission,
} from "../runtime/response-work-admission.js";
import type { ProxyConfig } from "./proxy.js";
// Provider credential: EXACTLY ONE of a static `apiKey` or a dynamic
// `getAuthHeader` (issue #38 OAuth). The dynamic path also accepts:
//   - `onUnauthorized`: invoked once on an upstream 401 to force a token refresh
//     (the manager's invalidate), after which the request is retried exactly once
//     with the freshly fetched header (D2 — the retry lives here in the client,
//     not the executor, so the SAME request is replayed with the new token).
//   - `currentSecrets`: live access + refresh tokens, used by `scrub()` to strip
//     any echoed credential from an upstream error body (principle 7).
// Credentials are runtime-only: from env, never persisted/logged.
import { isFetchTransportError, withConnectionRetry, withOverloadRetry } from "./retry.js";
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
  // Transient-connection retry at the fetch boundary (provider/retry.ts). Both
  // optional — omitted falls back to withConnectionRetry's defaults (2 retries,
  // [200,500] ms). Safe here because a retry happens BEFORE any byte reaches the
  // client (idempotent); it absorbs a keepalive-reuse race / ECONNRESET so a hiccup
  // does not burn a candidate or 502 a single-candidate chain.
  connectRetries?: number;
  connectRetryBackoffMs?: readonly number[];
  // Realtime sideband WebSockets must use the same egress hop as the HTTP call.
  realtimeProxy?: ProxyConfig;
}

export interface OpenAIClientDeps {
  config: ProviderConfig;
  fetch?: typeof globalThis.fetch;
  responseWorkAdmission?: ResponseWorkAdmission;
}

export type ChatCompletionRequest = Record<string, unknown>;
export type ChatCompletionResponse = Record<string, unknown>;
export type ImageEditInput =
  | { kind: "json"; body: Record<string, unknown> }
  | { kind: "multipart"; fields: readonly ImageEditMultipartField[] };
export type ImageEditMultipartField =
  | { name: string; value: string }
  | {
      name: string;
      value: Uint8Array;
      filename: string;
      contentType: string;
    };

export interface RealtimeCallRequest {
  endpoint: "realtime" | "live";
  query: string;
  sdp: string;
  session: Record<string, unknown>;
  /** Already allowlisted client metadata; never contains the Helm credential. */
  headers: Record<string, string>;
}

export interface RealtimeSidebandTarget {
  url: string;
  headers(): Promise<Record<string, string>>;
  onUnauthorized?: () => void;
  /** Called only after a refreshed sideband still returns an auth failure. */
  onCredentialFailure?: (status: number) => void;
  proxy?: ProxyConfig;
}

export interface RealtimeCallResult {
  status: number;
  sdp: string;
  contentType: string | null;
  location: string;
  callId: string;
  sideband: RealtimeSidebandTarget;
}
export type NativeProtocolProfile =
  | "anthropic_messages"
  | "codex_responses"
  | "generic_openai_responses"
  | "gemini";

// Options for a completion / native-passthrough call. `captureUpstream`, when
// supplied, is invoked with the EXACT serialized request body bytes the client is
// about to POST upstream — AFTER any OpenAI→native translation, just before the HTTP
// request. The gateway uses it to record the forwarded-upstream payload (what the
// model actually received), which differs from the inbound client body for both the
// translate path (re-serialized to the provider's native shape) and native passthrough
// (model patched to the resolved upstream id). Fires once per fetch attempt (idempotent
// across connection / 401 retries — same body). MUST NOT throw (capture is fail-open).
export interface ProviderCallOptions {
  signal?: AbortSignal;
  /** Media pools invoke this after selecting an account and before the paid write. */
  onAccountSelected?: (account: string) => void | Promise<void>;
  /** Trusted pool-selected account for an account-affine media poll. Provider
   * clients do not interpret it; the OAuth pool consumes it before delegating. */
  providerAccount?: string;
  /** Trusted persisted account pin for opaque stateful Responses continuations. */
  statefulAccount?: string;
  captureUpstream?: (wireBody: string) => void;
  /** Request-scoped Anthropic defensive recovery switch. The gateway owns the live
   * runtime setting and passes its current value per attempt; provider clients keep
   * the default OFF when the option is absent so unrelated callers never opt in by
   * accident. */
  toolCallXmlRecovery?: boolean;
  // Per-call response metadata channel. Codex Responses uses this for request-scoped
  // headers such as x-codex-turn-state and x-request-id; provider-level observers may
  // still subscribe separately. Hooks are fail-open and must not affect the response.
  onResponseMeta?: (headers: Headers) => void;
  /** Anthropic-only post-translation optimizer. Called after an OpenAI/IR-shaped
   * request is rendered into Anthropic Messages wire format, just before the POST
   * body is captured/sent. Other providers ignore it. */
  optimizeAnthropicBody?: (
    body: Record<string, unknown>,
  ) => Record<string, unknown> | Promise<Record<string, unknown>>;
  // PER-CANDIDATE timeout hint (ms) for an internal LOOPBACK call. Consumed ONLY by the
  // self-HTTP client (memory-self-http.ts), which forwards it to the nested gateway as
  // `x-helm-attempt-timeout-ms` so that request's executor bounds each candidate (a slow
  // head model then falls back instead of the caller aborting the whole loopback). Real
  // provider clients IGNORE it — the executor enforces the deadline itself (execute.ts
  // withAttemptDeadline); this is purely the loopback's way to propagate it inward.
  attemptTimeoutMs?: number;
}

export interface ProviderClient {
  nativeProtocolProfile?: NativeProtocolProfile;
  streamReframed?: boolean;
  chatCompletion(
    req: ChatCompletionRequest,
    opts?: ProviderCallOptions,
  ): Promise<ChatCompletionResponse>;
  chatCompletionStream(
    req: ChatCompletionRequest,
    opts?: ProviderCallOptions,
  ): AsyncIterable<string>;
  // Native protocol passthrough (issue #217, Phase 1). OPTIONAL so every existing
  // client and test double stays valid without change; the executor feature-detects
  // it. When present, it forwards the client's VERBATIM native body to the upstream
  // (NO OpenAI-Chat translation) and returns the upstream's native response
  // untranslated. Only same-protocol native clients (Anthropic→Anthropic in Phase 1)
  // implement it; the guard (canUseNativePassthrough) gates when it may be used.
  nativePassthrough?(
    request: NativePassthroughInput,
    opts?: ProviderCallOptions,
  ): Promise<Record<string, unknown>>;
  // Streaming native protocol passthrough (issue #217, Phase 2). The streaming sibling
  // of nativePassthrough: forwards the client's VERBATIM native body (which ALREADY
  // carries stream:true) to the upstream and BYTE-RELAYS the upstream SSE back without
  // translation — eliminating the SSE re-mapping state machine (principle 8) rather than
  // replacing it. OPTIONAL (feature-detected by the executor); only same-protocol native
  // clients implement it, gated by the same guard as nativePassthrough.
  nativePassthroughStream?(
    request: NativePassthroughInput,
    opts?: ProviderCallOptions,
  ): AsyncIterable<string>;
  countTokens?(
    req: ChatCompletionRequest,
    opts?: { signal?: AbortSignal },
  ): Promise<Record<string, unknown>>;
  // OpenAI Images API (POST /v1/images/generations). OPTIONAL — feature-detected by
  // the images route; only the OpenAI-compat provider implements it. Forwards the
  // verbatim images body to `${base}/images/generations` and returns the upstream
  // response (data[].b64_json) untranslated.
  imageGeneration?(
    req: Record<string, unknown>,
    opts?: ProviderCallOptions,
  ): Promise<Record<string, unknown>>;
  imageEdit?(req: ImageEditInput, opts?: ProviderCallOptions): Promise<Record<string, unknown>>;
  // Grok/xAI asynchronous Videos API. Start is a paid single-write operation;
  // retrieve is a safe GET that may refresh an expired OAuth bearer once.
  videoGeneration?(
    req: Record<string, unknown>,
    opts?: ProviderCallOptions,
  ): Promise<Record<string, unknown>>;
  videoExtension?(
    req: Record<string, unknown>,
    opts?: ProviderCallOptions,
  ): Promise<Record<string, unknown>>;
  videoRetrieve?(requestId: string, opts?: ProviderCallOptions): Promise<Record<string, unknown>>;
  ttsSpeech?(
    req: Record<string, unknown>,
    opts?: ProviderCallOptions,
  ): Promise<{ audio: Uint8Array; contentType: string }>;
  ttsVoices?(opts?: ProviderCallOptions): Promise<Record<string, unknown>>;
  realtimeCall?(req: RealtimeCallRequest, opts?: ProviderCallOptions): Promise<RealtimeCallResult>;
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
    req: NativePassthroughInput,
    opts?: ProviderCallOptions,
  ): Promise<Record<string, unknown>>;
  // Close a named native Responses WebSocket session. Used by the gateway when
  // the corresponding inbound Codex WebSocket disconnects.
  closeResponsesWebSocketSession?(sessionId: string): Promise<void>;
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
  readonly upstreamHeaders: Record<string, string> | null;
  constructor(
    errorClass: "upstream_error" | "timeout",
    message: string,
    providerRaw: unknown | null = null,
    upstreamStatus: number | null = null,
    upstreamHeaders: Record<string, string> | null = null,
    cause?: unknown,
  ) {
    super(message);
    if (cause !== undefined) Object.defineProperty(this, "cause", { value: cause });
    this.name = "UpstreamError";
    this.errorClass = errorClass;
    this.httpStatus = errorClass === "timeout" ? 504 : 502;
    this.upstreamStatus = upstreamStatus;
    this.providerRaw = providerRaw;
    this.upstreamHeaders = upstreamHeaders;
  }
}

function transportErrorNode(
  error: unknown,
  depth = 0,
  seen = new WeakSet<object>(),
): Record<string, unknown> {
  if (typeof error !== "object" || error === null) return { message: String(error) };
  if (seen.has(error)) return { message: "[circular cause]" };
  seen.add(error);
  const source = error as {
    name?: unknown;
    message?: unknown;
    code?: unknown;
    stack?: unknown;
    cause?: unknown;
  };
  const detail: Record<string, unknown> = {};
  if (typeof source.name === "string" && source.name.length > 0) detail.name = source.name;
  if (typeof source.message === "string" && source.message.length > 0) {
    detail.message = source.message.slice(0, 16_384);
  }
  if (typeof source.code === "string" || typeof source.code === "number") detail.code = source.code;
  if (typeof source.stack === "string" && source.stack.length > 0) {
    detail.stack = source.stack.slice(0, 16_384);
  }
  if (source.cause !== undefined && depth < 4) {
    detail.cause = transportErrorNode(source.cause, depth + 1, seen);
  }
  return detail;
}

export function upstreamTransportError(
  error: unknown,
  scrub: (raw: unknown) => unknown,
): UpstreamError {
  const detail = scrub(transportErrorNode(error));
  const rawMessage = error instanceof Error ? error.message : "upstream fetch failed";
  const message = scrub(rawMessage);
  return new UpstreamError(
    "upstream_error",
    typeof message === "string" ? message : "upstream fetch failed",
    { error: detail },
    null,
    null,
    detail,
  );
}

export const UPSTREAM_ERROR_BODY_MAX_BYTES = 64 * 1024;
const UPSTREAM_ERROR_HEADER_MAX_BYTES = 16 * 1024;
const UPSTREAM_ERROR_HEADER_VALUE_MAX_BYTES = 4 * 1024;
const CREDENTIAL_HEADERS = new Set([
  "authorization",
  "proxy-authorization",
  "x-proxy-authorization",
  "cookie",
  "set-cookie",
  "api-key",
  "x-api-key",
  "x-goog-api-key",
  "x-google-api-key",
  "x-auth-token",
  "x-access-token",
]);

export function safeUpstreamHeaders(headers: Headers): Record<string, string> {
  const safe: Record<string, string> = {};
  let bytes = 0;
  for (const [name, rawValue] of headers) {
    if (CREDENTIAL_HEADERS.has(name.toLowerCase())) continue;
    const value = rawValue.slice(0, UPSTREAM_ERROR_HEADER_VALUE_MAX_BYTES);
    const nextBytes = Buffer.byteLength(name) + Buffer.byteLength(value);
    if (bytes + nextBytes > UPSTREAM_ERROR_HEADER_MAX_BYTES) break;
    safe[name] = value;
    bytes += nextBytes;
  }
  return safe;
}

export async function readUpstreamErrorBody(
  response: Response,
  scrub: (raw: unknown) => unknown,
  admission: ResponseWorkAdmission = runtimeResponseWorkAdmission(),
): Promise<unknown> {
  try {
    return await consumeResponseTextWithinBudget(
      response,
      UPSTREAM_ERROR_BODY_MAX_BYTES,
      (text) => {
        try {
          return scrub(JSON.parse(text));
        } catch {
          return scrub(text);
        }
      },
      admission,
    );
  } catch (error) {
    if (error instanceof ResponseBodyTooLargeError) {
      return { error: { code: "error_body_too_large", limit_bytes: error.limitBytes } };
    }
    if (error instanceof ResponseWorkCapacityError) {
      return {
        error: { code: "error_body_capacity_exhausted", limit_bytes: error.capacityBytes },
      };
    }
    return scrub({ error: { code: "error_body_read_failed", message: String(error) } });
  }
}

export async function consumeUpstreamBodyWithinBudget<T>(
  response: Response,
  consume: (text: string) => T | Promise<T>,
  admission: ResponseWorkAdmission = runtimeResponseWorkAdmission(),
): Promise<T> {
  try {
    return await consumeResponseTextWithinBudget(
      response,
      admission.capacityBytes,
      consume,
      admission,
    );
  } catch (error) {
    if (error instanceof ResponseBodyTooLargeError) {
      throw new UpstreamError("upstream_error", error.message, {
        error: { code: "response_body_too_large", limit_bytes: error.limitBytes },
      });
    }
    if (error instanceof ResponseWorkCapacityError) {
      throw new UpstreamError("upstream_error", error.message, {
        error: { code: "response_work_capacity_exhausted", limit_bytes: error.capacityBytes },
      });
    }
    throw error;
  }
}

export async function readUpstreamJsonWithinBudget<T = Record<string, unknown>>(
  response: Response,
  admission: ResponseWorkAdmission = runtimeResponseWorkAdmission(),
): Promise<T> {
  return await consumeUpstreamBodyWithinBudget(
    response,
    (text) => JSON.parse(text) as T,
    admission,
  );
}

const DEFAULT_TIMEOUT_MS = 60_000;

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

  // The images endpoint — same base, different path. Used by imageGeneration().
  async function imagesUrl(): Promise<string> {
    const base = cfg.resolveBaseUrl ? await cfg.resolveBaseUrl() : cfg.baseUrl;
    return `${base}/images/generations`;
  }

  async function imageEditsUrl(): Promise<string> {
    const base = cfg.resolveBaseUrl ? await cfg.resolveBaseUrl() : cfg.baseUrl;
    return `${base}/images/edits`;
  }

  async function videosUrl(): Promise<string> {
    const base = cfg.resolveBaseUrl ? await cfg.resolveBaseUrl() : cfg.baseUrl;
    return `${base}/videos/generations`;
  }

  async function videoExtensionsUrl(): Promise<string> {
    const base = cfg.resolveBaseUrl ? await cfg.resolveBaseUrl() : cfg.baseUrl;
    return `${base}/videos/extensions`;
  }

  async function videoRetrieveUrl(requestId: string): Promise<string> {
    const base = cfg.resolveBaseUrl ? await cfg.resolveBaseUrl() : cfg.baseUrl;
    return `${base}/videos/${encodeURIComponent(requestId)}`;
  }

  async function ttsUrl(): Promise<string> {
    const base = cfg.resolveBaseUrl ? await cfg.resolveBaseUrl() : cfg.baseUrl;
    return `${base}/tts`;
  }

  async function ttsVoicesUrl(): Promise<string> {
    const base = cfg.resolveBaseUrl ? await cfg.resolveBaseUrl() : cfg.baseUrl;
    return `${base}/tts/voices`;
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

  async function headersWithoutContentType(): Promise<Record<string, string>> {
    const next = await headers();
    delete next["Content-Type"];
    return next;
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
    capture?: (wireBody: string) => void,
    urlFn: () => Promise<string> = chatUrl,
  ): Promise<Response> {
    // The exact bytes POSTed upstream — deterministic in `req`, so computed once
    // (outside the retry loop) and surfaced to the capture sink before the first fetch.
    const bodyText = JSON.stringify(prepareRequest(req));
    capture?.(bodyText);
    // Retry transient connection blips at the fetch boundary (pre-first-byte, so
    // idempotent). A timeout is rethrown as UpstreamError (non-transient → no retry,
    // the chain falls back); a client abort rethrows as-is. Each attempt gets a fresh
    // timeout + freshly resolved url/headers (tracks a rotating token).
    // withOverloadRetry wraps it: an overloaded 529/503 is a normal Response (never a
    // throw), so it re-issues the whole attempt after a pause instead of burning a
    // candidate on transient upstream capacity pressure.
    try {
      return await withOverloadRetry(
        () =>
          withConnectionRetry(
            async () => {
              const t = withTimeout(timeoutMs, external);
              try {
                return await doFetch(await urlFn(), {
                  method: "POST",
                  headers: await headers(),
                  body: bodyText,
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
            },
            { retries: cfg.connectRetries, backoffMs: cfg.connectRetryBackoffMs, signal: external },
          ),
        { signal: external },
      );
    } catch (error) {
      if (external?.aborted || !isFetchTransportError(error)) throw error;
      throw upstreamTransportError(error, scrub);
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
    capture?: (wireBody: string) => void,
    urlFn: () => Promise<string> = chatUrl,
  ): Promise<Response> {
    const res = await request(req, external, capture, urlFn);
    if (res.status === 401 && cfg.onUnauthorized !== undefined) {
      // Discard the 401 body (it may echo the credential) before refreshing.
      await res.body?.cancel().catch(() => {});
      cfg.onUnauthorized();
      return await request(req, external, capture, urlFn); // exactly one retry with the new token
    }
    return res;
  }

  async function rawRequestWithAuthRetry(options: {
    url: () => Promise<string>;
    body: () => NonNullable<RequestInit["body"]>;
    headers: () => Promise<Record<string, string>>;
    signal?: AbortSignal;
  }): Promise<Response> {
    const attempt = async (): Promise<Response> => {
      try {
        return await withConnectionRetry(
          async () => {
            const t = withTimeout(timeoutMs, options.signal);
            try {
              return await doFetch(await options.url(), {
                method: "POST",
                headers: await options.headers(),
                body: options.body(),
                signal: t.signal,
              });
            } catch (error) {
              if (t.isTimeout() && !t.isExternalAbort()) {
                throw new UpstreamError("timeout", "upstream request timed out");
              }
              throw error;
            } finally {
              t.cleanup();
            }
          },
          {
            retries: cfg.connectRetries,
            backoffMs: cfg.connectRetryBackoffMs,
            signal: options.signal,
          },
        );
      } catch (error) {
        if (options.signal?.aborted || !isFetchTransportError(error)) throw error;
        throw upstreamTransportError(error, scrub);
      }
    };
    const response = await attempt();
    if (response.status !== 401 || cfg.onUnauthorized === undefined) return response;
    await response.body?.cancel().catch(() => {});
    cfg.onUnauthorized();
    return await attempt();
  }

  // Image/video creation is an externally billable write. Unlike chat, it must
  // never replay after an ambiguous transport, timeout, or overload result: a
  // second POST could create and bill a second asset. OAuth refresh is likewise
  // intentionally reserved for the read-only poll path below.
  async function mediaWriteRequest(options: {
    url: () => Promise<string>;
    body: () => NonNullable<RequestInit["body"]>;
    headers: () => Promise<Record<string, string>>;
    signal?: AbortSignal;
  }): Promise<Response> {
    try {
      const t = withTimeout(timeoutMs, options.signal);
      try {
        return await doFetch(await options.url(), {
          method: "POST",
          headers: await options.headers(),
          body: options.body(),
          signal: t.signal,
        });
      } catch (error) {
        if (t.isTimeout() && !t.isExternalAbort()) {
          throw new UpstreamError("timeout", "upstream request timed out");
        }
        throw error;
      } finally {
        t.cleanup();
      }
    } catch (error) {
      if (options.signal?.aborted || !isFetchTransportError(error)) throw error;
      throw upstreamTransportError(error, scrub);
    }
  }

  // Polling is read-only, so a 401 is safe to replay once after the token manager
  // invalidates its bearer. It otherwise keeps the same no-transport-retry policy
  // as media writes; Grok CLI owns polling cadence and backoff.
  async function mediaRetrieveRequest(
    url: () => Promise<string>,
    signal?: AbortSignal,
  ): Promise<Response> {
    const attempt = async (): Promise<Response> => {
      try {
        const t = withTimeout(timeoutMs, signal);
        try {
          return await doFetch(await url(), {
            method: "GET",
            headers: await headers(),
            signal: t.signal,
          });
        } catch (error) {
          if (t.isTimeout() && !t.isExternalAbort()) {
            throw new UpstreamError("timeout", "upstream request timed out");
          }
          throw error;
        } finally {
          t.cleanup();
        }
      } catch (error) {
        if (signal?.aborted || !isFetchTransportError(error)) throw error;
        throw upstreamTransportError(error, scrub);
      }
    };
    const response = await attempt();
    if (response.status !== 401 || cfg.onUnauthorized === undefined) return response;
    await response.body?.cancel().catch(() => {});
    cfg.onUnauthorized();
    return await attempt();
  }

  async function errorFromResponse(res: Response): Promise<UpstreamError> {
    const providerRaw = await readUpstreamErrorBody(res, scrub, deps.responseWorkAdmission);
    return new UpstreamError(
      "upstream_error",
      `upstream returned ${res.status}`,
      providerRaw,
      res.status,
      scrub(safeUpstreamHeaders(res.headers)) as Record<string, string>,
    );
  }

  function invalidMediaResponse(res: Response, body: unknown, message: string): UpstreamError {
    return new UpstreamError(
      "upstream_error",
      message,
      scrub(body),
      res.status,
      scrub(safeUpstreamHeaders(res.headers)) as Record<string, string>,
    );
  }

  async function mediaJsonResponse(res: Response, requiredField: "request_id" | "status") {
    let body: unknown;
    try {
      body = await readUpstreamJsonWithinBudget(res, deps.responseWorkAdmission);
    } catch (error) {
      if (error instanceof UpstreamError) throw error;
      throw invalidMediaResponse(res, null, "upstream returned invalid media JSON");
    }
    const parsed =
      requiredField === "request_id"
        ? VideoGenerationResponseSchema.safeParse(body)
        : VideoRetrieveResponseSchema.safeParse(body);
    if (!parsed.success) {
      throw invalidMediaResponse(
        res,
        body,
        `upstream media response omitted valid ${requiredField}`,
      );
    }
    return parsed.data as Record<string, unknown>;
  }

  async function realtimeErrorFromResponse(res: Response): Promise<UpstreamError> {
    const providerRaw = await readUpstreamErrorBody(res, scrub, deps.responseWorkAdmission);
    const outer =
      providerRaw !== null && typeof providerRaw === "object" && !Array.isArray(providerRaw)
        ? (providerRaw as Record<string, unknown>)
        : null;
    const nested =
      outer?.error !== null && typeof outer?.error === "object" && !Array.isArray(outer.error)
        ? (outer.error as Record<string, unknown>)
        : null;
    const message =
      typeof nested?.message === "string" && nested.message.length > 0
        ? nested.message
        : `upstream returned ${res.status}`;
    return new UpstreamError(
      "upstream_error",
      message,
      providerRaw,
      res.status,
      scrub(safeUpstreamHeaders(res.headers)) as Record<string, string>,
    );
  }

  function realtimeCallId(location: string): string | null {
    let path: string;
    try {
      path = new URL(location, "https://realtime.invalid").pathname;
    } catch {
      return null;
    }
    for (const segment of path.split("/").reverse()) {
      if (segment.startsWith("rtc_") && segment.length > 4) return segment;
      if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(segment)) {
        return segment;
      }
    }
    return null;
  }

  return {
    ...(cfg.normalizeReasoningDeltaAlias ? { streamReframed: true } : {}),

    async chatCompletion(req, opts) {
      const res = await requestWithAuthRetry(req, opts?.signal, opts?.captureUpstream);
      if (!res.ok) throw await errorFromResponse(res);
      return await readUpstreamJsonWithinBudget<ChatCompletionResponse>(
        res,
        deps.responseWorkAdmission,
      );
    },

    async imageGeneration(req, opts) {
      const bodyText = JSON.stringify(req);
      opts?.captureUpstream?.(bodyText);
      const res = await mediaWriteRequest({
        url: imagesUrl,
        body: () => bodyText,
        headers,
        signal: opts?.signal,
      });
      if (!res.ok) throw await errorFromResponse(res);
      return await readUpstreamJsonWithinBudget(res, deps.responseWorkAdmission);
    },

    async imageEdit(req, opts) {
      let captured = false;
      const body = (): NonNullable<RequestInit["body"]> => {
        if (req.kind === "json") {
          const wire = JSON.stringify(req.body);
          if (!captured) {
            captured = true;
            opts?.captureUpstream?.(wire);
          }
          return wire;
        }
        const form = new FormData();
        for (const field of req.fields) {
          if (!("filename" in field)) form.append(field.name, field.value);
          else {
            form.append(
              field.name,
              new Blob([field.value], { type: field.contentType }),
              field.filename,
            );
          }
        }
        return form;
      };
      const res = await mediaWriteRequest({
        url: imageEditsUrl,
        body,
        headers: req.kind === "json" ? headers : headersWithoutContentType,
        signal: opts?.signal,
      });
      if (!res.ok) throw await errorFromResponse(res);
      return await readUpstreamJsonWithinBudget(res, deps.responseWorkAdmission);
    },

    async videoGeneration(req, opts) {
      const bodyText = JSON.stringify(req);
      opts?.captureUpstream?.(bodyText);
      const res = await mediaWriteRequest({
        url: videosUrl,
        body: () => bodyText,
        headers,
        signal: opts?.signal,
      });
      if (!res.ok) throw await errorFromResponse(res);
      return await mediaJsonResponse(res, "request_id");
    },

    async videoExtension(req, opts) {
      const bodyText = JSON.stringify(req);
      opts?.captureUpstream?.(bodyText);
      const res = await mediaWriteRequest({
        url: videoExtensionsUrl,
        body: () => bodyText,
        headers,
        signal: opts?.signal,
      });
      if (!res.ok) throw await errorFromResponse(res);
      return await mediaJsonResponse(res, "request_id");
    },

    async videoRetrieve(requestId, opts) {
      const res = await mediaRetrieveRequest(() => videoRetrieveUrl(requestId), opts?.signal);
      if (!res.ok) throw await errorFromResponse(res);
      return await mediaJsonResponse(res, "status");
    },

    async ttsSpeech(req, opts) {
      const bodyText = JSON.stringify(req);
      opts?.captureUpstream?.(bodyText);
      const res = await mediaWriteRequest({
        url: ttsUrl,
        body: () => bodyText,
        headers,
        signal: opts?.signal,
      });
      if (!res.ok) throw await errorFromResponse(res);
      try {
        return {
          audio: await consumeResponseBytesWithinBudget(
            res,
            deps.responseWorkAdmission?.capacityBytes ??
              runtimeResponseWorkAdmission().capacityBytes,
            deps.responseWorkAdmission,
          ),
          contentType: res.headers.get("content-type") ?? "audio/mpeg",
        };
      } catch (error) {
        if (error instanceof ResponseBodyTooLargeError) {
          throw new UpstreamError("upstream_error", error.message, {
            error: { code: "response_body_too_large", limit_bytes: error.limitBytes },
          });
        }
        if (error instanceof ResponseWorkCapacityError) {
          throw new UpstreamError("upstream_error", error.message, {
            error: { code: "response_work_capacity_exhausted", limit_bytes: error.capacityBytes },
          });
        }
        throw error;
      }
    },

    async ttsVoices(opts) {
      const res = await mediaRetrieveRequest(ttsVoicesUrl, opts?.signal);
      if (!res.ok) throw await errorFromResponse(res);
      return await readUpstreamJsonWithinBudget(res, deps.responseWorkAdmission);
    },

    async realtimeCall(req, opts) {
      const base = cfg.resolveBaseUrl ? await cfg.resolveBaseUrl() : cfg.baseUrl;
      const backendShape = base.includes("/backend-api/");
      const callPath = backendShape || req.endpoint === "realtime" ? "realtime/calls" : "live";
      const callQuery = new URLSearchParams(req.query);
      if (backendShape) {
        if (!callQuery.has("intent")) callQuery.set("intent", "quicksilver");
        if (!callQuery.has("architecture")) callQuery.set("architecture", "avas");
      }
      const queryText = callQuery.toString();
      const query = queryText.length > 0 ? `?${queryText}` : "";
      const url = `${base}/${callPath}${query}`;
      const forwardedHeaders = async (): Promise<Record<string, string>> => ({
        ...(await headersWithoutContentType()),
        ...req.headers,
      });
      const body = (): NonNullable<RequestInit["body"]> => {
        if (backendShape) return JSON.stringify({ sdp: req.sdp, session: req.session });
        const form = new FormData();
        form.append("sdp", new Blob([req.sdp], { type: "application/sdp" }), "sdp");
        form.append(
          "session",
          new Blob([JSON.stringify(req.session)], { type: "application/json" }),
          "session.json",
        );
        return form;
      };
      const response = await rawRequestWithAuthRetry({
        url: async () => url,
        body,
        headers: backendShape
          ? async () => ({ ...(await forwardedHeaders()), "Content-Type": "application/json" })
          : forwardedHeaders,
        signal: opts?.signal,
      });
      if (!response.ok) throw await realtimeErrorFromResponse(response);
      const sdp = await consumeUpstreamBodyWithinBudget(
        response,
        (text) => text,
        deps.responseWorkAdmission,
      );
      const location = response.headers.get("location") ?? "";
      const callId = realtimeCallId(location);
      if (callId === null) {
        throw new UpstreamError("upstream_error", "upstream Realtime response omitted call id");
      }
      const sideband = new URL(backendShape ? "https://api.openai.com/v1" : base);
      sideband.protocol = sideband.protocol === "http:" ? "ws:" : "wss:";
      sideband.pathname = `${sideband.pathname.replace(/\/$/, "")}/${
        req.endpoint === "live" ? "live" : "realtime"
      }`;
      if (req.endpoint === "live") {
        sideband.pathname = `${sideband.pathname.replace(/\/$/, "")}/${callId}`;
      } else {
        const sidebandQuery = new URLSearchParams(backendShape ? "" : req.query);
        sidebandQuery.delete("architecture");
        sidebandQuery.set("intent", "quicksilver");
        sideband.search = sidebandQuery.toString();
        sideband.searchParams.set("call_id", callId);
      }
      return {
        status: response.status,
        sdp,
        contentType: response.headers.get("content-type"),
        location,
        callId,
        sideband: {
          url: sideband.toString(),
          headers: forwardedHeaders,
          ...(cfg.onUnauthorized ? { onUnauthorized: cfg.onUnauthorized } : {}),
          ...(cfg.realtimeProxy ? { proxy: cfg.realtimeProxy } : {}),
        },
      };
    },

    async *chatCompletionStream(req, opts) {
      // 401-retry happens here, BEFORE getReader() / any chunk is yielded, so the
      // SSE stream is replayed cleanly from the start (principle 8 — no duplicated
      // or half-emitted events).
      const res = await requestWithAuthRetry(req, opts?.signal, opts?.captureUpstream);
      if (!res.ok) throw await errorFromResponse(res);
      const body = res.body;
      if (!body) return;
      const reader = body.getReader();
      const decoder = new TextDecoder();
      let pendingFrame = "";
      const frameGuard = cfg.normalizeReasoningDeltaAlias
        ? createSSEIncompleteFrameGuard(runtimeResponseWorkAdmission())
        : null;
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
          frameGuard?.resize(Buffer.byteLength(pendingFrame) + Buffer.byteLength(chunk));
          pendingFrame += chunk;
          while (true) {
            const boundary = nextSSEFrameBoundary(pendingFrame);
            if (!boundary) break;
            const frame = pendingFrame.slice(0, boundary.index);
            const separator = pendingFrame.slice(boundary.index, boundary.index + boundary.length);
            pendingFrame = pendingFrame.slice(boundary.index + boundary.length);
            frameGuard?.resize(Buffer.byteLength(pendingFrame));
            yield `${normalizeReasoningDeltaFrame(frame)}${separator}`;
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
        await reader.cancel().catch(() => {});
        reader.releaseLock();
        frameGuard?.release();
      }
    },
  };
}
