import type { Hono } from "hono";
import type { AppEnv } from "../../app.js";
import { ArkAssetAccessError, ArkAssetGrantInput } from "../../ark-asset-grants.js";
import type { AdminApiDeps } from "./deps.js";
export function registerArkAssetRoutes(app: Hono<AppEnv>, deps: AdminApiDeps): void {
  app.on(["GET", "PUT"], "/admin/api/keys/:id/ark-assets", async (c) => {
    if (!deps.arkAssets)
      return c.json(
        { error: { code: "unavailable", message: "Asset authorization unavailable" } },
        503,
      );
    try {
      if (c.req.method === "GET") return c.json(await deps.arkAssets.read(c.req.param("id")));
      const parsed = ArkAssetGrantInput.safeParse(await c.req.json().catch(() => null));
      if (!parsed.success)
        return c.json({ error: { code: "invalid_request", message: "Invalid asset grant" } }, 400);
      return c.json(await deps.arkAssets.replace(c.req.param("id"), parsed.data));
    } catch (error) {
      const known = error instanceof ArkAssetAccessError;
      return c.json(
        {
          error: {
            code: "asset_grant_failed",
            message: known ? error.message : "Asset authorization unavailable",
          },
        },
        known ? error.status : 503,
      );
    }
  });
}
