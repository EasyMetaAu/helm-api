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

import { createHash } from "node:crypto";
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
//
// FALLBACK version + entrypoint, used ONLY when the inbound request did NOT come from
// the real Claude Code CLI (e.g. an OpenAI/Gemini-shaped request routed to a Claude
// subscription lane), so no client billing identity was captured. For genuine CLI
// traffic the request's OWN version/entrypoint are passed through (see
// `req.metadata.client_billing_header`), which is both zero-maintenance and the most
// authentic. This fallback still wants to be a REAL recent version (a stale one is an
// anti-ban fingerprint) — verified field-for-field against the Claude Code 2.1.175
// binary (user-agent `claude-cli/<v> (external, cli)`, billing block, beta set) — but
// it is only hit by non-CLI traffic, so its staleness rarely matters. Bump with betas.
const FALLBACK_CLAUDE_CODE_VERSION = "2.1.175";
const FALLBACK_CLAUDE_CODE_ENTRYPOINT = "cli";
const OAUTH_BETA = "claude-code-20250219,oauth-2025-04-20";
const CONTEXT_MANAGEMENT_BETA = "context-management-2025-06-27";
const COMPACT_BETA = "compact-2026-01-12";
const FAST_MODE_BETA = "fast-mode-2026-02-01";
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

function withCacheControl<T extends AnthropicBlock>(block: T, cacheControl: unknown): T {
  if (cacheControl !== undefined) (block as AnthropicBlock).cache_control = cacheControl;
  return block;
}

function hasExplicitCacheControl(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasExplicitCacheControl);
  if (value === null || typeof value !== "object") return false;
  const obj = value as Record<string, unknown>;
  if (Object.hasOwn(obj, "cache_control")) return true;
  return Object.values(obj).some(hasExplicitCacheControl);
}

function normalizeAnthropicContextManagement(value: unknown): unknown {
  return Array.isArray(value) ? { edits: value } : value;
}

function dataUrlSource(url: string): { mediaType: string; data: string } | null {
  const m = url.match(/^data:([^;]+);base64,(.*)$/);
  return m?.[1] !== undefined && m[2] !== undefined ? { mediaType: m[1], data: m[2] } : null;
}

function imageBlockFromPart(part: Record<string, unknown>): AnthropicBlock | null {
  if (typeof part.data === "string") {
    return {
      type: "image",
      source: {
        type: "base64",
        media_type: typeof part.mediaType === "string" ? part.mediaType : "image/png",
        data: part.data,
      },
    };
  }
  if (typeof part.url === "string") {
    const source = dataUrlSource(part.url);
    if (source !== null) {
      return {
        type: "image",
        source: { type: "base64", media_type: source.mediaType, data: source.data },
      };
    }
  }
  return null;
}

function documentBlockFromPart(part: Record<string, unknown>): AnthropicBlock | null {
  if (typeof part.fileId === "string") {
    return {
      type: "document",
      source: { type: "file", file_id: part.fileId },
      ...(typeof part.filename === "string" ? { title: part.filename } : {}),
    };
  }
  if (typeof part.data === "string") {
    return {
      type: "document",
      source: {
        type: "base64",
        media_type: typeof part.mediaType === "string" ? part.mediaType : "application/pdf",
        data: part.data,
      },
      ...(typeof part.filename === "string" ? { title: part.filename } : {}),
    };
  }
  if (typeof part.url === "string") {
    const source = dataUrlSource(part.url);
    if (source !== null) {
      return {
        type: "document",
        source: { type: "base64", media_type: source.mediaType, data: source.data },
        ...(typeof part.filename === "string" ? { title: part.filename } : {}),
      };
    }
    return {
      type: "document",
      source: { type: "url", url: part.url },
      ...(typeof part.filename === "string" ? { title: part.filename } : {}),
    };
  }
  return null;
}

function contextManagementEdits(value: unknown): unknown[] {
  const normalized = normalizeAnthropicContextManagement(value);
  if (normalized && typeof normalized === "object" && !Array.isArray(normalized)) {
    const edits = (normalized as Record<string, unknown>).edits;
    return Array.isArray(edits) ? edits : [];
  }
  return [];
}

