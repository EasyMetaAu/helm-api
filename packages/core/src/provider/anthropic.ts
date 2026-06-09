// Native Anthropic Messages executor (issue #38) — routes Helm's internal
// OpenAI-Chat IR to the Anthropic /v1/messages API, used by Claude Pro/Max
// SUBSCRIPTION (OAuth) providers. Implements the same ProviderClient interface as
// the OpenAI client so the executor dispatches by provider name identically.
//
// Why a native executor (not the OpenAI client): the Claude subscription endpoint
// speaks the Anthropic Messages protocol and requires Claude-Code identity headers
// + a spoofed system preamble; an OpenAI-Chat body would be rejected. The
// protocol/anthropic transformers are INBOUND-only (serve an Anthropic-API client
// by going to/from the OpenAI-shaped IR), so this executor carries the inverse
// translation (OpenAI-Chat IR -> Anthropic request, Anthropic response/SSE -> IR).
//
// ⚠️ ToS: subscription use via a third-party gateway may violate Anthropic's terms
// (see README disclaimer). Identity recipe ported from openclaw (MIT).

import {
  type ChatCompletionRequest,
  type ChatCompletionResponse,
  type ProviderClient,
  UpstreamError,
} from "./openai.js";
import { readChunkWithIdle, StreamStalledError } from "./stream-idle.js";

export interface AnthropicClientConfig {
  baseUrl: string; // e.g. https://api.anthropic.com (NO /v1)
  apiKey?: string; // static x-api-key path (rare); mutually exclusive with getAuthHeader
  getAuthHeader?: () => Promise<string>; // dynamic "Bearer <oauth-access>"
  onUnauthorized?: () => void; // 401 hook -> force token refresh, replay once
  currentSecrets?: () => string[]; // live token set for redaction
  timeoutMs?: number;
  // Anti-ban stable device identity (Claude subscription, ref claude-relay-service):
  // an opaque, per-account-STABLE string sent verbatim as `metadata.user_id` on every
  // request. Computed ONCE per account upstream (deterministic, never per-request) so
  // the device identity never rotates — the real-client posture Anthropic expects.
  // Undefined → no `metadata` is sent (back-compat; matches openclaw's default).
  metadataUserId?: string;
}

export interface AnthropicClientDeps {
  config: AnthropicClientConfig;
  fetch?: typeof globalThis.fetch;
}

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_TOKENS = 4096;
const ANTHROPIC_VERSION = "2023-06-01";
// Claude-Code identity (openclaw src/llm/providers/anthropic.ts). All load-bearing
// for the OAuth subscription endpoint — without them it 401/403s.
const CLAUDE_CODE_VERSION = "1.0.0";
const OAUTH_BETA = "claude-code-20250219,oauth-2025-04-20";
const SYSTEM_SPOOF = "You are Claude Code, Anthropic's official CLI for Claude.";

// ── request translation: OpenAI-Chat IR -> Anthropic Messages ────────────────

interface AnthropicBlock {
  type: string;
  [k: string]: unknown;
}
interface AnthropicMessage {
  role: "user" | "assistant";
  content: AnthropicBlock[];
}

function textBlocksFromContent(content: unknown): AnthropicBlock[] {
  if (typeof content === "string") return content ? [{ type: "text", text: content }] : [];
  if (Array.isArray(content)) {
    return content.flatMap((part): AnthropicBlock[] => {
      if (part && typeof part === "object") {
        const p = part as Record<string, unknown>;
        if (p.type === "text" && typeof p.text === "string")
          return [{ type: "text", text: p.text }];
        // image_url -> anthropic image block (base64 data URLs only; http passes through name)
        if (p.type === "image_url" && p.image_url && typeof p.image_url === "object") {
          const urlVal = (p.image_url as Record<string, unknown>).url;
          if (typeof urlVal === "string" && urlVal.startsWith("data:")) {
            const m = urlVal.match(/^data:([^;]+);base64,(.*)$/);
            if (m) {
              return [{ type: "image", source: { type: "base64", media_type: m[1], data: m[2] } }];
            }
          }
        }
      }
      return [];
    });
  }
  return [];
}

