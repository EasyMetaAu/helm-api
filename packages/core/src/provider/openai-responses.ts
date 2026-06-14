// Native OpenAI Responses executor (issue #38, Codex) — routes Helm's internal
// OpenAI-Chat IR to the ChatGPT Codex backend (`/backend-api/codex/responses`),
// used by ChatGPT Plus/Pro (Codex) SUBSCRIPTION (OAuth) providers. Implements the
// same ProviderClient interface as the OpenAI/Anthropic clients so dispatch by
// provider name is identical.
//
// Why a native executor (not the OpenAI Chat client): the Codex subscription
// endpoint speaks the OpenAI *Responses* protocol (a different request + SSE shape
// from Chat Completions), is stream-only, and requires the ChatGPT identity headers
// (`chatgpt-account-id`, `originator`, `OpenAI-Beta: responses=experimental`). So
// this executor carries the Chat-IR ⇄ Responses translation both ways.
//
// The `chatgpt-account-id` is NOT plumbed separately: the OAuth access token is a
// JWT carrying the `chatgpt_account_id` claim, so we decode it from the Bearer
// header at request time (always correct, even after a token refresh).
//
// ⚠️ ToS: reverse-engineered first-party Codex client; the operator opts in (issue
// #38 README disclaimer). Request/SSE shapes + identity ported from openclaw (MIT).

import { isNativePassthroughCarrier, type NativePassthroughInput } from "@helm/shared";
import { prepareNativePassthroughRequest } from "./native-passthrough.js";
import {
  type ChatCompletionRequest,
  type ChatCompletionResponse,
  type ProviderClient,
  UpstreamError,
} from "./openai.js";
import { readChunkWithIdle, StreamStalledError } from "./stream-idle.js";

export interface CodexResponsesClientConfig {
  baseUrl: string; // e.g. https://chatgpt.com/backend-api/codex (endpoint = baseUrl + /responses)
  getAuthHeader?: () => Promise<string>; // dynamic "Bearer <oauth-access>" (required)
  onUnauthorized?: () => void; // 401 hook -> force token refresh, replay once
  currentSecrets?: () => string[]; // live token set for redaction
  timeoutMs?: number;
  // Stable per-account session id (anti-ban / cache coherence). When set it rides on
  // `session_id` + `x-client-request-id` headers and `prompt_cache_key` — the official
  // Codex client keys its prompt cache on a stable session, so reuse one per account
  // rather than minting a new one per request.
  sessionId?: string;
  // Overrides the default Codex-client User-Agent (openclaw proves a custom UA is
  // accepted by the backend; the real first-party value is not required).
  userAgent?: string;
  // Response-metadata hook (providers page Tier 3 quota). Invoked with the upstream
  // response Headers AS SOON AS they resolve — BEFORE any SSE chunk is read — so the
  // caller can scrape the `x-codex-*` rate-limit window headers without buffering or
  // perturbing the streamed body (Principle 8). MUST be cheap + non-throwing (the
  // caller wraps its own fail-open); a throw here is swallowed so it never breaks a
  // served request.
  onResponseMeta?: (headers: Headers) => void;
}

export interface CodexResponsesClientDeps {
  config: CodexResponsesClientConfig;
  fetch?: typeof globalThis.fetch;
}

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_INSTRUCTIONS = "You are a helpful assistant.";
const ORIGINATOR = "helm"; // matches the OAuth login `originator` (openai-codex.ts)
// Codex-client User-Agent. openclaw sends its own `openclaw (...)` UA and the backend
// accepts it, so a first-party `codex_cli_rs` value is not required — only a UA that
// presents as a Codex client. Overridable via config.userAgent. (Verified live: the
// ChatGPT-account model allowlist is gated by the account's Codex ENTITLEMENT, not by
// originator/UA/body — impersonating codex_cli_rs changed nothing.)
const DEFAULT_USER_AGENT = "helm-codex/1.0.0";

