// @helm/gateway entry. Builds the full Phase 0 server and starts listening.
// Fail-closed: invalid config / missing credentials throw and the process exits
// non-zero rather than starting in a degraded state.

import { readFile } from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { loadConfig } from "@helm/core";
import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
import { createJsonLogger } from "./logging.js";
import {
  installRealtimeWebSocketBridge,
  isRealtimeWebSocketPath,
  type RealtimeWebSocketBridge,
} from "./realtime-websocket.js";
import {
  installResponsesWebSocketBridge,
  isResponsesWebSocketPath,
  type ResponsesWebSocketBridge,
} from "./responses-websocket.js";
import { configureEgress } from "./runtime/egress.js";
import { type ClosableServer, closeServer } from "./runtime/shutdown.js";
import { buildServer, type ServerHandle, testStaticProviderKey } from "./server.js";
import {
  createSetupServer,
  loadManagedEnvironment,
  type SetupProvider,
  setupRequired,
} from "./setup.js";

export { type AppDeps, type AppEnv, createApp } from "./app.js";
export { type BuildInfo, readBuildInfo } from "./build-info.js";
export { createJsonLogger, type Logger } from "./logging.js";
export { type AuthDeps, type AuthIdentity, authMiddleware } from "./middleware/auth.js";
export { HelmHttpError } from "./middleware/error-handler.js";
export { type LimitsConfig, timeout } from "./middleware/limits.js";
export { normalizeHeaders } from "./middleware/normalize-headers.js";
export {
  type RateLimiterPort,
  type RateLimitMiddlewareDeps,
  rateLimitMiddleware,
} from "./middleware/rate-limit.js";
export {
  installRealtimeWebSocketBridge,
  isRealtimeWebSocketPath,
  type RealtimeWebSocketBridge,
  type RealtimeWebSocketBridgeOptions,
} from "./realtime-websocket.js";
export {
  installResponsesWebSocketBridge,
  isResponsesWebSocketPath,
  type ResponsesWebSocketBridge,
  type ResponsesWebSocketBridgeOptions,
  type ResponsesWebSocketUpgradeServer,
} from "./responses-websocket.js";
export { type ChatRouteDeps, registerChatRoutes } from "./routes/chat.js";
export { type HealthDeps, registerHealthRoutes } from "./routes/health.js";
export {
  type AnthropicErrorOut,
  type AnthropicSSEFrame,
  type MessagesIdentity,
  type MessagesRouteDeps,
  type PipelineRunResult,
  type RouteError,
  registerMessagesRoute,
} from "./routes/messages.js";
export { buildServer, type ServerHandle } from "./server.js";

export function buildDefaultApp() {
  return createApp({ logger: createJsonLogger() });
}

