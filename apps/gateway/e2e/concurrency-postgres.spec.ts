import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import {
  type AnthropicSSEEvent,
  anthropicTransformer,
  type CircuitBreaker,
  createCircuitBreaker,
  createDistributedKeyedSemaphore,
  createPgDb,
  type DecisionRecord,
  type DistributedKeyedSemaphore,
  type ExecutionPlan,
  geminiTransformer,
  type IRResponse,
  makeAnthropicError,
  makeGeminiError,
  PgConcurrencyLeaseStore,
  type PgDb,
  type ProviderClient,
  type ProviderRegistry,
  type ResponsesSSEEvent,
  type RouteDeps,
  type RouteOptions,
  responsesTransformer,
  routeRequest,
  type TelemetryStore,
} from "@helm/core";
import {
  ERROR_CLASS_HTTP_STATUS,
  ErrorClassSchema,
  type InternalRequest,
  type Protocol,
} from "@helm/shared";
import { expect, test } from "@playwright/test";
import type { Hono } from "hono";
import { type AppEnv, createApp } from "../src/app.js";
import type { AuthIdentity } from "../src/middleware/auth.js";
import {
  type ConcurrencyGateConfig,
  concurrencyMiddleware,
  createConcurrencyGate,
} from "../src/middleware/concurrency.js";
import { requestSignal, timeout } from "../src/middleware/limits.js";
import { CONCURRENCY_LEASE_LOST_REASON } from "../src/request-cancellation.js";
import { registerChatRoutes } from "../src/routes/chat.js";
import { createExecute } from "../src/routes/execute.js";
import { registerGeminiRoute } from "../src/routes/gemini.js";
import {
  type ImageAttempt,
  type ImageChainTarget,
  runImageChain,
} from "../src/routes/image-chain.js";
import {
  type MessagesIdentity,
  type RouteError,
  registerMessagesRoute,
} from "../src/routes/messages.js";
import { createMessagesPipeline } from "../src/routes/messages-pipeline.js";
import type { RecordServedDeps } from "../src/routes/payload-capture.js";
import { registerResponsesRoute } from "../src/routes/responses.js";

// This is intentionally request-level E2E rather than another PGlite contract test:
// two independent Hono app dependency graphs and two independent postgres-js pools
// represent two replicas while sharing the exact production lease store/manager.
// The e2e launcher guarantees a real PostgreSQL 17 + pgvector URL before Playwright
// starts. Explicit URL precedence is PG_TEST_URL, then HELM_TEST_POSTGRES_URL.
const postgresUrl = process.env.PG_TEST_URL ?? process.env.HELM_TEST_POSTGRES_URL;

const encoder = new TextEncoder();

interface ProviderState {
  active: number;
  maxActive: number;
  calls: number;
  failures: number;
  cooldowns: number;
}

interface Replica {
  app: Hono<AppEnv>;
  db: PgDb;
  manager: DistributedKeyedSemaphore;
  store: PgConcurrencyLeaseStore;
  ownerId: string;
  deleteCurrentLease: (keyId: string) => Promise<void>;
  closeDb: () => Promise<void>;
  shutdown: () => Promise<void>;
}

interface ReplicaOptions {
  name: string;
  state: ProviderState;
  ttlMs?: number;
  heartbeatMs?: number;
  waitTimeoutMs?: number;
  minQueueSize?: number;
}

function requirePostgresUrl(): string {
  if (!postgresUrl) {
    throw new Error(
      "real PostgreSQL E2E requires PG_TEST_URL or HELM_TEST_POSTGRES_URL; the pnpm test:e2e launcher must provision one",
    );
  }
  return postgresUrl;
}

