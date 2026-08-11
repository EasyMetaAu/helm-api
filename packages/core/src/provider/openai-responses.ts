// Native OpenAI Responses executor (issue #38, Codex) — routes Helm's internal
// OpenAI-Chat IR to the ChatGPT Codex backend (`/backend-api/codex/responses`),
// used by ChatGPT Plus/Pro (Codex) SUBSCRIPTION (OAuth) providers. Implements the
// same ProviderClient interface as the OpenAI/Anthropic clients so dispatch by
// provider name is identical.
//
// Why a native executor (not the OpenAI Chat client): the Codex subscription
// endpoint speaks the OpenAI *Responses* protocol (a different request + SSE shape
// from Chat Completions), is stream-only, and requires ChatGPT identity headers.
// This executor carries the Chat-IR ⇄ Responses translation both ways.
//
// The `chatgpt-account-id` is NOT plumbed separately: the OAuth access token is a
// JWT carrying the `chatgpt_account_id` claim, so we decode it from the Bearer
// header at request time (always correct, even after a token refresh).
//
// ⚠️ ToS: reverse-engineered first-party Codex client; the operator opts in (issue
// #38 README disclaimer). Request/SSE shapes + identity ported from openclaw (MIT).

import { arch, platform, release } from "node:os";
import {
  appendMutationList,
  cloneCarrierWithBody,
  isNativePassthroughCarrier,
  type NativePassthroughInput,
} from "@helm/shared";
import { createSSEIncompleteFrameGuard } from "../protocol/streaming.js";
import {
  consumeResponseTextWithinBudget,
  ResponseBodyTooLargeError,
} from "../runtime/bounded-response.js";
import {
  type ResponseWorkAdmission,
  ResponseWorkCapacityError,
  runtimeResponseWorkAdmission,
} from "../runtime/response-work-admission.js";
import {
  type PreparedNativePassthroughRequest,
  prepareNativePassthroughRequest,
} from "./native-passthrough.js";
import type { CodexModelInfo } from "./oauth/codex-model-info.js";
import { resolveOpenAICodexModelAlias } from "./oauth/models.js";
import {
  type ChatCompletionRequest,
  type ChatCompletionResponse,
  type ProviderClient,
  type ProviderConfig,
  readUpstreamErrorBody,
  safeUpstreamHeaders,
  UPSTREAM_ERROR_BODY_MAX_BYTES,
  UpstreamError,
  upstreamTransportError,
} from "./openai.js";
import {
  isFetchTransportError,
  isTransientConnectionError,
  withConnectionRetry,
  withOverloadRetry,
} from "./retry.js";
import { readChunkWithIdle, StreamStalledError } from "./stream-idle.js";

export interface CodexResponsesClientConfig {
  baseUrl: string; // e.g. https://chatgpt.com/backend-api/codex (endpoint = baseUrl + /responses)
  getAuthHeader?: () => Promise<string>; // dynamic "Bearer <oauth-access>" (required)
  onUnauthorized?: () => void; // 401 hook -> force token refresh, replay once
  currentSecrets?: () => string[]; // live token set for redaction
  timeoutMs?: number;
  // Stable per-account session id (anti-ban / cache coherence). When set it rides on
  // the canonical `session-id` header and `prompt_cache_key` — the official Codex
  // client keys its prompt cache on a stable session, so reuse one per account rather
  // than minting a new one per request.
  sessionId?: string;
  // Optional request-scoped Codex thread identity. When present it rides on `thread-id`
  // and is also the fallback for `x-client-request-id`, matching Codex CLI.
  threadId?: string;
  // Overrides the default Codex-client User-Agent (openclaw proves a custom UA is
  // accepted by the backend; the real first-party value is not required).
  userAgent?: string;
  // Per-account Fast mode for ChatGPT/Codex subscription traffic. When enabled the
  // account forces OpenAI Responses `service_tier: "priority"` on every request it
  // serves, including native passthrough bodies that already supplied another tier.
  fastMode?: boolean;
  // Response-metadata hook (providers page Tier 3 quota). Invoked with the upstream
  // response Headers AS SOON AS they resolve — BEFORE any SSE chunk is read — so the
  // caller can scrape the `x-codex-*` rate-limit window headers without buffering or
  // perturbing the streamed body (Principle 8). MUST be cheap + non-throwing (the
  // caller wraps its own fail-open); a throw here is swallowed so it never breaks a
  // served request.
  onResponseMeta?: (headers: Headers) => void;
  // Account-scoped live model metadata. The caller owns refresh/cache policy; this
  // client only consumes the resolved request-contract capabilities.
  resolveModelInfo?: (
    model: string,
  ) => CodexModelInfo | undefined | Promise<CodexModelInfo | undefined>;
  // Codex returns X-Models-Etag on inference responses when the account catalog has
  // changed. The caller can force-refresh its model cache from this signal.
  onModelsEtag?: (etag: string) => void;
  // Persisted ChatGPT identity from the id_token/account manager. This is
  // authoritative when refreshed access tokens omit workspace/FedRAMP claims.
  getAccountIdentity?: () => { accountId?: string; isFedramp?: boolean };
  // Backward-compatible static FedRAMP identity.
  isFedramp?: boolean;
  // Transient-connection retry at the fetch boundary (provider/retry.ts). Optional —
  // omitted falls back to defaults (2 retries, [200,500] ms). Pre-first-byte, so the
  // retry is idempotent. See ProviderConfig for the rationale.
  connectRetries?: number;
  connectRetryBackoffMs?: readonly number[];
  // Optional native Responses-over-WebSocket transport. The gateway injects this
  // for ChatGPT subscription accounts; callers without a named ingress session
  // continue using the existing HTTP transport.
  responsesWebSocketConnector?: CodexResponsesWebSocketConnector;
}

export interface CodexResponsesClientDeps {
  config: CodexResponsesClientConfig;
  fetch?: typeof globalThis.fetch;
}

export interface GenericOpenAIResponsesClientDeps {
  config: ProviderConfig;
  fetch?: typeof globalThis.fetch;
  // Provider-neutral compatibility profile for Responses endpoints that only
  // accept SSE inference requests (for example a subscription-backed proxy).
  // Omitted by default, preserving the public OpenAI Responses contract.
  requestContract?: GenericOpenAIResponsesRequestContract;
}

export interface GenericOpenAIResponsesRequestHeaderContext {
  /** Final wire body after the request contract has applied its shims. */
  body: Record<string, unknown>;
  model: string;
  /** Exact provider Authorization value, or an empty string when unauthenticated. */
  authorization: string;
}

export interface GenericOpenAIResponsesModelRequestDefaults {
  streamToolCalls?: boolean;
  maxCompletionTokens?: number;
}

export interface GenericOpenAIResponsesRequestContract {
  forceSse?: boolean;
  forceStoreFalse?: boolean;
  // xAI's first-party Responses client always asks the proxy to return opaque
  // encrypted reasoning items so a full-history caller can replay them verbatim.
  ensureReasoningEncryptedContent?: boolean;
  // Some subscription proxies require a non-empty top-level instruction even for
  // otherwise-valid native Responses requests.
  ensureInstructions?: boolean;
  // A stream-only/store:false proxy cannot persist response ids for server-side
  // continuation. Reject deterministically before network I/O instead of surfacing
  // the proxy's eventual 404 as an all-providers-failed 502.
  rejectPreviousResponseId?: boolean;
  // Some providers accept only the Responses item sequence form; reject the
  // proven object form locally instead of sending a deterministic upstream 422.
  rejectObjectInput?: boolean;
  // Account-scoped model metadata discovered from the upstream catalog. The
  // resolver receives the final wire model; no provider-wide defaults are guessed.
  resolveModelRequestDefaults?: (
    model: string,
  ) => GenericOpenAIResponsesModelRequestDefaults | undefined;
  requestHeaders?: (
    context: GenericOpenAIResponsesRequestHeaderContext,
  ) => Record<string, string> | Promise<Record<string, string>>;
}

export const CODEX_RESPONSES_WEBSOCKET_SESSION_HEADER = "x-helm-codex-responses-websocket-session";

export interface CodexResponsesWebSocketConnectInput {
  url: string;
  headers: Record<string, string>;
  signal?: AbortSignal;
}

export interface CodexResponsesWebSocketReceivedMessage {
  text: string;
  release(): void;
}

export interface CodexResponsesWebSocketConnection {
  responseHeaders: Headers;
  send(text: string): Promise<void>;
  receive(): Promise<string | null>;
  receiveWithWork?(): Promise<CodexResponsesWebSocketReceivedMessage | null>;
  close(): Promise<void>;
}

export type CodexResponsesWebSocketConnector = (
  input: CodexResponsesWebSocketConnectInput,
) => Promise<CodexResponsesWebSocketConnection>;

export class CodexResponsesWebSocketConnectError extends Error {
  readonly status: number | null;
  readonly headers: Headers;
  readonly body: string;

  constructor(
    message: string,
    options: {
      status?: number | null;
      headers?: Headers;
      body?: string;
      cause?: unknown;
    } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "CodexResponsesWebSocketConnectError";
    this.status = options.status ?? null;
    this.headers = new Headers(options.headers);
    this.body = options.body ?? "";
  }
}

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_INSTRUCTIONS = "You are a helpful assistant.";
const ORIGINATOR = "codex_cli_rs";
const DEFAULT_CODEX_VERSION = "0.0.0";
const CODEX_FAST_SERVICE_TIER = "priority";
const RESPONSES_WEBSOCKET_BETA = "responses_websockets=2026-02-06";
const RESPONSES_LITE_HEADER = "x-openai-internal-codex-responses-lite";
const CODEX_TURN_METADATA_HEADER = "x-codex-turn-metadata";
const CODEX_TURN_STATE_HEADER = "x-codex-turn-state";
const MAX_CODEX_TURN_STATES = 128;

function responseBodyTooLargeUpstreamError(error: ResponseBodyTooLargeError): UpstreamError {
  return new UpstreamError("upstream_error", error.message, {
    error: { code: "response_body_too_large", limit_bytes: error.limitBytes },
  });
}

function responseWorkCapacityUpstreamError(error: ResponseWorkCapacityError): UpstreamError {
  return new UpstreamError("upstream_error", error.message, {
    error: { code: "response_work_capacity_exhausted", limit_bytes: error.capacityBytes },
  });
}

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

