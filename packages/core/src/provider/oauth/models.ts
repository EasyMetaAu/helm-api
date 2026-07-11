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
import { type CodexModelInfo, CodexModelsResponseSchema } from "./codex-model-info.js";
import { listGitHubCopilotModels } from "./github-copilot.js";
import { parseOpenAICodexIdentity } from "./openai-codex.js";

// Curated FALLBACK model ids — used when live discovery is unavailable or fails.
// Anthropic and Codex are normally live; these are only their safety net.
export const CURATED_OAUTH_MODELS: Record<string, string[]> = {
  anthropic: ["claude-opus-4-6", "claude-sonnet-4-6", "claude-haiku-4-5"],
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
  ],
};

const OPENAI_CODEX_MODEL_ALIASES: Readonly<Record<string, string>> = {
  "gpt-5.6": "gpt-5.6-sol",
};

export function resolveOpenAICodexModelAlias(model: string): string {
  return OPENAI_CODEX_MODEL_ALIASES[model] ?? model;
}

export function expandOpenAICodexModelAliases(models: readonly string[]): string[] {
  const expanded = [...new Set(models)];
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

export interface OpenAICodexModelsOptions {
  accountId?: string;
  isFedramp?: boolean;
  clientVersion?: string;
  userAgent?: string;
  fetchImpl?: typeof globalThis.fetch;
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

  const response = await (options.fetchImpl ?? fetch)(url.toString(), { headers });
  if (!response.ok) {
    await response.text().catch(() => "");
    throw new OpenAICodexModelsError(response.status);
  }

  let body: unknown;
  try {
    body = await response.json();
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
    models: parsed.data.models,
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
): Promise<string[]> {
  const res = await fetchImpl("https://api.anthropic.com/v1/models?limit=1000", {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "anthropic-version": "2023-06-01",
      "anthropic-beta": "claude-code-20250219,oauth-2025-04-20",
      "user-agent": "claude-cli/1.0.0",
      "x-app": "cli",
    },
  });
  if (!res.ok) throw new Error(`anthropic /v1/models HTTP ${res.status}`);
  const body = (await res.json()) as { data?: Array<{ id?: unknown }> };
  const ids = (body.data ?? [])
    .map((m) => (typeof m.id === "string" ? m.id.trim() : ""))
    .filter((id) => id.length > 0);
  return [...new Set(ids)].sort();
}

// Whether this provider has a LIVE list-models API that `discoverOAuthModels`
// queries. The admin UI uses this to expose account-specific refresh actions.
export function hasLiveModelDiscovery(providerId: string): boolean {
  return (
    providerId === "github-copilot" || providerId === "anthropic" || providerId === "openai-codex"
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
  return fallback();
}
