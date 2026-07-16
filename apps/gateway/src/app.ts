import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { readBuildInfo } from "./build-info.js";
import type { Logger } from "./logging.js";
import { handleError } from "./middleware/error-handler.js";
import {
  bodyLimit,
  type LimitsConfig,
  type RequestTimeoutState,
  timeout,
} from "./middleware/limits.js";
import { normalizeHeaders } from "./middleware/normalize-headers.js";
import { requestLoggerMiddleware } from "./middleware/request-logger.js";
import { traceIdMiddleware } from "./middleware/trace-id.js";
import { type HealthDeps, registerHealthRoutes } from "./routes/health.js";
import { registerLandingRoute } from "./routes/landing.js";
import { registerOpenApiRoutes } from "./routes/openapi.js";

export interface AppDeps {
  logger: Logger;
  genTraceId?: () => string;
  // Health/version wiring. Optional so tests can build a bare app; defaults to a
  // ready probe + env-derived build info.
  health?: HealthDeps;
  // Request size/timeout limits. Optional; omitted = no limits middleware.
  limits?: LimitsConfig;
}

// Per-request context variables (typed c.get/c.set).
export type AppEnv = {
  Variables: {
    // Server-generated storage/audit identity. This is never sourced from a
    // client header and is the only id allowed to key telemetry/payload rows.
    request_id: string;
    // Client-facing correlation id. May come from X-Request-Id/X-Trace-Id and
    // is safe for logs/response envelopes, but must never be a storage key.
    trace_id: string;
    logger: Logger;
    request_timeout?: RequestTimeoutState;
  };
};

// Assemble middleware + routes + the global error handler. Does NOT listen() —
// the entry file serves it so tests can call app.request() directly.
//
// Middleware order is a contract (outer -> inner):
//   1. request_id + trace_id (generate internal id + resolve client correlation;
//                             must precede the logger)
//   2. logger ctx   (expose logger on the context)
//   3. requestLogger(one structured completion log per request)
//   4. [limits]     (gateway.limits mounts here)
//   5. [auth]       (auth mounts here)
//   6. routes       (/healthz /version, then /v1/*)
//   7. /admin/*     (admin API + static SPA; wired in server.ts, not here)
export function createApp(deps: AppDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  const genTraceId = deps.genTraceId ?? randomUUID;

  app.use("*", traceIdMiddleware(genTraceId));
  app.use("*", async (c, next) => {
    c.set("logger", deps.logger);
    await next();
  });
  app.use("*", requestLoggerMiddleware());

  // Hygiene: normalize hop-by-hop/correlation headers, then enforce body size + timeout.
  // Order: normalizeHeaders -> bodyLimit -> timeout (before auth/routes).
  app.use("*", normalizeHeaders());
  if (deps.limits) {
    app.use("*", bodyLimit(deps.limits));
    app.use("*", timeout(deps.limits));
  }

  // Health/version routes (unauthenticated, registered before auth).
  const health: HealthDeps = deps.health ?? {
    checkReadiness: async () => ({ ready: true, checks: {} }),
    buildInfo: readBuildInfo(),
  };
  registerHealthRoutes(app, health);

  // Public landing page at "/" (status dashboard). Unauthenticated, static HTML;
  // replaces the bare 404 the root used to return. Headless callers simply never
  // see it — it adds no dependency on routing/admin (Principle 1).
  registerLandingRoute(app);

  // Public API docs: GET /openapi.json (3.1 spec generated from the Zod schemas)
  // and GET /docs (Swagger UI). Schema-only, no data — safe to expose unauth.
  registerOpenApiRoutes(app, { buildInfo: health.buildInfo });

  // /admin (admin API + static SPA) is wired by server.ts (it needs the resolved
  // adminAuth config + Store deps). createApp stays framework-glue only and does
  // NOT mount admin so headless callers can opt out entirely (CLAUDE.md Principle 1).

  app.onError((err, c) => handleError(err, c));

  return app;
}
