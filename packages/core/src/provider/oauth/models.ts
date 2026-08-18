// Model discovery for OAuth subscription providers (issue #38). Answers "which
// models can this bound subscription use?" so they become routable aliases +
// show up in the Lanes picker.
//
// Strategy (maintainer decision): discover live where an API exists, else fall
// back to a curated list. Copilot, Anthropic, and ChatGPT Codex are queried LIVE
// with the account's token. Any list is
// OVERRIDABLE by declaring the provider with its own models[] in providers.yaml
// (that wins).

import { arch, platform, release } from "node:os";
import type { ResponseWorkAdmission } from "../../runtime/response-work-admission.js";
import { readUpstreamJsonWithinBudget } from "../openai.js";
import { type CodexModelInfo, CodexModelsResponseSchema } from "./codex-model-info.js";
import { listGitHubCopilotModels } from "./github-copilot.js";
import { parseOpenAICodexIdentity } from "./openai-codex.js";
import { buildOAuthRequestSignal } from "./runtime.js";
import { XAI_GROK_OAUTH_BASE_URL, xaiGrokCatalogHeaders } from "./xai.js";

// Curated FALLBACK model ids — used when live discovery is unavailable or fails.
// Anthropic and Codex are normally live; these are only their safety net.
export const CURATED_OAUTH_MODELS: Record<string, string[]> = {
  anthropic: ["claude-opus-4-6", "claude-sonnet-5", "claude-haiku-4-5"],
  // ChatGPT Codex set. The family alias is derived from Sol entitlement and is
  // never an independent authorization source.
  "openai-codex": [
    "gpt-5.6",
    "gpt-5.6-sol",
    "gpt-5.6-terra",
    "gpt-5.6-luna",
    "gpt-5.5",
    "gpt-5.4",
    "gpt-5.4-mini",
    "gpt-realtime",
    "gpt-realtime-1.5",
    "gpt-live-1-boulder-alpha",
  ],
};

// Grok Imagine is a separate, verified OAuth media capability. Keep it out of
// the text-model discovery catalog: its upstream `apiBackend` is not Responses,
// and treating it as such would incorrectly make it chat-routable.
export const GROK_OAUTH_MEDIA_MODELS = [
  "grok-imagine-image",
  "grok-imagine-image-quality",
  "grok-imagine-video-1.5-preview",
  "grok-imagine-video",
] as const;

const OPENAI_CODEX_MODEL_ALIASES: Readonly<Record<string, string>> = {
  "gpt-5.6": "gpt-5.6-sol",
};

const RETIRED_OPENAI_CODEX_MODELS = new Set(["gpt-5.3-codex-spark"]);

export function isRetiredOpenAICodexModel(model: string): boolean {
  return RETIRED_OPENAI_CODEX_MODELS.has(model.trim().toLowerCase());
}

export function isRetiredOpenAICodexLimit(
  limitId: string | null | undefined,
  limitName: string | null | undefined,
): boolean {
  const normalizedId = limitId?.trim().toLowerCase().replaceAll("-", "_");
  if (normalizedId === "codex_spark") return true;
  const normalizedName = limitName?.trim().toLowerCase().replaceAll("_", "-");
  return normalizedName?.endsWith("-codex-spark") === true;
}

export function filterRetiredOpenAICodexLimits<
  T extends { limitId?: string | null; limitName?: string | null },
>(limits: readonly T[] | null | undefined): T[] {
  return (limits ?? []).filter(
    (limit) => !isRetiredOpenAICodexLimit(limit.limitId, limit.limitName),
  );
}

export function resolveOpenAICodexModelAlias(model: string): string {
  return OPENAI_CODEX_MODEL_ALIASES[model] ?? model;
}

export function expandOpenAICodexModelAliases(models: readonly string[]): string[] {
  const expanded = [...new Set(models.filter((model) => !isRetiredOpenAICodexModel(model)))];
  for (const [alias, target] of Object.entries(OPENAI_CODEX_MODEL_ALIASES)) {
    if (expanded.includes(target) && !expanded.includes(alias)) expanded.push(alias);
  }
  return expanded;
}

