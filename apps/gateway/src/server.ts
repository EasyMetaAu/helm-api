import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import {
  type AnthropicSSEEvent,
  anthropicTransformer,
  bootstrapRootKey,
  createCircuitBreaker,
  createMemoryMomentumStore,
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
  loadRuntimeCatalog,
  makeAnthropicError,
  type PoliciesConfig,
  type ProviderClient,
  type ProviderConfig,
  parseLanesConfig,
  type ProviderRegistryConfig as RegistryProviderConfig,
  type RouteOptions,
  redact,
  routeRequest,
  type StoreSet,
  startSignalScheduler,
  toRegistryProviders,
} from "@helm/core";
import type {
  CatalogEntry,
  ClassifierConfig,
  InternalRequest,
  ProviderConfig as ProviderConfigShared,
} from "@helm/shared";
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

// Build the provider registry from the FULL multi-provider config (providers-
// multi). It is the union of two alias sources, in priority order:
//
//  1. Explicit per-model aliases from config.providers[].models[] — these map a
//     lane/policy alias (e.g. 'deepseek/deepseek-v4-flash') to a SPECIFIC provider
//     + upstream model id (the registry providerName then selects that provider's
//     client in the executor, so a fallback chain can CROSS providers).
//
//  2. Phase-0 PASSTHROUGH back-fill: any alias referenced by the active lanes
//     that is NOT already mapped by (1) is registered against the PRIMARY provider
//     with provider_model === alias (the single OpenAI-compatible upstream the
//     mock/e2e harness points at; the upstream ignores the exact model id). This
//     keeps single-provider deployments working with lanes that name bare aliases.
//
// A duplicate alias ACROSS providers in (1) fails closed at build time inside
// createProviderRegistry (principle 2); back-fill (2) never overrides (1).
function buildRegistry(
  providers: ReadonlyArray<ProviderConfigShared>,
  primaryName: string,
  primaryBaseUrl: string,
  primaryApiKeyEnv: string,
  lanes: LanesConfig,
  fallbackBaseUrl: string,
) {
  // (1) Explicit per-model providers (drop those with no models[] — passthrough).
  const explicit = toRegistryProviders(
    providers.filter((p) => p.models.length > 0),
    { fallbackBaseUrl },
  );
  const mapped = new Set<string>();
  for (const p of explicit) for (const m of p.models) mapped.add(m.alias);

  // (2) Back-fill the remaining lane aliases against the primary provider.
  const backfill = new Set<string>();
  for (const [, lane] of Object.entries(lanes)) {
    for (const el of [lane.primary, ...lane.fallback]) {
      // Skip lane references (resolved during chain expansion) and aliases already
      // mapped explicitly; register only the remaining terminal model aliases.
      if (!Object.hasOwn(lanes, el) && !mapped.has(el)) backfill.add(el);
    }
  }
  const cfgs: RegistryProviderConfig[] = [...explicit];
  if (backfill.size > 0) {
    cfgs.push({
      name: primaryName,
      base_url: primaryBaseUrl,
      api_key_env: primaryApiKeyEnv,
      models: [...backfill].map((alias) => ({ alias, provider_model: alias })),
    });
  }
  return createProviderRegistry(cfgs);
}

