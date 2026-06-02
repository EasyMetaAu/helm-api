import type { Hono } from "hono";
import type { AppEnv } from "../../app.js";
import type { AdminApiDeps } from "./deps.js";

// /admin/api/models — read-only catalog of routable model aliases (configured
// providers + LIVE per-account OAuth curation), deduped + sorted. Pure HTTP glue
// (CLAUDE.md Principle 1): the route owns no logic — it calls the injected thunk,
// which recomputes the OAuth part on each read so a Manage-dialog curation edit is
// reflected without a restart. Consumed by the Lanes admin UI to offer combobox
// suggestions so an operator picks a real alias instead of hand-typing one. Sits
// behind the same /admin/api/* basicAuth as its siblings; provider supply-chain
// detail (Principle 6) is never exposed to API clients.

export function registerModelsRoutes(app: Hono<AppEnv>, deps: AdminApiDeps): void {
  app.get("/admin/api/models", async (c) => c.json(await deps.modelAliases()));
}