function providerState(): ProviderState {
  return { active: 0, maxActive: 0, calls: 0, failures: 0, cooldowns: 0 };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function createReplica(options: ReplicaOptions): Promise<Replica> {
  const db = await createPgDb(requirePostgresUrl());
  const store = new PgConcurrencyLeaseStore(db);
  const ownerId = `e2e-${options.name}-${crypto.randomUUID()}`;
  let leaseSequence = 0;
  let currentLeaseId = "";
  const manager = createDistributedKeyedSemaphore({
    store,
    ownerId,
    leaseTtlMs: options.ttlMs ?? 2_000,
    heartbeatIntervalMs: options.heartbeatMs ?? 500,
    random: () => 0,
    createLeaseId: () => {
      currentLeaseId = `${ownerId}-lease-${++leaseSequence}`;
      return currentLeaseId;
    },
  });
  const config: ConcurrencyGateConfig = {
    enabled: true,
    minSize: options.minQueueSize ?? 100,
    multiplier: 0,
    waitTimeoutMs: options.waitTimeoutMs ?? 4_000,
  };
  const gate = createConcurrencyGate({ semaphore: manager, getConfig: () => config });
  const app = createApp({ logger: { log: () => {} } });

  app.use("/work", async (c, next) => {
    const keyId = c.req.header("x-test-key") ?? "real-pg-default";
    const limit = Number(c.req.header("x-test-limit") ?? "1");
    // biome-ignore lint/suspicious/noExplicitAny: request-level test identity seam
    (c as any).set("identity", { keyId, caps: { concurrencyLimit: limit } });
    await next();
  });
  app.use("/work", concurrencyMiddleware(gate));
  app.post("/work", async (c) => {
    options.state.calls += 1;
    options.state.active += 1;
    options.state.maxActive = Math.max(options.state.maxActive, options.state.active);
    try {
      await delay(Number(c.req.header("x-test-work-ms") ?? "2"));
      return c.json({ ok: true });
    } finally {
      options.state.active -= 1;
    }
  });

  let dbClosed = false;
  const closeDb = async (): Promise<void> => {
    if (dbClosed) return;
    dbClosed = true;
    await db.$close();
  };
  return {
    app,
    db,
    manager,
    store,
    ownerId,
    deleteCurrentLease: async (keyId: string) => {
      if (currentLeaseId === "") throw new Error("replica has no current lease to delete");
      await store.release({ keyId, leaseId: currentLeaseId, ownerId });
    },
    closeDb,
    shutdown: async () => {
      await manager.shutdown();
      await closeDb();
    },
  };
}

async function work(replica: Replica, keyId: string, workMs = 2, limit = 1): Promise<Response> {
  return replica.app.request("/work", {
    method: "POST",
    headers: {
      "x-test-key": keyId,
      "x-test-limit": String(limit),
      "x-test-work-ms": String(workMs),
    },
  });
}

function leaseLossRegistry(aliases: string[]): ProviderRegistry {
  const known = new Set(aliases);
  return {
    resolve(alias: string) {
      if (!known.has(alias)) return { ok: false, error: { kind: "unknown_alias", alias } };
      return {
        ok: true,
        value: {
          alias,
          providerName: alias,
          providerModel: `wire/${alias}`,
          baseUrl: "http://lease-loss.invalid",
          apiKeyEnv: "LEASE_LOSS_TEST",
          targetProviderProtocol: "openai_chat" as const,
          providerRequiresCompatibilityRewrite: false,
        },
      };
    },
    list: () => aliases,
  };
}

function leaseLossPlan(aliases: string[]): ExecutionPlan {
  return { selected_lane: "balanced", candidate_chain: aliases, explicit_model: null };
}

function leaseLossRequest(stream = false): InternalRequest {
  return {
    request_id: `lease-loss-${crypto.randomUUID()}`,
    protocol: "openai_chat",
    account_id: "acct",
    api_key_id: "key",
    user_id: null,
    org_id: null,
    requested_model: "auto",
    messages: [{ role: "user", content: "hello" }],
    tools: null,
    response_format: null,
    attachments: null,
    max_tokens: null,
    stream,
    metadata: {
      conversation_id: null,
      thread_id: null,
      resource_id: null,
      project_id: null,
      memory_mode: "off",
    },
  };
}

function abortError(): Error {
  return Object.assign(new Error("lease lost"), { name: "AbortError" });
}

async function waitForAbort(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  await new Promise<void>((resolve) =>
    signal.addEventListener("abort", () => resolve(), { once: true }),
  );
}

async function spawnLeaseHolderChild(
  keyId: string,
  ttlMs: number,
): Promise<ChildProcessWithoutNullStreams> {
  const child = spawn(
    process.execPath,
    ["--import", "tsx", new URL("./lease-holder-child.ts", import.meta.url).pathname],
    {
      env: {
        ...process.env,
        PG_TEST_URL: requirePostgresUrl(),
        LEASE_TEST_KEY_ID: keyId,
        LEASE_TEST_TTL_MS: String(ttlMs),
      },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  await new Promise<void>((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(
      () => reject(new Error(`child replica readiness timeout: ${stderr}`)),
      5_000,
    );
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
      if (stdout.includes('"event":"lease-held"')) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      reject(
        new Error(`child replica exited before ready: code=${code} signal=${signal} ${stderr}`),
      );
    });
  });
  return child;
}

async function acquireLease(replica: Replica, keyId: string) {
  const held = await replica.manager.acquire({
    key: keyId,
    limit: 1,
    maxQueue: 2,
    timeoutMs: 2_000,
  });
  expect(held.ok).toBe(true);
  if (!held.ok) throw new Error(`failed to acquire test lease: ${held.reason}`);
  return held;
}

function streamApp(replica: Replica): {
  app: Hono<AppEnv>;
  ready: Promise<void>;
  finish: () => void;
} {
  const ready = deferred();
  const finish = deferred();
  const gate = createConcurrencyGate({
    semaphore: replica.manager,
    getConfig: () => ({ enabled: true, minSize: 10, multiplier: 0, waitTimeoutMs: 4_000 }),
  });
  const app = createApp({ logger: { log: () => {} } });
  app.use("/stream", async (c, next) => {
    // biome-ignore lint/suspicious/noExplicitAny: request-level test identity seam
    (c as any).set("identity", {
      keyId: c.req.header("x-test-key") ?? "stream-key",
      caps: { concurrencyLimit: 1 },
    });
    await next();
  });
  app.use("/stream", concurrencyMiddleware(gate));
  app.get("/stream", (c) => {
    const release = c.get("concurrencyClaim")?.();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode("event: chunk\ndata: first\n\n"));
        ready.resolve();
        void finish.promise.then(async () => {
          controller.enqueue(encoder.encode("event: done\ndata: [DONE]\n\n"));
          controller.close();
          await release?.();
        });
      },
      async cancel() {
        await release?.();
      },
    });
    return new Response(body, { headers: { "content-type": "text/event-stream" } });
  });
  return { app, ready: ready.promise, finish: finish.resolve };
}