// Build one OpenAI-compatible client per configured provider, keyed by provider
// NAME, so the executor can dispatch each resolved candidate to the right
// upstream (cross-provider fallback). Credentials come ONLY from the env var each
// provider's api_key_env points at (principle 7 — never plaintext in config). A
// provider whose credential env is unset is SKIPPED (it cannot be invoked); its
// aliases will fail open at resolve/execute time rather than blocking startup of
// the others. The PRIMARY provider's missing credential is still fatal (handled
// by the caller) since it backs the default path.
function buildProviderClients(
  providers: ReadonlyArray<ProviderConfigShared>,
  fallbackBaseUrl: string,
  timeoutMs: number,
): Map<string, ProviderClient> {
  const clients = new Map<string, ProviderClient>();
  for (const p of providers) {
    const apiKey = process.env[p.api_key_env];
    if (!apiKey) continue; // no credential → cannot build a client; skip.
    const baseUrl = p.base_url ?? fallbackBaseUrl;
    clients.set(p.name, createOpenAIClient({ config: { baseUrl, apiKey, timeoutMs } }));
  }
  return clients;
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

  // Provider(s): the configured upstreams (providers-multi). The PRIMARY provider
  // (providers[0]) backs the default/eval path and the Phase-0 passthrough; its
  // credential is mandatory (fail-closed). Additional providers each get their own
  // OpenAI-compatible client so a fallback chain can CROSS providers. Credentials
  // come ONLY from the env var each api_key_env names (principle 7). The e2e/test
  // harness points every provider at the mock via HELM_PROVIDER_BASE_URL (used as
  // the shared fallback base_url when a provider omits one).
  const first = config.providers[0];
  if (!first) throw new Error("no provider configured");
  const apiKey = process.env[first.api_key_env];
  if (!apiKey) throw new Error(`missing provider credential env: ${first.api_key_env}`);
  // HELM_PROVIDER_BASE_URL (test/e2e) overrides EVERY provider's base_url so the
  // mock upstream serves all of them; otherwise each provider uses its own.
  const baseUrlOverride = process.env.HELM_PROVIDER_BASE_URL;
  const fallbackBaseUrl = baseUrlOverride ?? "https://api.openai.com/v1";
  const baseUrl = baseUrlOverride ?? first.base_url ?? fallbackBaseUrl;
  const timeoutMs = config.runtime.request_timeout_ms;
  const providerConfig: ProviderConfig = { baseUrl, apiKey, timeoutMs };
  // The default/primary client (eval + passthrough + back-fill aliases).
  const provider = createOpenAIClient({ config: providerConfig });
  // Per-provider clients keyed by provider NAME. When HELM_PROVIDER_BASE_URL is
  // set (test/e2e), force the override so cross-provider candidates still hit the
  // mock; in production each provider keeps its own base_url.
  const providerClients = buildProviderClients(
    baseUrlOverride
      ? config.providers.map((p) => ({ ...p, base_url: baseUrlOverride }))
      : config.providers,
    fallbackBaseUrl,
    timeoutMs,
  );
  // Ensure the primary client is registered under its name (it is built above with
  // the resolved baseUrl, which already honors the override).
  providerClients.set(first.name, provider);

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
  // Session-momentum soft-state. Instantiated ONCE here (process-wide singleton,
  // NEVER per request) so the Layer-1 classifier's history survives across
  // requests under the same x-session-key (→ metadata.conversation_id). This is
  // the composition-root wiring that makes momentum live: core defines the port +
  // ships this in-memory Map impl, server.ts injects it. Best-effort SOFT STATE
  // (principle 3): a stateless gateway may lose it on restart, which only degrades
  // to "no momentum", never an error; no session key → the engine no-ops. TTL
  // (30 min) + last-5 window are applied at read time from config.classifier.rules
  // .momentum (principle 2: config-driven). Holds only complexity/rawScore/at —
  // never plaintext message content (principle 7).
  const momentumStore = createMemoryMomentumStore();
  // Capability/pricing catalog: the checked-in GENERATED catalog (supply-chain
  // input, never fetched at runtime) merged with the manual capabilities.yaml /
  // pricing.yaml overrides (manual wins per-field). This is what makes the
  // capability filter LIVE: the executor looks up each candidate's resolved
  // providerModel here and prunes known-incompatible candidates (needs_json /
  // needs_vision / needs_tools / context) with explicit skip reasons; a model
  // with NO entry stays fail-open (not over-pruned). It is ALSO the pricing
  // source for cost conversion (cost-wire, docs/07): the executor converts each
  // served attempt's usage → cost_usd, and the classify adapter converts the
  // eval call's usage → eval_usd. An invalid override yaml fails closed
  // (principle 2) — loadRuntimeCatalog throws, the process exits.
  const catalog: Map<string, CatalogEntry> = loadRuntimeCatalog({
    configDir: opts.configDir ?? "./config",
  });
  // Three-layer cascade classify adapter: Layer-1 rules + Layer-2 eval (OFF by
  // default; per-request override threaded from the chat route) + Layer-3
  // balanced fail-open. The eval small-model is invoked via the same provider
  // (eval alias). Reads the CURRENT classifier config per request via the getter.
  // The catalog is injected so the eval call's usage becomes eval_usd (docs/07).
  const classify = buildClassifyAdapter({
    getClassifierConfig: () => classifierConfig,
    lanes,
    provider,
    now: () => Date.now(),
    log: (level, msg, fields) => logger.log(level as "info", msg, fields),
    momentum: { store: momentumStore },
    catalog,
  });
  const registry = buildRegistry(
    config.providers,
    first.name,
    baseUrl,
    first.api_key_env,
    lanes,
    fallbackBaseUrl,
  );
  const breaker = createCircuitBreaker({
    config: { failureThreshold: 5, cooldownMs: 30_000 },
    now: () => Date.now(),
  });
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
          defaultProvider: provider,
          providers: providerClients,
          registry,
          breaker,
          catalog,
          now: () => Date.now(),
          signal,
          log: (level, msg, fields) => logger.log(level as "info", msg, fields),
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
