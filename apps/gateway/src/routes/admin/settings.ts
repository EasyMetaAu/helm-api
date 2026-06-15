import { RuntimeSettingsSchema } from "@helm/shared";
import type { Hono } from "hono";
import type { AppEnv } from "../../app.js";
import type { AdminApiDeps } from "./deps.js";

// /admin/api/settings — the System Settings surface (runtime-mutable config that
// applies WITHOUT a restart). PURE HTTP glue (Principle 1): validate → save → echo. The
// save seam (deps.settings.save) validates+persists to config_kv and applies live
// (logger level, rate-limit switch); it is wired in server.ts.

export function registerSettingsRoutes(app: Hono<AppEnv>, deps: AdminApiDeps): void {
  // GET /settings -> the live RuntimeSettings.
  app.get("/admin/api/settings", async (c) => {
    return c.json(deps.settings.get());
  });

  // PUT /settings -> validate the WHOLE object against the schema, persist+apply,
  // echo the validated result. Fail-closed (Principle 2): an invalid body is rejected
  // (400) and never written nor applied to the live closures.
  app.put("/admin/api/settings", async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = RuntimeSettingsSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: "invalid settings", issues: parsed.error.issues }, 400);
    }
    // default_lane must name a lane that actually exists. The schema only checks
    // it's a non-empty string (it can't see the lane set), so validate it here
    // against the live lanes — fail-closed (Principle 2). The resolver ALSO guards
    // at runtime (falls back to "balanced"), but rejecting at the boundary gives the
    // operator a clear 400 instead of a silently-ignored setting.
    const lanes = await deps.rules.getLanes();
    if (!(parsed.data.default_lane in lanes)) {
      return c.json(
        {
          error: "unknown lane",
          detail: `default_lane '${parsed.data.default_lane}' is not a defined lane`,
        },
        400,
      );
    }
    const saved = await deps.settings.save(parsed.data);
    return c.json(saved);
  });
}
