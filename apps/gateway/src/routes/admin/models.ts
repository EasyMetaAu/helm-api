import type { Hono } from "hono";
import type { AppEnv } from "../../app.js";
import type { AdminApiDeps } from "./deps.js";

// /admin/api/models — read-only catalog of routable model aliases
// (config.providers[].models[].alias), deduped + sorted at startup and injected
// via AdminApiDeps. Pure HTTP glue (CLAUDE.md 原则1): the route owns no logic and
// touches no config/DB — it just echoes the pre-computed list. Consumed by the
// Lanes admin UI to offer combobox suggestions so an operator picks a real alias
// instead of hand-typing one. Sits behind the same /admin/api/* basicAuth as its
// siblings; provider supply-chain detail (原则6) is never exposed to API clients.

export function registerModelsRoutes(app: Hono<AppEnv>, deps: AdminApiDeps): void {
  app.get("/admin/api/models", (c) => c.json(deps.modelAliases));
}