// Codex sends the whole semver (major.minor.patch) to /models. The current main
// branch is the 0.145.0 line; alpha suffixes are intentionally omitted, matching
// codex-rs/models-manager::client_version_to_whole.
export const DEFAULT_OPENAI_CODEX_CLIENT_VERSION = "0.145.0";
export const OPENAI_CODEX_CLIENT_VERSION_ENV = "HELM_OPENAI_CODEX_CLIENT_VERSION";
// Provider-model discovery is an admin observability action. It must never inherit
// Node fetch's multi-minute default and block the providers page refresh worker.
export const OAUTH_MODEL_DISCOVERY_TIMEOUT_MS = 10_000;

export interface OpenAICodexModelsOptions {
  accountId?: string;
  isFedramp?: boolean;
  clientVersion?: string;
  userAgent?: string;
  fetchImpl?: typeof globalThis.fetch;
  timeoutMs?: number;
  signal?: AbortSignal;
  responseWorkAdmission?: ResponseWorkAdmission;
}

export interface OpenAICodexModelsResult {
  models: CodexModelInfo[];
  etag?: string;
  reasoningIncluded?: boolean;
}

export class OpenAICodexModelsError extends Error {
  readonly httpStatus: number;

  constructor(httpStatus: number) {
    super(`OpenAI Codex /models HTTP ${httpStatus}`);
    this.name = "OpenAICodexModelsError";
    this.httpStatus = httpStatus;
  }
}

function assertSemanticClientVersion(version: string): void {
  if (!/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error(`OpenAI Codex client version must be an x.y.z semantic version: ${version}`);
  }
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

export function resolveOpenAICodexClientVersion(
  env: Readonly<Record<string, string | undefined>> = process.env,
): string {
  const version =
    env[OPENAI_CODEX_CLIENT_VERSION_ENV]?.trim() || DEFAULT_OPENAI_CODEX_CLIENT_VERSION;
  assertSemanticClientVersion(version);
  return version;
}

export function buildOpenAICodexUserAgent(clientVersion: string): string {
  assertSemanticClientVersion(clientVersion);
  return `codex_cli_rs/${clientVersion} (${sanitizeUserAgentComment(codexOsType())} ${sanitizeUserAgentComment(release())}; ${sanitizeUserAgentComment(arch())}) ${terminalUserAgentToken()}`;
}

export async function listOpenAICodexModels(
  accessToken: string,
  options: OpenAICodexModelsOptions = {},
): Promise<OpenAICodexModelsResult> {
  const clientVersion = options.clientVersion ?? resolveOpenAICodexClientVersion();
  assertSemanticClientVersion(clientVersion);

  const identity = parseOpenAICodexIdentity(accessToken);
  const accountId = options.accountId ?? identity.accountId;
  const isFedramp = options.isFedramp ?? identity.isFedramp;
  const url = new URL("https://chatgpt.com/backend-api/codex/models");
  url.searchParams.set("client_version", clientVersion);

  const headers = new Headers({
    Accept: "application/json",
    Authorization: `Bearer ${accessToken}`,
    originator: "codex_cli_rs",
    version: clientVersion,
    "user-agent": options.userAgent ?? buildOpenAICodexUserAgent(clientVersion),
  });
  if (accountId) headers.set("chatgpt-account-id", accountId);
  if (isFedramp) headers.set("X-OpenAI-Fedramp", "true");

  const timeoutMs =
    typeof options.timeoutMs === "number" && Number.isFinite(options.timeoutMs)
      ? Math.max(1, Math.floor(options.timeoutMs))
      : OAUTH_MODEL_DISCOVERY_TIMEOUT_MS;
  const response = await (options.fetchImpl ?? fetch)(url.toString(), {
    headers,
    signal: buildOAuthRequestSignal({ signal: options.signal, timeoutMs }),
  });
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    throw new OpenAICodexModelsError(response.status);
  }

  let body: unknown;
  try {
    body = await readUpstreamJsonWithinBudget(response, options.responseWorkAdmission);
  } catch {
    throw new Error("OpenAI Codex /models returned invalid JSON");
  }
  const parsed = CodexModelsResponseSchema.safeParse(body);
  if (!parsed.success) {
    throw new Error("OpenAI Codex /models returned invalid model metadata");
  }

  const etag = response.headers.get("etag") ?? undefined;
  const reasoningIncluded = response.headers.has("x-reasoning-included");
  return {
    models: parsed.data.models.filter((model) => !isRetiredOpenAICodexModel(model.slug)),
    ...(etag ? { etag } : {}),
    ...(reasoningIncluded ? { reasoningIncluded: true } : {}),
  };
}

