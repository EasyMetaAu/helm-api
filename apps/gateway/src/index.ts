// @helm/gateway entry. Builds the full Phase 0 server and starts listening.
// Fail-closed: invalid config / missing credentials throw and the process exits
// non-zero rather than starting in a degraded state.

import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
import { createJsonLogger } from "./logging.js";
import { buildServer } from "./server.js";

export { type AppDeps, type AppEnv, createApp } from "./app.js";
export { type BuildInfo, readBuildInfo } from "./build-info.js";
export { createJsonLogger, type Logger } from "./logging.js";
export { type AuthDeps, type AuthIdentity, authMiddleware } from "./middleware/auth.js";
export { HelmHttpError } from "./middleware/error-handler.js";
export { bodyLimit, type LimitsConfig, timeout } from "./middleware/limits.js";
export { normalizeHeaders } from "./middleware/normalize-headers.js";
export { type ChatRouteDeps, registerChatRoutes } from "./routes/chat.js";
export { type HealthDeps, registerHealthRoutes } from "./routes/health.js";
export { buildServer, type ServerHandle } from "./server.js";

export function buildDefaultApp() {
  return createApp({ logger: createJsonLogger() });
}

// Start the server when run directly (e.g. `node dist/index.js` in the image).
function main(): void {
  const logger = createJsonLogger();
  try {
    const { app, port, host } = buildServer({ logger });
    serve({ fetch: app.fetch, port, hostname: host });
    logger.log("info", "gateway.listening", { host, port });
  } catch (err) {
    logger.log("error", "gateway.startup_failed", {
      message: err instanceof Error ? err.message : String(err),
    });
    process.exit(1);
  }
}

// Detect "run as the main module" under Node ESM.
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main();
}
