import { LaneSchema } from "@helm/core";
import type { Hono } from "hono";
import type { AppEnv } from "../../app.js";
import type { AdminApiDeps } from "./deps.js";

// /admin/api/lanes — CRUD over the lane config (config/lanes.yaml via RuleStore,
// NEVER the DB; CLAUDE.md 原则2 配置即代码). Pure HTTP glue: every read/write goes
// through the injected RuleStore; the route only validates the body against the
// shared LaneSchema and translates to HTTP. Invalid body -> 400, nothing written
// (fail-closed). LaneSchema is the single type source (z.infer); no duplicate shape.

export function registerLanesRoutes(app: Hono<AppEnv>, deps: AdminApiDeps): void {
  // GET /lanes -> [{ name, ...Lane }]
  app.get("/admin/api/lanes", async (c) => {
    const lanes = await deps.rules.getLanes();
    const list = Object.entries(lanes).map(([name, lane]) => ({ name, ...lane }));
    return c.json(list);
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
    const lanes = { ...(await deps.rules.getLanes()), [name]: parsed.data };
    await deps.rules.setLanes(lanes);
    return c.json(parsed.data);
  });

  // DELETE /lanes/:name
  app.delete("/admin/api/lanes/:name", async (c) => {
    const name = c.req.param("name");
    const lanes = { ...(await deps.rules.getLanes()) };
    if (!(name in lanes)) return c.json({ error: "lane not found" }, 404);
    delete lanes[name];
    await deps.rules.setLanes(lanes);
    return c.json({ deleted: name });
  });
}
