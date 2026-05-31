import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import {
  type AnthropicSSEEvent,
  anthropicTransformer,
  bootstrapRootKey,
  createCircuitBreaker,
  createOpenAIClient,
  createProviderRegistry,
  createRateLimiter,
  createSignalCollector,
  createStore,
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
  type StoreSet,
  startSignalScheduler,
} from "@helm/core";
import type { CatalogEntry, ClassifierConfig, InternalRequest } from "@helm/shared";
import { createApp } from "./app.js";
import { readBuildInfo } from "./build-info.js";
import { createJsonLogger, type Logger } from "./logging.js";
import { authMiddleware } from "./middleware/auth.js";
import { basicAuth, resolveAdminAuth } from "./middleware/basic-auth.js";
import { rateLimitMiddleware } from "./middleware/rate-limit.js";
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
  // Stop background workers (e.g. the Agentic Signals scheduler). Optional and
  // safe to skip — the timers are unref'd so they never block process exit.
  dispose?: () => void;
}

// Build a provider registry that maps every model alias referenced by the active
// lanes (each lane's primary + fallback elements that are NOT themselves lane
// names) to the single configured upstream (Phase 1: one OpenAI-compatible
// provider; the mock upstream ignores the model id). Driven by config.lanes so a
// task lane's primary (e.g. coding_capable_model) is resolvable. TODO: replace
// with a real multi-model registry once providers.yaml grows models[] (impl-notes).
function buildRegistry(
  providerName: string,
  baseUrl: string,
  apiKeyEnv: string,
  lanes: LanesConfig,
) {
  const aliases = new Set<string>();
  for (const [, lane] of Object.entries(lanes)) {
    for (const el of [lane.primary, ...lane.fallback]) {
      // Skip lane references (resolved during chain expansion); register only
      // terminal model aliases.
      if (!Object.hasOwn(lanes, el)) aliases.add(el);
    }
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
// is performed by the caller (index.ts) so this stays testable. Async because the
// Store factory may open a remote Postgres (supabase driver); the sqlite default
// resolves synchronously under the await.
export async function buildServer(
  opts: { logger?: Logger; configDir?: string } = {},
): Promise<ServerHandle> {
  const logger = opts.logger ?? createJsonLogger();
  const config = loadConfig({ configDir: opts.configDir ?? "./config" });

  // Store adapter set, chosen by config (CLAUDE.md "DB 抽象层"): sqlite (default,
  // local file) or supabase (hosted Postgres). The factory fails CLOSED on an
  // unknown driver / a missing supabase credential (principle 2). The supabase
  // connection string is referenced by env-var NAME (runtime.store.url_env) and
  // resolved HERE — never read from yaml, never logged (principle 7).
  const dataDir = process.env.HELM_DATA_DIR ?? "./data";
  const storeCfg = config.runtime.store;
  const connectionString =
    storeCfg.driver === "supabase" && storeCfg.url_env ? process.env[storeCfg.url_env] : undefined;
  if (storeCfg.driver === "supabase" && !connectionString) {
    throw new Error(
      `store.driver=supabase but no connection string: set runtime.store.url_env to an env var holding the Postgres DSN`,
    );
  }
  const store: StoreSet = await createStore({ store: storeCfg, dataDir, connectionString });
  const keyStore = store.keys;
  const telemetry = store.telemetry;
  // Agentic Signals (POST-MVP feedback layer, docs/02). The collector consumes
  // ALREADY-persisted telemetry and writes aggregated, REDACTED signals — it is
  // started as a BACKGROUND interval below (NEVER on the request path), so it
  // adds zero latency to any served request. Observe-only this phase: nothing
  // reads these signals back into routing.
  const signalCollector = createSignalCollector({
    telemetry,
    signals: store.signals,
    now: () => Date.now(),
    log: (level, msg, fields) => logger.log(level, msg, fields),
  });
  // Per-key rate limiter (docs/06). Default OFF (config.runtime.rate_limit.enabled)
  // -> zero-overhead pass-through. Counters persist in the SAME store so windows
  // survive restarts / span instances. Sits AFTER auth, BEFORE routing.
  const rateLimiter = createRateLimiter({
    config: config.runtime.rate_limit,
    store: store.rateLimit,
  });

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
  //
  // Lanes/policies come from the Zod-validated config (config/lanes.yaml +
  // config/policies.yaml). config.lanes is undefined only when lanes.yaml is
  // absent; in that case fall back to core's DEFAULT_LANES so the lane
  // abstraction is always present (principle 6, config-as-code principle 2 —
  // an invalid lanes.yaml already failed the load above). policies default to []
  // via the schema, so an absent policies.yaml is a no-op.
  let lanes: LanesConfig = config.lanes ?? parseLanesConfig(DEFAULT_LANES);
  let policies: PoliciesConfig = config.policies;
  // Live classifier config. `let` so an admin edit (via the runtime RuleStore's
  // onClassifier callback below) re-binds the value the classify adapter reads
  // per request — classifier changes hot-apply WITHOUT a restart (closes the
  // admin.api TODO: "admin 改 classifier 不热生效"). The adapter rebuilds its eval
  // cache when this value changes, so a verdict from the old config is never served.
  let classifierConfig: ClassifierConfig = config.classifier;
  // Three-layer cascade classify adapter: Layer-1 rules + Layer-2 eval (OFF by
  // default; per-request override threaded from the chat route) + Layer-3
  // balanced fail-open. The eval small-model is invoked via the same provider
  // (eval alias). Reads the CURRENT classifier config per request via the getter.
  const classify = buildClassifyAdapter({
    getClassifierConfig: () => classifierConfig,
    lanes,
    provider,
    now: () => Date.now(),
    log: (level, msg, fields) => logger.log(level as "info", msg, fields),
  });
  const registry = buildRegistry(first.alias, baseUrl, first.api_key_env, lanes);
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
  // Rate limit AFTER auth (needs the resolved key_id) and BEFORE classify/route
  // (cut off cost before classification/eval). No-op when disabled (docs/06).
  app.use("/v1/chat/*", rateLimitMiddleware({ limiter: rateLimiter }));

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
    classifier: classifierConfig,
    onLanes: (next) => {
      lanes = next as LanesConfig;
    },
    onPolicies: (next) => {
      policies = next;
    },
    // Re-bind the live classifier config so the classify adapter (which reads it
    // per request) observes the admin edit on the very next classification — no
    // restart, no stale eval verdict (the adapter drops its cache on change).
    onClassifier: (next) => {
      classifierConfig = next;
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
          keyPrefix: record.prefix,
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

  // Start the Agentic Signals background scheduler — the OFF-the-request-path
  // trigger. It periodically asks the collector to aggregate the just-elapsed
  // window. The timer is unref'd (never blocks exit) and fail-open (a tick error
  // is logged, never thrown). DELIBERATELY started here, OUTSIDE every middleware
  // / route registration, so no request ever touches signal code (zero added
  // latency). Disabled when HELM_SIGNALS_DISABLED is set (e.g. unit/e2e runs).
  let signalScheduler: { stop: () => void } | null = null;
  if (process.env.HELM_SIGNALS_DISABLED !== "1") {
    const intervalMs = Number(process.env.HELM_SIGNALS_INTERVAL_MS ?? 60_000);
    signalScheduler = startSignalScheduler({
      collector: signalCollector,
      intervalMs: Number.isFinite(intervalMs) && intervalMs > 0 ? intervalMs : 60_000,
      now: () => Date.now(),
      log: (level, msg, fields) => logger.log(level, msg, fields),
    });
  }

  return {
    app,
    port: config.server.port,
    host: config.server.host,
    dispose: () => {
      signalScheduler?.stop();
      // Close the underlying DB connection (sqlite file handle / pg pool). Best
      // effort: a close error must not mask a clean shutdown.
      void store.close().catch(() => {});
    },
  };
}