function betaHeaderForBody(body: Record<string, unknown>): string {
  const betas = new Set(OAUTH_BETA.split(","));
  if (body.context_management !== undefined) {
    betas.add(CONTEXT_MANAGEMENT_BETA);
    for (const edit of contextManagementEdits(body.context_management)) {
      if (edit && typeof edit === "object") {
        const type = (edit as Record<string, unknown>).type;
        if (type === "compact_20260112" || type === "compaction") betas.add(COMPACT_BETA);
      }
    }
  }
  if (body.speed === "fast") betas.add(FAST_MODE_BETA);
  return [...betas].join(",");
}

function textBlocksFromContent(content: unknown, messageCacheControl?: unknown): AnthropicBlock[] {
  if (typeof content === "string")
    return content ? [withCacheControl({ type: "text", text: content }, messageCacheControl)] : [];
  if (Array.isArray(content)) {
    return content.flatMap((part): AnthropicBlock[] => {
      if (part && typeof part === "object") {
        const p = part as Record<string, unknown>;
        const cacheControl = p.cache_control ?? messageCacheControl;
        if (p.type === "text" && typeof p.text === "string")
          return [withCacheControl({ type: "text", text: p.text }, cacheControl)];
        if (p.type === "image") {
          const block = imageBlockFromPart(p);
          return block === null ? [] : [withCacheControl(block, cacheControl)];
        }
        if (p.type === "document") {
          const block = documentBlockFromPart(p);
          return block === null ? [] : [withCacheControl(block, cacheControl)];
        }
        // image_url -> anthropic image block (base64 data URLs only; http passes through name)
        if (p.type === "image_url" && p.image_url && typeof p.image_url === "object") {
          const urlVal = (p.image_url as Record<string, unknown>).url;
          if (typeof urlVal === "string" && urlVal.startsWith("data:")) {
            const source = dataUrlSource(urlVal);
            if (source !== null) {
              return [
                withCacheControl(
                  {
                    type: "image",
                    source: { type: "base64", media_type: source.mediaType, data: source.data },
                  },
                  cacheControl,
                ),
              ];
            }
          }
        }
      }
      return [];
    });
  }
  return [];
}

function thinkingBlocksFromMessage(message: Record<string, unknown>): AnthropicBlock[] {
  const blocks = message.thinking_blocks;
  if (!Array.isArray(blocks)) return [];
  return blocks.flatMap((block): AnthropicBlock[] => {
    if (!block || typeof block !== "object") return [];
    const b = block as Record<string, unknown>;
    if (b.type === "redacted_thinking" && typeof b.data === "string") {
      return [{ type: "redacted_thinking", data: b.data }];
    }
    if (typeof b.thinking === "string") {
      return [
        {
          type: "thinking",
          thinking: b.thinking,
          ...(typeof b.signature === "string" ? { signature: b.signature } : {}),
        },
      ];
    }
    return [];
  });
}

function toolResultContentFromContent(content: unknown): string | AnthropicBlock[] {
  if (content === null || content === undefined) return "";
  if (typeof content === "string") return content;
  const blocks = textBlocksFromContent(content);
  return blocks.length > 0 ? blocks : JSON.stringify(content);
}

// Reproduce Claude Code's `x-anthropic-billing-header` attribution block as the FIRST
// system entry — the exact slot (system[0], ahead of the "You are Claude Code…"
// preamble) real CC emits it. `clientIdentity` is the inbound CLI's own
// "cc_version=<v>; cc_entrypoint=<e>" the route captured (cch dropped); we re-emit it
// verbatim for the most authentic, zero-maintenance fingerprint. When it is absent
// (non-CLI traffic) we synthesize a coherent header from the FALLBACK version instead.
//
// Either way the `cch` is the part that matters for caching: real CC derives it (and
// the version suffix) from request CONTENT and recomputes it every request, and because
// the block lives in the cached prefix that per-turn churn is precisely what guts prompt
// caching (cached_tokens=0, full prefix re-write each turn). We derive `cch` from the
// STABLE system text instead, so to Anthropic it reads as an ordinary content hash yet
// stays byte-identical across a conversation's turns — it only changes when the system
// prompt changes, exactly when the cache would invalidate anyway. The optional
// cc_workload / cc_is_subagent fields are omitted, matching a normal interactive
// main-session request. (Absence of the whole block is also legitimate — it is what
// `CLAUDE_CODE_ATTRIBUTION_HEADER=0` produces — but the subscription path presents the
// coherent positive.)
function billingHeaderBlock(systemText: string, clientIdentity?: string | null): AnthropicBlock {
  const digest = createHash("sha256").update(systemText, "utf8").digest("hex");
  const cch = digest.slice(0, 5);
  const identity =
    clientIdentity != null && clientIdentity.length > 0
      ? clientIdentity
      : `cc_version=${FALLBACK_CLAUDE_CODE_VERSION}.${digest.slice(5, 8)}; cc_entrypoint=${FALLBACK_CLAUDE_CODE_ENTRYPOINT}`;
  return { type: "text", text: `x-anthropic-billing-header: ${identity}; cch=${cch};` };
}

