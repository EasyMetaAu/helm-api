import { join } from "node:path";
import {
  type AnthropicSSEEvent,
  anthropicTransformer,
  bootstrapRootKey,
  type Classification,
  type Complexity,
  createCircuitBreaker,
  createOpenAIClient,
  createProviderRegistry,
  createSqliteDb,
  DEFAULT_LANES,
  generateKey,
  hashKey,
  type IRResponse,
  type LanesConfig,
  loadConfig,
  makeAnthropicError,
  type PoliciesConfig,
  type ProviderConfig,
  parseLanesConfig,
  type ProviderRegistryConfig as RegistryProviderConfig,
  type RouteOptions,
  redact,
  routeRequest,
  SqliteKeyStore,
  SqliteTelemetryStore,
  scoreRequest,
} from "@helm/core";
import type { CatalogEntry, ClassifierRulesConfig, InternalRequest } from "@helm/shared";
import { createApp } from "./app.js";
import { readBuildInfo } from "./build-info.js";
import { createJsonLogger, type Logger } from "./logging.js";
import { authMiddleware } from "./middleware/auth.js";
import { registerChatRoutes } from "./routes/chat.js";
import { createExecute } from "./routes/execute.js";
import type { MessagesIdentity, RouteError } from "./routes/messages.js";
import { registerMessagesRoute } from "./routes/messages.js";
import { createMessagesPipeline } from "./routes/messages-pipeline.js";

export interface ServerHandle {
  app: ReturnType<typeof createApp>;
  port: number;
  host: string;
}

// classifier complexity (simple|standard|complex|reasoning) -> routing
// complexity (simple|medium|complex). See implementation-notes 2026-05-31.
function mapComplexity(c: Complexity): Classification["complexity"] {
  switch (c) {
    case "standard":
      return "medium";
    case "reasoning":
      return "complex";
    case "complex":
      return "complex";
    default:
      return "simple";
  }
}

// Cheap prompt-token estimate (~4 chars/token) for the classifier's context gate.
function approxTokens(req: InternalRequest): number {
  let chars = 0;
  for (const m of req.messages) {
    const content = (m as { content?: unknown }).content;
    if (typeof content === "string") chars += content.length;
  }
  return Math.ceil(chars / 4);
}

// Build the classify adapter: Layer-1 rule engine (fail-open internally) mapped
// to the routing Classification contract. classifier failures degrade upstream
// to balanced (routeRequest's classifySafe), so this never needs to throw.
// True when no message carries any non-whitespace text — a genuinely
// unclassifiable request. The Layer-1 scorer is hardened to always commit to a
// lane, so an empty/contentless prompt must be detected HERE and surfaced as a
// classification failure so routeRequest's classifySafe degrades to `balanced`
// (CLAUDE.md principle 3 fail-open + principle 5 classification fallback).
function hasNoTextContent(req: InternalRequest): boolean {
  for (const m of req.messages) {
    const content = (m as { content?: unknown }).content;
    if (typeof content === "string" && content.trim().length > 0) return false;
    if (Array.isArray(content)) {
      for (const part of content) {
        if (typeof part === "string" && part.trim().length > 0) return false;
        if (
          part &&
          typeof part === "object" &&
          typeof (part as { text?: unknown }).text === "string" &&
          (part as { text: string }).text.trim().length > 0
        ) {
          return false;
        }
      }
    }
  }
  return true;
}

function buildClassify(rules: ClassifierRulesConfig) {
  return async (req: InternalRequest): Promise<Classification> => {
    // Unclassifiable input → throw so the orchestrator falls open to balanced.
    if (hasNoTextContent(req)) {
      throw new Error("classifier: no classifiable text content");
    }
    const r = scoreRequest(req, { cfg: rules, approxTokens: approxTokens(req) });
    return {
      task_type: r.task_type,
      complexity: mapComplexity(r.complexity),
      confidence: r.confidence,
      decided_by: r.decided_by,
      constraints: {
        needs_json: r.constraints.needs_json,
        needs_tools: r.constraints.needs_tools,
        needs_vision: r.constraints.needs_vision,
      },
      explanation: r.explanation,
    };
  };
}

// Build a provider registry that maps every DEFAULT_LANES model alias to the
// single configured upstream (Phase 1: one OpenAI-compatible provider; the mock
// upstream ignores the model id). TODO: replace with config-driven multi-model
// registry once providers.yaml grows the models[] mapping (see impl-notes).
function buildRegistry(providerName: string, baseUrl: string, apiKeyEnv: string) {
  const aliases = new Set<string>();
  for (const lane of Object.values(DEFAULT_LANES)) {
    aliases.add(lane.primary);
  }
  const cfg: RegistryProviderConfig = {
    name: providerName,
    base_url: baseUrl,
    api_key_env: apiKeyEnv,
    models: [...aliases].map((alias) => ({ alias, provider_model: alias })),
  };
  return createProviderRegistry([cfg]);
}