// IR/OpenAI content (array or string) -> native Responses content parts. Provider
// clients receive the normalized IR shape (`image`/`audio`/`document`), but direct
// unit callers and legacy paths may still carry Chat's `image_url`; support both.
function inputPartsFromContent(
  content: unknown,
  textType: "input_text" | "output_text" = "input_text",
): ResponsesContentPart[] {
  if (typeof content === "string") return content ? [{ type: textType, text: content }] : [];
  if (Array.isArray(content)) {
    return content.flatMap((part): ResponsesContentPart[] => {
      if (part && typeof part === "object") {
        const p = part as Record<string, unknown>;
        if (p.type === "text" && typeof p.text === "string")
          return [{ type: textType, text: p.text }];
        if ((p.type === "input_text" || p.type === "output_text") && typeof p.text === "string") {
          return [{ type: textType, text: p.text }];
        }
        if (p.type === "image_url" && p.image_url && typeof p.image_url === "object") {
          const urlVal = (p.image_url as Record<string, unknown>).url;
          if (typeof urlVal === "string") {
            const detail = (p.image_url as Record<string, unknown>).detail;
            return [
              {
                type: "input_image",
                image_url: urlVal,
                ...(typeof detail === "string" ? { detail } : {}),
              },
            ];
          }
        }
        if (p.type === "image" && typeof p.url === "string") {
          return [
            {
              type: "input_image",
              image_url: p.url,
              ...(typeof p.detail === "string" ? { detail: p.detail } : {}),
            },
          ];
        }
        if (p.type === "audio" && typeof p.data === "string" && typeof p.format === "string") {
          return [{ type: "input_audio", input_audio: { data: p.data, format: p.format } }];
        }
        if (p.type === "document") {
          const filename = typeof p.filename === "string" ? { filename: p.filename } : {};
          if (typeof p.fileId === "string") {
            return [{ type: "input_file", file_id: p.fileId, ...filename }];
          }
          if (typeof p.data === "string") {
            const mediaType =
              typeof p.mediaType === "string" ? p.mediaType : "application/octet-stream";
            return [
              {
                type: "input_file",
                ...filename,
                file_data: `data:${mediaType};base64,${p.data}`,
              },
            ];
          }
          if (typeof p.url === "string") {
            return [{ type: "input_file", file_url: p.url, ...filename }];
          }
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

function responsesToolOutput(content: unknown): string | ResponsesContentPart[] {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts = inputPartsFromContent(content, "input_text");
    return parts.length > 0 ? parts : "";
  }
  return JSON.stringify(content ?? "");
}

// The system prompt goes in the top-level `instructions`, NOT the input array. Join
// every system message (the Codex backend has no system-spoof requirement).
function buildInstructions(messages: Array<Record<string, unknown>>): string {
  const parts: string[] = [];
  for (const m of messages) {
    if (m.role === "system" || m.role === "developer") parts.push(plainText(m.content));
  }
  const joined = parts.filter((s) => s.length > 0).join("\n\n");
  return joined || DEFAULT_INSTRUCTIONS;
}

export type ResponsesInstructionsFix = "none" | "hoisted_from_input" | "defaulted";

function hasHeader(
  headers: Record<string, string | string[]> | undefined,
  name: string,
  expected?: string,
): boolean {
  if (!headers) return false;
  const value = Object.entries(headers).find(
    ([key]) => key.toLowerCase() === name.toLowerCase(),
  )?.[1];
  if (value === undefined) return false;
  const joined = Array.isArray(value) ? value.join(",") : value;
  return expected === undefined ? true : joined.toLowerCase() === expected.toLowerCase();
}

function bodyUsesResponsesLite(body: Record<string, unknown>): boolean {
  if (Array.isArray(body.input)) {
    const first = body.input[0];
    if (isRecord(first) && first.type === "additional_tools") return true;
  }
  return isRecord(body.reasoning) && body.reasoning.context === "all_turns";
}

// Legacy native clients need developer/system items hoisted. Responses Lite requires
// those same items to remain in `input`, so callers must pass the carrier headers or
// resolved model metadata when available.
export function hoistResponsesInstructions(
  body: Record<string, unknown>,
  opts?: {
    headers?: Record<string, string | string[]>;
    modelInfo?: CodexModelInfo;
  },
): {
  body: Record<string, unknown>;
  fix: ResponsesInstructionsFix;
} {
  if (
    opts?.modelInfo?.use_responses_lite === true ||
    hasHeader(opts?.headers, RESPONSES_LITE_HEADER, "true") ||
    bodyUsesResponsesLite(body)
  ) {
    return { body, fix: "none" };
  }
  // Already carries instructions → forward byte-for-byte (verbatim passthrough).
  if (typeof body.instructions === "string" && body.instructions.trim().length > 0) {
    return { body, fix: "none" };
  }
  const input = body.input;
  if (Array.isArray(input)) {
    const systemParts: string[] = [];
    const remaining: unknown[] = [];
    for (const item of input) {
      const role =
        item !== null && typeof item === "object" ? (item as { role?: unknown }).role : undefined;
      if (role === "system" || role === "developer") {
        const text = plainText((item as { content?: unknown }).content);
        if (text.length > 0) {
          // Hoist this item's text into instructions and drop it from input.
          systemParts.push(text);
          continue;
        }
      }
      remaining.push(item);
    }
    const joined = systemParts.join("\n\n");
    if (joined.length > 0) {
      return {
        body: { ...body, instructions: joined, input: remaining },
        fix: "hoisted_from_input",
      };
    }
  }
  // No system content anywhere (and instructions absent/empty): inject the default so
  // the Codex backend never receives an empty `instructions`.
  return { body: { ...body, instructions: DEFAULT_INSTRUCTIONS }, fix: "defaulted" };
}

export type CodexResponsesNativeBodyFix =
  | "empty_reasoning_items_dropped"
  | "input_item_references_stripped"
  | "max_output_tokens_removed"
  | "temperature_removed";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasNonEmptyArray(value: unknown): boolean {
  return Array.isArray(value) && value.length > 0;
}

function hasUsefulReasoningPayload(item: Record<string, unknown>): boolean {
  if (hasNonEmptyArray(item.summary)) return true;
  if (hasNonEmptyArray(item.content)) return true;
  const encrypted = item.encrypted_content;
  if (typeof encrypted === "string") return encrypted.length > 0;
  return encrypted !== undefined && encrypted !== null;
}

function sanitizeStoreFalseInputItems(input: unknown): {
  input: unknown;
  referencesStripped: boolean;
  emptyReasoningDropped: boolean;
} {
  if (!Array.isArray(input)) {
    return { input, referencesStripped: false, emptyReasoningDropped: false };
  }

  let referencesStripped = false;
  let emptyReasoningDropped = false;
  const next: unknown[] = [];
  for (const item of input) {
    if (!isRecord(item)) {
      next.push(item);
      continue;
    }
    const sanitized = { ...item };
    if ("id" in sanitized) {
      delete sanitized.id;
      referencesStripped = true;
    }
    if (sanitized.type === "reasoning" && !hasUsefulReasoningPayload(sanitized)) {
      emptyReasoningDropped = true;
      continue;
    }
    next.push(sanitized);
  }

  return { input: next, referencesStripped, emptyReasoningDropped };
}

// ChatGPT-account Codex Responses is stricter than the public OpenAI Responses API.
// It rejects max_output_tokens/temperature and store:false item IDs from prior
// responses. Keep this shim Codex-only; generic OpenAI Responses passthrough must
// remain byte-faithful.
export function sanitizeCodexResponsesNativeBody(body: Record<string, unknown>): {
  body: Record<string, unknown>;
  fixes: CodexResponsesNativeBodyFix[];
} {
  let next = body;
  const fixes = new Set<CodexResponsesNativeBodyFix>();
  const ensureCopy = (): Record<string, unknown> => {
    if (next === body) next = { ...body };
    return next;
  };

  if ("max_output_tokens" in next) {
    delete ensureCopy().max_output_tokens;
    fixes.add("max_output_tokens_removed");
  }
  if ("temperature" in next) {
    delete ensureCopy().temperature;
    fixes.add("temperature_removed");
  }
  if (next.store === false) {
    const sanitized = sanitizeStoreFalseInputItems(next.input);
    if (sanitized.referencesStripped || sanitized.emptyReasoningDropped) {
      ensureCopy().input = sanitized.input;
      if (sanitized.referencesStripped) fixes.add("input_item_references_stripped");
      if (sanitized.emptyReasoningDropped) fixes.add("empty_reasoning_items_dropped");
    }
  }

  return { body: next, fixes: [...fixes].sort() };
}

function toResponsesInput(
  messages: Array<Record<string, unknown>>,
  preserveInstructionRoles = false,
): ResponsesItem[] {
  const out: ResponsesItem[] = [];
  for (const m of messages) {
    const role = m.role;
    if (role === "system" || role === "developer") {
      if (preserveInstructionRoles) {
        out.push({
          type: "message",
          role,
          content: inputPartsFromContent(m.content),
        });
      }
      continue;
    }
    if (role === "tool") {
      out.push({
        type: "function_call_output",
        call_id: String(m.tool_call_id ?? ""),
        output: responsesToolOutput(m.content),
      });
      continue;
    }
    if (role === "assistant") {
      const translated = inputPartsFromContent(m.content, "output_text");
      const media = translated.filter((part) => part.type !== "output_text");
      const text = plainText(m.content);
      const content = [...(text.length > 0 ? [{ type: "output_text", text }] : []), ...media];
      if (content.length > 0) {
        out.push({
          type: "message",
          role: "assistant",
          content,
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

function responsesToolsFromChat(tools: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(tools)) return [];
  return (tools as Array<Record<string, unknown>>).flatMap((tool) => {
    const fn = (tool.function ?? {}) as Record<string, unknown>;
    if (!fn.name) return [];
    return [
      {
        type: "function",
        name: fn.name,
        description: fn.description ?? "",
        parameters: fn.parameters ?? { type: "object" },
        strict: typeof fn.strict === "boolean" ? fn.strict : false,
      },
    ];
  });
}

function responsesTextFromChatResponseFormat(responseFormat: unknown): unknown {
  if (!isRecord(responseFormat)) return undefined;
  if (responseFormat.type === "json_object") return { format: { type: "json_object" } };
  if (responseFormat.type !== "json_schema" || !isRecord(responseFormat.json_schema)) {
    return undefined;
  }
  const schema = responseFormat.json_schema;
  const format: Record<string, unknown> = { type: "json_schema" };
  if (typeof schema.name === "string") format.name = schema.name;
  if (typeof schema.description === "string") format.description = schema.description;
  if (schema.schema !== undefined) format.schema = schema.schema;
  if (typeof schema.strict === "boolean") format.strict = schema.strict;
  return { format };
}

function supportedReasoningEfforts(modelInfo: CodexModelInfo): string[] {
  return modelInfo.supported_reasoning_levels.flatMap((preset) =>
    typeof preset.effort === "string" ? [preset.effort] : [],
  );
}

function fallbackReasoningEffort(modelInfo: CodexModelInfo, supported: string[]): string | null {
  return (
    supported[Math.floor((supported.length - 1) / 2)] ?? modelInfo.default_reasoning_level ?? null
  );
}

function reasoningEffortForRequest(effort: string): string {
  return effort === "ultra" ? "max" : effort;
}

function buildCodexReasoning(
  request: Record<string, unknown>,
  modelInfo: CodexModelInfo | undefined,
): Record<string, unknown> | undefined {
  const preserved = isRecord(request.reasoning)
    ? request.reasoning
    : isRecord(request.reasoning_config)
      ? request.reasoning_config
      : {};
  const requested =
    typeof request.reasoning_effort === "string" && request.reasoning_effort.length > 0
      ? request.reasoning_effort
      : typeof preserved.effort === "string" && preserved.effort.length > 0
        ? preserved.effort
        : undefined;
  const requestedWire = requested !== undefined ? reasoningEffortForRequest(requested) : undefined;
  if (modelInfo === undefined) {
    return requestedWire !== undefined ? { effort: requestedWire } : undefined;
  }
  const supported = supportedReasoningEfforts(modelInfo);
  const effective =
    requestedWire !== undefined &&
    (supported.includes(requestedWire) ||
      (requested !== undefined && supported.includes(requested)))
      ? requestedWire
      : fallbackReasoningEffort(modelInfo, supported);
  const reasoning = {
    ...preserved,
    ...(typeof effective === "string" && effective.length > 0
      ? { effort: reasoningEffortForRequest(effective) }
      : {}),
    ...(modelInfo.supports_reasoning_summaries && modelInfo.default_reasoning_summary !== "none"
      ? { summary: modelInfo.default_reasoning_summary }
      : {}),
    ...(modelInfo.use_responses_lite ? { context: "all_turns" } : {}),
  };
  return Object.keys(reasoning).length > 0 ? reasoning : undefined;
}

function modelSupportsServiceTier(modelInfo: CodexModelInfo, tier: string): boolean {
  return modelInfo.service_tiers.some((candidate) => candidate.id === tier);
}

export function openaiToResponsesRequest(
  req: ChatCompletionRequest,
  opts?: { sessionId?: string; modelInfo?: CodexModelInfo },
): Record<string, unknown> {
  const r = req as Record<string, unknown>;
  const messages = Array.isArray(r.messages) ? (r.messages as Array<Record<string, unknown>>) : [];
  const modelInfo = opts?.modelInfo;
  const useResponsesLite = modelInfo?.use_responses_lite === true;
  const tools = Array.isArray(r.responses_tools)
    ? (r.responses_tools as Array<Record<string, unknown>>)
    : responsesToolsFromChat(r.tools);
  const instructions = buildInstructions(messages);
  const input = Array.isArray(r.responses_input_items)
    ? [...(r.responses_input_items as Array<Record<string, unknown>>)]
    : toResponsesInput(messages);
  if (useResponsesLite) {
    const first = input[0];
    if (!isRecord(first) || first.type !== "additional_tools") {
      input.unshift({
        type: "additional_tools",
        role: "developer",
        tools,
      });
    }
    const developer = input[1];
    if (instructions.length > 0 && (!isRecord(developer) || developer.role !== "developer")) {
      input.splice(1, 0, {
        type: "message",
        role: "developer",
        content: [{ type: "input_text", text: instructions }],
      });
    }
  }
  const reasoning = buildCodexReasoning(r, modelInfo);
  const requestedVerbosity =
    typeof r.verbosity === "string" && r.verbosity.length > 0 ? r.verbosity : undefined;
  const verbosity =
    modelInfo === undefined
      ? "low"
      : modelInfo.support_verbosity
        ? (requestedVerbosity ?? modelInfo.default_verbosity ?? undefined)
        : undefined;
  const body: Record<string, unknown> = {
    model: r.model,
    // Codex backend constraints (ported from openclaw's known-good body): store MUST
    // be false, stream MUST be true, and a store:false request MUST ask for the
    // encrypted reasoning back (omitting `include` is rejected by the ChatGPT-account
    // backend, surfaced misleadingly as "model not supported"). `text.verbosity` is
    // part of the Codex request contract too. NOTE: we deliberately send NO
    // `max_output_tokens` or `temperature` — openclaw omits them and the
    // ChatGPT-account backend rejects them.
    store: false,
    stream: true,
    input,
    ...(verbosity !== undefined ? { text: { verbosity } } : {}),
    include:
      modelInfo === undefined
        ? ["reasoning.encrypted_content"]
        : reasoning !== undefined
          ? ["reasoning.encrypted_content"]
          : [],
    tool_choice: "auto",
    parallel_tool_calls: useResponsesLite
      ? false
      : modelInfo === undefined
        ? true
        : modelInfo.supports_parallel_tool_calls && r.parallel_tool_calls !== false,
  };
  if (!useResponsesLite && instructions.length > 0) body.instructions = instructions;
  // Stable prompt cache key. Client-supplied keys preserve OpenAI/Codex cache
  // affinity; otherwise fall back to the per-account subscription session id.
  if (typeof r.prompt_cache_key === "string" && r.prompt_cache_key.length > 0)
    body.prompt_cache_key = r.prompt_cache_key;
  else if (opts?.sessionId) body.prompt_cache_key = opts.sessionId;
  if (typeof r.prompt_cache_retention === "string")
    body.prompt_cache_retention = r.prompt_cache_retention;
  if (r.prompt_cache_options !== undefined) body.prompt_cache_options = r.prompt_cache_options;
  if (reasoning !== undefined) body.reasoning = reasoning;
  if (
    modelInfo !== undefined &&
    typeof r.service_tier === "string" &&
    r.service_tier !== "default" &&
    modelSupportsServiceTier(modelInfo, r.service_tier)
  ) {
    body.service_tier = r.service_tier;
  }
  if (r.tool_choice !== undefined) body.tool_choice = chatToolChoiceToResponses(r.tool_choice);
  if (!useResponsesLite && tools.length > 0) body.tools = tools;
  return body;
}

export function openaiToGenericResponsesRequest(
  req: ChatCompletionRequest,
): Record<string, unknown> {
  const r = req as Record<string, unknown>;
  const messages = Array.isArray(r.messages) ? (r.messages as Array<Record<string, unknown>>) : [];
  const body: Record<string, unknown> = {
    model: r.model,
    // Generic Responses supports native system/developer input roles. Keep those
    // roles intact instead of flattening their priority into one instruction string;
    // the xAI Composer proxy demonstrably follows the native role item but may let a
    // conflicting user message override the same text when sent only at top level.
    instructions: DEFAULT_INSTRUCTIONS,
    input: toResponsesInput(messages, true),
  };
  if (r.stream === true) body.stream = true;
  const maxOutput = r.max_output_tokens ?? r.max_completion_tokens ?? r.max_tokens;
  if (typeof maxOutput === "number") body.max_output_tokens = maxOutput;
  if (typeof r.temperature === "number") body.temperature = r.temperature;
  if (typeof r.top_p === "number") body.top_p = r.top_p;
  if (typeof r.reasoning_effort === "string" && r.reasoning_effort.length > 0) {
    body.reasoning = { effort: r.reasoning_effort };
  }
  // A Responses-origin request keeps its native `text` object in the flattened
  // fallback body. Prefer that lossless shape over a synthesized Chat format.
  const text =
    r.text !== undefined ? r.text : responsesTextFromChatResponseFormat(r.response_format);
  if (text !== undefined) body.text = text;
  if (typeof r.parallel_tool_calls === "boolean") {
    body.parallel_tool_calls = r.parallel_tool_calls;
  }
  // Responses-only continuation/control fields are flattened back onto the Chat IR
  // before provider execution when native passthrough is disabled. Re-emit them so
  // the fallback path does not silently break stateful turns.
  if (typeof r.previous_response_id === "string") {
    body.previous_response_id = r.previous_response_id;
  }
  if (Array.isArray(r.include)) body.include = r.include;
  if (isRecord(r.metadata)) body.metadata = r.metadata;
  if (r.truncation === "auto" || r.truncation === "disabled") body.truncation = r.truncation;
  if (typeof r.store === "boolean") body.store = r.store;
  if (r.context_management !== undefined) body.context_management = r.context_management;
  if (typeof r.background === "boolean") body.background = r.background;
  if (r.prompt_cache_options !== undefined) body.prompt_cache_options = r.prompt_cache_options;
  if (isRecord(r.logit_bias)) body.logit_bias = r.logit_bias;
  if (r.tool_choice !== undefined) body.tool_choice = chatToolChoiceToResponses(r.tool_choice);
  const tools = responsesToolsFromChat(r.tools);
  if (tools.length > 0) body.tools = tools;
  return body;
}

function responsesJsonToChatResponse(
  response: Record<string, unknown>,
  model: string,
): ChatCompletionResponse {
  const output = Array.isArray(response.output) ? response.output : [];
  const text = output
    .flatMap((item) => {
      if (item === null || typeof item !== "object") return [];
      const content = (item as { content?: unknown }).content;
      if (!Array.isArray(content)) return [];
      return content.flatMap((part) =>
        part !== null &&
        typeof part === "object" &&
        typeof (part as { text?: unknown }).text === "string"
          ? [(part as { text: string }).text]
          : [],
      );
    })
    .join("");
  // Responses `function_call` output items → OpenAI chat `tool_calls` so a
  // cross-protocol (chat→generic-responses) caller still sees the tool invocation
  // instead of silently losing it. Mirrors the streaming aggregator's mapping.
  const toolCalls = output.flatMap((item) => {
    if (item === null || typeof item !== "object") return [];
    const it = item as Record<string, unknown>;
    if (it.type !== "function_call") return [];
    const name = typeof it.name === "string" ? it.name : undefined;
    if (name === undefined) return [];
    const callId =
      typeof it.call_id === "string" ? it.call_id : typeof it.id === "string" ? it.id : name;
    const args =
      typeof it.arguments === "string" ? it.arguments : JSON.stringify(it.arguments ?? {});
    return [{ id: callId, type: "function", function: { name, arguments: args } }];
  });
  const usage = response.usage && typeof response.usage === "object" ? response.usage : {};
  const inputTokens =
    typeof (usage as { input_tokens?: unknown }).input_tokens === "number"
      ? ((usage as { input_tokens: number }).input_tokens ?? 0)
      : 0;
  const outputTokens =
    typeof (usage as { output_tokens?: unknown }).output_tokens === "number"
      ? ((usage as { output_tokens: number }).output_tokens ?? 0)
      : 0;
  // OpenAI convention: content is null (not "") when the turn is purely tool calls.
  const message: Record<string, unknown> = {
    role: "assistant",
    content: text.length > 0 ? text : toolCalls.length > 0 ? null : "",
    ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
  };
  return {
    id: typeof response.id === "string" ? response.id : `chatcmpl-${Date.now()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message, finish_reason: toolCalls.length > 0 ? "tool_calls" : "stop" }],
    usage: {
      prompt_tokens: inputTokens,
      completion_tokens: outputTokens,
      total_tokens: inputTokens + outputTokens,
    },
  };
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

function sanitizeUserAgentToken(value: string | undefined): string {
  const sanitized = (value ?? "").trim().replace(/[^A-Za-z0-9!#$%&'*+\-.^_`|~/:]/g, "_");
  return sanitized.length > 0 ? sanitized : "unknown";
}

function sanitizeUserAgentComment(value: string): string {
  const sanitized = [...value.trim()]
    .map((char) => {
      const code = char.charCodeAt(0);
      return code <= 0x1f || code === 0x7f || char === "(" || char === ")" || char === "\\"
        ? "_"
        : char;
    })
    .join("");
  return sanitized.length > 0 ? sanitized : "unknown";
}

function codexOsType(): string {
  switch (platform()) {
    case "darwin":
      return "Mac OS";
    case "win32":
      return "Windows";
    case "linux":
      return "Linux";
    default:
      return platform();
  }
}

function terminalUserAgentToken(): string {
  const program = process.env.TERM_PROGRAM?.trim();
  if (program) {
    const version = process.env.TERM_PROGRAM_VERSION?.trim();
    return sanitizeUserAgentToken(version ? `${program}/${version}` : program);
  }
  return sanitizeUserAgentToken(process.env.TERM);
}

function buildDefaultCodexUserAgent(originator: string, version: string): string {
  return `${sanitizeUserAgentToken(originator)}/${sanitizeUserAgentToken(version)} (${sanitizeUserAgentComment(codexOsType())} ${sanitizeUserAgentComment(release())}; ${sanitizeUserAgentComment(arch())}) ${terminalUserAgentToken()}`;
}

function codexUserAgent(configured: string | undefined): string {
  if (
    configured !== undefined &&
    /^[^/\s]+\/[^\s(]+ \(.+ .+; .+\) \S+(?: .*)?$/.test(configured) &&
    !/\snode\/v?\S+/i.test(configured)
  ) {
    return configured;
  }
  const match = /^([^/\s]+)\/([^\s(]+)/.exec(configured ?? "");
  return buildDefaultCodexUserAgent(match?.[1] ?? ORIGINATOR, match?.[2] ?? DEFAULT_CODEX_VERSION);
}

function codexVersion(configuredUserAgent: string | undefined): string {
  return /^([^/\s]+)\/([^\s(]+)/.exec(configuredUserAgent ?? "")?.[2] ?? DEFAULT_CODEX_VERSION;
}

function withCodexServiceTier(
  input: NativePassthroughInput,
  fastMode: boolean,
  modelInfo: CodexModelInfo | undefined,
): NativePassthroughInput {
  const body = isNativePassthroughCarrier(input) ? input.body : input;
  let nextTier = body.service_tier;
  if (modelInfo === undefined) {
    if (!fastMode) return input;
    nextTier = CODEX_FAST_SERVICE_TIER;
  } else if (fastMode && modelSupportsServiceTier(modelInfo, CODEX_FAST_SERVICE_TIER)) {
    nextTier = CODEX_FAST_SERVICE_TIER;
  } else if (
    typeof nextTier === "string" &&
    (nextTier === "default" || !modelSupportsServiceTier(modelInfo, nextTier))
  ) {
    nextTier = undefined;
  }
  if (nextTier === body.service_tier) return input;
  const next = { ...body };
  if (typeof nextTier === "string") next.service_tier = nextTier;
  else delete next.service_tier;
  if (!isNativePassthroughCarrier(input)) return next;
  const carrier = cloneCarrierWithBody(input, next);
  appendMutationList(carrier.mutations, "body_shims_applied", [
    nextTier === CODEX_FAST_SERVICE_TIER ? "codex_fast_mode" : "unsupported_service_tier_removed",
  ]);
  return carrier;
}

function stripNativePassthroughHeader(
  input: NativePassthroughInput,
  headerName: string,
): NativePassthroughInput {
  if (!isNativePassthroughCarrier(input)) return input;
  const nextHeaders = Object.fromEntries(
    Object.entries(input.headers).filter(
      ([name]) => name.toLowerCase() !== headerName.toLowerCase(),
    ),
  );
  if (Object.keys(nextHeaders).length === Object.keys(input.headers).length) return input;
  appendMutationList(input.mutations, "headers_dropped", [headerName.toLowerCase()]);
  return { ...input, headers: nextHeaders };
}

function nativeInputModel(input: NativePassthroughInput): string {
  const body = isNativePassthroughCarrier(input) ? input.body : input;
  return typeof body.model === "string" ? body.model : "";
}

function nativeInputUsesResponsesLite(
  input: NativePassthroughInput,
  modelInfo: CodexModelInfo | undefined,
): boolean {
  if (modelInfo?.use_responses_lite === true) return true;
  if (isNativePassthroughCarrier(input)) {
    if (hasHeader(input.headers, RESPONSES_LITE_HEADER, "true")) return true;
    return bodyUsesResponsesLite(input.body);
  }
  return bodyUsesResponsesLite(input);
}

function stripResponsesLiteImageDetails(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripResponsesLiteImageDetails);
  if (!isRecord(value)) return value;
  const next = Object.fromEntries(
    Object.entries(value).map(([key, child]) => [key, stripResponsesLiteImageDetails(child)]),
  );
  if (next.type === "input_image") delete next.detail;
  return next;
}

function canonicalizeCodexNativeInput(
  input: NativePassthroughInput,
  modelInfo: CodexModelInfo | undefined,
  forceStore: boolean,
): NativePassthroughInput {
  const body = isNativePassthroughCarrier(input) ? input.body : input;
  const useResponsesLite = nativeInputUsesResponsesLite(input, modelInfo);
  const next: Record<string, unknown> = {
    ...body,
    model: typeof body.model === "string" ? resolveOpenAICodexModelAlias(body.model) : body.model,
    ...(forceStore ? { store: false } : {}),
  };
  if (!forceStore) delete next.store;
  const originalInput = Array.isArray(body.input) ? body.input : [];

  if (useResponsesLite) {
    const isIncrementalContinuation =
      typeof body.previous_response_id === "string" && body.previous_response_id.length > 0;
    if (isIncrementalContinuation) {
      // Codex WebSocket v2 already compressed this request against the previous
      // response. Re-inserting the Lite prefix here corrupts the delta
      // (`additional_tools` must only appear in the full request baseline).
      next.input = stripResponsesLiteImageDetails(originalInput);
      next.parallel_tool_calls = false;
      if (isRecord(next.reasoning)) {
        next.reasoning = { ...next.reasoning, context: "all_turns" };
      }
      if (JSON.stringify(next) === JSON.stringify(body)) return input;
      if (!isNativePassthroughCarrier(input)) return next;
      const carrier = cloneCarrierWithBody(input, next);
      appendMutationList(carrier.mutations, "body_shims_applied", [
        "codex_native_request_canonicalized",
      ]);
      return carrier;
    }
    const first = originalInput[0];
    const alreadyHasAdditionalTools = isRecord(first) && first.type === "additional_tools";
    const tools = Array.isArray(body.tools)
      ? body.tools
      : alreadyHasAdditionalTools && Array.isArray(first.tools)
        ? first.tools
        : [];
    const liteInput = alreadyHasAdditionalTools
      ? [...originalInput]
      : [{ type: "additional_tools", role: "developer", tools }, ...originalInput];
    const instructions =
      typeof body.instructions === "string" && body.instructions.length > 0
        ? body.instructions
        : "";
    if (instructions.length > 0) {
      liteInput.splice(alreadyHasAdditionalTools ? 1 : 1, 0, {
        type: "message",
        role: "developer",
        content: [{ type: "input_text", text: instructions }],
      });
    }
    next.input = stripResponsesLiteImageDetails(liteInput);
    next.parallel_tool_calls = false;
    delete next.instructions;
    delete next.tools;
    if (isRecord(next.reasoning)) {
      next.reasoning = { ...next.reasoning, context: "all_turns" };
    }
  } else {
    const first = originalInput[0];
    if (isRecord(first) && first.type === "additional_tools") {
      const remaining = originalInput.slice(1);
      if (!Array.isArray(next.tools) && Array.isArray(first.tools)) next.tools = first.tools;
      const developer = remaining[0];
      if (
        (typeof next.instructions !== "string" || next.instructions.length === 0) &&
        isRecord(developer) &&
        developer.role === "developer"
      ) {
        const text = plainText(developer.content);
        if (text.length > 0) {
          next.instructions = text;
          remaining.shift();
        }
      }
      next.input = remaining;
    }
    if (next.instructions === "") delete next.instructions;
    if (modelInfo?.supports_parallel_tool_calls === false) next.parallel_tool_calls = false;
  }

  if (JSON.stringify(next) === JSON.stringify(body)) return input;
  if (!isNativePassthroughCarrier(input)) return next;
  const carrier = cloneCarrierWithBody(input, next);
  appendMutationList(carrier.mutations, "body_shims_applied", [
    "codex_native_request_canonicalized",
  ]);
  return carrier;
}

export function createCodexResponsesClient(deps: CodexResponsesClientDeps): ProviderClient {
  const doFetch = deps.fetch ?? globalThis.fetch;
  const cfg = deps.config;
  const timeoutMs = cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  // baseUrl may or may not already end in /responses (mirror openclaw normalize).
  const url = cfg.baseUrl.endsWith("/responses")
    ? cfg.baseUrl
    : `${cfg.baseUrl.replace(/\/$/, "")}/responses`;
  const compactUrl = `${url}/compact`;
  const turnStates = new Map<string, string>();
  const websocketMetadataFired = new WeakSet<CodexResponsesWebSocketConnection>();
  const websocketHttpFallbackSessions = new Set<string>();
  const websocketSessions = new Map<
    string,
    {
      connection: Promise<CodexResponsesWebSocketConnection>;
      tail: Promise<void>;
    }
  >();

  if (cfg.getAuthHeader === undefined) {
    throw new Error("codex responses client requires `getAuthHeader`");
  }
  const getAuthHeader = cfg.getAuthHeader;

  function nativeHeader(input: NativePassthroughInput, name: string): string | undefined {
    if (!isNativePassthroughCarrier(input)) return undefined;
    const target = name.toLowerCase();
    for (const [key, value] of Object.entries(input.headers)) {
      if (key.toLowerCase() !== target) continue;
      const normalized = Array.isArray(value) ? value.join(", ") : value;
      return normalized.length > 0 ? normalized : undefined;
    }
    return undefined;
  }

  function rememberTurnState(turnKey: string | undefined, state: string | undefined): void {
    if (!turnKey || !state || turnStates.has(turnKey)) return;
    if (turnStates.size >= MAX_CODEX_TURN_STATES) {
      const oldest = turnStates.keys().next().value;
      if (oldest !== undefined) turnStates.delete(oldest);
    }
    turnStates.set(turnKey, state);
  }

  async function resolveModelInfo(model: string): Promise<CodexModelInfo | undefined> {
    if (!cfg.resolveModelInfo || model.length === 0) return undefined;
    try {
      return await cfg.resolveModelInfo(model);
    } catch {
      return undefined;
    }
  }

  async function headers(
    useResponsesLite: boolean,
    accept: "application/json" | "text/event-stream",
  ): Promise<Record<string, string>> {
    const auth = await getAuthHeader();
    const token = auth.replace(/^Bearer /, "");
    const persistedIdentity = cfg.getAccountIdentity?.() ?? {};
    const accountId = persistedIdentity.accountId ?? codexAccountIdFromToken(token);
    const isFedramp = persistedIdentity.isFedramp ?? cfg.isFedramp;
    const h: Record<string, string> = {
      "Content-Type": "application/json",
      accept,
      Authorization: `Bearer ${token}`,
      originator: ORIGINATOR,
      "User-Agent": codexUserAgent(cfg.userAgent),
      version: codexVersion(cfg.userAgent),
      ...(accountId.length > 0 ? { "chatgpt-account-id": accountId } : {}),
      ...(isFedramp === true ? { "X-OpenAI-Fedramp": "true" } : {}),
      ...(useResponsesLite ? { [RESPONSES_LITE_HEADER]: "true" } : {}),
    };
    if (cfg.sessionId) {
      h["session-id"] = cfg.sessionId;
    }
    if (cfg.threadId) {
      h["thread-id"] = cfg.threadId;
      h["x-client-request-id"] = cfg.threadId;
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

  type RequestTimeout = ReturnType<typeof withTimeout>;
  interface CodexHttpResponse {
    response: Response;
    bodyTimeout?: RequestTimeout;
    turnKey?: string;
  }

  async function prepareRequest(
    input: NativePassthroughInput,
    modelInfo: CodexModelInfo | undefined,
    accept: "application/json" | "text/event-stream",
    forceStore: boolean,
  ): Promise<{
    prepared: PreparedNativePassthroughRequest;
    turnKey: string | undefined;
  }> {
    const canonicalInput = canonicalizeCodexNativeInput(input, modelInfo, forceStore);
    const tieredInput = withCodexServiceTier(canonicalInput, cfg.fastMode === true, modelInfo);
    const wireInput = stripNativePassthroughHeader(tieredInput, "openai-beta");
    const useResponsesLite = nativeInputUsesResponsesLite(wireInput, modelInfo);
    const turnKey = nativeHeader(input, CODEX_TURN_METADATA_HEADER);
    const explicitTurnState = nativeHeader(input, CODEX_TURN_STATE_HEADER);
    rememberTurnState(turnKey, explicitTurnState);
    const providerHeaders = await headers(useResponsesLite, accept);
    const turnState = explicitTurnState ?? (turnKey ? turnStates.get(turnKey) : undefined);
    if (turnState) providerHeaders[CODEX_TURN_STATE_HEADER] = turnState;
    const prepared = prepareNativePassthroughRequest(wireInput, providerHeaders, {
      mergeHeaders: ["x-codex-beta-features"],
      preserveClientHeaders: [
        "accept",
        "accept-language",
        "originator",
        "session-id",
        "thread-id",
        "user-agent",
        "version",
        "x-client-request-id",
        "x-codex-beta-features",
        "x-codex-installation-id",
        CODEX_TURN_METADATA_HEADER,
        "x-codex-turn-state",
      ],
    });
    if (
      isNativePassthroughCarrier(input) &&
      prepared.carrier !== null &&
      prepared.carrier !== input
    ) {
      Object.assign(input.mutations, prepared.carrier.mutations);
    }
    return { prepared, turnKey };
  }

  async function request(
    input: NativePassthroughInput,
    modelInfo: CodexModelInfo | undefined,
    init: {
      endpoint: string;
      accept: "application/json" | "text/event-stream";
      signal?: AbortSignal;
      capture?: (wireBody: string) => void;
      timeoutThroughBody?: boolean;
    },
  ): Promise<CodexHttpResponse> {
    const { prepared, turnKey } = await prepareRequest(
      input,
      modelInfo,
      init.accept,
      init.endpoint !== compactUrl,
    );
    // The exact Responses-native bytes POSTed upstream (translate path: OpenAI→Responses
    // re-serialization; native passthrough: verbatim, model patched) — surfaced for capture.
    init.capture?.(prepared.bodyText);
    // Retry transient connection blips at the fetch boundary (pre-first-byte → idempotent);
    // a timeout becomes a non-transient UpstreamError and a client abort rethrows as-is.
    try {
      // withOverloadRetry wraps the connection retry: an overloaded 529/503 answer is a
      // normal Response (never a throw), so it re-issues the whole attempt after a pause
      // rather than burning a candidate on transient upstream capacity pressure. A
      // discarded attempt's deferred body-timeout timer is released explicitly.
      return await withOverloadRetry(
        () =>
          withConnectionRetry(
            async () => {
              const t = withTimeout(timeoutMs, init.signal);
              try {
                const response = await doFetch(init.endpoint, {
                  method: "POST",
                  headers: prepared.headers,
                  body: prepared.bodyText,
                  signal: t.signal,
                });
                if (init.timeoutThroughBody === true) {
                  return { response, bodyTimeout: t, turnKey };
                }
                return { response, turnKey };
              } catch (err) {
                if (t.isTimeout() && !t.isExternalAbort()) {
                  throw new UpstreamError("timeout", "upstream request timed out");
                }
                throw err;
              } finally {
                if (init.timeoutThroughBody !== true) {
                  t.cleanup();
                }
              }
            },
            {
              retries: cfg.connectRetries,
              backoffMs: cfg.connectRetryBackoffMs,
              signal: init.signal,
            },
          ),
        {
          signal: init.signal,
          pick: (value) => value.response,
          release: (value) => value.bodyTimeout?.cleanup(),
        },
      );
    } catch (error) {
      // An external abort is client-owned even when fetch happens to surface a
      // transport-shaped TypeError. Explicit provider timeouts are already
      // UpstreamError("timeout") and therefore fail this raw-transport guard.
      if (init.signal?.aborted || !isFetchTransportError(error)) throw error;
      throw upstreamTransportError(error, scrub);
    }
  }

  async function consumeUnaryBody<T>(
    result: CodexHttpResponse,
    consume: (text: string) => T | Promise<T>,
    maxBytes = 0,
  ): Promise<T> {
    try {
      return await consumeResponseTextWithinBudget(result.response, maxBytes, consume);
    } catch (err) {
      if (result.bodyTimeout?.isTimeout() && !result.bodyTimeout.isExternalAbort()) {
        throw new UpstreamError("timeout", "upstream request timed out");
      }
      if (err instanceof ResponseBodyTooLargeError) {
        throw responseBodyTooLargeUpstreamError(err);
      }
      if (err instanceof ResponseWorkCapacityError) {
        throw responseWorkCapacityUpstreamError(err);
      }
      throw err;
    } finally {
      if (result.bodyTimeout !== undefined) {
        result.bodyTimeout.cleanup();
      }
    }
  }

  async function readUnaryJson(result: CodexHttpResponse): Promise<Record<string, unknown>> {
    return await consumeUnaryBody(result, (text) => JSON.parse(text) as Record<string, unknown>);
  }

  function fireMetadataHook(
    hook: ((headers: Headers) => void) | undefined,
    headers: Headers,
  ): void {
    if (!hook) return;
    try {
      hook(headers);
    } catch {
      /* fail-open: response metadata never breaks the served request */
    }
  }

  // Scrape the upstream rate-limit window headers (providers page Tier 3) the moment
  // the response resolves — headers are available before any SSE chunk is read, so
  // this never buffers or perturbs the streamed body (Principle 8). Fail-open: a
  // throwing hook is swallowed (a quota-scrape must never break a served request).
  function fireResponseMeta(res: Response, onResponseMeta?: (headers: Headers) => void): void {
    fireResponseMetaHeaders(res.headers, onResponseMeta);
  }

  function fireResponseMetaHeaders(
    responseHeaders: Headers,
    onResponseMeta?: (headers: Headers) => void,
  ): void {
    fireMetadataHook(cfg.onResponseMeta, responseHeaders);
    fireMetadataHook(onResponseMeta, responseHeaders);
    const modelsEtag = responseHeaders.get("X-Models-Etag");
    if (cfg.onModelsEtag && modelsEtag) {
      try {
        cfg.onModelsEtag(modelsEtag);
      } catch {
        /* fail-open: catalog invalidation never breaks the served request */
      }
    }
  }

  function captureTurnState(result: CodexHttpResponse): void {
    const state = result.response.headers.get(CODEX_TURN_STATE_HEADER) ?? undefined;
    rememberTurnState(result.turnKey, state);
  }

  async function requestWithRetry(
    body: NativePassthroughInput,
    modelInfo: CodexModelInfo | undefined,
    init: {
      endpoint?: string;
      accept?: "application/json" | "text/event-stream";
      signal?: AbortSignal;
      capture?: (wireBody: string) => void;
      onResponseMeta?: (headers: Headers) => void;
      timeoutThroughBody?: boolean;
    },
  ): Promise<CodexHttpResponse> {
    const requestInit = {
      endpoint: init.endpoint ?? url,
      accept: init.accept ?? "text/event-stream",
      signal: init.signal,
      capture: init.capture,
      timeoutThroughBody: init.timeoutThroughBody,
    };
    const first = await request(body, modelInfo, requestInit);
    if (first.response.status === 401 && cfg.onUnauthorized !== undefined) {
      await first.response.body?.cancel().catch(() => {});
      first.bodyTimeout?.cleanup();
      cfg.onUnauthorized();
      const retried = await request(body, modelInfo, requestInit);
      captureTurnState(retried);
      fireResponseMeta(retried.response, init.onResponseMeta);
      return retried;
    }
    captureTurnState(first);
    fireResponseMeta(first.response, init.onResponseMeta);
    return first;
  }

  function codexErrorHeaders(headers: Headers): Record<string, string> {
    const selected: Record<string, string> = {};
    for (const [name, value] of headers) {
      const lower = name.toLowerCase();
      if (
        lower.startsWith("x-codex-") ||
        lower === "retry-after" ||
        lower === "x-request-id" ||
        lower === "x-oai-request-id" ||
        lower === "cf-ray"
      ) {
        selected[lower] = value;
      }
    }
    return selected;
  }

  async function errorFromResponse(result: CodexHttpResponse): Promise<UpstreamError> {
    let providerRaw: unknown = null;
    try {
      providerRaw = await consumeUnaryBody(
        result,
        (text) => {
          let raw: unknown;
          try {
            raw = JSON.parse(text);
          } catch {
            raw = text;
          }
          return scrub(raw);
        },
        UPSTREAM_ERROR_BODY_MAX_BYTES,
      );
    } catch (err) {
      if (err instanceof UpstreamError && err.errorClass === "timeout") throw err;
      if (err instanceof UpstreamError) providerRaw = err.providerRaw;
    }
    const scrubbedBody = providerRaw;
    const selectedHeaders =
      result.response.status === 429 ? codexErrorHeaders(result.response.headers) : {};
    const structuredRaw =
      Object.keys(selectedHeaders).length > 0
        ? { body: scrubbedBody, headers: scrub(selectedHeaders) }
        : scrubbedBody;
    return new UpstreamError(
      "upstream_error",
      `upstream returned ${result.response.status}`,
      structuredRaw,
      result.response.status,
      scrub(safeUpstreamHeaders(result.response.headers)) as Record<string, string>,
    );
  }

  function websocketUrl(): string {
    const endpoint = new URL(url);
    if (endpoint.protocol === "https:") endpoint.protocol = "wss:";
    else if (endpoint.protocol === "http:") endpoint.protocol = "ws:";
    else throw new Error(`unsupported Codex Responses websocket protocol: ${endpoint.protocol}`);
    return endpoint.toString();
  }

  function websocketErrorRaw(error: CodexResponsesWebSocketConnectError): unknown {
    let body: unknown = error.body;
    if (error.body.length > 0) {
      try {
        body = JSON.parse(error.body);
      } catch {
        body = error.body;
      }
    } else {
      body = null;
    }
    const selectedHeaders =
      error.status === 429 ? codexErrorHeaders(error.headers) : ({} as Record<string, string>);
    const scrubbedBody = scrub(body);
    return Object.keys(selectedHeaders).length > 0
      ? { body: scrubbedBody, headers: scrub(selectedHeaders) }
      : scrubbedBody;
  }

  function websocketUpstreamError(error: unknown): UpstreamError {
    if (error instanceof UpstreamError) return error;
    if (error instanceof CodexResponsesWebSocketConnectError) {
      return new UpstreamError(
        "upstream_error",
        error.status === null ? error.message : `upstream websocket returned ${error.status}`,
        websocketErrorRaw(error),
        error.status,
        scrub(safeUpstreamHeaders(error.headers)) as Record<string, string>,
      );
    }
    return new UpstreamError(
      "upstream_error",
      error instanceof Error ? error.message : "Codex Responses websocket connection failed",
    );
  }

  async function connectWebSocket(
    prepared: PreparedNativePassthroughRequest,
    signal: AbortSignal | undefined,
  ): Promise<CodexResponsesWebSocketConnection> {
    const connector = cfg.responsesWebSocketConnector;
    if (!connector) throw new Error("Codex Responses websocket connector is unavailable");
    const connectOnce = async (): Promise<CodexResponsesWebSocketConnection> => {
      const connectHeaders: Record<string, string> = {
        ...prepared.headers,
        "openai-beta": RESPONSES_WEBSOCKET_BETA,
      };
      const authorization = await getAuthHeader();
      const token = authorization.replace(/^Bearer /, "");
      const persistedIdentity = cfg.getAccountIdentity?.() ?? {};
      const accountId = persistedIdentity.accountId ?? codexAccountIdFromToken(token);
      connectHeaders.Authorization = `Bearer ${token}`;
      if (accountId.length > 0) connectHeaders["chatgpt-account-id"] = accountId;
      else delete connectHeaders["chatgpt-account-id"];
      delete connectHeaders.accept;
      delete connectHeaders["Content-Type"];
      delete connectHeaders["content-type"];
      return await connector({
        url: websocketUrl(),
        headers: connectHeaders,
        signal,
      });
    };
    const connectWithRetry = async (): Promise<CodexResponsesWebSocketConnection> =>
      await withConnectionRetry(connectOnce, {
        retries: cfg.connectRetries,
        backoffMs: cfg.connectRetryBackoffMs,
        signal,
        shouldRetry: (error) =>
          error instanceof CodexResponsesWebSocketConnectError
            ? error.status === null
            : isTransientConnectionError(error),
      });
    try {
      return await connectWithRetry();
    } catch (error) {
      if (signal?.aborted) throw signal.reason ?? error;
      if (
        error instanceof CodexResponsesWebSocketConnectError &&
        error.status === 401 &&
        cfg.onUnauthorized !== undefined
      ) {
        cfg.onUnauthorized();
        try {
          return await connectWithRetry();
        } catch (retryError) {
          if (signal?.aborted) throw signal.reason ?? retryError;
          throw websocketUpstreamError(retryError);
        }
      }
      throw websocketUpstreamError(error);
    }
  }

  function websocketRetryCount(): number {
    const configured = cfg.connectRetries;
    return configured === undefined || !Number.isFinite(configured)
      ? 2
      : Math.max(0, Math.floor(configured));
  }

  async function waitForWebsocketRetry(attempt: number, signal: AbortSignal | undefined) {
    const backoff = cfg.connectRetryBackoffMs ?? [200, 500];
    const delay = backoff[Math.min(attempt, backoff.length - 1)] ?? 0;
    if (delay <= 0) return;
    await new Promise<void>((resolve) => {
      if (signal?.aborted) {
        resolve();
        return;
      }
      const timer = setTimeout(() => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      }, delay);
      const onAbort = () => {
        clearTimeout(timer);
        resolve();
      };
      signal?.addEventListener("abort", onAbort, { once: true });
    });
    if (signal?.aborted) throw signal.reason ?? new Error("client aborted");
  }

  function isWebsocketConnectionLimitError(error: UpstreamError): boolean {
    if (!isRecord(error.providerRaw)) return false;
    const nested = isRecord(error.providerRaw.error) ? error.providerRaw.error : {};
    return nested.code === "websocket_connection_limit_reached";
  }

  function websocketSessionId(input: NativePassthroughInput): string | undefined {
    return nativeHeader(input, CODEX_RESPONSES_WEBSOCKET_SESSION_HEADER);
  }

  async function acquireWebSocketSession(
    sessionId: string,
    prepared: PreparedNativePassthroughRequest,
    signal: AbortSignal | undefined,
  ): Promise<
    | {
        connection: CodexResponsesWebSocketConnection;
        release: () => void;
      }
    | undefined
  > {
    while (!websocketHttpFallbackSessions.has(sessionId)) {
      if (signal?.aborted) throw signal.reason ?? new Error("client aborted");
      let state = websocketSessions.get(sessionId);
      if (!state) {
        const connection = connectWebSocket(prepared, signal);
        state = { connection, tail: Promise.resolve() };
        websocketSessions.set(sessionId, state);
        connection.catch(() => {
          if (websocketSessions.get(sessionId) === state) websocketSessions.delete(sessionId);
        });
      }
      let release = () => {};
      const previous = state.tail;
      state.tail = new Promise<void>((resolve) => {
        release = resolve;
      });
      await previous;
      if (signal?.aborted) {
        release();
        throw signal.reason ?? new Error("client aborted");
      }
      if (websocketSessions.get(sessionId) !== state) {
        release();
        continue;
      }
      try {
        return { connection: await state.connection, release };
      } catch (error) {
        release();
        throw error;
      }
    }
    return undefined;
  }

  async function closeWebSocketSession(sessionId: string): Promise<void> {
    websocketHttpFallbackSessions.delete(sessionId);
    const state = websocketSessions.get(sessionId);
    if (!state) return;
    websocketSessions.delete(sessionId);
    try {
      await (await state.connection).close();
    } catch {
      // Session teardown is best-effort; the socket may already be closed.
    }
  }

  type ParsedWebSocketEvent =
    | {
        kind: "frame";
        frame: string;
        preamble: boolean;
        terminal: boolean;
        reusable: boolean;
      }
    | {
        kind: "rate_limits";
        headers: Headers;
      }
    | {
        kind: "error";
        error: UpstreamError;
        headers: Headers;
      };

  function websocketJsonHeaders(value: unknown): Headers {
    const headers = new Headers();
    if (!isRecord(value)) return headers;
    for (const [name, rawValue] of Object.entries(value)) {
      const headerValue =
        typeof rawValue === "string"
          ? rawValue
          : typeof rawValue === "number" && Number.isFinite(rawValue)
            ? String(rawValue)
            : typeof rawValue === "boolean"
              ? String(rawValue)
              : null;
      if (headerValue === null) continue;
      try {
        headers.set(name, headerValue);
      } catch {
        // Malformed server-provided header names/values are ignored like Codex CLI.
      }
    }
    return headers;
  }

  function websocketRateLimitHeaders(event: Record<string, unknown>): Headers {
    const headers = new Headers();
    const rawLimitId =
      typeof event.metered_limit_name === "string"
        ? event.metered_limit_name
        : typeof event.limit_name === "string"
          ? event.limit_name
          : "";
    const normalizedLimitId = rawLimitId.trim().toLowerCase().replaceAll("_", "-");
    const limitId = /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(normalizedLimitId)
      ? normalizedLimitId
      : "codex";
    const rateLimits = isRecord(event.rate_limits) ? event.rate_limits : {};

    const appendWindow = (kind: "primary" | "secondary", value: unknown): void => {
      if (!isRecord(value)) return;
      const usedPercent = value.used_percent;
      if (typeof usedPercent !== "number" || !Number.isFinite(usedPercent)) return;
      const prefix = `x-${limitId}-${kind}`;
      headers.set(`${prefix}-used-percent`, String(usedPercent));
      if (typeof value.window_minutes === "number" && Number.isFinite(value.window_minutes)) {
        headers.set(`${prefix}-window-minutes`, String(value.window_minutes));
      }
      if (typeof value.reset_at === "number" && Number.isFinite(value.reset_at)) {
        headers.set(`${prefix}-reset-at`, String(value.reset_at));
      }
    };

    appendWindow("primary", rateLimits.primary);
    appendWindow("secondary", rateLimits.secondary);

    const credits = isRecord(event.credits) ? event.credits : null;
    if (
      credits &&
      typeof credits.has_credits === "boolean" &&
      typeof credits.unlimited === "boolean"
    ) {
      headers.set("x-codex-credits-has-credits", String(credits.has_credits));
      headers.set("x-codex-credits-unlimited", String(credits.unlimited));
      if (typeof credits.balance === "string") {
        headers.set("x-codex-credits-balance", credits.balance);
      }
    }
    if (typeof event.plan_type === "string" && event.plan_type.trim().length > 0) {
      headers.set("x-codex-plan-type", event.plan_type.trim());
    }
    return headers;
  }

  function websocketWrappedError(
    event: Record<string, unknown>,
  ): { error: UpstreamError; headers: Headers } | null {
    if (event.type !== "error") return null;
    const nestedError = isRecord(event.error) ? event.error : {};
    const message =
      typeof nestedError.message === "string" && nestedError.message.length > 0
        ? nestedError.message
        : typeof event.message === "string" && event.message.length > 0
          ? event.message
          : "Codex Responses websocket error";
    if (nestedError.code === "websocket_connection_limit_reached") {
      return {
        error: new UpstreamError("upstream_error", message, scrub(event)),
        headers: websocketJsonHeaders(event.headers),
      };
    }
    const rawStatus =
      typeof event.status === "number"
        ? event.status
        : typeof event.status_code === "number"
          ? event.status_code
          : null;
    if (
      rawStatus === null ||
      !Number.isInteger(rawStatus) ||
      rawStatus < 100 ||
      rawStatus > 599 ||
      (rawStatus >= 200 && rawStatus < 300)
    ) {
      return null;
    }
    const headers = websocketJsonHeaders(event.headers);
    const selectedHeaders = rawStatus === 429 ? codexErrorHeaders(headers) : {};
    const body = scrub(event);
    const providerRaw =
      Object.keys(selectedHeaders).length > 0 ? { body, headers: scrub(selectedHeaders) } : body;
    return {
      error: new UpstreamError("upstream_error", message, providerRaw, rawStatus),
      headers,
    };
  }

  function websocketSseFrame(text: string): ParsedWebSocketEvent {
    let event: Record<string, unknown>;
    try {
      const parsed = JSON.parse(text) as unknown;
      if (!isRecord(parsed) || typeof parsed.type !== "string") {
        throw new Error("websocket response is not a typed JSON event");
      }
      event = parsed;
    } catch (error) {
      throw new UpstreamError(
        "upstream_error",
        error instanceof Error ? error.message : "invalid Codex Responses websocket event",
      );
    }
    const type = String(event.type);
    if (type === "codex.rate_limits") {
      return {
        kind: "rate_limits",
        headers: websocketRateLimitHeaders(event),
      };
    }
    const wrappedError = websocketWrappedError(event);
    if (wrappedError) {
      return {
        kind: "error",
        ...wrappedError,
      };
    }
    return {
      kind: "frame",
      frame: `event: ${type}\ndata: ${text}\n\n`,
      preamble: type === "response.created" || type === "response.in_progress",
      terminal:
        type === "response.completed" ||
        type === "response.failed" ||
        type === "response.incomplete" ||
        type === "response.cancelled" ||
        type === "error",
      reusable: type === "response.completed",
    };
  }

  async function receiveWebSocketMessage(
    connection: CodexResponsesWebSocketConnection,
    signal: AbortSignal | undefined,
  ): Promise<CodexResponsesWebSocketReceivedMessage | null> {
    const timeout = withTimeout(timeoutMs, signal);
    const receive =
      connection.receiveWithWork?.() ??
      connection.receive().then((text) =>
        text === null
          ? null
          : {
              text,
              release() {},
            },
      );
    try {
      return await Promise.race([
        receive,
        new Promise<never>((_, reject) => {
          const rejectAbort = () => {
            if (timeout.isTimeout() && !timeout.isExternalAbort()) {
              reject(new UpstreamError("timeout", "upstream websocket stream timed out"));
            } else {
              reject(signal?.reason ?? new Error("client aborted"));
            }
          };
          if (timeout.signal.aborted) rejectAbort();
          else timeout.signal.addEventListener("abort", rejectAbort, { once: true });
        }),
      ]);
    } catch (error) {
      void receive.then(
        (message) => message?.release(),
        () => {},
      );
      throw error;
    } finally {
      timeout.cleanup();
    }
  }

  return {
    nativeProtocolProfile: "codex_responses",

    async chatCompletion(req, opts) {
      const model = String((req as Record<string, unknown>).model ?? "");
      const modelInfo = await resolveModelInfo(model);
      const result = await requestWithRetry(
        openaiToResponsesRequest(req, { sessionId: cfg.sessionId, modelInfo }),
        modelInfo,
        {
          signal: opts?.signal,
          capture: opts?.captureUpstream,
          onResponseMeta: opts?.onResponseMeta,
        },
      );
      if (!result.response.ok) throw await errorFromResponse(result);
      // Codex is stream-only → aggregate the SSE into a single Chat response.
      return await aggregateResponsesStream(result.response, model, timeoutMs);
    },

    async *chatCompletionStream(req, opts) {
      const model = String((req as Record<string, unknown>).model ?? "");
      const modelInfo = await resolveModelInfo(model);
      const result = await requestWithRetry(
        openaiToResponsesRequest(req, { sessionId: cfg.sessionId, modelInfo }),
        modelInfo,
        {
          signal: opts?.signal,
          capture: opts?.captureUpstream,
          onResponseMeta: opts?.onResponseMeta,
        },
      );
      if (!result.response.ok) throw await errorFromResponse(result);
      yield* translateResponsesSSE(result.response, model, timeoutMs);
    },

    // Native protocol passthrough (issue #217, Phase 3): the inbound /v1/responses body
    // is ALREADY a native Responses body (the real Codex CLI supplies store:false +
    // stream:true + include + reasoning + tools …), so forward it VERBATIM and return the
    // upstream's native JSON untranslated. Reuses the same HTTP core (headers/withTimeout/
    // 401-retry/scrub/errorFromResponse/onResponseMeta) but SKIPS both translators —
    // `openaiToResponsesRequest` (no instructions/input rewrite, no store/include
    // injection) and `aggregateResponsesStream` (no Responses→Chat folding). The ChatGPT
    // Current identity headers (Bearer + chatgpt-account-id + originator) are applied by
    // `headers()` inside the shared core, so they ride on the native body unchanged.
    async nativePassthrough(body, opts) {
      const modelInfo = await resolveModelInfo(nativeInputModel(body));
      const result = await requestWithRetry(body, modelInfo, {
        accept: "application/json",
        signal: opts?.signal,
        capture: opts?.captureUpstream,
        onResponseMeta: opts?.onResponseMeta,
        timeoutThroughBody: true,
      });
      if (!result.response.ok) throw await errorFromResponse(result);
      return await readUnaryJson(result);
    },

    // Streaming native passthrough (issue #217, Phase 3). The native body from a STREAMING
    // /v1/responses client ALREADY carries `stream:true`, so it is forwarded VERBATIM — NO
    // `stream:true` injection, NO `openaiToResponsesRequest` translation. The 401-retry /
    // non-2xx error path runs BEFORE the first chunk (same as chatCompletionStream), then
    // the upstream Responses SSE is BYTE-RELAYED unchanged via readResponsesSSERaw — no SSE
    // re-mapping state machine to mangle reasoning.encrypted_content / tools (principle 8).
    async *nativePassthroughStream(body, opts) {
      const modelInfo = await resolveModelInfo(nativeInputModel(body));
      const sessionId = websocketSessionId(body);
      if (
        cfg.responsesWebSocketConnector &&
        sessionId &&
        !websocketHttpFallbackSessions.has(sessionId)
      ) {
        const { prepared, turnKey } = await prepareRequest(
          body,
          modelInfo,
          "text/event-stream",
          true,
        );
        const maxRetries = websocketRetryCount();
        let retries = 0;
        while (!websocketHttpFallbackSessions.has(sessionId)) {
          let lease:
            | {
                connection: CodexResponsesWebSocketConnection;
                release: () => void;
              }
            | undefined;
          try {
            lease = await acquireWebSocketSession(sessionId, prepared, opts?.signal);
            if (!lease) break;
          } catch (error) {
            if (
              error instanceof UpstreamError &&
              (error.upstreamStatus === 426 || error.upstreamStatus === null) &&
              !opts?.signal?.aborted
            ) {
              websocketHttpFallbackSessions.add(sessionId);
              break;
            }
            throw error;
          }

          let retryConnection = false;
          let fallbackToHttp = false;
          let sendingRequest = false;
          let outputStarted = false;
          const preambleFrames: string[] = [];
          try {
            if (!websocketMetadataFired.has(lease.connection)) {
              websocketMetadataFired.add(lease.connection);
              fireResponseMetaHeaders(lease.connection.responseHeaders, opts?.onResponseMeta);
            }
            const turnState =
              lease.connection.responseHeaders.get(CODEX_TURN_STATE_HEADER) ?? undefined;
            rememberTurnState(turnKey, turnState);
            const requestText = JSON.stringify({ type: "response.create", ...prepared.body });
            opts?.captureUpstream?.(requestText);
            sendingRequest = true;
            await lease.connection.send(requestText);
            sendingRequest = false;
            while (true) {
              const received = await receiveWebSocketMessage(lease.connection, opts?.signal);
              if (received === null) {
                await closeWebSocketSession(sessionId);
                if (outputStarted) {
                  throw new UpstreamError(
                    "upstream_error",
                    "upstream websocket closed before a terminal response event",
                  );
                }
                if (retries < maxRetries) {
                  retryConnection = true;
                } else {
                  websocketHttpFallbackSessions.add(sessionId);
                  fallbackToHttp = true;
                }
                break;
              }
              try {
                const event = websocketSseFrame(received.text);
                if (event.kind === "rate_limits") {
                  fireResponseMetaHeaders(event.headers, opts?.onResponseMeta);
                  continue;
                }
                if (event.kind === "error") {
                  fireResponseMetaHeaders(event.headers, opts?.onResponseMeta);
                  if (isWebsocketConnectionLimitError(event.error)) {
                    await closeWebSocketSession(sessionId);
                    if (!outputStarted && retries < maxRetries) {
                      retryConnection = true;
                    } else if (!outputStarted) {
                      websocketHttpFallbackSessions.add(sessionId);
                      fallbackToHttp = true;
                    } else {
                      throw event.error;
                    }
                    break;
                  }
                  await closeWebSocketSession(sessionId);
                  throw event.error;
                }
                if (!outputStarted && event.preamble && preambleFrames.length < 2) {
                  preambleFrames.push(event.frame);
                  continue;
                }
                if (!outputStarted) {
                  outputStarted = true;
                  yield* preambleFrames;
                }
                if (event.terminal && !event.reusable) {
                  await closeWebSocketSession(sessionId);
                }
                yield event.frame;
                if (event.terminal) {
                  return;
                }
              } finally {
                received.release();
              }
            }
          } catch (error) {
            await closeWebSocketSession(sessionId);
            if (opts?.signal?.aborted) throw opts.signal.reason ?? error;
            if (sendingRequest && isTransientConnectionError(error)) {
              if (retries < maxRetries) {
                retryConnection = true;
              } else {
                websocketHttpFallbackSessions.add(sessionId);
                fallbackToHttp = true;
              }
            } else {
              throw error;
            }
          } finally {
            lease.release();
          }
          if (fallbackToHttp) break;
          if (retryConnection) {
            await waitForWebsocketRetry(retries, opts?.signal);
            retries += 1;
            continue;
          }
          break;
        }
      }
      const result = await requestWithRetry(body, modelInfo, {
        signal: opts?.signal,
        capture: opts?.captureUpstream,
        onResponseMeta: opts?.onResponseMeta,
      });
      if (!result.response.ok) throw await errorFromResponse(result);
      yield* readResponsesSSERaw(result.response, timeoutMs);
    },

    closeResponsesWebSocketSession: closeWebSocketSession,

    async responsesCompact(body, opts) {
      const modelInfo = await resolveModelInfo(nativeInputModel(body));
      const result = await requestWithRetry(body, modelInfo, {
        endpoint: compactUrl,
        accept: "application/json",
        signal: opts?.signal,
        capture: opts?.captureUpstream,
        onResponseMeta: opts?.onResponseMeta,
        timeoutThroughBody: true,
      });
      if (!result.response.ok) throw await errorFromResponse(result);
      return await readUnaryJson(result);
    },
  };
}

export function createGenericOpenAIResponsesClient(
  deps: GenericOpenAIResponsesClientDeps,
): ProviderClient {
  const doFetch = deps.fetch ?? globalThis.fetch;
  const cfg = deps.config;
  const requestContract = deps.requestContract;
  const timeoutMs = cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const rootUrl = async (): Promise<string> => {
    const base = cfg.resolveBaseUrl ? await cfg.resolveBaseUrl() : cfg.baseUrl;
    const trimmed = base.replace(/\/$/, "");
    return trimmed.endsWith("/responses") ? trimmed.slice(0, -"/responses".length) : trimmed;
  };

  const endpoint = async (path: string): Promise<string> => `${await rootUrl()}/${path}`;

  async function providerHeaders(
    accept = "application/json",
    body?: Record<string, unknown>,
  ): Promise<Record<string, string>> {
    const authorization =
      cfg.getAuthHeader !== undefined
        ? await cfg.getAuthHeader()
        : cfg.apiKey !== undefined
          ? `Bearer ${cfg.apiKey}`
          : "";
    const dynamicHeaders =
      body !== undefined && requestContract?.requestHeaders !== undefined
        ? await requestContract.requestHeaders({
            body,
            model: typeof body.model === "string" ? body.model : "",
            authorization,
          })
        : {};
    return {
      "Content-Type": "application/json",
      accept,
      ...(authorization.length > 0 ? { Authorization: authorization } : {}),
      ...(cfg.extraHeaders ? cfg.extraHeaders() : {}),
      ...dynamicHeaders,
    };
  }

  function applyResponsesRequestContract(body: NativePassthroughInput): NativePassthroughInput {
    const contract = requestContract;
    if (
      contract?.forceSse !== true &&
      contract?.forceStoreFalse !== true &&
      contract?.ensureReasoningEncryptedContent !== true &&
      contract?.ensureInstructions !== true &&
      contract?.rejectPreviousResponseId !== true &&
      contract?.rejectObjectInput !== true &&
      contract?.resolveModelRequestDefaults === undefined
    ) {
      return body;
    }
    const source = isNativePassthroughCarrier(body) ? body.body : body;
    const next: Record<string, unknown> = {
      ...source,
      ...(contract.forceSse === true ? { stream: true } : {}),
      ...(contract.forceStoreFalse === true ? { store: false } : {}),
    };
    const model = typeof next.model === "string" ? next.model : "";
    const modelDefaults = contract.resolveModelRequestDefaults?.(model);
    let streamToolCallsAdded = false;
    if (modelDefaults?.streamToolCalls === true && next.stream_tool_calls !== true) {
      next.stream_tool_calls = true;
      streamToolCallsAdded = true;
    }
    let maxOutputTokensAdded = false;
    if (
      next.max_output_tokens === undefined &&
      typeof modelDefaults?.maxCompletionTokens === "number" &&
      Number.isSafeInteger(modelDefaults.maxCompletionTokens) &&
      modelDefaults.maxCompletionTokens >= 0
    ) {
      next.max_output_tokens = modelDefaults.maxCompletionTokens;
      maxOutputTokensAdded = true;
    }
    let reasoningIncludeAdded = false;
    if (contract.ensureReasoningEncryptedContent === true) {
      const includes = Array.isArray(next.include)
        ? next.include.filter((value): value is string => typeof value === "string")
        : [];
      if (!includes.includes("reasoning.encrypted_content")) {
        next.include = [...includes, "reasoning.encrypted_content"];
        reasoningIncludeAdded = true;
      }
    }
    if (
      contract.rejectPreviousResponseId === true &&
      typeof next.previous_response_id === "string" &&
      next.previous_response_id.length > 0
    ) {
      const message =
        "previous_response_id is not supported by this subscription provider; send the full conversation input instead";
      throw new UpstreamError(
        "upstream_error",
        message,
        { type: "invalid_request_error", code: "previous_response_id_unsupported", message },
        400,
      );
    }
    if (
      contract.rejectObjectInput === true &&
      next.input !== null &&
      typeof next.input === "object" &&
      !Array.isArray(next.input)
    ) {
      const message = "input must be an array of Responses items for this subscription provider";
      throw new UpstreamError(
        "upstream_error",
        message,
        { type: "invalid_request_error", code: "responses_input_sequence_required", message },
        400,
      );
    }
    const instructionShims: string[] = [];
    if (
      contract.ensureInstructions === true &&
      (typeof next.instructions !== "string" || next.instructions.trim().length === 0)
    ) {
      next.instructions = DEFAULT_INSTRUCTIONS;
      instructionShims.push("generic_responses_default_instructions");
    }
    if (!isNativePassthroughCarrier(body)) return next;
    const carrier = cloneCarrierWithBody(body, next);
    appendMutationList(carrier.mutations, "body_shims_applied", [
      ...(contract.forceSse === true ? ["generic_responses_force_stream"] : []),
      ...(contract.forceStoreFalse === true ? ["generic_responses_force_store_false"] : []),
      ...(reasoningIncludeAdded ? ["generic_responses_include_encrypted_reasoning"] : []),
      ...(streamToolCallsAdded ? ["generic_responses_stream_tool_calls_default"] : []),
      ...(maxOutputTokensAdded ? ["generic_responses_max_output_tokens_default"] : []),
      ...instructionShims,
    ]);
    return carrier;
  }

  function scrub(raw: unknown): unknown {
    if (raw === null) return raw;
    const secrets = cfg.currentSecrets ? cfg.currentSecrets() : [];
    // Mirror the openai/anthropic/gemini clients: a static apiKey must also be
    // redacted from upstream error bodies (else it can leak into error_detail/
    // telemetry if the upstream echoes the Authorization value).
    if (cfg.apiKey !== undefined) secrets.push(cfg.apiKey);
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

  async function fetchWithTimeout(
    url: string,
    init: RequestInit,
    external?: AbortSignal,
  ): Promise<Response> {
    // A 529/503 is transient upstream capacity pressure, not a request fault — pause
    // and re-issue the SAME body (pre-first-byte → idempotent) before the executor
    // burns another candidate on it.
    try {
      return await withOverloadRetry(
        async () => {
          const t = withTimeout(timeoutMs, external);
          try {
            return await doFetch(url, { ...init, signal: t.signal });
          } catch (err) {
            if (t.isTimeout() && !t.isExternalAbort()) {
              throw new UpstreamError("timeout", "upstream request timed out");
            }
            throw err;
          } finally {
            t.cleanup();
          }
        },
        { signal: external },
      );
    } catch (error) {
      if (external?.aborted || !isFetchTransportError(error)) throw error;
      throw upstreamTransportError(error, scrub);
    }
  }

  async function errorFromResponse(res: Response): Promise<UpstreamError> {
    const providerRaw = await readUpstreamErrorBody(res, scrub);
    return new UpstreamError(
      "upstream_error",
      `upstream returned ${res.status}`,
      providerRaw,
      res.status,
      scrub(safeUpstreamHeaders(res.headers)) as Record<string, string>,
    );
  }

  async function readUnaryJson(res: Response): Promise<Record<string, unknown>> {
    try {
      return await consumeResponseTextWithinBudget(
        res,
        0,
        (text) => JSON.parse(text) as Record<string, unknown>,
      );
    } catch (error) {
      if (error instanceof ResponseBodyTooLargeError) {
        throw responseBodyTooLargeUpstreamError(error);
      }
      if (error instanceof ResponseWorkCapacityError) {
        throw responseWorkCapacityUpstreamError(error);
      }
      throw error;
    }
  }

  async function requestJson(
    path: string,
    init: {
      method: "GET" | "POST" | "DELETE";
      body?: NativePassthroughInput;
      accept?: string;
      signal?: AbortSignal;
      captureUpstream?: (wireBody: string) => void;
      applyRequestContract?: boolean;
    },
  ): Promise<Response> {
    const requestBody =
      init.body !== undefined && init.applyRequestContract === true
        ? applyResponsesRequestContract(init.body)
        : init.body;
    const finalBody =
      requestBody === undefined
        ? undefined
        : isNativePassthroughCarrier(requestBody)
          ? requestBody.body
          : requestBody;
    const headers = await providerHeaders(init.accept, finalBody);
    let bodyText: string | undefined;
    let requestHeaders = headers;
    if (requestBody !== undefined) {
      const prepared = prepareNativePassthroughRequest(requestBody, headers, {
        // A stream-only profile must override a native carrier's stale JSON Accept.
        ...(requestContract?.forceSse === true && init.applyRequestContract === true
          ? {
              preserveClientHeaders: [
                "accept-language",
                "originator",
                "session_id",
                "user-agent",
                "x-client-request-id",
                "x-session-id",
              ],
              providerProfileApplied: "generic_responses_stream_only",
            }
          : {}),
      });
      requestHeaders = prepared.headers;
      bodyText = prepared.bodyText;
      // Exact Responses-native bytes POSTed upstream (post OpenAI→Responses translation
      // on the translate path) — surfaced for forwarded-upstream capture.
      init.captureUpstream?.(bodyText);
    }
    const res = await fetchWithTimeout(
      await endpoint(path),
      { method: init.method, headers: requestHeaders, ...(bodyText ? { body: bodyText } : {}) },
      init.signal,
    );
    if (res.status === 401 && cfg.onUnauthorized !== undefined) {
      await res.body?.cancel().catch(() => {});
      cfg.onUnauthorized();
      // Rebuild headers AFTER onUnauthorized so an OAuth provider's retry carries the
      // refreshed token — reusing the original headers would resend the expired one
      // and the refresh would never recover the request.
      const refreshedHeaders = await providerHeaders(init.accept, finalBody);
      let retryHeaders = refreshedHeaders;
      let retryBodyText = bodyText;
      if (requestBody !== undefined) {
        const prepared = prepareNativePassthroughRequest(requestBody, refreshedHeaders, {
          ...(requestContract?.forceSse === true && init.applyRequestContract === true
            ? {
                preserveClientHeaders: [
                  "accept-language",
                  "originator",
                  "session_id",
                  "user-agent",
                  "x-client-request-id",
                  "x-session-id",
                ],
                providerProfileApplied: "generic_responses_stream_only",
              }
            : {}),
        });
        retryHeaders = prepared.headers;
        retryBodyText = prepared.bodyText;
        init.captureUpstream?.(retryBodyText);
      }
      return await fetchWithTimeout(
        await endpoint(path),
        {
          method: init.method,
          headers: retryHeaders,
          ...(retryBodyText ? { body: retryBodyText } : {}),
        },
        init.signal,
      );
    }
    return res;
  }

  return {
    nativeProtocolProfile: "generic_openai_responses",

    async chatCompletion(req, opts) {
      const model = String((req as Record<string, unknown>).model ?? "");
      const res = await requestJson("responses", {
        method: "POST",
        body: openaiToGenericResponsesRequest(req),
        ...(requestContract?.forceSse === true ? { accept: "text/event-stream" } : {}),
        signal: opts?.signal,
        captureUpstream: opts?.captureUpstream,
        applyRequestContract: true,
      });
      if (!res.ok) throw await errorFromResponse(res);
      if (requestContract?.forceSse === true) {
        return await aggregateResponsesStream(res, model, timeoutMs, { allowIncomplete: true });
      }
      return responsesJsonToChatResponse(await readUnaryJson(res), model);
    },

    async *chatCompletionStream(req, opts) {
      const model = String((req as Record<string, unknown>).model ?? "");
      const res = await requestJson("responses", {
        method: "POST",
        body: { ...openaiToGenericResponsesRequest(req), stream: true },
        accept: "text/event-stream",
        signal: opts?.signal,
        captureUpstream: opts?.captureUpstream,
        applyRequestContract: true,
      });
      if (!res.ok) throw await errorFromResponse(res);
      yield* translateResponsesSSE(res, model, timeoutMs, {
        strictTerminal: requestContract?.forceSse === true,
      });
    },

    async nativePassthrough(body, opts) {
      const res = await requestJson("responses", {
        method: "POST",
        body,
        ...(requestContract?.forceSse === true ? { accept: "text/event-stream" } : {}),
        signal: opts?.signal,
        captureUpstream: opts?.captureUpstream,
        applyRequestContract: true,
      });
      if (!res.ok) throw await errorFromResponse(res);
      if (requestContract?.forceSse === true) {
        return await aggregateNativeResponsesStream(res, timeoutMs);
      }
      return await readUnaryJson(res);
    },

    async *nativePassthroughStream(body, opts) {
      const res = await requestJson("responses", {
        method: "POST",
        body,
        accept: "text/event-stream",
        signal: opts?.signal,
        captureUpstream: opts?.captureUpstream,
        applyRequestContract: true,
      });
      if (!res.ok) throw await errorFromResponse(res);
      yield* readResponsesSSERaw(res, timeoutMs);
    },

    async responsesRetrieve(responseId, opts) {
      const res = await requestJson(`responses/${encodeURIComponent(responseId)}`, {
        method: "GET",
        signal: opts?.signal,
      });
      if (!res.ok) throw await errorFromResponse(res);
      return await readUnaryJson(res);
    },

    async responsesDelete(responseId, opts) {
      const res = await requestJson(`responses/${encodeURIComponent(responseId)}`, {
        method: "DELETE",
        signal: opts?.signal,
      });
      if (!res.ok) throw await errorFromResponse(res);
      return await readUnaryJson(res);
    },

    async responsesCancel(responseId, opts) {
      const res = await requestJson(`responses/${encodeURIComponent(responseId)}/cancel`, {
        method: "POST",
        signal: opts?.signal,
      });
      if (!res.ok) throw await errorFromResponse(res);
      return await readUnaryJson(res);
    },

    async responsesInputItems(responseId, opts) {
      const res = await requestJson(`responses/${encodeURIComponent(responseId)}/input_items`, {
        method: "GET",
        signal: opts?.signal,
      });
      if (!res.ok) throw await errorFromResponse(res);
      return await readUnaryJson(res);
    },

    async responsesCompact(req, opts) {
      const res = await requestJson("responses/compact", {
        method: "POST",
        body: req,
        signal: opts?.signal,
      });
      if (!res.ok) throw await errorFromResponse(res);
      return await readUnaryJson(res);
    },

    async responsesInputTokens(req, opts) {
      const res = await requestJson("responses/input_tokens", {
        method: "POST",
        body: req,
        signal: opts?.signal,
      });
      if (!res.ok) throw await errorFromResponse(res);
      return await readUnaryJson(res);
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

function nextRawSSEFrameBoundary(buffer: string): { index: number; length: number } | null {
  const match = /(?:\r\n|\r|\n)(?:\r\n|\r|\n)/.exec(buffer);
  return match ? { index: match.index, length: match[0].length } : null;
}

export async function* readResponsesEvents(
  res: Response,
  // Inter-chunk liveness deadline (ms); 0 disables. Threaded from the client's
  // request timeout so a wedged mid-stream upstream is reclaimed, not hung
  // (connect/TTFB timeout was already cleared at headers).
  idleMs = 0,
  workAdmission: ResponseWorkAdmission = runtimeResponseWorkAdmission(),
): AsyncGenerator<Record<string, unknown>> {
  const body = res.body;
  if (!body) return;
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const frameGuard = createSSEIncompleteFrameGuard(workAdmission);
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
        const tail = decoder.decode();
        frameGuard.resize(Buffer.byteLength(buffer) + Buffer.byteLength(tail));
        buffer += tail;
        if (buffer.trim() !== "") {
          const evt = parseResponsesSSEFrame(buffer);
          if (evt !== null) yield evt;
        }
        break;
      }
      const decoded = decoder.decode(value, { stream: true });
      frameGuard.resize(Buffer.byteLength(buffer) + Buffer.byteLength(decoded));
      buffer += decoded;
      const { frames, tail } = splitCompleteSSEFrames(buffer);
      buffer = tail;
      frameGuard.resize(Buffer.byteLength(buffer));
      for (const raw of frames) {
        const evt = parseResponsesSSEFrame(raw);
        if (evt !== null) yield evt;
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
    frameGuard.release();
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
  workAdmission: ResponseWorkAdmission = runtimeResponseWorkAdmission(),
): AsyncGenerator<string> {
  const body = res.body;
  if (!body) {
    throw new UpstreamError("upstream_error", "stream closed before response.completed");
  }
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let detectionBuffer = "";
  const frameGuard = createSSEIncompleteFrameGuard(workAdmission);

  function terminalEndInChunk(text: string, flush = false): number | null {
    frameGuard.resize(Buffer.byteLength(detectionBuffer) + Buffer.byteLength(text));
    const previousTailLength = detectionBuffer.length;
    let remaining = detectionBuffer + text;
    let consumed = 0;
    while (true) {
      const boundary = nextRawSSEFrameBoundary(remaining);
      if (!boundary) break;
      const frameEnd = boundary.index + boundary.length;
      const event = parseResponsesSSEFrame(remaining.slice(0, boundary.index));
      consumed += frameEnd;
      remaining = remaining.slice(frameEnd);
      if (
        event?.type === "response.completed" ||
        event?.type === "response.failed" ||
        event?.type === "response.incomplete"
      ) {
        detectionBuffer = "";
        return Math.max(0, consumed - previousTailLength);
      }
    }
    if (flush && remaining.trim() !== "") {
      const event = parseResponsesSSEFrame(remaining);
      detectionBuffer = "";
      if (
        event?.type === "response.completed" ||
        event?.type === "response.failed" ||
        event?.type === "response.incomplete"
      ) {
        return Math.max(0, previousTailLength + text.length - previousTailLength);
      }
    }
    detectionBuffer = flush ? "" : remaining;
    frameGuard.resize(Buffer.byteLength(detectionBuffer));
    return null;
  }

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
        const tail = decoder.decode();
        const terminalEnd = terminalEndInChunk(tail);
        if (terminalEnd !== null) {
          if (terminalEnd > 0) yield tail.slice(0, terminalEnd);
          return;
        }
        if (tail.length > 0) yield tail;
        if (terminalEndInChunk("", true) !== null) return;
        break;
      }
      if (value) {
        const text = decoder.decode(value, { stream: true });
        const terminalEnd = terminalEndInChunk(text);
        if (terminalEnd !== null) {
          if (terminalEnd > 0) yield text.slice(0, terminalEnd);
          await reader.cancel().catch(() => {});
          return;
        }
        yield text;
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
    frameGuard.release();
  }
  throw new UpstreamError("upstream_error", "stream closed before response.completed");
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

function responseEventError(evt: Record<string, unknown>): UpstreamError {
  if (evt.type === "response.incomplete") {
    const response = isRecord(evt.response) ? evt.response : {};
    const details = isRecord(response.incomplete_details) ? response.incomplete_details : {};
    const reason =
      typeof details.reason === "string" && details.reason.length > 0 ? details.reason : "unknown";
    return new UpstreamError(
      "upstream_error",
      `Incomplete response returned, reason: ${reason}`,
      evt,
    );
  }
  const response = isRecord(evt.response) ? evt.response : {};
  const nestedError = isRecord(response.error) ? response.error : {};
  const code =
    typeof evt.code === "string"
      ? evt.code
      : typeof nestedError.code === "string"
        ? nestedError.code
        : "";
  const message =
    typeof evt.message === "string"
      ? evt.message
      : typeof nestedError.message === "string"
        ? nestedError.message
        : "codex responses stream error";
  const isQuota =
    code === "rate_limit_exceeded" ||
    code === "insufficient_quota" ||
    code === "usage_not_included";
  return new UpstreamError("upstream_error", message, evt, isQuota ? 429 : null);
}

interface ResponsesToolCallState {
  index: number;
  id: string;
  name: string;
  arguments: string;
  started: boolean;
  streamedArguments: boolean;
}

function responseToolCallId(item: Record<string, unknown>, fallback = ""): string {
  if (typeof item.call_id === "string" && item.call_id.length > 0) return item.call_id;
  if (typeof item.id === "string" && item.id.length > 0) return item.id;
  return fallback;
}

function responseToolArguments(item: Record<string, unknown>): string {
  if (typeof item.arguments === "string") return item.arguments;
  if (typeof item.input === "string") return item.input;
  return "";
}

export async function* translateResponsesSSE(
  res: Response,
  model: string,
  idleMs = 0,
  options: { strictTerminal?: boolean } = {},
): AsyncGenerator<string> {
  const strictTerminal = options.strictTerminal ?? true;
  let started = false;
  let hadToolCall = false;
  let status: unknown = "completed";
  let currentToolId = "";
  const tools = new Map<string, ResponsesToolCallState>();
  const pendingToolArguments = new Map<string, string>();

  const ensureTool = (item: Record<string, unknown>, fallbackId = ""): ResponsesToolCallState => {
    const id = responseToolCallId(item, fallbackId || `call_${tools.size}`);
    const existing = tools.get(id);
    if (existing) {
      if (typeof item.name === "string" && item.name.length > 0) existing.name = item.name;
      return existing;
    }
    const state: ResponsesToolCallState = {
      index: tools.size,
      id,
      name: typeof item.name === "string" ? item.name : "",
      arguments: pendingToolArguments.get(id) ?? "",
      started: false,
      streamedArguments: false,
    };
    tools.set(id, state);
    return state;
  };

  for await (const evt of readResponsesEvents(res, idleMs)) {
    const type = evt.type;
    if (type === "error" || type === "response.failed") {
      throw responseEventError(evt);
    }
    if (!started) {
      started = true;
      yield openaiChunk(model, { role: "assistant", content: "" }, null);
    }
    if (type === "response.output_item.added") {
      const item = (evt.item ?? {}) as Record<string, unknown>;
      if (item.type === "function_call" || item.type === "custom_tool_call") {
        hadToolCall = true;
        const tool = ensureTool(item);
        currentToolId = tool.id;
        tool.started = true;
        yield openaiChunk(
          model,
          {
            tool_calls: [
              {
                index: tool.index,
                id: tool.id,
                type: "function",
                function: { name: tool.name, arguments: "" },
              },
            ],
          },
          null,
        );
      }
    } else if (type === "response.output_item.done") {
      const item = (evt.item ?? {}) as Record<string, unknown>;
      if (item.type === "function_call" || item.type === "custom_tool_call") {
        hadToolCall = true;
        const tool = ensureTool(item, currentToolId);
        currentToolId = tool.id;
        const completeArguments =
          responseToolArguments(item) || pendingToolArguments.get(tool.id) || tool.arguments;
        if (!tool.started) {
          tool.started = true;
          tool.arguments = completeArguments;
          yield openaiChunk(
            model,
            {
              tool_calls: [
                {
                  index: tool.index,
                  id: tool.id,
                  type: "function",
                  function: { name: tool.name, arguments: completeArguments },
                },
              ],
            },
            null,
          );
        } else if (!tool.streamedArguments && completeArguments.length > 0) {
          tool.arguments = completeArguments;
          yield openaiChunk(
            model,
            {
              tool_calls: [{ index: tool.index, function: { arguments: completeArguments } }],
            },
            null,
          );
        }
      }
    } else if (type === "response.output_text.delta") {
      if (typeof evt.delta === "string") yield openaiChunk(model, { content: evt.delta }, null);
    } else if (typeof type === "string" && RESPONSES_REASONING_DELTA_TYPES.has(type)) {
      if (typeof evt.delta === "string") {
        yield openaiChunk(model, { reasoning_content: evt.delta }, null);
      }
    } else if (
      type === "response.function_call_arguments.delta" ||
      type === "response.custom_tool_call_input.delta"
    ) {
      if (typeof evt.delta === "string") {
        const eventToolId =
          typeof evt.call_id === "string"
            ? evt.call_id
            : typeof evt.item_id === "string"
              ? evt.item_id
              : currentToolId;
        const tool = tools.get(eventToolId);
        if (tool?.started) {
          tool.arguments += evt.delta;
          tool.streamedArguments = true;
          yield openaiChunk(
            model,
            { tool_calls: [{ index: tool.index, function: { arguments: evt.delta } }] },
            null,
          );
        } else if (eventToolId.length > 0) {
          pendingToolArguments.set(
            eventToolId,
            `${pendingToolArguments.get(eventToolId) ?? ""}${evt.delta}`,
          );
        }
      }
    } else if (type === "response.completed" || type === "response.incomplete") {
      const response = (evt.response ?? {}) as Record<string, unknown>;
      status = response.status ?? (type === "response.incomplete" ? "incomplete" : "completed");
      yield openaiChunk(model, {}, finishReason(status, hadToolCall));
      // include_usage terminal frame before [DONE] (order 14).
      const usage = (response.usage ?? {}) as Record<string, unknown>;
      yield openaiUsageChunk(model, usage);
      yield "data: [DONE]\n\n";
      return;
    }
  }
  if (strictTerminal) {
    throw new UpstreamError("upstream_error", "stream closed before response.completed");
  }
  if (started) {
    yield openaiChunk(model, {}, finishReason(status, hadToolCall));
    yield "data: [DONE]\n\n";
  }
}

// ── aggregation: Responses SSE -> a single OpenAI-Chat response (non-stream) ──

/** Aggregate a stream-only native Responses call without translating its payload.
 * Only response.completed is a successful terminal event. Returning the embedded
 * response object keeps native passthrough byte semantics for unary callers while
 * still failing closed on truncated or unsuccessful streams. */
export async function aggregateNativeResponsesStream(
  res: Response,
  idleMs = 0,
): Promise<Record<string, unknown>> {
  for await (const evt of readResponsesEvents(res, idleMs)) {
    const type = evt.type;
    if (type === "error" || type === "response.failed" || type === "response.incomplete") {
      throw responseEventError(evt);
    }
    if (type === "response.completed") {
      if (!isRecord(evt.response)) {
        throw new UpstreamError(
          "upstream_error",
          "response.completed did not include a native response",
          evt,
        );
      }
      return evt.response;
    }
  }
  throw new UpstreamError("upstream_error", "stream closed before response.completed");
}

export async function aggregateResponsesStream(
  res: Response,
  model: string,
  idleMs = 0,
  options: { allowIncomplete?: boolean } = {},
): Promise<ChatCompletionResponse> {
  const allowIncomplete = options.allowIncomplete ?? false;
  let text = "";
  let id = `chatcmpl-${Date.now()}`;
  let status: unknown = "completed";
  let inTok = 0;
  let outTok = 0;
  let cacheRead = 0;
  let cacheCreation = 0;
  let reasoning = "";
  let completed = false;
  // call_id -> accumulated arguments, preserving first-seen order.
  const toolOrder: string[] = [];
  const toolById = new Map<string, { id: string; name: string; arguments: string }>();
  const pendingToolArguments = new Map<string, string>();
  let currentCallId = "";

  const ensureTool = (
    item: Record<string, unknown>,
    fallbackId = "",
  ): { id: string; name: string; arguments: string } => {
    const callId = responseToolCallId(item, fallbackId || `call_${toolOrder.length}`);
    const existing = toolById.get(callId);
    if (existing) {
      if (typeof item.name === "string" && item.name.length > 0) existing.name = item.name;
      return existing;
    }
    const tool = {
      id: callId,
      name: typeof item.name === "string" ? item.name : "",
      arguments: pendingToolArguments.get(callId) ?? "",
    };
    toolById.set(callId, tool);
    toolOrder.push(callId);
    return tool;
  };

  for await (const evt of readResponsesEvents(res, idleMs)) {
    const type = evt.type;
    if (
      type === "error" ||
      type === "response.failed" ||
      (type === "response.incomplete" && !allowIncomplete)
    ) {
      throw responseEventError(evt);
    }
    if (type === "response.created") {
      const response = (evt.response ?? {}) as Record<string, unknown>;
      if (typeof response.id === "string") id = response.id;
    } else if (type === "response.output_item.added") {
      const item = (evt.item ?? {}) as Record<string, unknown>;
      if (item.type === "function_call" || item.type === "custom_tool_call") {
        const tool = ensureTool(item);
        currentCallId = tool.id;
        const args = responseToolArguments(item);
        if (args.length > 0) tool.arguments = args;
      }
    } else if (type === "response.output_item.done") {
      const item = (evt.item ?? {}) as Record<string, unknown>;
      if (item.type === "function_call" || item.type === "custom_tool_call") {
        const tool = ensureTool(item, currentCallId);
        currentCallId = tool.id;
        tool.arguments =
          responseToolArguments(item) || pendingToolArguments.get(tool.id) || tool.arguments;
      }
    } else if (type === "response.output_text.delta") {
      if (typeof evt.delta === "string") text += evt.delta;
    } else if (typeof type === "string" && RESPONSES_REASONING_DELTA_TYPES.has(type)) {
      if (typeof evt.delta === "string") reasoning += evt.delta;
    } else if (
      type === "response.function_call_arguments.delta" ||
      type === "response.custom_tool_call_input.delta"
    ) {
      if (typeof evt.delta !== "string") continue;
      const eventToolId =
        typeof evt.call_id === "string"
          ? evt.call_id
          : typeof evt.item_id === "string"
            ? evt.item_id
            : currentCallId;
      const tool = toolById.get(eventToolId);
      if (tool) tool.arguments += evt.delta;
      else if (eventToolId.length > 0) {
        pendingToolArguments.set(
          eventToolId,
          `${pendingToolArguments.get(eventToolId) ?? ""}${evt.delta}`,
        );
      }
    } else if (type === "response.function_call_arguments.done") {
      const eventToolId =
        typeof evt.call_id === "string"
          ? evt.call_id
          : typeof evt.item_id === "string"
            ? evt.item_id
            : currentCallId;
      const tc = toolById.get(eventToolId);
      if (tc && typeof evt.arguments === "string") tc.arguments = evt.arguments;
    } else if (type === "response.completed" || type === "response.incomplete") {
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
      completed = true;
      break;
    }
  }

  if (!completed) {
    throw new UpstreamError("upstream_error", "stream closed before response.completed");
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