// Extract the system prompt (string or array) and ALWAYS prepend the Claude-Code
// spoof as system[0] (mandatory for the OAuth subscription endpoint). Both
// `system` AND `developer` turns fold here, in original message order — Anthropic
// has no `developer` role (it is OpenAI's renamed system tier), so dropping it to
// a user turn would shift instruction precedence and leak hidden instructions.
// Mirrors LiteLLM map_developer_role_to_system_role + the Gemini collectSystemText
// policy (developer == system, order preserved).
function buildSystem(messages: Array<Record<string, unknown>>): AnthropicBlock[] {
  const sys: AnthropicBlock[] = [{ type: "text", text: SYSTEM_SPOOF }];
  for (const m of messages) {
    if (m.role !== "system" && m.role !== "developer") continue;
    for (const b of textBlocksFromContent(m.content)) sys.push(b);
  }
  return sys;
}

function toAnthropicMessages(messages: Array<Record<string, unknown>>): AnthropicMessage[] {
  const out: AnthropicMessage[] = [];
  for (const m of messages) {
    const role = m.role;
    // system + developer both fold into the top-level system param (buildSystem).
    if (role === "system" || role === "developer") continue;
    if (role === "tool") {
      // OpenAI tool result -> anthropic tool_result block on a user message.
      out.push({
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: String(m.tool_call_id ?? ""),
            content: typeof m.content === "string" ? m.content : JSON.stringify(m.content ?? ""),
          },
        ],
      });
      continue;
    }
    if (role === "assistant") {
      const blocks: AnthropicBlock[] = textBlocksFromContent(m.content);
      const toolCalls = Array.isArray(m.tool_calls) ? m.tool_calls : [];
      for (const tc of toolCalls as Array<Record<string, unknown>>) {
        const fn = (tc.function ?? {}) as Record<string, unknown>;
        let args: unknown = {};
        try {
          args = fn.arguments ? JSON.parse(String(fn.arguments)) : {};
        } catch {
          args = {};
        }
        blocks.push({
          type: "tool_use",
          id: String(tc.id ?? ""),
          name: String(fn.name ?? ""),
          input: args,
        });
      }
      out.push({
        role: "assistant",
        content: blocks.length ? blocks : [{ type: "text", text: "" }],
      });
      continue;
    }
    // user (default)
    out.push({ role: "user", content: textBlocksFromContent(m.content) });
  }
  return out;
}

export function openaiToAnthropicRequest(
  req: ChatCompletionRequest,
  opts?: { metadataUserId?: string },
): Record<string, unknown> {
  const r = req as Record<string, unknown>;
  const messages = Array.isArray(r.messages) ? (r.messages as Array<Record<string, unknown>>) : [];
  const body: Record<string, unknown> = {
    model: r.model,
    system: buildSystem(messages),
    messages: toAnthropicMessages(messages),
    max_tokens: typeof r.max_tokens === "number" ? r.max_tokens : DEFAULT_MAX_TOKENS,
  };
  // Anti-ban stable device identity: forward the ready-made, per-account-stable
  // user_id verbatim. Anthropic's metadata.user_id is an opaque ≤256-char string;
  // we carry {device_id, account_uuid, session_id} like the official client.
  if (opts?.metadataUserId) body.metadata = { user_id: opts.metadataUserId };
  if (typeof r.temperature === "number") body.temperature = r.temperature;
  if (typeof r.top_p === "number") body.top_p = r.top_p;
  if (r.stream === true) body.stream = true;
  if (typeof r.stop === "string") body.stop_sequences = [r.stop];
  else if (Array.isArray(r.stop)) body.stop_sequences = r.stop;
  // tools: OpenAI function tools -> anthropic tools.
  if (Array.isArray(r.tools)) {
    const tools = (r.tools as Array<Record<string, unknown>>).flatMap((t) => {
      const fn = (t.function ?? {}) as Record<string, unknown>;
      if (!fn.name) return [];
      return [
        {
          name: fn.name,
          description: fn.description ?? "",
          input_schema: fn.parameters ?? { type: "object" },
        },
      ];
    });
    if (tools.length) body.tools = tools;
  }
  return body;
}

// ── response translation: Anthropic Messages -> OpenAI-Chat ──────────────────

const STOP_MAP: Record<string, string> = {
  end_turn: "stop",
  max_tokens: "length",
  stop_sequence: "stop",
  tool_use: "tool_calls",
};