// Live-list Anthropic (Claude Pro/Max) models via GET /v1/models with the OAuth
// subscription identity (same Claude-Code headers the executor uses). Throws on a
// non-2xx / bad shape so the caller can fall back to the curated set.
export async function listAnthropicModels(
  accessToken: string,
  fetchImpl: typeof globalThis.fetch = fetch,
  options: { timeoutMs?: number } = {},
): Promise<string[]> {
  const timeoutMs =
    typeof options.timeoutMs === "number" && Number.isFinite(options.timeoutMs)
      ? Math.max(1, Math.floor(options.timeoutMs))
      : OAUTH_MODEL_DISCOVERY_TIMEOUT_MS;
  const res = await fetchImpl("https://api.anthropic.com/v1/models?limit=1000", {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "anthropic-version": "2023-06-01",
      "anthropic-beta": "claude-code-20250219,oauth-2025-04-20",
      "user-agent": "claude-cli/1.0.0",
      "x-app": "cli",
    },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    await res.body?.cancel().catch(() => {});
    throw new Error(`anthropic /v1/models HTTP ${res.status}`);
  }
  const body = await readUpstreamJsonWithinBudget<{ data?: Array<{ id?: unknown }> }>(res);
  const ids = (body.data ?? [])
    .map((m) => (typeof m.id === "string" ? m.id.trim() : ""))
    .filter((id) => id.length > 0);
  return [...new Set(ids)].sort();
}

// SuperGrok/X Premium OAuth uses the Grok CLI subscription proxy, not api.x.ai.
// Its catalog is account/region dependent, so there is deliberately no curated
// public-API fallback: a failed subscription discovery exposes no guessed models.
const XAI_MODELS_TIMEOUT_MS = 30_000;
const XAI_MODELS_MAX_RESPONSE_BYTES = 1024 * 1024;
const XAI_DEFAULT_CONTEXT_WINDOW = 256_000;
const XAI_U32_MAX = 4_294_967_295;

export interface XaiOAuthModelsOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Persisted session identity wins; JWT claims are only a fallback for old rows. */
  identity?: { userId?: string; email?: string };
}

// First-party grok-build model metadata. Keep the catalog key (`id`) separate
// from the model slug sent on the inference wire (`model`): the upstream parser
// deliberately gives `model` precedence and has a regression test for id != model.
export type XaiApiBackend = "responses" | "chat_completions" | "messages";
export type XaiReasoningEffort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh";

export interface XaiReasoningEffortOption {
  id: string;
  value: XaiReasoningEffort;
  label: string;
  description?: string;
  default?: boolean;
}

export interface XaiOAuthModel {
  /** Account-catalog key exposed as Helm's model alias suffix. */
  id: string;
  /** Actual model slug sent in the Responses request and model-override header. */
  model: string;
  apiBackend: XaiApiBackend;
  name?: string;
  description?: string;
  contextWindow: number;
  maxCompletionTokens?: number;
  maxRetries?: number;
  hidden: boolean;
  supportedInApi: boolean;
  supportsReasoningEffort: boolean;
  reasoningEffort?: XaiReasoningEffort;
  reasoningEfforts: XaiReasoningEffortOption[];
  streamToolCalls?: boolean;
}