// Build the Anthropic system param: the Claude-Code billing block at system[0], the
// spoof preamble at system[1], then the folded client system. Both `system` AND
// `developer` turns fold here, in original message order — Anthropic has no
// `developer` role (it is OpenAI's renamed system tier), so dropping it to a user turn
// would shift instruction precedence and leak hidden instructions. Mirrors LiteLLM
// map_developer_role_to_system_role + the Gemini collectSystemText policy (developer
// == system, order preserved).
function buildSystem(
  messages: Array<Record<string, unknown>>,
  clientIdentity?: string | null,
): AnthropicBlock[] {
  const sys: AnthropicBlock[] = [{ type: "text", text: SYSTEM_SPOOF }];
  for (const m of messages) {
    if (m.role !== "system" && m.role !== "developer") continue;
    for (const b of textBlocksFromContent(m.content, m.cache_control)) sys.push(b);
  }
  // Derive the billing block from the (stable) text it precedes, then put it first.
  const systemText = sys.map((b) => String(b.text ?? "")).join("\n");
  return [billingHeaderBlock(systemText, clientIdentity), ...sys];
}

// Build the `claude-cli/<version> (external, <entrypoint>)` user-agent from the billing
// block at system[0] (the version WITHOUT its 3-hex build suffix, matching real CC's
// user-agent). Reading it back from the assembled body keeps the header in lockstep
// with whatever identity buildSystem emitted — the client's real one or the fallback —
// so the two can never drift. Falls back to the baked default if the block is missing.
const UA_VERSION_RE = /cc_version=([0-9]+(?:\.[0-9]+)*)\.[0-9a-f]{3}(?:;|\s|$)/;
const UA_ENTRYPOINT_RE = /cc_entrypoint=([a-z][a-z0-9_-]{0,31})(?:;|\s|$)/;

function userAgentFromBody(body: Record<string, unknown>): string {
  const sys = body.system;
  const first = Array.isArray(sys) ? (sys[0] as { text?: unknown } | undefined) : undefined;
  const text = typeof first?.text === "string" ? first.text : "";
  const version = text.match(UA_VERSION_RE)?.[1] ?? FALLBACK_CLAUDE_CODE_VERSION;
  const entrypoint = text.match(UA_ENTRYPOINT_RE)?.[1] ?? FALLBACK_CLAUDE_CODE_ENTRYPOINT;
  return `claude-cli/${version} (external, ${entrypoint})`;
}

function toAnthropicMessages(messages: Array<Record<string, unknown>>): AnthropicMessage[] {
  const out: AnthropicMessage[] = [];
  const push = (message: AnthropicMessage): void => {
    const prev = out[out.length - 1];
    if (prev !== undefined && prev.role === message.role) {
      prev.content.push(...message.content);
      return;
    }
    out.push(message);
  };

  for (const m of messages) {
    const role = m.role;
    // system + developer both fold into the top-level system param (buildSystem).
    if (role === "system" || role === "developer") continue;
    if (role === "tool") {
      // OpenAI tool result -> anthropic tool_result block on a user message.
      push({
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: String(m.tool_call_id ?? ""),
            content: toolResultContentFromContent(m.content),
            ...(m.cache_control !== undefined ? { cache_control: m.cache_control } : {}),
          },
        ],
      });
      continue;
    }
    if (role === "assistant") {
      const blocks: AnthropicBlock[] = [
        ...thinkingBlocksFromMessage(m),
        ...textBlocksFromContent(m.content, m.cache_control),
      ];
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
      push({
        role: "assistant",
        content: blocks.length ? blocks : [{ type: "text", text: "" }],
      });
      continue;
    }
    // user (default)
    push({ role: "user", content: textBlocksFromContent(m.content, m.cache_control) });
  }
  return out;
}

