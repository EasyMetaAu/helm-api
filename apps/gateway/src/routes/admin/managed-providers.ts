import { ManagedProviderInputSchema, UpstreamApiKeySchema } from "@helm/shared";
import type { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../../app.js";
import { sameOrigin } from "../admin-login.js";

export const ManagedProviderSaveSchema = z
  .object({
    provider: ManagedProviderInputSchema,
    key: UpstreamApiKeySchema.optional(),
    accountName: z.string().trim().min(1).max(80).default("Default"),
    importLegacy: z.boolean().default(false),
  })
  .strict();
export type ManagedProviderSave = z.infer<typeof ManagedProviderSaveSchema>;
export function registerManagedProviderRoutes(
  app: Hono<AppEnv>,
  deps: {
    list: () => unknown;
    save: (input: ManagedProviderSave) => Promise<void>;
    remove: (id: string) => Promise<void>;
  },
) {
  app.get("/admin/api/providers", async (c) => {
    c.header("cache-control", "no-store");
    return c.json((await deps.list()) as object);
  });
  app.post("/admin/api/providers", async (c) => {
    if (!sameOrigin(c)) return c.json({ error: "Untrusted request origin" }, 403);
    if (!c.req.header("content-type")?.toLowerCase().startsWith("application/json"))
      return c.json({ error: "Use application/json" }, 415);
    const parsed = ManagedProviderSaveSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success)
      return c.json(
        { error: "Invalid provider settings. Check endpoint, model aliases and credentials." },
        400,
      );
    try {
      await deps.save(parsed.data);
      return c.json({ saved: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      if (/alias|reserved|subscription|already|match|model|identity/i.test(message))
        return c.json(
          { error: "Provider identity, aliases or credential conflict with existing settings." },
          409,
        );
      return c.json(
        { error: "Provider could not be applied. Refresh to verify the saved state." },
        503,
      );
    }
  });
  app.delete("/admin/api/providers/:id", async (c) => {
    if (!sameOrigin(c)) return c.json({ error: "Untrusted request origin" }, 403);
    try {
      await deps.remove(c.req.param("id"));
      return c.body(null, 204);
    } catch {
      return c.json({ error: "Provider could not be removed. Refresh to verify its state." }, 503);
    }
  });
}
