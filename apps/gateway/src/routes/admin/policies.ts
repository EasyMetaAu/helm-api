import { PoliciesConfigSchema } from "@helm/core";
import type { Hono } from "hono";
import type { AppEnv } from "../../app.js";
import type { AdminApiDeps } from "./deps.js";

// /admin/api/policies — read/write the policy list (config/policies.yaml via
// RuleStore, NEVER the DB). The wire shape is a bare Policy[] (the editor edits a
// list); we wrap/unwrap the `{ policies: [...] }` config envelope at this seam and
// validate the whole set with the shared PoliciesConfigSchema. An unknown `match`
// field (strict schema) -> 400, config unchanged (fail-closed, Principle 2).

export function registerPoliciesRoutes(app: Hono<AppEnv>, deps: AdminApiDeps): void {
  // GET /policies -> Policy[]
  app.get("/admin/api/policies", async (c) => {
    const cfg = await deps.rules.getPolicies();
    return c.json(cfg.policies);
  });

  // PUT /policies <- Policy[] (validated as a whole set -> write). Invalid -> 400.
  app.put("/admin/api/policies", async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = PoliciesConfigSchema.safeParse({ policies: body });
    if (!parsed.success) {
      return c.json({ error: "invalid policies", issues: parsed.error.issues }, 400);
    }
    await deps.rules.setPolicies(parsed.data);
    return c.json(parsed.data.policies);
  });

  // DELETE /policies/:id — EXPLICIT-ID ONLY: drop the policy whose explicit id
  // matches. `id` is optional in the schema, so id-less policies are NOT
  // addressable here (the UI mutates the set via whole-set PUT anyway). When no
  // policy carries an explicit id we return 422 (not a misleading 404) to make it
  // clear the operation requires an explicit policy id rather than implying the
  // target merely doesn't exist.
  app.delete("/admin/api/policies/:id", async (c) => {
    const id = c.req.param("id");
    const cfg = await deps.rules.getPolicies();
    const remaining = cfg.policies.filter((p) => p.id !== id);
    if (remaining.length === cfg.policies.length) {
      // Distinguish "no policy has any explicit id" (DELETE-by-id is unusable;
      // 422) from "ids exist but none match" (genuine 404).
      const anyHasId = cfg.policies.some((p) => p.id !== undefined);
      if (!anyHasId) {
        return c.json(
          {
            error:
              "DELETE requires an explicit policy id; no policy carries one — edit the set via PUT /admin/api/policies instead",
          },
          422,
        );
      }
      return c.json({ error: "policy not found" }, 404);
    }
    await deps.rules.setPolicies({ policies: remaining });
    return c.json({ deleted: id });
  });
}