type XaiModelsStreamReadResult =
  | { done: false; value: Uint8Array }
  | { done: true; value?: Uint8Array };

async function readWithSignal(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal,
): Promise<XaiModelsStreamReadResult> {
  if (signal.aborted) throw signal.reason;
  return new Promise<XaiModelsStreamReadResult>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    reader
      .read()
      .then(resolve, reject)
      .finally(() => {
        signal.removeEventListener("abort", onAbort);
      });
  });
}

async function readXaiModelsJson(response: Response, signal: AbortSignal): Promise<unknown> {
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null) {
    const declaredLength = Number(contentLength);
    if (Number.isFinite(declaredLength) && declaredLength > XAI_MODELS_MAX_RESPONSE_BYTES) {
      await response.body?.cancel().catch(() => {});
      throw new Error(`xAI OAuth /models response exceeds ${XAI_MODELS_MAX_RESPONSE_BYTES} bytes`);
    }
  }
  if (!response.body) return null;

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await readWithSignal(reader, signal);
      if (done) break;
      total += value.byteLength;
      if (total > XAI_MODELS_MAX_RESPONSE_BYTES) {
        await reader.cancel().catch(() => {});
        throw new Error(
          `xAI OAuth /models response exceeds ${XAI_MODELS_MAX_RESPONSE_BYTES} bytes`,
        );
      }
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new Error("xAI OAuth /models returned invalid JSON");
  }
}

const XAI_MODEL_TOKEN_RE = /^[A-Za-z0-9._:-]+$/;
const XAI_REASONING_EFFORTS = new Set<XaiReasoningEffort>([
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
]);

function xaiString(record: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim().length > 0) return value.trim();
  }
  return undefined;
}

function xaiBoolean(record: Record<string, unknown>, ...keys: string[]): boolean | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "boolean") return value;
  }
  return undefined;
}

function xaiArray(record: Record<string, unknown>, ...keys: string[]): unknown[] | undefined {
  for (const key of keys) {
    const value = record[key];
    if (Array.isArray(value)) return value;
  }
  return undefined;
}

function xaiNonNegativeInteger(
  record: Record<string, unknown>,
  ...keys: string[]
): number | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return value;
  }
  return undefined;
}

function xaiU32(record: Record<string, unknown>, ...keys: string[]): number | undefined {
  const value = xaiNonNegativeInteger(record, ...keys);
  return value !== undefined && value <= XAI_U32_MAX ? value : undefined;
}

function xaiModelToken(value: string | undefined): string | undefined {
  if (!value || value.length > 200 || !XAI_MODEL_TOKEN_RE.test(value)) return undefined;
  return value;
}

function parseXaiReasoningEffort(value: unknown): XaiReasoningEffort | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  if (normalized === "max") return "xhigh";
  return XAI_REASONING_EFFORTS.has(normalized as XaiReasoningEffort)
    ? (normalized as XaiReasoningEffort)
    : undefined;
}

function humanizeXaiEffort(id: string): string {
  return id.length > 0 ? `${id[0]?.toUpperCase()}${id.slice(1)}` : id;
}

function parseXaiReasoningEfforts(value: unknown): XaiReasoningEffortOption[] {
  if (!Array.isArray(value)) return [];
  const options: XaiReasoningEffortOption[] = [];
  for (const raw of value) {
    if (typeof raw === "string") {
      const effort = parseXaiReasoningEffort(raw);
      if (!effort) continue;
      options.push({ id: effort, value: effort, label: humanizeXaiEffort(effort) });
      continue;
    }
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const record = raw as Record<string, unknown>;
    const effort = parseXaiReasoningEffort(record.value);
    if (!effort) continue;
    const id = xaiString(record, "id") ?? effort;
    const label = xaiString(record, "label") ?? humanizeXaiEffort(id);
    const description = xaiString(record, "description");
    const isDefault = xaiBoolean(record, "default");
    options.push({
      id,
      value: effort,
      label,
      ...(description ? { description } : {}),
      ...(isDefault === true ? { default: true } : {}),
    });
  }
  return options;
}