const RESPONSES_REASONING_DELTA_TYPES = new Set([
  "response.reasoning_summary.delta",
  "response.reasoning_summary_text.delta",
  "response.reasoning_text.delta",
]);

// ── account id from the access-token JWT (chatgpt_account_id claim) ───────────
// Same recipe as the login-time capture in oauth/openai-codex.ts, applied at
// request time so it always reflects the current token. Returns "" when absent.
export function codexAccountIdFromToken(accessToken: string): string {
  const parts = accessToken.split(".");
  const payloadSeg = parts[1];
  if (parts.length !== 3 || !payloadSeg) return "";
  try {
    const payload = JSON.parse(Buffer.from(payloadSeg, "base64url").toString("utf8")) as Record<
      string,
      unknown
    >;
    const auth = payload["https://api.openai.com/auth"] as Record<string, unknown> | undefined;
    const id = auth?.chatgpt_account_id;
    return typeof id === "string" ? id : "";
  } catch {
    return "";
  }
}

// ── request translation: OpenAI-Chat IR -> Responses API ─────────────────────

interface ResponsesContentPart {
  type: string;
  [k: string]: unknown;
}
interface ResponsesItem {
  type: string;
  [k: string]: unknown;
}

// User/system content (array or string) -> Responses input_text / input_image parts.
function inputPartsFromContent(content: unknown): ResponsesContentPart[] {
  if (typeof content === "string") return content ? [{ type: "input_text", text: content }] : [];
  if (Array.isArray(content)) {
    return content.flatMap((part): ResponsesContentPart[] => {
      if (part && typeof part === "object") {
        const p = part as Record<string, unknown>;
        if (p.type === "text" && typeof p.text === "string")
          return [{ type: "input_text", text: p.text }];
        if (p.type === "image_url" && p.image_url && typeof p.image_url === "object") {
          const urlVal = (p.image_url as Record<string, unknown>).url;
          if (typeof urlVal === "string") return [{ type: "input_image", image_url: urlVal }];
        }
      }
      return [];
    });
  }
  return [];
}

function plainText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((p) =>
        p && typeof p === "object" && typeof (p as { text?: unknown }).text === "string"
          ? (p as { text: string }).text
          : "",
      )
      .join("");
  }
  return "";
}

// The system prompt goes in the top-level `instructions`, NOT the input array. Join
// every system message (the Codex backend has no system-spoof requirement).
function buildInstructions(messages: Array<Record<string, unknown>>): string {
  const parts: string[] = [];
  for (const m of messages) if (m.role === "system") parts.push(plainText(m.content));
  const joined = parts.filter((s) => s.length > 0).join("\n\n");
  return joined || DEFAULT_INSTRUCTIONS;
}

function toResponsesInput(messages: Array<Record<string, unknown>>): ResponsesItem[] {
  const out: ResponsesItem[] = [];
  for (const m of messages) {
    const role = m.role;
    if (role === "system") continue;
    if (role === "tool") {
      out.push({
        type: "function_call_output",
        call_id: String(m.tool_call_id ?? ""),
        output: typeof m.content === "string" ? m.content : JSON.stringify(m.content ?? ""),
      });
      continue;
    }
    if (role === "assistant") {
      const text = plainText(m.content);
      if (text) {
        out.push({
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text }],
        });
      }
      const toolCalls = Array.isArray(m.tool_calls) ? m.tool_calls : [];
      for (const tc of toolCalls as Array<Record<string, unknown>>) {
        const fn = (tc.function ?? {}) as Record<string, unknown>;
        out.push({
          type: "function_call",
          call_id: String(tc.id ?? ""),
          name: String(fn.name ?? ""),
          arguments:
            typeof fn.arguments === "string" ? fn.arguments : JSON.stringify(fn.arguments ?? {}),
        });
      }
      continue;
    }
    // user (default)
    out.push({ type: "message", role: "user", content: inputPartsFromContent(m.content) });
  }
  return out;
}

