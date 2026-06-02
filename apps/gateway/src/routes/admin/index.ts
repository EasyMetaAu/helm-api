import type { Hono } from "hono";
import type { AppEnv } from "../../app.js";
import { registerClassifierRoutes } from "./classifier.js";
import type { AdminApiDeps } from "./deps.js";
import { registerKeysRoutes } from "./keys.js";
import { registerLanesRoutes } from "./lanes.js";
import { registerModelsRoutes } from "./models.js";
import { registerOAuthRoutes } from "./oauth.js";
import { registerPoliciesRoutes } from "./policies.js";
import { registerRequestsRoutes } from "./requests.js";
import { registerSettingsRoutes } from "./settings.js";

// /admin/api/* — the gateway management API. All endpoints are registered here
// and MUST sit behind the admin basicAuth middleware (mounted by the caller on
// the `/admin/api/*` path; see app/server wiring). The two persistence targets stay separate by file:
//   - rules (lanes/policies/classifier) -> RuleStore (config/*.yaml)
//   - runtime (keys/requests)           -> KeyStore / TelemetryStore
// The route files own ONLY HTTP↔domain glue (CLAUDE.md Principle 1); no business logic,
// no IO — every dependency is injected via AdminApiDeps.

export function registerAdminApi(app: Hono<AppEnv>, deps: AdminApiDeps): void {
  registerLanesRoutes(app, deps);
  registerModelsRoutes(app, deps);
  registerPoliciesRoutes(app, deps);
  registerClassifierRoutes(app, deps);
  registerKeysRoutes(app, deps);
  registerRequestsRoutes(app, deps);
  registerSettingsRoutes(app, deps);
  registerOAuthRoutes(app, deps);
}

export type { AdminApiDeps, RuleStore } from "./deps.js";