function parseXaiOAuthModel(row: unknown): XaiOAuthModel | null {
  if (!row || typeof row !== "object" || Array.isArray(row)) return null;
  const record = row as Record<string, unknown>;
  const meta =
    record._meta && typeof record._meta === "object" && !Array.isArray(record._meta)
      ? (record._meta as Record<string, unknown>)
      : {};
  const declaredBackend = xaiString(record, "apiBackend", "api_backend");
  const rawBackend = declaredBackend ?? "chat_completions";
  if (
    rawBackend !== "responses" &&
    rawBackend !== "chat_completions" &&
    rawBackend !== "messages"
  ) {
    return null;
  }
  const model = xaiModelToken(
    xaiString(record, "model", "modelId") ??
      xaiString(record, "id") ??
      xaiString(meta, "model", "modelId"),
  );
  if (!model) return null;
  const id = xaiModelToken(xaiString(record, "id") ?? model);
  if (!id) return null;
  const declaredContextWindow =
    xaiNonNegativeInteger(record, "contextWindow", "context_window") ??
    xaiNonNegativeInteger(meta, "contextWindow", "totalContextTokens");
  if (declaredContextWindow === 0) return null;
  const contextWindow = declaredContextWindow ?? XAI_DEFAULT_CONTEXT_WINDOW;
  const reasoningEffort = parseXaiReasoningEffort(
    xaiString(record, "reasoningEffort", "reasoning_effort") ?? xaiString(meta, "reasoningEffort"),
  );
  const reasoningEfforts = parseXaiReasoningEfforts(
    xaiArray(record, "reasoningEfforts", "reasoning_efforts") ?? xaiArray(meta, "reasoningEfforts"),
  );
  const name = xaiString(record, "name");
  const description = xaiString(record, "description");
  const maxCompletionTokens = xaiU32(record, "maxCompletionTokens", "max_completion_tokens");
  const maxRetries = xaiU32(record, "maxRetries", "max_retries");
  const streamToolCalls = xaiBoolean(record, "streamToolCalls", "stream_tool_calls");
  return {
    id,
    model,
    apiBackend: rawBackend,
    ...(name ? { name } : {}),
    ...(description ? { description } : {}),
    contextWindow,
    ...(maxCompletionTokens !== undefined ? { maxCompletionTokens } : {}),
    ...(maxRetries !== undefined ? { maxRetries } : {}),
    hidden: xaiBoolean(record, "hidden") ?? xaiBoolean(meta, "hidden") ?? false,
    supportedInApi:
      xaiBoolean(record, "supportedInApi", "supported_in_api") ??
      xaiBoolean(meta, "supportedInApi") ??
      true,
    supportsReasoningEffort:
      xaiBoolean(record, "supportsReasoningEffort", "supports_reasoning_effort") ??
      xaiBoolean(meta, "supportsReasoningEffort") ??
      false,
    ...(reasoningEffort ? { reasoningEffort } : {}),
    reasoningEfforts,
    ...(streamToolCalls !== undefined ? { streamToolCalls } : {}),
  };
}

/**
 * Revalidate a persisted first-party xAI catalog with the same parser used for
 * live `/models` responses. `null` means the snapshot itself is malformed;
 * a valid array may intentionally normalize to `[]` after invalid rows are
 * discarded.
 */
export function parseXaiOAuthModels(value: unknown): XaiOAuthModel[] | null {
  if (!Array.isArray(value)) return null;
  const models = new Map<string, XaiOAuthModel>();
  for (const row of value) {
    const model = parseXaiOAuthModel(row);
    if (!model) continue;
    // Match grok-build's IndexMap::insert semantics: a duplicate id replaces the
    // value without moving the key from its first insertion position.
    models.set(model.id, model);
  }
  return [...models.values()];
}

/** Helm currently implements only the xAI Responses transport. */
export function isRoutableXaiOAuthModel(model: XaiOAuthModel): boolean {
  // `supportedInApi` limits API-key discovery only. grok-build's session-auth
  // visibility rule is `!hidden`, so an OAuth subscription may route it.
  return model.apiBackend === "responses" && !model.hidden;
}

