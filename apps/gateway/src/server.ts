import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  type AnthropicSSEEvent,
  anthropicTransformer,
  bootstrapRootKey,
  createCircuitBreaker,
  createOpenAIClient,
  createProviderRegistry,
  createSqliteDb,
  DEFAULT_LANES,
  generateKey,
  hashKey,
  type IRResponse,
  type Lane,
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
} from "@helm/core";
import type { CatalogEntry, InternalRequest } from "@helm/shared";
import { createApp } from "./app.js";
import { readBuildInfo } from "./build-info.js";
import { createJsonLogger, type Logger } from "./logging.js";
import { authMiddleware } from "./middleware/auth.js";
import { basicAuth, resolveAdminAuth } from "./middleware/basic-auth.js";
import { registerAdminApi } from "./routes/admin/index.js";
import { createRuntimeRuleStore } from "./routes/admin/rule-store.js";
import { ADMIN_BUILD_ROOT, mountAdminStatic } from "./routes/admin-static.js";
import { registerChatRoutes } from "./routes/chat.js";
import { buildClassifyAdapter } from "./routes/classify.js";
import { createExecute } from "./routes/execute.js";
import type { MessagesIdentity, RouteError } from "./routes/messages.js";
import { registerMessagesRoute } from "./routes/messages.js";
import { createMessagesPipeline } from "./routes/messages-pipeline.js";

export interface ServerHandle {
  app: ReturnType<typeof createApp>;
  port: number;
  host: string;
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

  // Routing pipeline building blocks (framework-agnostic core). `let` so admin
  // rule edits (via the runtime RuleStore below) re-bind the live config the
  // `route` closure reads — changes apply without a restart.
  let lanes: LanesConfig = parseLanesConfig(DEFAULT_LANES);
  let policies: PoliciesConfig = { policies: [] };
  // Three-layer cascade classify adapter: Layer-1 rules + Layer-2 eval (OFF by
  // default; per-request override threaded from the chat route) + Layer-3
  // balanced fail-open. The eval small-model is invoked via the same provider
  // (eval alias). Holds one process-local eval cache (content-hash keyed).
  const classify = buildClassifyAdapter({
    classifierConfig: config.classifier,
    lanes,
    provider,
    now: () => Date.now(),
    log: (level, msg, fields) => logger.log(level as "info", msg, fields),
  });
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
  // `evalEnabled` is the per-request Layer-2 toggle (default OFF); it is bound
  // into the classify closure here so the orchestrator's `classify(req)` contract
  // stays single-arg and core remains unaware of the eval knob.
  const route = (
    req: InternalRequest,
    routeOpts: RouteOptions,
    signal: AbortSignal,
    classifyOverrides?: { evalEnabled?: boolean; rulesThreshold?: number },
  ) =>
    routeRequest(
      req,
      {
        classify: (r) => classify(r, classifyOverrides),
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
    // e2e-only: allow the `x-helm-eval` header to toggle Layer-2 eval per request
    // so the eval cascade can be black-boxed without a config reload. Production
    // leaves HELM_E2E unset → eval stays config-driven (fail-closed, principle 2).
    evalHeaderOverride: process.env.HELM_E2E === "1",
  });

  // Anthropic Messages route (/v1/messages). It reuses the SAME routing core via
  // `route`, behind a pipeline adapter that bridges IR ↔ the OpenAI executor and
  // produces the native Anthropic response / SSE events (docs/05). Self-auth so a
  // missing key is rejected as an Anthropic error envelope (docs/07).
  // Admin API (/admin/api/*) behind HTTP Basic (admin.auth). DELIBERATELY separate
  // from API-key auth (different credential source, no RBAC). Rule edits go through
  // a runtime RuleStore that re-binds the live `lanes`/`policies` the router reads;
  // keys/requests go to the Store. The plaintext of a freshly minted key is the
  // ONLY secret ever returned, once (原则7).
  const adminAuth = resolveAdminAuth(config as { admin?: Record<string, unknown> }, process.env);
  const ruleStore = createRuntimeRuleStore({
    lanes: lanes as Record<string, Lane>,
    policies,
    classifier: config.classifier,
    onLanes: (next) => {
      lanes = next as LanesConfig;
    },
    onPolicies: (next) => {
      policies = next;
    },
  });
  app.use("/admin/api/*", basicAuth(adminAuth));
  registerAdminApi(app, {
    rules: ruleStore,
    keyStore,
    telemetry,
    genKey: () => {
      const k = generateKey();
      return { plaintext: k.plaintext, hash: k.hash, prefix: k.prefix };
    },
    genKeyId: () => randomUUID(),
    accountId: "default",
  });

  // Admin SPA static hosting (/admin). MUST be mounted AFTER registerAdminApi so
  // the more-specific /admin/api/* routes win (Hono matches in registration
  // order); the static catch-all would otherwise return index.html for them. The
  // sub-app re-applies basicAuth so the page + assets are also gated. We never run
  // SvelteKit here — just serve the adapter-static build (CLAUDE.md 原则1).
  if (!existsSync(ADMIN_BUILD_ROOT)) {
    logger.log("warn", "admin.static_missing", {
      dir: ADMIN_BUILD_ROOT,
      line: `admin SPA build not found at ${ADMIN_BUILD_ROOT}; /admin will 404 until 'pnpm build' produces it`,
    });
  }
  app.route("/admin", mountAdminStatic(adminAuth));

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