// Full wiring: config -> store -> bootstrap key -> provider -> routing pipeline.
// Fail-closed: an invalid config throws (caller exits non-zero). The HTTP listen
// is performed by the caller (index.ts) so this stays testable.
export function buildServer(opts: { logger?: Logger; configDir?: string } = {}): ServerHandle {
  const logger = opts.logger ?? createJsonLogger();
  const config = loadConfig({ configDir: opts.configDir ?? "./config" });

  // Store: SQLite (default). dataDir from the key persist path's directory.
  const dataDir = process.env.HELM_DATA_DIR ?? "./data";
  const db = createSqliteDb(join(dataDir, "helm.db"));
  const keyStore = new SqliteKeyStore(db);
  const telemetry = new SqliteTelemetryStore(db);

  // Bootstrap root key on first start (idempotent; prints once).
  void bootstrapRootKey({
    keyStore,
    generateKey,
    now: () => new Date(),
    log: (line) => logger.log("warn", "bootstrap.root_key", { line }),
  });

  // Provider: the first configured OpenAI-compatible upstream.
  const first = config.providers[0];
  if (!first) throw new Error("no provider configured");
  const apiKey = process.env[first.api_key_env];
  if (!apiKey) throw new Error(`missing provider credential env: ${first.api_key_env}`);
  const baseUrl =
    process.env.HELM_PROVIDER_BASE_URL ?? first.base_url ?? "https://api.openai.com/v1";
  const providerConfig: ProviderConfig = {
    baseUrl,
    apiKey,
    timeoutMs: config.runtime.request_timeout_ms,
  };
  const provider = createOpenAIClient({ config: providerConfig });

  // Routing pipeline building blocks (framework-agnostic core).
  const lanes: LanesConfig = parseLanesConfig(DEFAULT_LANES);
  const policies: PoliciesConfig = { policies: [] };
  const classify = buildClassify(config.classifier.rules);
  const registry = buildRegistry(first.alias, baseUrl, first.api_key_env);
  const breaker = createCircuitBreaker({
    config: { failureThreshold: 5, cooldownMs: 30_000 },
    now: () => Date.now(),
  });
  // Empty catalog → the capability filter is skipped (fail-open) until catalog
  // data is wired into the loader (see impl-notes TODO).
  const catalog = new Map<string, CatalogEntry>();

  const app = createApp({
    logger,
    health: {
      checkReadiness: async () => ({ ready: true, checks: { store: "ok" } }),
      buildInfo: readBuildInfo(),
    },
    limits: {
      maxBodyBytes: config.runtime.max_request_bytes,
      requestTimeoutMs: config.runtime.request_timeout_ms,
    },
  });

  // Mandatory auth for the OpenAI chat surface (Hono middleware -> HelmError on
  // failure). The Anthropic /v1/messages route self-authenticates so its errors
  // are translated to the Anthropic envelope (docs/07) — see registerMessagesRoute.
  app.use(
    "/v1/chat/*",
    authMiddleware({ keyStore, log: (l) => logger.log("warn", "auth", { line: l }) }),
  );

  // The per-request `route`: bind a fresh `execute` to the request's abort
  // signal (client disconnect), then run the framework-agnostic orchestrator.
  const route = (req: InternalRequest, routeOpts: RouteOptions, signal: AbortSignal) =>
    routeRequest(
      req,
      {
        classify,
        policies,
        lanes,
        execute: createExecute({
          provider,
          registry,
          breaker,
          catalog,
          now: () => Date.now(),
          signal,
        }),
        now: () => new Date(),
        log: (record) => logger.log("info", "route.decision", { trace_id: record.request_id }),
      },
      routeOpts,
    );

  registerChatRoutes(app, {
    route,
    telemetry,
    redact: (payload) => redact(payload),
    now: () => Date.now(),
  });

  // Anthropic Messages route (/v1/messages). It reuses the SAME routing core via
  // `route`, behind a pipeline adapter that bridges IR ↔ the OpenAI executor and
  // produces the native Anthropic response / SSE events (docs/05). Self-auth so a
  // missing key is rejected as an Anthropic error envelope (docs/07).
  const messagesPipeline = createMessagesPipeline(route);
  registerMessagesRoute(app, {
    auth: {
      resolve: async (credential): Promise<MessagesIdentity | null> => {
        if (credential === null) return null;
        const record = await keyStore.getByHash(hashKey(credential));
        if (record === null || record.disabled) return null;
        return {
          keyId: record.key_id,
          accountId: record.account_id,
          orgId: null,
          userId: null,
          role: record.role,
          caps: { allowCustomModel: record.allow_custom_model },
        };
      },
    },
    transformers: {
      anthropic: {
        transformRequestOut: (native) => anthropicTransformer.transformRequestOut(native),
        // `collect()` contractually returns an IRResponse; the route hands it back
        // as `unknown`, so narrow at this single boundary.
        transformResponseOut: (ir) => anthropicTransformer.transformResponseOut(ir as IRResponse),
        // The pipeline already produced Anthropic SSE events; here we only
        // serialize ONE event into its wire event/data pair.
        transformStreamOut: (event) => {
          const ev = event as AnthropicSSEEvent & { type: string };
          return { event: ev.type, data: JSON.stringify(ev) };
        },
        transformErrorOut: (err: RouteError) =>
          makeAnthropicError({
            error_class: err.error_class === "auth_error" ? "auth_error" : "upstream_error",
            message: err.message,
            trace_id: err.trace_id,
          }),
      },
    },
    pipeline: messagesPipeline,
  });

  return { app, port: config.server.port, host: config.server.host };
}