type ProductionRouteProtocol = Extract<
  Protocol,
  "openai_chat" | "anthropic_messages" | "openai_responses" | "gemini"
>;

interface BreakerObservations {
  failures: number;
  cooldowns: number;
}

type PersistenceRaceStep = "lease_loss" | "timeout" | "persist";

interface ProductionRouteResult {
  wire: string;
  decision: DecisionRecord;
  primaryCalls: number;
  fallbackCalls: number;
  breakerState: ReturnType<CircuitBreaker["getState"]>;
  breaker: BreakerObservations;
  persistenceOrder: PersistenceRaceStep[];
}

function trackedBreaker(): {
  breaker: CircuitBreaker;
  observations: BreakerObservations;
} {
  const inner = createCircuitBreaker({
    config: { failureThreshold: 1, cooldownMs: 60_000 },
    now: Date.now,
  });
  const observations: BreakerObservations = { failures: 0, cooldowns: 0 };
  return {
    observations,
    breaker: {
      canAttempt(model) {
        const decision = inner.canAttempt(model);
        if (!decision.allow && decision.reason === "circuit_open") observations.cooldowns += 1;
        return decision;
      },
      recordFailure(model) {
        observations.failures += 1;
        inner.recordFailure(model);
      },
      recordSuccess: (model) => inner.recordSuccess(model),
      recordAbort: (model, probeToken) => inner.recordAbort(model, probeToken),
      getState: (model) => inner.getState(model),
    },
  };
}

function routeIdentity(keyId: string): {
  chat: AuthIdentity;
  pipeline: MessagesIdentity;
} {
  const commonCaps = {
    allowedLanes: null,
    allowCustomModel: true,
    blockedModels: null,
    allowFastMode: true,
    rateLimit: { rpm: null, tpm: null },
    concurrencyLimit: 1,
    budget: {
      requests: null,
      tokens: null,
      spendUsd: null,
      windowSeconds: null,
      behavior: "degrade" as const,
      degradeLane: null,
    },
    memory: {
      mode: "off" as const,
      projectId: null,
      threadSource: "header" as const,
    },
  };
  return {
    chat: {
      keyId,
      keyPrefix: "helm_test_route",
      accountId: "acct",
      orgId: null,
      userId: null,
      role: "user",
      caps: commonCaps,
    },
    pipeline: {
      keyId,
      keyPrefix: "helm_test_route",
      accountId: "acct",
      orgId: null,
      userId: null,
      role: "user",
      caps: commonCaps,
    },
  };
}

function errorClass(error: RouteError) {
  const parsed = ErrorClassSchema.safeParse(error.error_class);
  return parsed.success ? parsed.data : ("upstream_error" as const);
}