export function openaiToAnthropicRequest(
  req: ChatCompletionRequest,
  opts?: { metadataUserId?: string },
): Record<string, unknown> {
  const r = req as Record<string, unknown>;
  const messages = Array.isArray(r.messages) ? (r.messages as Array<Record<string, unknown>>) : [];
  // The inbound CLI's own billing identity (version + entrypoint), captured by the
  // route; re-emitted verbatim in the billing block so the upstream fingerprint is the
  // client's REAL version, not a pinned spoof. Absent for non-CLI traffic → fallback.
  const clientIdentity =
    typeof (r.metadata as Record<string, unknown> | undefined)?.client_billing_header === "string"
      ? ((r.metadata as Record<string, unknown>).client_billing_header as string)
      : null;
  const body: Record<string, unknown> = {
    model: r.model,
    system: buildSystem(messages, clientIdentity),
    messages: toAnthropicMessages(messages),
    max_tokens:
      typeof r.max_completion_tokens === "number"
        ? r.max_completion_tokens
        : typeof r.max_tokens === "number"
          ? r.max_tokens
          : DEFAULT_MAX_TOKENS,
  };
  // Anti-ban stable device identity: forward the ready-made, per-account-stable
  // user_id verbatim. Anthropic's metadata.user_id is an opaque ≤256-char string;
  // we carry {device_id, account_uuid, session_id} like the official client.
  if (opts?.metadataUserId) body.metadata = { user_id: opts.metadataUserId };
  if (typeof r.temperature === "number") body.temperature = r.temperature;
  if (typeof r.top_p === "number") body.top_p = r.top_p;
  if (typeof r.top_k === "number") body.top_k = r.top_k;
  if (r.thinking && typeof r.thinking === "object") body.thinking = r.thinking;
  if (r.context_management !== undefined) {
    body.context_management = normalizeAnthropicContextManagement(r.context_management);
  }
  if (r.mcp_servers !== undefined) body.mcp_servers = r.mcp_servers;
  if (r.container !== undefined) body.container = r.container;
  if (r.speed !== undefined) body.speed = r.speed;
  if (r.output_config !== undefined) body.output_config = r.output_config;
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
          ...(t.cache_control !== undefined
            ? { cache_control: t.cache_control }
            : fn.cache_control !== undefined
              ? { cache_control: fn.cache_control }
              : {}),
        },
      ];
    });
    if (tools.length) body.tools = tools;
  }
  const toolChoice = anthropicToolChoice(r.tool_choice, r.parallel_tool_calls);
  if (toolChoice !== undefined) body.tool_choice = toolChoice;
  if (
    r.cache_control !== undefined &&
    typeof r.cache_control === "object" &&
    r.cache_control !== null &&
    !hasExplicitCacheControl([body.system, body.messages, body.tools])
  ) {
    body.cache_control = r.cache_control;
  }
  return body;
}