function chatToolChoiceToResponses(toolChoice: unknown): unknown {
  if (typeof toolChoice !== "object" || toolChoice === null || Array.isArray(toolChoice)) {
    return toolChoice;
  }
  const choice = toolChoice as { type?: unknown; name?: unknown; function?: unknown };
  if (choice.type !== "function") return toolChoice;
  if (typeof choice.name === "string") return toolChoice;
  if (typeof choice.function !== "object" || choice.function === null) return toolChoice;
  const fn = choice.function as { name?: unknown };
  return typeof fn.name === "string" ? { type: "function", name: fn.name } : toolChoice;
}

export function openaiToResponsesRequest(
  req: ChatCompletionRequest,
  opts?: { sessionId?: string },
): Record<string, unknown> {
  const r = req as Record<string, unknown>;
  const messages = Array.isArray(r.messages) ? (r.messages as Array<Record<string, unknown>>) : [];
  const body: Record<string, unknown> = {
    model: r.model,
    // Codex backend constraints (ported from openclaw's known-good body): store MUST
    // be false, stream MUST be true, and a store:false request MUST ask for the
    // encrypted reasoning back (omitting `include` is rejected by the ChatGPT-account
    // backend, surfaced misleadingly as "model not supported"). `text.verbosity` is
    // part of the Codex request contract too. NOTE: we deliberately send NO
    // `max_output_tokens` — openclaw omits it and the ChatGPT-account backend dislikes it.
    store: false,
    stream: true,
    instructions: buildInstructions(messages),
    input: toResponsesInput(messages),
    text: { verbosity: "low" },
    include: ["reasoning.encrypted_content"],
    tool_choice: "auto",
    parallel_tool_calls: true,
  };
  // Stable prompt cache key. Client-supplied keys preserve OpenAI/Codex cache
  // affinity; otherwise fall back to the per-account subscription session id.
  if (typeof r.prompt_cache_key === "string" && r.prompt_cache_key.length > 0)
    body.prompt_cache_key = r.prompt_cache_key;
  else if (opts?.sessionId) body.prompt_cache_key = opts.sessionId;
  if (typeof r.prompt_cache_retention === "string")
    body.prompt_cache_retention = r.prompt_cache_retention;
  if (typeof r.temperature === "number") body.temperature = r.temperature;
  // Forward the client's reasoning effort to the Codex backend (Responses speaks
  // `reasoning.effort`). Without this the subscription always ran at its DEFAULT —
  // a real Codex `model_reasoning_effort` (incl. high/xhigh/max) was silently
  // dropped here. The IR has already normalized any unknown tier to a known one.
  if (typeof r.reasoning_effort === "string" && r.reasoning_effort.length > 0)
    body.reasoning = { effort: r.reasoning_effort };
  if (r.tool_choice !== undefined) body.tool_choice = chatToolChoiceToResponses(r.tool_choice);
  if (Array.isArray(r.tools)) {
    const tools = (r.tools as Array<Record<string, unknown>>).flatMap((t) => {
      const fn = (t.function ?? {}) as Record<string, unknown>;
      if (!fn.name) return [];
      return [
        {
          type: "function",
          name: fn.name,
          description: fn.description ?? "",
          parameters: fn.parameters ?? { type: "object" },
          strict: false,
        },
      ];
    });
    if (tools.length) body.tools = tools;
  }
  return body;
}

// ── response status -> OpenAI finish_reason ──────────────────────────────────

function finishReason(status: unknown, hadToolCall: boolean): string {
  if (hadToolCall) return "tool_calls";
  if (status === "incomplete") return "length";
  return "stop";
}

// ── client ───────────────────────────────────────────────────────────────────

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