export function anthropicToOpenAIResponse(
  resp: Record<string, unknown>,
  model: string,
): ChatCompletionResponse {
  const content = Array.isArray(resp.content)
    ? (resp.content as Array<Record<string, unknown>>)
    : [];
  let text = "";
  const toolCalls: Array<Record<string, unknown>> = [];
  for (const block of content) {
    if (block.type === "text" && typeof block.text === "string") text += block.text;
    if (block.type === "tool_use") {
      toolCalls.push({
        id: block.id,
        type: "function",
        function: { name: block.name, arguments: JSON.stringify(block.input ?? {}) },
      });
    }
  }
  const usage = (resp.usage ?? {}) as Record<string, unknown>;
  const inTok = typeof usage.input_tokens === "number" ? usage.input_tokens : 0;
  const outTok = typeof usage.output_tokens === "number" ? usage.output_tokens : 0;
  const message: Record<string, unknown> = { role: "assistant", content: text || null };
  if (toolCalls.length) message.tool_calls = toolCalls;
  return {
    id: resp.id ?? `chatcmpl-${Date.now()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message,
        finish_reason: STOP_MAP[String(resp.stop_reason)] ?? "stop",
      },
    ],
    usage: { prompt_tokens: inTok, completion_tokens: outTok, total_tokens: inTok + outTok },
  };
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

export function createAnthropicClient(deps: AnthropicClientDeps): ProviderClient {
  const doFetch = deps.fetch ?? globalThis.fetch;
  const cfg = deps.config;
  const timeoutMs = cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const url = `${cfg.baseUrl}/v1/messages`;

  const hasStatic = cfg.apiKey !== undefined;
  const hasDynamic = cfg.getAuthHeader !== undefined;
  if (hasStatic === hasDynamic) {
    throw new Error("anthropic client requires exactly one of `apiKey` or `getAuthHeader`");
  }

  async function headers(): Promise<Record<string, string>> {
    const h: Record<string, string> = {
      "Content-Type": "application/json",
      // Header parity with openclaw's OAuth recipe — both are load-bearing for the
      // Claude-Code identity the subscription endpoint expects.
      accept: "application/json",
      "anthropic-dangerous-direct-browser-access": "true",
      "anthropic-version": ANTHROPIC_VERSION,
      "anthropic-beta": OAUTH_BETA,
      "user-agent": `claude-cli/${CLAUDE_CODE_VERSION}`,
      "x-app": "cli",
    };
    if (cfg.getAuthHeader) h.Authorization = await cfg.getAuthHeader();
    else h["x-api-key"] = cfg.apiKey as string;
    return h;
  }

  function scrub(raw: unknown): unknown {
    if (raw === null) return raw;
    const secrets = cfg.currentSecrets ? cfg.currentSecrets() : [];
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

  async function request(body: Record<string, unknown>, external?: AbortSignal): Promise<Response> {
    const t = withTimeout(timeoutMs, external);
    try {
      return await doFetch(url, {
        method: "POST",
        headers: await headers(),
        body: JSON.stringify(body),
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

  async function requestWithRetry(
    body: Record<string, unknown>,
    external?: AbortSignal,
  ): Promise<Response> {
    const res = await request(body, external);
    if (res.status === 401 && cfg.onUnauthorized !== undefined) {
      await res.body?.cancel().catch(() => {});
      cfg.onUnauthorized();
      return await request(body, external);
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
    async chatCompletion(req, opts) {
      const model = String((req as Record<string, unknown>).model ?? "");
      const res = await requestWithRetry(
        openaiToAnthropicRequest(req, { metadataUserId: cfg.metadataUserId }),
        opts?.signal,
      );
      if (!res.ok) throw await errorFromResponse(res);
      const anthResp = (await res.json()) as Record<string, unknown>;
      return anthropicToOpenAIResponse(anthResp, model);
    },

    async *chatCompletionStream(req, opts) {
      const model = String((req as Record<string, unknown>).model ?? "");
      const body = {
        ...openaiToAnthropicRequest(req, { metadataUserId: cfg.metadataUserId }),
        stream: true,
      };
      const res = await requestWithRetry(body, opts?.signal);
      if (!res.ok) throw await errorFromResponse(res);
      yield* translateAnthropicSSE(res, model, timeoutMs);
    },
  };
}

// ── streaming translation: Anthropic SSE -> OpenAI-Chat SSE strings ──────────

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

// OpenAI's stream_options.include_usage convention: a FINAL chunk carrying empty
// choices + a usage object (prompt = full input incl cache; cached reported via
// prompt_tokens_details). execute.ts always sets include_usage on streaming, so an
// OpenAI client (and the budget settle) depends on this frame being emitted.
function openaiUsageChunk(
  model: string,
  usage: { input: number; output: number; cacheRead: number; cacheCreation: number },
): string {
  const promptTokens = usage.input + usage.cacheRead + usage.cacheCreation;
  const chunk = {
    id: `chatcmpl-${Date.now()}`,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [] as never[],
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: usage.output,
      total_tokens: promptTokens + usage.output,
      ...(usage.cacheRead > 0 || usage.cacheCreation > 0
        ? { prompt_tokens_details: { cached_tokens: usage.cacheRead } }
        : {}),
    },
  };
  return `data: ${JSON.stringify(chunk)}\n\n`;
}

export async function* translateAnthropicSSE(
  res: Response,
  model: string,
  // Inter-chunk liveness deadline (ms); 0 disables. Threaded from the client's
  // request timeout so a stream that wedges mid-flight is reclaimed rather than
  // hanging forever (the connect/TTFB timeout was already cleared at headers).
  idleMs = 0,
): AsyncGenerator<string> {
  const body = res.body;
  if (!body) return;
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  // tool-call streaming state: anthropic emits one content_block per tool_use.
  let toolIndex = -1;
  let started = false;
  // include_usage accumulation: input/cache land on message_start, output on
  // message_delta. Emitted as a terminal usage chunk before [DONE] (OpenAI convention).
  let usageInput = 0;
  let usageOutput = 0;
  let usageCacheRead = 0;
  let usageCacheCreation = 0;
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
      buffer += decoder.decode(value, { stream: true });
      const events = buffer.split("\n\n");
      buffer = events.pop() ?? "";
      for (const raw of events) {
        const dataLine = raw.split("\n").find((l) => l.startsWith("data:"));
        if (!dataLine) continue;
        let evt: Record<string, unknown>;
        try {
          evt = JSON.parse(dataLine.slice(5).trim());
        } catch {
          continue;
        }
        const type = evt.type;
        if (type === "message_start" && !started) {
          started = true;
          const u = ((evt.message as Record<string, unknown> | undefined)?.usage ?? {}) as Record<
            string,
            unknown
          >;
          if (typeof u.input_tokens === "number") usageInput = u.input_tokens;
          if (typeof u.cache_read_input_tokens === "number")
            usageCacheRead = u.cache_read_input_tokens;
          if (typeof u.cache_creation_input_tokens === "number")
            usageCacheCreation = u.cache_creation_input_tokens;
          yield openaiChunk(model, { role: "assistant", content: "" }, null);
        } else if (type === "content_block_start") {
          const block = (evt.content_block ?? {}) as Record<string, unknown>;
          if (block.type === "tool_use") {
            toolIndex += 1;
            yield openaiChunk(
              model,
              {
                tool_calls: [
                  {
                    index: toolIndex,
                    id: block.id,
                    type: "function",
                    function: { name: block.name, arguments: "" },
                  },
                ],
              },
              null,
            );
          }
        } else if (type === "content_block_delta") {
          const d = (evt.delta ?? {}) as Record<string, unknown>;
          if (d.type === "text_delta" && typeof d.text === "string") {
            yield openaiChunk(model, { content: d.text }, null);
          } else if (d.type === "input_json_delta" && typeof d.partial_json === "string") {
            yield openaiChunk(
              model,
              {
                tool_calls: [
                  { index: Math.max(0, toolIndex), function: { arguments: d.partial_json } },
                ],
              },
              null,
            );
          }
        } else if (type === "message_delta") {
          const d = (evt.delta ?? {}) as Record<string, unknown>;
          const u = (evt.usage ?? {}) as Record<string, unknown>;
          if (typeof u.output_tokens === "number") usageOutput = u.output_tokens;
          if (typeof u.cache_read_input_tokens === "number")
            usageCacheRead = Math.max(usageCacheRead, u.cache_read_input_tokens);
          if (typeof d.stop_reason === "string") {
            yield openaiChunk(model, {}, STOP_MAP[d.stop_reason] ?? "stop");
          }
        } else if (type === "message_stop") {
          // include_usage: emit the terminal usage frame BEFORE [DONE] so an OpenAI
          // client and the budget settle see the real token counts (order 14).
          yield openaiUsageChunk(model, {
            input: usageInput,
            output: usageOutput,
            cacheRead: usageCacheRead,
            cacheCreation: usageCacheCreation,
          });
          yield "data: [DONE]\n\n";
          // Terminal event: stop reading NOW. Otherwise the next read would block
          // on the idle guard and could turn a completed response into a spurious
          // timeout if the upstream delays closing the HTTP body after message_stop.
          return;
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}
