import { LaneSchema, LanesConfigSchema } from "@helm/core";
import type { Hono } from "hono";
import type { AppEnv } from "../../app.js";
import type { AdminApiDeps } from "./deps.js";
import { rulePersistErrorResponse } from "./persist-error.js";

// /admin/api/lanes — CRUD over the lane config (config/lanes.yaml via RuleStore,
// NEVER the DB; CLAUDE.md Principle 2, config-as-code). Pure HTTP glue: every read/write goes
// through the injected RuleStore; the route only validates the body against the
// shared LaneSchema and translates to HTTP. Invalid body -> 400, nothing written
// (fail-closed). LaneSchema is the single type source (z.infer); no duplicate shape.

class LaneMutationHttpError extends Error {
  constructor(
    readonly status: 400 | 404 | 409,
    readonly body: Record<string, unknown>,
  ) {
    super(String(body.error ?? "lane mutation rejected"));
  }
}

export function registerLanesRoutes(app: Hono<AppEnv>, deps: AdminApiDeps): void {
  // GET /lanes -> [{ name, ...Lane }]
  app.get("/admin/api/lanes", async (c) => {
    const lanes = await deps.rules.getLanes();
    const list = Object.entries(lanes).map(([name, lane]) => ({ name, ...lane }));
    return c.json(list);
  });

  // PUT /lanes <- complete lane map (validated as one atomic config write).
  app.put("/admin/api/lanes", async (c) => {
    const parsed = LanesConfigSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json({ error: "invalid lanes config", issues: parsed.error.issues }, 400);
    }
    const defaultLane = deps.settings.get().default_lane;
    if (!(defaultLane in parsed.data)) {
      return c.json({ error: `cannot remove the default lane '${defaultLane}'` }, 409);
    }
    try {
      await deps.rules.setLanes(parsed.data);
    } catch (err) {
      return rulePersistErrorResponse(c, err);
    }
    return c.json(Object.entries(parsed.data).map(([name, lane]) => ({ name, ...lane })));
  });

  // GET /lanes/:name -> Lane | 404
  app.get("/admin/api/lanes/:name", async (c) => {
    const lanes = await deps.rules.getLanes();
    const lane = lanes[c.req.param("name")];
    if (!lane) return c.json({ error: "lane not found" }, 404);
    return c.json(lane);
  });

  // PUT /lanes/:name <- Lane (Zod-validated -> write). Invalid -> 400, no write.
  app.put("/admin/api/lanes/:name", async (c) => {
    const name = c.req.param("name");
    const parsed = LaneSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json({ error: "invalid lane", issues: parsed.error.issues }, 400);
    }
    try {
      await deps.rules.updateLanes((current) => {
        const lanes = { ...current, [name]: parsed.data };
        // Re-validate the WHOLE map before writing. Fail-closed: nothing is written
        // when any lane makes the complete config invalid.
        const map = LanesConfigSchema.safeParse(lanes);
        if (!map.success) {
          throw new LaneMutationHttpError(400, {
            error: "invalid lanes config",
            issues: map.error.issues,
          });
        }
        return map.data;
      });
    } catch (err) {
      if (err instanceof LaneMutationHttpError) return c.json(err.body, err.status);
      // Persist failure (e.g. unwritable config mount) is a local 500, not a 502.
      return rulePersistErrorResponse(c, err);
    }
    return c.json(parsed.data);
  });

  // DELETE /lanes/:name
  app.delete("/admin/api/lanes/:name", async (c) => {
    const name = c.req.param("name");
    const defaultLane = deps.settings.get().default_lane;
    if (name === defaultLane) {
      return c.json({ error: `cannot delete the default lane '${defaultLane}'` }, 409);
    }
    try {
      await deps.rules.updateLanes((current) => {
        const lanes = { ...current };
        if (!(name in lanes)) throw new LaneMutationHttpError(404, { error: "lane not found" });
        delete lanes[name];
        // Re-validate the mutated map BEFORE writing. The configured default lane
        // is protected above; the schema still requires at least one valid lane.
        const map = LanesConfigSchema.safeParse(lanes);
        if (!map.success) {
          throw new LaneMutationHttpError(409, {
            error: "invalid lanes config",
            issues: map.error.issues,
          });
        }
        return map.data;
      });
    } catch (err) {
      if (err instanceof LaneMutationHttpError) return c.json(err.body, err.status);
      return rulePersistErrorResponse(c, err);
    }
    return c.json({ deleted: name });
  });
}