async function runProductionRouteLeaseLoss(
  protocol: ProductionRouteProtocol,
): Promise<ProductionRouteResult> {
  const state = providerState();
  const replica = await createReplica({
    name: `route-${protocol}`,
    state,
    ttlMs: 400,
    heartbeatMs: 40,
  });
  const keyId = `route-${protocol}-${crypto.randomUUID()}`;
  const identity = routeIdentity(keyId);
  const primaryAlias = `${protocol}-primary`;
  const fallbackAlias = `${protocol}-fallback`;
  const providerWaiting = deferred();
  const timeoutObserved = deferred();
  const persisted = deferred();
  const persistedDecisions: DecisionRecord[] = [];
  const persistenceOrder: PersistenceRaceStep[] = [];
  let primaryCalls = 0;
  let fallbackCalls = 0;
  let executionSignal: AbortSignal | null = null;
  const { breaker, observations } = trackedBreaker();

  async function* primaryStream(): AsyncGenerator<string> {
    yield `data: ${JSON.stringify({
      id: "chatcmpl-route-lease-loss",
      object: "chat.completion.chunk",
      created: 1,
      model: "wire/route-primary",
      choices: [
        {
          index: 0,
          delta: { role: "assistant", content: "first-visible-chunk" },
          finish_reason: null,
        },
      ],
    })}\n\n`;
    providerWaiting.resolve();
    if (executionSignal === null) throw new Error("production route did not bind its signal");
    await waitForAbort(executionSignal);
    if (executionSignal.reason !== CONCURRENCY_LEASE_LOST_REASON) {
      throw new Error(
        `expected lease loss to win cancellation race, got ${executionSignal.reason}`,
      );
    }
    persistenceOrder.push("lease_loss");
    throw abortError();
  }

  const primary = {
    chatCompletion: async () => ({ id: "unexpected-non-stream" }),
    chatCompletionStream: () => {
      primaryCalls += 1;
      return primaryStream();
    },
  } as unknown as ProviderClient;
  const fallback = {
    chatCompletion: async () => {
      fallbackCalls += 1;
      return { id: "unexpected-fallback" };
    },
    chatCompletionStream: () => {
      fallbackCalls += 1;
      return (async function* () {
        yield "data: [DONE]\n\n";
      })();
    },
  } as unknown as ProviderClient;
  const providers = new Map([
    [primaryAlias, primary],
    [fallbackAlias, fallback],
  ]);
  const registry = leaseLossRegistry([primaryAlias, fallbackAlias]);
  const routingDeps = {
    classify: async () => ({
      task_type: "general",
      complexity: "medium" as const,
      confidence: 1,
      decided_by: "rules" as const,
      constraints: {},
      explanation: [],
    }),
    policies: { policies: [] },
    lanes: {
      balanced: {
        primary: primaryAlias,
        fallback: [fallbackAlias],
        constraints: {},
      },
    },
    now: () => new Date(),
    log: () => {},
  } as RouteDeps;
  const route = (request: InternalRequest, options: RouteOptions, signal: AbortSignal) => {
    executionSignal = signal;
    return routeRequest(
      request,
      {
        ...routingDeps,
        execute: createExecute({
          defaultProvider: primary,
          providers,
          registry,
          breaker,
          catalog: new Map(),
          now: Date.now,
          signal,
        }),
      },
      options,
    );
  };

  const telemetry = {
    insert: async (input: { decision: DecisionRecord }) => {
      persistenceOrder.push("persist");
      persistedDecisions.push(input.decision);
      persisted.resolve();
      return { id: "route-lease-loss" };
    },
  } as unknown as TelemetryStore;
  const record: RecordServedDeps = {
    telemetry,
    redact: (decision) => decision,
    now: Date.now,
    capturePayloads: () => false,
    captureSessions: () => false,
  };
  const releaseAfterTimeoutSemaphore: DistributedKeyedSemaphore = {
    async acquire(args) {
      const acquired = await replica.manager.acquire(args);
      if (!acquired.ok) return acquired;
      let releasePromise: Promise<void> | null = null;
      return {
        ...acquired,
        release: () => {
          releasePromise ??= timeoutObserved.promise.then(() => acquired.release());
          return releasePromise;
        },
      };
    },
    shutdown: () => replica.manager.shutdown(),
  };
  const gate = createConcurrencyGate({
    semaphore: releaseAfterTimeoutSemaphore,
    getConfig: () => ({
      enabled: true,
      minSize: 2,
      multiplier: 0,
      waitTimeoutMs: 2_000,
    }),
  });
  const routeLogs: Array<{
    level: string;
    message: string;
    fields: Record<string, unknown> | undefined;
  }> = [];
  const app = createApp({
    logger: {
      log: (level, message, fields) => routeLogs.push({ level, message, fields }),
    },
    limits: { requestTimeoutMs: 2_000 },
  });
  app.use("*", async (c, next) => {
    const timeoutState = c.get("request_timeout");
    if (timeoutState === undefined) throw new Error("production route did not install limits");
    timeoutState.signal.addEventListener(
      "abort",
      () => {
        if (!timeoutState.timedOut) return;
        persistenceOrder.push("timeout");
        timeoutObserved.resolve();
      },
      { once: true },
    );
    await next();
  });

  try {
    let path: string;
    let headers: Record<string, string>;
    let body: Record<string, unknown>;
    if (protocol === "openai_chat") {
      path = "/v1/chat/completions";
      headers = { "content-type": "application/json" };
      body = {
        model: "auto",
        messages: [{ role: "user", content: "hello" }],
        stream: true,
      };
      app.use(path, async (c, next) => {
        c.set("identity", identity.chat);
        await next();
      });
      app.use(path, concurrencyMiddleware(gate));
      registerChatRoutes(app, {
        route,
        telemetry,
        redact: (decision) => decision,
        now: Date.now,
      });
    } else if (protocol === "anthropic_messages") {
      path = "/v1/messages";
      headers = { "content-type": "application/json", "x-api-key": "route-test-key" };
      body = {
        model: "auto",
        max_tokens: 32,
        messages: [{ role: "user", content: "hello" }],
        stream: true,
      };
      registerMessagesRoute(app, {
        concurrencyGate: gate,
        record,
        auth: { resolve: async () => identity.pipeline },
        transformers: {
          anthropic: {
            transformRequestOut: (native) => anthropicTransformer.transformRequestOut(native),
            transformResponseOut: (ir, options) =>
              anthropicTransformer.transformResponseOut(ir as IRResponse, options),
            transformStreamOut: (event) => {
              const typed = event as AnthropicSSEEvent & { type: string };
              return { event: typed.type, data: JSON.stringify(typed) };
            },
            transformErrorOut: (error) =>
              makeAnthropicError({
                error_class: errorClass(error),
                message: error.message,
                trace_id: error.trace_id,
              }),
          },
        },
        pipeline: createMessagesPipeline(route, protocol),
      });
    } else if (protocol === "openai_responses") {
      path = "/v1/responses";
      headers = {
        authorization: "Bearer route-test-key",
        "content-type": "application/json",
      };
      body = { model: "auto", input: "hello", stream: true };
      registerResponsesRoute(app, {
        concurrencyGate: gate,
        record,
        auth: { resolve: async () => identity.pipeline },
        transformer: {
          transformRequestOut: (native) => responsesTransformer.transformRequestOut(native),
          transformResponseOut: (ir) => responsesTransformer.transformResponseOut(ir as IRResponse),
          transformStreamOut: (event) => {
            const typed = event as ResponsesSSEEvent & { type: string };
            return { event: typed.type, data: JSON.stringify(typed) };
          },
        },
        pipeline: createMessagesPipeline(route, protocol),
      });
    } else {
      path = "/v1beta/models/auto:streamGenerateContent?alt=sse";
      headers = {
        "content-type": "application/json",
        "x-goog-api-key": "route-test-key",
      };
      body = {
        contents: [{ role: "user", parts: [{ text: "hello" }] }],
      };
      registerGeminiRoute(app, {
        concurrencyGate: gate,
        record,
        auth: { resolve: async () => identity.pipeline },
        transformer: {
          transformRequestOut: (native) => geminiTransformer.transformRequestOut(native),
          transformResponseOut: (ir) => geminiTransformer.transformResponseOut(ir as IRResponse),
          transformErrorOut: (error) =>
            makeGeminiError({
              error_class: errorClass(error),
              message: error.message,
              trace_id: error.trace_id,
            }),
        },
        pipeline: createMessagesPipeline(route, protocol),
      });
    }

    const response = await app.request(path, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
    if (response.status !== 200) {
      throw new Error(
        `${protocol} route returned HTTP ${response.status}: ${await response.text()}; logs=${JSON.stringify(routeLogs)}`,
      );
    }
    const wirePromise = response.text();
    await providerWaiting.promise;
    await replica.deleteCurrentLease(keyId);
    const wire = await wirePromise;
    await persisted.promise;
    expect(persistedDecisions).toHaveLength(1);
    return {
      wire,
      decision: persistedDecisions[0] as DecisionRecord,
      primaryCalls,
      fallbackCalls,
      breakerState: breaker.getState(primaryAlias),
      breaker: observations,
      persistenceOrder,
    };
  } finally {
    await replica.shutdown();
  }
}

function assertProductionRouteLeaseLoss(
  result: ProductionRouteResult,
  normalTerminals: readonly string[],
): void {
  expect(result.wire).toContain("first-visible-chunk");
  for (const terminal of normalTerminals) expect(result.wire).not.toContain(terminal);
  expect(result.decision.fallback_count).toBe(0);
  expect(result.decision.provider_attempts).toHaveLength(1);
  expect(result.primaryCalls).toBe(1);
  expect(result.fallbackCalls).toBe(0);
  expect(result.breakerState).toBe("CLOSED");
  expect(result.breaker.failures).toBe(0);
  expect(result.breaker.cooldowns).toBe(0);
  expect(result.persistenceOrder).toEqual(["lease_loss", "timeout", "persist"]);
  expect(result.decision.final.status).toBe("error");
  expect(result.decision.stream_outcome).toBe("truncated");
  expect(result.decision.final.error_reason).toBe("concurrency_lease_lost");
}

test.describe("real PostgreSQL distributed concurrency leases", () => {
  test("preserves Chat lease loss when timeout follows lease loss before independent persistence", async () => {
    test.setTimeout(20_000);
    assertProductionRouteLeaseLoss(await runProductionRouteLeaseLoss("openai_chat"), ["[DONE]"]);
  });

  test("preserves Messages lease loss when timeout follows lease loss before shared persistence", async () => {
    test.setTimeout(20_000);
    assertProductionRouteLeaseLoss(await runProductionRouteLeaseLoss("anthropic_messages"), [
      "event: message_stop",
    ]);
  });

  test("preserves Responses lease loss when timeout follows lease loss before shared persistence", async () => {
    test.setTimeout(20_000);
    assertProductionRouteLeaseLoss(await runProductionRouteLeaseLoss("openai_responses"), [
      "event: response.completed",
    ]);
  });

  test("preserves Gemini lease loss when timeout follows lease loss before shared persistence", async () => {
    test.setTimeout(20_000);
    assertProductionRouteLeaseLoss(await runProductionRouteLeaseLoss("gemini"), [
      '"finishReason":"STOP"',
      "[DONE]",
    ]);
  });

  test("enforces one global slot across two replicas and 100 concurrent requests", async () => {
    test.setTimeout(20_000);
    const state = providerState();
    const replicaA = await createReplica({ name: "load-a", state, waitTimeoutMs: 5_000 });
    const replicaB = await createReplica({ name: "load-b", state, waitTimeoutMs: 5_000 });
    const keyId = `load-${crypto.randomUUID()}`;
    try {
      const responses = await Promise.all(
        Array.from({ length: 100 }, (_, index) =>
          work(index % 2 === 0 ? replicaA : replicaB, keyId, 3),
        ),
      );
      expect(responses.map((response) => response.status)).toEqual(Array(100).fill(200));
      expect(state.calls).toBe(100);
      expect(state.maxActive).toBe(1);
      console.info(`[real-pg] requests=100 max_active=${state.maxActive}`);
    } finally {
      await Promise.all([replicaA.shutdown(), replicaB.shutdown()]);
    }
  });

  test("does not let key A limit=1 block key B", async () => {
    const state = providerState();
    const replicaA = await createReplica({ name: "isolation-a", state });
    const replicaB = await createReplica({ name: "isolation-b", state });
    const holdA = deferred();
    const keyA = `isolation-a-${crypto.randomUUID()}`;
    const keyB = `isolation-b-${crypto.randomUUID()}`;
    try {
      const held = replicaA.manager.acquire({
        key: keyA,
        limit: 1,
        maxQueue: 2,
        timeoutMs: 2_000,
      });
      const leaseA = await held;
      expect(leaseA.ok).toBe(true);

      const responseB = await Promise.race([
        work(replicaB, keyB, 10),
        holdA.promise.then(() => {
          throw new Error("key B waited for unrelated key A");
        }),
      ]);
      expect(responseB.status).toBe(200);
      if (leaseA.ok) await leaseA.release();
    } finally {
      holdA.resolve();
      await Promise.all([replicaA.shutdown(), replicaB.shutdown()]);
    }
  });

  test("recovers capacity after a child replica holding the lease is SIGKILLed", async () => {
    test.setTimeout(10_000);
    const ttlMs = 250;
    const state = providerState();
    const replicaB = await createReplica({
      name: "crash-b",
      state,
      ttlMs,
      heartbeatMs: 50,
      waitTimeoutMs: ttlMs + 5_000,
    });
    const keyId = `crash-${crypto.randomUUID()}`;
    let child: ChildProcessWithoutNullStreams | undefined;
    try {
      child = await spawnLeaseHolderChild(keyId, ttlMs);
      const crashedAt = Date.now();
      expect(child.kill("SIGKILL")).toBe(true);
      const [exitCode, exitSignal] = await new Promise<[number | null, NodeJS.Signals | null]>(
        (resolve) => child?.once("exit", (code, signal) => resolve([code, signal])),
      );
      expect(exitCode).toBeNull();
      expect(exitSignal).toBe("SIGKILL");

      const recovered = await replicaB.manager.acquire({
        key: keyId,
        limit: 1,
        maxQueue: 2,
        timeoutMs: ttlMs + 5_000,
      });
      const recoveryMs = Date.now() - crashedAt;
      expect(recovered.ok).toBe(true);
      expect(recoveryMs).toBeLessThanOrEqual(ttlMs + 5_000);
      console.info(`[real-pg] child_sigkill=true crash_recovery_ms=${recoveryMs} ttl_ms=${ttlMs}`);
      if (recovered.ok) await recovered.release();
    } finally {
      if (child?.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await replicaB.shutdown();
    }
  });

  test("heartbeats a request beyond two TTLs without oversubscribing", async () => {
    test.setTimeout(10_000);
    const ttlMs = 180;
    const state = providerState();
    const replicaA = await createReplica({
      name: "heartbeat-a",
      state,
      ttlMs,
      heartbeatMs: 40,
      waitTimeoutMs: 4_000,
    });
    const replicaB = await createReplica({
      name: "heartbeat-b",
      state,
      ttlMs,
      heartbeatMs: 40,
      waitTimeoutMs: 4_000,
    });
    const keyId = `heartbeat-${crypto.randomUUID()}`;
    try {
      const first = work(replicaA, keyId, ttlMs * 3);
      await delay(50);
      const second = work(replicaB, keyId, 10);
      expect((await first).status).toBe(200);
      expect((await second).status).toBe(200);
      expect(state.maxActive).toBe(1);
    } finally {
      await Promise.all([replicaA.shutdown(), replicaB.shutdown()]);
    }
  });

  test("routes real-PG lease loss through production execute and runImageChain semantics", async () => {
    test.setTimeout(20_000);
    const state = providerState();
    const replica = await createReplica({
      name: "lease-loss-production",
      state,
      ttlMs: 400,
      heartbeatMs: 40,
    });
    try {
      const textKey = `lease-loss-text-${crypto.randomUUID()}`;
      const textLease = await acquireLease(replica, textKey);
      const textEntered = deferred();
      let primaryCalls = 0;
      let fallbackCalls = 0;
      const primary = {
        chatCompletion: async (_request: unknown, options: { signal: AbortSignal }) => {
          primaryCalls += 1;
          textEntered.resolve();
          await waitForAbort(options.signal);
          throw abortError();
        },
        chatCompletionStream: () => {
          throw new Error("unexpected stream call");
        },
      } as unknown as ProviderClient;
      const fallback = {
        chatCompletion: async () => {
          fallbackCalls += 1;
          return { id: "unexpected-fallback" };
        },
        chatCompletionStream: () => {
          throw new Error("unexpected fallback stream call");
        },
      } as unknown as ProviderClient;
      const textBreaker = createCircuitBreaker({
        config: { failureThreshold: 1, cooldownMs: 60_000 },
        now: Date.now,
      });
      const executeText = createExecute({
        defaultProvider: primary,
        providers: new Map([
          ["primary", primary],
          ["fallback", fallback],
        ]),
        registry: leaseLossRegistry(["primary", "fallback"]),
        breaker: textBreaker,
        catalog: new Map(),
        now: Date.now,
        signal: textLease.signal,
      });
      const textOutcomePromise = executeText(
        leaseLossPlan(["primary", "fallback"]),
        leaseLossRequest(),
      );
      await textEntered.promise;
      await replica.deleteCurrentLease(textKey);
      const textOutcome = await textOutcomePromise;
      expect(textOutcome.final.status).toBe("error");
      if (textOutcome.final.status !== "error") throw new Error("expected terminal text error");
      expect(textOutcome.final.error.error_class).toBe("lane_unavailable");
      expect(ERROR_CLASS_HTTP_STATUS[textOutcome.final.error.error_class]).toBe(503);
      expect(textOutcome.attempts[0]).toMatchObject({
        skip_reason: "concurrency_lease_lost",
        error_class: "lane_unavailable",
      });
      expect(primaryCalls).toBe(1);
      expect(fallbackCalls).toBe(0);
      expect(textBreaker.getState("primary")).toBe("CLOSED");

      for (const kind of ["openai", "gemini"] as const) {
        const keyId = `lease-loss-${kind}-${crypto.randomUUID()}`;
        const held = await acquireLease(replica, keyId);
        const entered = deferred();
        let calls = 0;
        const imageBreaker = createCircuitBreaker({
          config: { failureThreshold: 1, cooldownMs: 60_000 },
          now: Date.now,
        });
        const targets: ImageChainTarget[] = [
          {
            alias: `${kind}-primary`,
            providerModel: `${kind}-wire-primary`,
            kind,
            client: {} as ProviderClient,
          },
          {
            alias: `${kind}-fallback`,
            providerModel: `${kind}-wire-fallback`,
            kind,
            client: {} as ProviderClient,
          },
        ];
        const attempt: ImageAttempt = async () => {
          calls += 1;
          entered.resolve();
          await waitForAbort(held.signal);
          throw abortError();
        };
        const outcomePromise = runImageChain(targets, imageBreaker, attempt, held.signal);
        await entered.promise;
        await replica.deleteCurrentLease(keyId);
        const outcome = await outcomePromise;
        expect(outcome.ok).toBe(false);
        if (outcome.ok) throw new Error("expected terminal image error");
        expect(outcome.aborted).toBe(false);
        expect(outcome.errorClass).toBe("lane_unavailable");
        expect(outcome.httpStatus).toBe(503);
        expect(outcome.attempts[0]).toMatchObject({
          skip_reason: "concurrency_lease_lost",
          error_class: "lane_unavailable",
        });
        expect(calls).toBe(1);
        expect(imageBreaker.getState(`${kind}-primary`)).toBe("CLOSED");
      }

      const streamKey = `lease-loss-stream-${crypto.randomUUID()}`;
      const streamLease = await acquireLease(replica, streamKey);
      const streamWaiting = deferred();
      const streamLogs: Array<{ msg: string; fields: Record<string, unknown> }> = [];
      async function* productionStream(): AsyncGenerator<string> {
        yield 'data: {"choices":[{"delta":{"content":"first"}}]}\n\n';
        streamWaiting.resolve();
        await waitForAbort(streamLease.signal);
        throw abortError();
      }
      const streamProvider = {
        chatCompletion: async () => ({ id: "unexpected-non-stream" }),
        chatCompletionStream: () => productionStream(),
      } as unknown as ProviderClient;
      const streamBreaker = createCircuitBreaker({
        config: { failureThreshold: 1, cooldownMs: 60_000 },
        now: Date.now,
      });
      const executeStream = createExecute({
        defaultProvider: streamProvider,
        providers: new Map([["stream-primary", streamProvider]]),
        registry: leaseLossRegistry(["stream-primary"]),
        breaker: streamBreaker,
        catalog: new Map(),
        now: Date.now,
        signal: streamLease.signal,
        log: (_level, msg, fields) => streamLogs.push({ msg, fields }),
      });
      const streamOutcome = await executeStream(
        leaseLossPlan(["stream-primary"]),
        leaseLossRequest(true),
      );
      expect(streamOutcome.final.status).toBe("ok");
      const chunks: string[] = [];
      let streamError: unknown;
      const consume = (async () => {
        try {
          for await (const chunk of streamOutcome.stream as AsyncIterable<string>)
            chunks.push(chunk);
        } catch (error) {
          streamError = error;
        }
      })();
      await streamWaiting.promise;
      await replica.deleteCurrentLease(streamKey);
      await consume;
      expect(streamError).toBeInstanceOf(Error);
      expect(chunks.join("")).not.toContain("[DONE]");
      expect(streamLogs).toContainEqual({
        msg: "stream.truncated",
        fields: {
          alias: "stream-primary",
          error_class: "lane_unavailable",
          reason: "concurrency_lease_lost",
        },
      });
      expect(streamBreaker.getState("stream-primary")).toBe("CLOSED");
      console.info(
        "[real-pg] production lease-loss text/image/interaction/stream failure=0 cooldown=0",
      );
    } finally {
      await replica.shutdown();
    }
  });

  test("leaves zero real-PG leases after provider error timeout client abort and stream error", async () => {
    test.setTimeout(15_000);
    const state = providerState();
    const replica = await createReplica({
      name: "exit-matrix",
      state,
      ttlMs: 500,
      heartbeatMs: 100,
      waitTimeoutMs: 2_000,
    });
    const gate = createConcurrencyGate({
      semaphore: replica.manager,
      getConfig: () => ({ enabled: true, minSize: 2, multiplier: 0, waitTimeoutMs: 2_000 }),
    });
    const app = createApp({ logger: { log: () => {} } });
    const keyFor = (path: string) => `exit-${path}-${crypto.randomUUID()}`;
    const keys = new Map<string, string>();
    app.use("/exit/*", async (c, next) => {
      const path = c.req.path.split("/").at(-1) ?? "unknown";
      const keyId = c.req.header("x-test-key") ?? keyFor(path);
      keys.set(path, keyId);
      // biome-ignore lint/suspicious/noExplicitAny: request-level test identity seam
      (c as any).set("identity", { keyId, caps: { concurrencyLimit: 1 } });
      await next();
    });
    app.use("/exit/request-timeout", timeout({ requestTimeoutMs: 25 }));
    app.use("/exit/*", concurrencyMiddleware(gate));
    app.get("/exit/provider-error", () => {
      throw new Error("provider failed");
    });
    app.get("/exit/request-timeout", async (c) => {
      await waitForAbort(requestSignal(c));
      await delay(10);
      return c.text("late timeout completion");
    });
    const clientEntered = deferred();
    app.get("/exit/client-abort", async (c) => {
      clientEntered.resolve();
      await waitForAbort(requestSignal(c));
      throw Object.assign(new Error("client abort"), { name: "AbortError" });
    });
    app.get("/exit/stream-error", (c) => {
      const release = c.get("concurrencyClaim")?.();
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode("first"));
          setTimeout(() => {
            void release?.().finally(() => controller.error(new Error("stream failed")));
          }, 10);
        },
        async cancel() {
          await release?.();
        },
      });
      return new Response(body);
    });

    const assertNoResidual = async (path: string): Promise<void> => {
      const keyId = keys.get(path);
      expect(keyId).toBeTruthy();
      const probe = await replica.manager.acquire({
        key: keyId as string,
        limit: 1,
        maxQueue: 0,
        timeoutMs: 1_000,
      });
      expect(probe.ok).toBe(true);
      if (probe.ok) await probe.release();
    };

    try {
      const providerKey = keyFor("provider-error");
      expect(
        (
          await app.request("/exit/provider-error", {
            headers: { "x-test-key": providerKey },
          })
        ).status,
      ).toBe(502);
      await assertNoResidual("provider-error");

      const timeoutKey = keyFor("request-timeout");
      expect(
        (
          await app.request("/exit/request-timeout", {
            headers: { "x-test-key": timeoutKey },
          })
        ).status,
      ).toBe(504);
      await delay(20);
      await assertNoResidual("request-timeout");

      const abortKey = keyFor("client-abort");
      const controller = new AbortController();
      const abortedRequest = app
        .request("/exit/client-abort", {
          headers: { "x-test-key": abortKey },
          signal: controller.signal,
        })
        .catch(() => null);
      await clientEntered.promise;
      controller.abort("client_disconnect");
      await abortedRequest;
      await assertNoResidual("client-abort");

      const streamKey = keyFor("stream-error");
      const streamResponse = await app.request("/exit/stream-error", {
        headers: { "x-test-key": streamKey },
      });
      await expect(streamResponse.text()).rejects.toThrow("stream failed");
      await assertNoResidual("stream-error");
      console.info(
        "[real-pg] exit_matrix provider_error/timeout/client_abort/stream_error residual=0",
      );
    } finally {
      await replica.shutdown();
    }
  });

  test("holds a streaming slot until the final event and reader cancel", async () => {
    test.setTimeout(10_000);
    const state = providerState();
    const replicaA = await createReplica({ name: "stream-a", state, waitTimeoutMs: 4_000 });
    const replicaB = await createReplica({ name: "stream-b", state, waitTimeoutMs: 4_000 });
    const keyId = `stream-${crypto.randomUUID()}`;
    try {
      const first = streamApp(replicaA);
      const response = await first.app.request("/stream", { headers: { "x-test-key": keyId } });
      await first.ready;
      const competing = work(replicaB, keyId, 5);
      let competingDone = false;
      void competing.then(() => {
        competingDone = true;
      });
      await delay(100);
      expect(competingDone).toBe(false);
      first.finish();
      expect(await response.text()).toContain("[DONE]");
      expect((await competing).status).toBe(200);

      const cancelled = streamApp(replicaA);
      const cancelResponse = await cancelled.app.request("/stream", {
        headers: { "x-test-key": keyId },
      });
      await cancelled.ready;
      const reader = cancelResponse.body?.getReader();
      expect(reader).toBeTruthy();
      await reader?.read();
      const blocked = work(replicaB, keyId, 5);
      await delay(100);
      await reader?.cancel("client_cancelled");
      expect((await blocked).status).toBe(200);
    } finally {
      await Promise.all([replicaA.shutdown(), replicaB.shutdown()]);
    }
  });

  test("fails closed with protocol 503 and zero provider calls when the DB is unavailable", async () => {
    const state = providerState();
    const replica = await createReplica({ name: "db-down", state });
    try {
      await replica.closeDb();
      const response = await work(replica, `db-down-${crypto.randomUUID()}`);
      expect(response.status).toBe(503);
      expect(state.calls).toBe(0);
      const body = (await response.json()) as { error: { code: string } };
      expect(body.error.code).toBe("lane_unavailable");
    } finally {
      await replica.shutdown();
    }
  });
});
