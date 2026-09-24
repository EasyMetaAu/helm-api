import { consumeResponseTextWithinBudget, ResponseWorkCapacityError } from "@helm/core";
import type { Hono } from "hono";
import type { AppEnv } from "../../app.js";
import { registerClassifierRoutes } from "./classifier.js";
import { registerCleanupRoutes } from "./cleanup.js";
import type { AdminApiDeps } from "./deps.js";
import { registerKeysRoutes } from "./keys.js";
import { registerLanesRoutes } from "./lanes.js";
import { registerMemoryRoutes } from "./memory.js";
import { registerModelsRoutes } from "./models.js";
import { registerOAuthRoutes } from "./oauth.js";
import { registerPoliciesRoutes } from "./policies.js";
import { registerReplayRoutes } from "./replay.js";
import { registerRequestsRoutes } from "./requests.js";
import { registerSettingsRoutes } from "./settings.js";
import { registerStatsRoutes } from "./stats.js";

// /admin/api/* — the gateway management API. All endpoints are registered here
// and MUST sit behind the admin basicAuth middleware (mounted by the caller on
// the `/admin/api/*` path; see app/server wiring). The two persistence targets stay separate by file:
//   - rules (lanes/policies/classifier) -> RuleStore (config/*.yaml)
//   - runtime (keys/requests)           -> KeyStore / TelemetryStore
// The route files own ONLY HTTP↔domain glue (CLAUDE.md Principle 1); no business logic,
// no IO — every dependency is injected via AdminApiDeps.

export function registerAdminApi(app: Hono<AppEnv>, deps: AdminApiDeps): void {
  // Admin edits and replays must share the same live memory budget as provider work.
  app.use("/admin/api/*", async (c, next) => {
    if (c.req.raw.body === null) return await next();
    try {
      await consumeResponseTextWithinBudget(
        new Response(c.req.raw.body, { headers: c.req.raw.headers }),
        0,
        async (text) => {
          // Hono caches promises at runtime; its public BodyCache type omits Promise.
          Object.assign(c.req.bodyCache, { text: Promise.resolve(text) });
          await next();
        },
        deps.responseWorkAdmission,
        c.req.raw.signal,
      );
    } catch (error) {
      if (!(error instanceof ResponseWorkCapacityError)) throw error;
      c.header("retry-after", "1");
      return c.json({ error: { code: "server_overloaded", message: error.message } }, 503);
    }
  });
  registerLanesRoutes(app, deps);
  registerModelsRoutes(app, deps);
  registerPoliciesRoutes(app, deps);
  registerClassifierRoutes(app, deps);
  registerKeysRoutes(app, deps);
  registerMemoryRoutes(app, deps);
  registerRequestsRoutes(app, deps);
  registerStatsRoutes(app, deps);
  registerReplayRoutes(app, deps);
  registerSettingsRoutes(app, deps);
  registerOAuthRoutes(app, deps);
  registerCleanupRoutes(app, deps);
}

export type { AdminApiDeps, RuleStore } from "./deps.js";