// Start the server when run directly (e.g. `node dist/index.js` in the image).
async function main(): Promise<void> {
  const logger = createJsonLogger();
  try {
    // Tune the process-global undici dispatcher (keep-alive) BEFORE any upstream
    // call can be made — it is a process global, so it cannot live inside buildServer.
    configureEgress(process.env);
    const config = loadConfig({ configDir: "./config" });
    const dataDir = process.env.HELM_DATA_DIR ?? "./data";
    const staticProviders = config.providers.filter(
      (provider): provider is typeof provider & { api_key_env: string } =>
        !provider.oauth && typeof provider.api_key_env === "string" && provider.api_key_env !== "",
    );
    const providerEnvNames = [...new Set(staticProviders.map((provider) => provider.api_key_env))];
    await loadManagedEnvironment({
      dataDir,
      env: process.env,
      allowedProviderEnvNames: providerEnvNames,
    });

    let handle: ServerHandle;
    let responsesWebSocket: ResponsesWebSocketBridge | undefined;
    let realtimeWebSocket: RealtimeWebSocketBridge | undefined;
    let server: ReturnType<typeof serve> | undefined;
    let rejectUnknownUpgrade: ((request: IncomingMessage, socket: Duplex) => void) | undefined;

    const attachWebSockets = (next: ServerHandle): void => {
      if (!server) return;
      if (!responsesWebSocket) {
        responsesWebSocket = installResponsesWebSocketBridge({
          server,
          fetch: (request) => handle.app.fetch(request),
          closeSession: next.closeResponsesWebSocketSession,
          sessionProof: next.responsesWebSocketSessionProof,
          memoryAdmission: next.responsesMemoryAdmission,
          ingressAdmission: next.websocketIngressAdmission,
        });
      }
      if (!realtimeWebSocket && next.realtimeCallRegistry && next.resolveRealtimeKey) {
        realtimeWebSocket = installRealtimeWebSocketBridge({
          server,
          registry: next.realtimeCallRegistry,
          resolveKey: next.resolveRealtimeKey,
          memoryAdmission: next.websocketIngressAdmission,
        });
      }
      if (!rejectUnknownUpgrade) {
        rejectUnknownUpgrade = (request, socket) => {
          if (!isResponsesWebSocketPath(request.url) && !isRealtimeWebSocketPath(request.url)) {
            socket.destroy();
          }
        };
        server.on("upgrade", rejectUnknownUpgrade);
      }
    };

    if (setupRequired(process.env)) {
      const representativeByEnv = new Map(
        providerEnvNames.flatMap((envName) => {
          const matching = staticProviders.filter((provider) => provider.api_key_env === envName);
          const representative =
            matching.find((provider) => provider.type === "openai") ?? matching[0];
          return representative ? [[envName, representative] as const] : [];
        }),
      );
      const setupProviders: SetupProvider[] = [...representativeByEnv].map(
        ([envName, provider]) => ({
          id: envName,
          label: provider.name,
          envName,
          configured: Boolean(process.env[envName]),
        }),
      );
      const setup = await createSetupServer({
        dataDir,
        host: config.server.host,
        port: config.server.port,
        providers: setupProviders,
        env: process.env,
        testProvider: async (providerId, apiKey) => {
          const provider = representativeByEnv.get(providerId);
          if (!provider) throw new Error(`unknown provider ${providerId}`);
          await testStaticProviderKey(provider, apiKey);
        },
        buildFullServer: () => buildServer({ logger }),
        activate: (next) => {
          handle = next;
          attachWebSockets(next);
          logger.log("info", "gateway.setup_completed", { host: next.host, port: next.port });
        },
        readRootKey: async () => {
          try {
            return (await readFile(config.auth.bootstrap.persist_to, "utf8")).trim() || null;
          } catch {
            return null;
          }
        },
        log: (line) => logger.log("warn", "gateway.setup", { line }),
      });
      handle = setup.handle;
    } else {
      handle = await buildServer({ logger });
    }

    server = serve({
      fetch: (request) => handle.app.fetch(request),
      port: handle.port,
      hostname: handle.host,
    });
    if (!setupRequired(process.env)) attachWebSockets(handle);
    logger.log("info", "gateway.listening", {
      host: handle.host,
      port: handle.port,
      mode: setupRequired(process.env) ? "setup" : "gateway",
    });

    // Graceful shutdown: FIRST stop accepting connections and wait for in-flight
    // requests to finish (so their post-response enqueue()s land while the queue is
    // still running), THEN drain the deferred write queue + close the store
    // (handle.dispose). Ordering matters — disposing before requests drain would drop
    // their telemetry/payload writes and run budget/store work against a closed DB.
    // Idempotent across repeated signals. The drain is bounded by HELM_SHUTDOWN_DRAIN_MS.
    const drainRaw = Number(process.env.HELM_SHUTDOWN_DRAIN_MS);
    const drainMs = Number.isFinite(drainRaw) && drainRaw > 0 ? drainRaw : 10_000;
    let shuttingDown = false;
    const shutdown = async (signal: string): Promise<void> => {
      if (shuttingDown) return;
      shuttingDown = true;
      logger.log("info", "gateway.shutdown", { signal });
      try {
        await responsesWebSocket?.close();
        await realtimeWebSocket?.close();
        if (rejectUnknownUpgrade) server?.off("upgrade", rejectUnknownUpgrade);
        await closeServer(server as unknown as ClosableServer, drainMs);
        await handle.dispose?.();
      } catch (err) {
        logger.log("error", "gateway.shutdown_failed", {
          message: err instanceof Error ? err.message : String(err),
        });
      } finally {
        process.exit(0);
      }
    };
    process.on("SIGTERM", () => void shutdown("SIGTERM"));
    process.on("SIGINT", () => void shutdown("SIGINT"));
  } catch (err) {
    logger.log("error", "gateway.startup_failed", {
      message: err instanceof Error ? err.message : String(err),
    });
    process.exit(1);
  }
}

// Detect "run as the main module" under Node ESM.
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  void main();
}
