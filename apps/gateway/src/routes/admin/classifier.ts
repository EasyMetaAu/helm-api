import { ClassifierConfigSchema } from "@helm/shared";
import type { Hono } from "hono";
import type { AppEnv } from "../../app.js";
import type { AdminApiDeps } from "./deps.js";

// /admin/api/classifier — read/write the classifier config (config/classifier.yaml
// via RuleStore, NEVER the DB). The toggle for Layer-2 eval, confidence_threshold,
// and rule weights all live here as data (原则2/4). An out-of-range threshold or
// any schema violation -> 400, config unchanged (fail-closed). ClassifierConfigSchema
// is the single type source (z.infer); no duplicate shape.

export function registerClassifierRoutes(app: Hono<AppEnv>, deps: AdminApiDeps): void {
  app.get("/admin/api/classifier", async (c) => {
    return c.json(await deps.rules.getClassifier());
  });

  app.put("/admin/api/classifier", async (c) => {
    const parsed = ClassifierConfigSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json({ error: "invalid classifier config", issues: parsed.error.issues }, 400);
    }
    await deps.rules.setClassifier(parsed.data);
    return c.json(parsed.data);
  });
}