export async function listXaiOAuthModels(
  accessToken: string,
  fetchImpl: typeof globalThis.fetch = fetch,
  options: XaiOAuthModelsOptions = {},
): Promise<XaiOAuthModel[]> {
  const timeoutMs =
    typeof options.timeoutMs === "number" && Number.isFinite(options.timeoutMs)
      ? Math.max(1, Math.floor(options.timeoutMs))
      : XAI_MODELS_TIMEOUT_MS;
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const signal = options.signal ? AbortSignal.any([options.signal, timeoutSignal]) : timeoutSignal;
  const res = await fetchImpl(`${XAI_GROK_OAUTH_BASE_URL}/models`, {
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${accessToken}`,
      "User-Agent": "helm-api/xai-oauth",
      ...xaiGrokCatalogHeaders(accessToken, options.identity),
    },
    redirect: "error",
    signal,
  });
  if (!res.ok) {
    await res.body?.cancel().catch(() => {});
    throw new Error(`xAI OAuth /models HTTP ${res.status}`);
  }
  const body = (await readXaiModelsJson(res, signal)) as { data?: unknown; models?: unknown };
  const rows = Array.isArray(body.data) ? body.data : Array.isArray(body.models) ? body.models : [];
  return parseXaiOAuthModels(rows) ?? [];
}

// Whether this provider has a LIVE list-models API that `discoverOAuthModels`
// queries. The admin UI uses this to expose account-specific refresh actions.
export function hasLiveModelDiscovery(providerId: string): boolean {
  return (
    providerId === "github-copilot" ||
    providerId === "anthropic" ||
    providerId === "openai-codex" ||
    providerId === "xai"
  );
}

export interface DiscoverOAuthModelsOptions {
  // Runtime composition may keep a curated safety net, while account-management
  // surfaces need the exact discovery result and must not present fallback ids as
  // models reported by that account.
  fallbackToCurated?: boolean;
}

// Resolve the routable model ids for a bound provider. `accessToken` drives live
// discovery. Never throws — by default a discovery failure falls back to the
// curated list (or [] when none), so the composition root stays fail-open.
// Account-management callers may disable that fallback to preserve provenance.
// `fetchImpl` lets the caller route discovery through the account's egress proxy
// (issue #38) so this leg of the flow leaves from the same hop as the rest.
export async function discoverOAuthModels(
  providerId: string,
  accessToken: string | undefined,
  fetchImpl: typeof globalThis.fetch = fetch,
  options: DiscoverOAuthModelsOptions = {},
): Promise<string[]> {
  const fallback = () =>
    options.fallbackToCurated === false ? [] : (CURATED_OAUTH_MODELS[providerId] ?? []);
  if (providerId === "github-copilot") {
    if (!accessToken) return [];
    try {
      return await listGitHubCopilotModels(accessToken, undefined, fetchImpl);
    } catch {
      return [];
    }
  }
  if (providerId === "anthropic") {
    if (accessToken) {
      try {
        const live = await listAnthropicModels(accessToken, fetchImpl);
        if (live.length > 0) return live;
      } catch {
        // fall through to curated
      }
    }
    return fallback();
  }
  if (providerId === "openai-codex") {
    if (!accessToken) return [];
    try {
      const live = await listOpenAICodexModels(accessToken, { fetchImpl });
      const visible = live.models
        .filter((model) => model.visibility === "list")
        .sort((left, right) => left.priority - right.priority)
        .map((model) => model.slug);
      return [...new Set(visible)];
    } catch {
      return [];
    }
  }
  if (providerId === "xai") {
    if (!accessToken) return [];
    try {
      return (await listXaiOAuthModels(accessToken, fetchImpl))
        .filter(isRoutableXaiOAuthModel)
        .map((model) => model.id)
        .sort();
    } catch {
      return [];
    }
  }
  return fallback();
}
