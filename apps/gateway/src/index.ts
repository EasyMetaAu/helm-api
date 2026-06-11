// @helm/gateway entry. Builds the full Phase 0 server and starts listening.
// Fail-closed: invalid config / missing credentials throw and the process exits
// non-zero rather than starting in a degraded state.

import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
import { createJsonLogger } from "./logging.js";
import { configureEgress } from "./runtime/egress.js";
import { type ClosableServer, closeServer } from "./runtime/shutdown.js";
import { buildServer } from "./server.js";

export { type AppDeps, type AppEnv, createApp } from "./app.js";
export { type BuildInfo, readBuildInfo } from "./build-info.js";
export { createJsonLogger, type Logger } from "./logging.js";
export { type AuthDeps, type AuthIdentity, authMiddleware } from "./middleware/auth.js";
export { HelmHttpError } from "./middleware/error-handler.js";
export { bodyLimit, type LimitsConfig, timeout } from "./middleware/limits.js";
export { normalizeHeaders } from "./middleware/normalize-headers.js";
export {
  type RateLimiterPort,
  type RateLimitMiddlewareDeps,
  rateLimitMiddleware,
} from "./middleware/rate-limit.js";
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
    const handle = await buildServer({ logger });
    const server = serve({ fetch: handle.app.fetch, port: handle.port, hostname: handle.host });
    logger.log("info", "gateway.listening", { host: handle.host, port: handle.port });

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
