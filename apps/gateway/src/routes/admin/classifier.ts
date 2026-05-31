import { ClassifierConfigStrictSchema } from "@helm/shared";
import type { Hono } from "hono";
import type { AppEnv } from "../../app.js";
import type { AdminApiDeps } from "./deps.js";

// PUT is a full REPLACE of the classifier config, so it uses the STRICT schema
// (both `rules` and `eval` required, unknown keys rejected). The base
// ClassifierConfigSchema prefaults both blocks, which meant a wrong-shaped patch
// (e.g. `{eval_enabled, confidence_threshold}`) silently parsed to an all-defaults
// config and OVERWROTE the live one with 200 — a fail-OPEN write that violates
// principle 2. ClassifierConfigStrictSchema fails such payloads closed (400), while
// the admin UI's "merge-onto-fetched-config-then-PUT-the-whole-object" flow passes.

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
    const parsed = ClassifierConfigStrictSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json({ error: "invalid classifier config", issues: parsed.error.issues }, 400);
    }
    await deps.rules.setClassifier(parsed.data);
    return c.json(parsed.data);
  });
}