function anthropicToolChoice(
  toolChoice: unknown,
  parallelToolCalls: unknown,
): Record<string, unknown> | undefined {
  let out: Record<string, unknown> | undefined;
  if (toolChoice === "auto") out = { type: "auto" };
  else if (toolChoice === "required") out = { type: "any" };
  else if (toolChoice === "none" || toolChoice === undefined || toolChoice === null)
    out = undefined;
  else if (typeof toolChoice === "object") {
    const tc = toolChoice as { type?: unknown; function?: { name?: unknown }; name?: unknown };
    if (tc.type === "function" && typeof tc.function?.name === "string") {
      out = { type: "tool", name: tc.function.name };
    } else {
      out = toolChoice as Record<string, unknown>;
    }
  }
  if (parallelToolCalls === false) {
    return { ...(out ?? { type: "auto" }), disable_parallel_tool_use: true };
  }
  return out;
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
  const cacheRead =
    typeof usage.cache_read_input_tokens === "number" ? usage.cache_read_input_tokens : 0;
  const cacheCreation =
    typeof usage.cache_creation_input_tokens === "number" ? usage.cache_creation_input_tokens : 0;
  const promptTokens = inTok + cacheRead + cacheCreation;
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
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: outTok,
      total_tokens: promptTokens + outTok,
      ...(cacheRead > 0 || cacheCreation > 0
        ? {
            prompt_tokens_details: {
              cached_tokens: cacheRead,
              ...(cacheCreation > 0 ? { cache_creation_tokens: cacheCreation } : {}),
            },
          }
        : {}),
    },
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

  async function headers(body: Record<string, unknown>): Promise<Record<string, string>> {
    const h: Record<string, string> = {
      "Content-Type": "application/json",
      // Header parity with openclaw's OAuth recipe — both are load-bearing for the
      // Claude-Code identity the subscription endpoint expects.
      accept: "application/json",
      "anthropic-dangerous-direct-browser-access": "true",
      "anthropic-version": ANTHROPIC_VERSION,
      "anthropic-beta": betaHeaderForBody(body),
      // Keep the user-agent coherent with the billing block at system[0]: derive its
      // version + entrypoint from the SAME identity emitted there (the client's real
      // one when present, else the fallback) so the two never disagree.
      "user-agent": userAgentFromBody(body),
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
        headers: await headers(body),
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

    // Native protocol passthrough (issue #217, Phase 1): the inbound /v1/messages body
    // is ALREADY Anthropic-native, so forward it VERBATIM and return the upstream's
    // native JSON untranslated. Reuses the same HTTP core (headers/withTimeout/
    // 401-retry/scrub/errorFromResponse) but SKIPS both translators —
    // `openaiToAnthropicRequest` (no spoof injection / no openai->anthropic mangling)
    // and `anthropicToOpenAIResponse` (no response wrapping). `headers(body)` derives
    // beta/user-agent/auth from the native body's own system[0]/context_management/speed,
    // so the same closure works unchanged on a native body.
    async nativePassthrough(body, opts) {
      const res = await requestWithRetry(body, opts?.signal);
      if (!res.ok) throw await errorFromResponse(res);
      return (await res.json()) as Record<string, unknown>;
    },

    // Streaming native passthrough (issue #217, Phase 2). The native body from a
    // STREAMING /v1/messages client ALREADY carries `stream:true`, so it is forwarded
    // VERBATIM — NO `stream:true` injection, NO `openaiToAnthropicRequest` translation.
    // The 401-retry / non-2xx error path runs BEFORE the first chunk (same as
    // chatCompletionStream), then the upstream SSE is BYTE-RELAYED unchanged via
    // readAnthropicSSERaw — no SSE re-mapping state machine to mis-translate (principle 8).
    async *nativePassthroughStream(body, opts) {
      const res = await requestWithRetry(body, opts?.signal);
      if (!res.ok) throw await errorFromResponse(res);
      yield* readAnthropicSSERaw(res, timeoutMs);
    },
  };
}

// Byte-faithful Anthropic SSE reader for native passthrough (issue #217, Phase 2).
// Yields the upstream body's decoded text VERBATIM using the SAME reader pattern as
// translateAnthropicSSE (getReader + TextDecoder + readChunkWithIdle idle guard +
// StreamStalledError → UpstreamError("timeout")), but with NO frame splitting and NO
// translation. The raw bytes (the `data:` JSON payload) reach the client untouched; only
// the standard SSE envelope is reframed downstream by Hono's writeSSE (semantically
// identical). This ELIMINATES the convertOpenAIStreamToAnthropic state machine — the
// real #221/#222 bug source — instead of replacing it.
export async function* readAnthropicSSERaw(
  res: Response,
  // Inter-chunk liveness deadline (ms); 0 disables. Threaded from the client's request
  // timeout so a stream that wedges mid-flight is reclaimed (the connect/TTFB timeout was
  // already cleared once headers arrived). Identical semantics to translateAnthropicSSE.
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
        ? {
            prompt_tokens_details: {
              cached_tokens: usage.cacheRead,
              ...(usage.cacheCreation > 0 ? { cache_creation_tokens: usage.cacheCreation } : {}),
            },
          }
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
          if (typeof u.cache_creation_input_tokens === "number")
            usageCacheCreation = Math.max(usageCacheCreation, u.cache_creation_input_tokens);
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