export function createCodexResponsesClient(deps: CodexResponsesClientDeps): ProviderClient {
  const doFetch = deps.fetch ?? globalThis.fetch;
  const cfg = deps.config;
  const timeoutMs = cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  // baseUrl may or may not already end in /responses (mirror openclaw normalize).
  const url = cfg.baseUrl.endsWith("/responses")
    ? cfg.baseUrl
    : `${cfg.baseUrl.replace(/\/$/, "")}/responses`;

  if (cfg.getAuthHeader === undefined) {
    throw new Error("codex responses client requires `getAuthHeader`");
  }
  const getAuthHeader = cfg.getAuthHeader;

  async function headers(): Promise<Record<string, string>> {
    const auth = await getAuthHeader();
    const token = auth.replace(/^Bearer /, "");
    const h: Record<string, string> = {
      "Content-Type": "application/json",
      accept: "text/event-stream",
      Authorization: `Bearer ${token}`,
      "chatgpt-account-id": codexAccountIdFromToken(token),
      originator: ORIGINATOR,
      "User-Agent": cfg.userAgent ?? DEFAULT_USER_AGENT,
      "OpenAI-Beta": "responses=experimental",
    };
    // The official Codex client carries a stable session id on both headers; reuse
    // ours (per-account-stable) so the backend recognizes a coherent session.
    if (cfg.sessionId) {
      h.session_id = cfg.sessionId;
      h["x-client-request-id"] = cfg.sessionId;
    }
    return h;
  }

  function scrub(raw: unknown): unknown {
    if (raw === null) return raw;
    const secrets = cfg.currentSecrets ? cfg.currentSecrets() : [];
    const replace = (value: string): { value: string; changed: boolean } => {
      let v = value;
      let changed = false;
      for (const s of secrets) {
        if (s.length < 4) continue;
        if (v.includes(s)) {
          v = v.split(s).join("[redacted]");
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

  async function request(input: NativePassthroughInput, external?: AbortSignal): Promise<Response> {
    const providerHeaders = await headers();
    if (isNativePassthroughCarrier(input) && cfg.userAgent === undefined) {
      const hasClientUserAgent = Object.keys(input.headers).some(
        (name) => name.toLowerCase() === "user-agent",
      );
      if (hasClientUserAgent) delete providerHeaders["User-Agent"];
    }
    const prepared = prepareNativePassthroughRequest(input, providerHeaders, {
      mergeHeaders: ["openai-beta"],
    });
    const t = withTimeout(timeoutMs, external);
    try {
      return await doFetch(url, {
        method: "POST",
        headers: prepared.headers,
        body: prepared.bodyText,
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

  // Scrape the upstream rate-limit window headers (providers page Tier 3) the moment
  // the response resolves — headers are available before any SSE chunk is read, so
  // this never buffers or perturbs the streamed body (Principle 8). Fail-open: a
  // throwing hook is swallowed (a quota-scrape must never break a served request).
  function fireResponseMeta(res: Response): void {
    if (!cfg.onResponseMeta) return;
    try {
      cfg.onResponseMeta(res.headers);
    } catch {
      /* fail-open: quota observability never breaks the request */
    }
  }

  async function requestWithRetry(
    body: NativePassthroughInput,
    external?: AbortSignal,
  ): Promise<Response> {
    const res = await request(body, external);
    if (res.status === 401 && cfg.onUnauthorized !== undefined) {
      await res.body?.cancel().catch(() => {});
      cfg.onUnauthorized();
      const retried = await request(body, external);
      fireResponseMeta(retried);
      return retried;
    }
    fireResponseMeta(res);
    return res;
  }

  async function errorFromResponse(res: Response): Promise<UpstreamError> {
    const providerRaw = await res
      .text()
      .then((t) => {
        try {
          return JSON.parse(t);
        } catch {
          return t;
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

  return {
    async chatCompletion(req, opts) {
      const model = String((req as Record<string, unknown>).model ?? "");
      const res = await requestWithRetry(
        openaiToResponsesRequest(req, { sessionId: cfg.sessionId }),
        opts?.signal,
      );
      if (!res.ok) throw await errorFromResponse(res);
      // Codex is stream-only → aggregate the SSE into a single Chat response.
      return await aggregateResponsesStream(res, model, timeoutMs);
    },

    async *chatCompletionStream(req, opts) {
      const model = String((req as Record<string, unknown>).model ?? "");
      const res = await requestWithRetry(
        openaiToResponsesRequest(req, { sessionId: cfg.sessionId }),
        opts?.signal,
      );
      if (!res.ok) throw await errorFromResponse(res);
      yield* translateResponsesSSE(res, model, timeoutMs);
    },

    // Native protocol passthrough (issue #217, Phase 3): the inbound /v1/responses body
    // is ALREADY a native Responses body (the real Codex CLI supplies store:false +
    // stream:true + include + reasoning + tools …), so forward it VERBATIM and return the
    // upstream's native JSON untranslated. Reuses the same HTTP core (headers/withTimeout/
    // 401-retry/scrub/errorFromResponse/onResponseMeta) but SKIPS both translators —
    // `openaiToResponsesRequest` (no instructions/input rewrite, no store/include
    // injection) and `aggregateResponsesStream` (no Responses→Chat folding). The ChatGPT
    // identity headers (Bearer + chatgpt-account-id + originator + OpenAI-Beta) are applied
    // by `headers()` inside the shared core, so they ride on the native body unchanged.
    async nativePassthrough(body, opts) {
      const res = await requestWithRetry(body, opts?.signal);
      if (!res.ok) throw await errorFromResponse(res);
      return (await res.json()) as Record<string, unknown>;
    },

    // Streaming native passthrough (issue #217, Phase 3). The native body from a STREAMING
    // /v1/responses client ALREADY carries `stream:true`, so it is forwarded VERBATIM — NO
    // `stream:true` injection, NO `openaiToResponsesRequest` translation. The 401-retry /
    // non-2xx error path runs BEFORE the first chunk (same as chatCompletionStream), then
    // the upstream Responses SSE is BYTE-RELAYED unchanged via readResponsesSSERaw — no SSE
    // re-mapping state machine to mangle reasoning.encrypted_content / tools (principle 8).
    async *nativePassthroughStream(body, opts) {
      const res = await requestWithRetry(body, opts?.signal);
      if (!res.ok) throw await errorFromResponse(res);
      yield* readResponsesSSERaw(res, timeoutMs);
    },
  };
}

// ── low-level SSE event reader (shared by stream + aggregate) ─────────────────

function parseResponsesSSEFrame(raw: string): Record<string, unknown> | null {
  let eventName = "";
  const dataLines: string[] = [];
  for (const line of raw.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n")) {
    if (line === "" || line.startsWith(":")) continue;
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") eventName = value;
    else if (field === "data") dataLines.push(value);
  }

  const payload = dataLines.join("\n");
  const trimmed = payload.trim();
  if (trimmed === "" || trimmed === "[DONE]") return null;
  try {
    const parsed = JSON.parse(payload) as unknown;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const evt = parsed as Record<string, unknown>;
    if (typeof evt.type !== "string" && eventName !== "") return { ...evt, type: eventName };
    return evt;
  } catch {
    // skip malformed event
    return null;
  }
}

function splitCompleteSSEFrames(buffer: string): { frames: string[]; tail: string } {
  const normalized = buffer.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const parts = normalized.split("\n\n");
  const tail = parts.pop() ?? "";
  return { frames: parts, tail };
}

export async function* readResponsesEvents(
  res: Response,
  // Inter-chunk liveness deadline (ms); 0 disables. Threaded from the client's
  // request timeout so a wedged mid-stream upstream is reclaimed, not hung
  // (connect/TTFB timeout was already cleared at headers).
  idleMs = 0,
): AsyncGenerator<Record<string, unknown>> {
  const body = res.body;
  if (!body) return;
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      let read: { done: boolean; value?: Uint8Array };
      try {
        read = await readChunkWithIdle(reader, idleMs);
      } catch (err) {
        if (err instanceof StreamStalledError) throw new UpstreamError("timeout", err.message);
        throw err;
      }
      const { done, value } = read;
      if (done) {
        buffer += decoder.decode();
        if (buffer.trim() !== "") {
          const evt = parseResponsesSSEFrame(buffer);
          if (evt !== null) yield evt;
        }
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      const { frames, tail } = splitCompleteSSEFrames(buffer);
      buffer = tail;
      for (const raw of frames) {
        const evt = parseResponsesSSEFrame(raw);
        if (evt !== null) yield evt;
      }
    }
  } finally {
    reader.releaseLock();
  }
}

// Byte-faithful Responses SSE reader for native passthrough (issue #217, Phase 3).
// Yields the upstream body's decoded text VERBATIM using the SAME reader pattern as
// readResponsesEvents (getReader + TextDecoder + readChunkWithIdle idle guard +
// StreamStalledError → UpstreamError("timeout")), but with NO frame splitting and NO
// translation. The raw bytes (the `data:` JSON payload, INCLUDING reasoning.encrypted_content
// and the native tool-call events) reach the client untouched; only the standard SSE
// envelope is reframed downstream by Hono's writeSSE (semantically identical). This
// ELIMINATES the responses→IR(openai-chat)→responses round trip — the reasoning/tool
// mangling source — instead of replacing it.
export async function* readResponsesSSERaw(
  res: Response,
  // Inter-chunk liveness deadline (ms); 0 disables. Threaded from the client's request
  // timeout so a stream that wedges mid-flight is reclaimed (the connect/TTFB timeout was
  // already cleared once headers arrived). Identical semantics to readResponsesEvents.
  idleMs = 0,
): AsyncGenerator<string> {
  const body = res.body;
  if (!body) return;
  const reader = body.getReader();
  const decoder = new TextDecoder();
  try {
    while (true) {
      let read: { done: boolean; value?: Uint8Array };
      try {
        read = await readChunkWithIdle(reader, idleMs);
      } catch (err) {
        if (err instanceof StreamStalledError) throw new UpstreamError("timeout", err.message);
        throw err;
      }
      const { done, value } = read;
      if (done) break;
      if (value) yield decoder.decode(value, { stream: true });
    }
  } finally {
    reader.releaseLock();
  }
}

// ── streaming translation: Responses SSE -> OpenAI-Chat SSE strings ──────────

function openaiChunk(model: string, delta: Record<string, unknown>, finish: string | null): string {
  const chunk = {
    id: `chatcmpl-${Date.now()}`,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta, finish_reason: finish }],
  };
  return `data: ${JSON.stringify(chunk)}\n\n`;
}

// include_usage terminal chunk (OpenAI convention: empty choices + usage). The
// Responses API reports usage as input_tokens/output_tokens on response.completed.
function openaiUsageChunk(model: string, usage: Record<string, unknown>): string {
  const input = typeof usage.input_tokens === "number" ? usage.input_tokens : 0;
  const output = typeof usage.output_tokens === "number" ? usage.output_tokens : 0;
  const details = (usage.input_tokens_details ?? {}) as Record<string, unknown>;
  const cached = typeof details.cached_tokens === "number" ? details.cached_tokens : 0;
  const cacheCreation =
    typeof details.cache_creation_input_tokens === "number"
      ? details.cache_creation_input_tokens
      : 0;
  const outDetails = (usage.output_tokens_details ?? {}) as Record<string, unknown>;
  const reasoning =
    typeof outDetails.reasoning_tokens === "number" ? outDetails.reasoning_tokens : undefined;
  const chunk = {
    id: `chatcmpl-${Date.now()}`,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [] as never[],
    usage: {
      prompt_tokens: input,
      completion_tokens: output,
      total_tokens: input + output,
      ...(cached > 0 || cacheCreation > 0
        ? {
            prompt_tokens_details: {
              cached_tokens: cached,
              ...(cacheCreation > 0 ? { cache_creation_tokens: cacheCreation } : {}),
            },
          }
        : {}),
      ...(reasoning !== undefined
        ? { completion_tokens_details: { reasoning_tokens: reasoning } }
        : {}),
    },
  };
  return `data: ${JSON.stringify(chunk)}\n\n`;
}

export async function* translateResponsesSSE(
  res: Response,
  model: string,
  idleMs = 0,
): AsyncGenerator<string> {
  let started = false;
  let toolIndex = -1;
  let hadToolCall = false;
  let status: unknown = "completed";
  for await (const evt of readResponsesEvents(res, idleMs)) {
    const type = evt.type;
    if (!started) {
      started = true;
      yield openaiChunk(model, { role: "assistant", content: "" }, null);
    }
    if (type === "response.output_item.added") {
      const item = (evt.item ?? {}) as Record<string, unknown>;
      if (item.type === "function_call") {
        hadToolCall = true;
        toolIndex += 1;
        yield openaiChunk(
          model,
          {
            tool_calls: [
              {
                index: toolIndex,
                id: String(item.call_id ?? ""),
                type: "function",
                function: { name: String(item.name ?? ""), arguments: "" },
              },
            ],
          },
          null,
        );
      }
    } else if (type === "response.output_text.delta") {
      if (typeof evt.delta === "string") yield openaiChunk(model, { content: evt.delta }, null);
    } else if (typeof type === "string" && RESPONSES_REASONING_DELTA_TYPES.has(type)) {
      if (typeof evt.delta === "string") {
        yield openaiChunk(model, { reasoning_content: evt.delta }, null);
      }
    } else if (type === "response.function_call_arguments.delta") {
      if (typeof evt.delta === "string") {
        yield openaiChunk(
          model,
          { tool_calls: [{ index: Math.max(0, toolIndex), function: { arguments: evt.delta } }] },
          null,
        );
      }
    } else if (type === "response.completed" || type === "response.incomplete") {
      // response.incomplete is terminal too (max_output_tokens / content filter); it
      // carries the same response object (status + usage) and must finalize cleanly.
      const response = (evt.response ?? {}) as Record<string, unknown>;
      status = response.status ?? (type === "response.incomplete" ? "incomplete" : "completed");
      yield openaiChunk(model, {}, finishReason(status, hadToolCall));
      // include_usage terminal frame before [DONE] (order 14).
      const usage = (response.usage ?? {}) as Record<string, unknown>;
      yield openaiUsageChunk(model, usage);
      yield "data: [DONE]\n\n";
      return;
    } else if (type === "error" || type === "response.failed") {
      const msg =
        typeof evt.message === "string"
          ? evt.message
          : (
              (((evt.response ?? {}) as Record<string, unknown>).error ?? {}) as {
                message?: string;
              }
            ).message;
      throw new UpstreamError("upstream_error", msg || "codex responses stream error");
    }
  }
  // Stream ended without an explicit response.completed → close cleanly.
  if (started) {
    yield openaiChunk(model, {}, finishReason(status, hadToolCall));
    yield "data: [DONE]\n\n";
  }
}

// ── aggregation: Responses SSE -> a single OpenAI-Chat response (non-stream) ──

export async function aggregateResponsesStream(
  res: Response,
  model: string,
  idleMs = 0,
): Promise<ChatCompletionResponse> {
  let text = "";
  let id = `chatcmpl-${Date.now()}`;
  let status: unknown = "completed";
  let inTok = 0;
  let outTok = 0;
  let cacheRead = 0;
  let cacheCreation = 0;
  let reasoning = "";
  // call_id -> accumulated arguments, preserving first-seen order.
  const toolOrder: string[] = [];
  const toolById = new Map<string, { id: string; name: string; arguments: string }>();
  let currentCallId = "";

  for await (const evt of readResponsesEvents(res, idleMs)) {
    const type = evt.type;
    if (type === "response.created") {
      const response = (evt.response ?? {}) as Record<string, unknown>;
      if (typeof response.id === "string") id = response.id;
    } else if (type === "response.output_item.added") {
      const item = (evt.item ?? {}) as Record<string, unknown>;
      if (item.type === "function_call") {
        currentCallId = String(item.call_id ?? "");
        if (!toolById.has(currentCallId)) {
          toolById.set(currentCallId, {
            id: currentCallId,
            name: String(item.name ?? ""),
            arguments: typeof item.arguments === "string" ? item.arguments : "",
          });
          toolOrder.push(currentCallId);
        }
      }
    } else if (type === "response.output_text.delta") {
      if (typeof evt.delta === "string") text += evt.delta;
    } else if (typeof type === "string" && RESPONSES_REASONING_DELTA_TYPES.has(type)) {
      if (typeof evt.delta === "string") reasoning += evt.delta;
    } else if (type === "response.function_call_arguments.delta") {
      const tc = toolById.get(currentCallId);
      if (tc && typeof evt.delta === "string") tc.arguments += evt.delta;
    } else if (type === "response.function_call_arguments.done") {
      const tc = toolById.get(currentCallId);
      if (tc && typeof evt.arguments === "string") tc.arguments = evt.arguments;
    } else if (type === "response.completed" || type === "response.incomplete") {
      // response.incomplete is terminal too (truncation / content filter): capture its
      // status + usage and stop, else the idle guard could turn it into a timeout.
      const response = (evt.response ?? {}) as Record<string, unknown>;
      status = response.status ?? (type === "response.incomplete" ? "incomplete" : "completed");
      const usage = (response.usage ?? {}) as Record<string, unknown>;
      if (typeof usage.input_tokens === "number") inTok = usage.input_tokens;
      if (typeof usage.output_tokens === "number") outTok = usage.output_tokens;
      const details = (usage.input_tokens_details ?? {}) as Record<string, unknown>;
      if (typeof details.cached_tokens === "number") cacheRead = details.cached_tokens;
      if (typeof details.cache_creation_input_tokens === "number")
        cacheCreation = details.cache_creation_input_tokens;
      // Terminal event: stop reading NOW so the idle guard cannot turn a completed
      // aggregation into a timeout if the upstream delays closing the body.
      break;
    } else if (type === "error" || type === "response.failed") {
      const msg =
        typeof evt.message === "string"
          ? evt.message
          : (
              (((evt.response ?? {}) as Record<string, unknown>).error ?? {}) as {
                message?: string;
              }
            ).message;
      throw new UpstreamError("upstream_error", msg || "codex responses stream error");
    }
  }

  const toolCalls = toolOrder.map((cid) => {
    const tc = toolById.get(cid) as { id: string; name: string; arguments: string };
    return {
      id: tc.id,
      type: "function",
      function: { name: tc.name, arguments: tc.arguments || "{}" },
    };
  });
  const message: Record<string, unknown> = { role: "assistant", content: text || null };
  if (reasoning !== "") message.reasoning_content = reasoning;
  if (toolCalls.length) message.tool_calls = toolCalls;
  return {
    id,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message, finish_reason: finishReason(status, toolCalls.length > 0) }],
    usage: {
      prompt_tokens: inTok,
      completion_tokens: outTok,
      total_tokens: inTok + outTok,
      ...(cacheRead > 0 || cacheCreation > 0
        ? {
            prompt_tokens_details: {
              cached_tokens: cacheRead,
              ...(cacheCreation > 0 ? { cache_creation_tokens: cacheCreation } : {}),
            },
          }
        : {}),
    },
  } as ChatCompletionResponse;
}
