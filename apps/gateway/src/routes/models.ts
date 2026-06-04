import type { LanesConfig } from "@helm/core";
import { buildModelsList } from "@helm/core";
import { type CatalogEntry, makeHelmError } from "@helm/shared";
import type { Context, Hono } from "hono";
import type { AppEnv } from "../app.js";
import { HelmHttpError } from "../middleware/error-handler.js";

// GET /v1/models — OpenAI-compatible model discovery. Behind API-key auth (mounted
// in server.ts) so the listing is KEY-AWARE: the authenticated identity's
// allow_custom_model + allowed_lanes caps decide what buildModelsList returns
// (lanes always; concrete aliases only for keys that may name a model). Pure
// presentation glue — all policy lives in core (principle 1).
export interface ModelsRouteDeps {
  // Live lanes thunk: admin edits rebind the router's lanes at runtime, so read
  // it per request rather than capturing a snapshot.
  lanes: () => LanesConfig;
  // Capability/pricing catalog (loadRuntimeCatalog), immutable for the process.
  catalog: Map<string, CatalogEntry>;
  // Configured provider aliases: config.providers[].models[].alias.
  providerAliases: string[];
}

export function registerModelsRoute(app: Hono<AppEnv>, deps: ModelsRouteDeps): void {
  const build = (c: Context<AppEnv>) => {
    const identity = c.get("identity");
    return buildModelsList({
      lanes: deps.lanes(),
      catalog: deps.catalog,
      providerAliases: deps.providerAliases,
      allowCustomModel: identity.caps.allowCustomModel,
      allowedLanes: identity.caps.allowedLanes,
    });
  };

  app.get("/v1/models", (c) => c.json(build(c), 200));

  // Retrieve a single model the key can use. An id outside the key's listing is
  // reported as invalid_request (the structured error taxonomy has no 404 class);
  // the OpenAI envelope is rendered by the global handler.
  app.get("/v1/models/:id", (c) => {
    const id = c.req.param("id");
    const model = build(c).data.find((m) => m.id === id);
    if (!model) {
      throw new HelmHttpError(
        makeHelmError({
          error_class: "invalid_request",
          message: `model '${id}' not found or not available to this key`,
          trace_id: c.get("trace_id"),
        }),
      );
    }
    return c.json(model, 200);
  });
}
