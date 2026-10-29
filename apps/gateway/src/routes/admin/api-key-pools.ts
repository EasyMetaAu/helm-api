import { ApiKeyAccountInputSchema, ApiKeyAccountPatchSchema } from "@helm/shared";
import type { Context, Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../../app.js";
import type { AdminApiDeps } from "./deps.js";

export function registerApiKeyPoolRoutes(app: Hono<AppEnv>, deps: AdminApiDeps): void {
  app.get("/admin/api/api-key-pools", async (c) => {
    const usage = (await deps.oauthUsage?.queryRange(Date.now() - 86_400_000, Date.now())) ?? [];
    const pools = await Promise.all(
      [...(deps.apiKeyPools ?? [])].map(async ([id, pool]) => {
        const accounts = (await pool.accounts?.list()) ?? [];
        const aggregated = new Map<
          string,
          { account: string; requests: number; tokens: number; costUsd: number | null }
        >();
        for (const row of usage.filter((u) => u.providerId === id)) {
          const account = row.account.split("@")[0]!;
          const previous = aggregated.get(account);
          aggregated.set(account, {
            account,
            requests: (previous?.requests ?? 0) + row.requests,
            tokens: (previous?.tokens ?? 0) + row.tokens,
            costUsd: previous
              ? previous.costUsd === null || row.costUsd === null
                ? null
                : previous.costUsd + row.costUsd
              : row.costUsd,
          });
        }
        return {
          id,
          configured: pool.accounts !== null,
          timezone: pool.timezone,
          strategy: pool.accounts?.strategy(pool.strategy) ?? pool.strategy,
          models: pool.models,
          accounts,
          usage: [...aggregated.values()],
        };
      }),
    );
    c.header("cache-control", "no-store");
    return c.json({ pools });
  });
  const apply = async (c: Context<AppEnv>, action: () => Promise<void>) => {
    try {
      await action();
      return c.body(null, 204);
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      if (
        message === "API key is already in this pool" ||
        message === "Replace the invalid API key before retrying"
      )
        return c.json({ error: message }, 409);
      if (message === "API key account not found") return c.json({ error: message }, 404);
      return c.json({ error: "API key operation failed; no success was confirmed" }, 503);
    }
  };
  app.use("/admin/api/api-key-pools/:pool/*", async (c, next) => {
    const pool = deps.apiKeyPools?.get(c.req.param("pool") ?? "");
    if (!pool) return c.json({ error: "Unknown API key pool" }, 404);
    if (!pool.accounts)
      return c.json({ error: "Set HELM_OAUTH_ENC_KEY to enable encrypted API key storage" }, 503);
    await next();
  });
  app.put("/admin/api/api-key-pools/:pool/strategy", async (c) => {
    const parsed = z
      .object({ strategy: z.enum(["round_robin", "manual_priority"]) })
      .strict()
      .safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "Invalid pool strategy" }, 400);
    return apply(c, () =>
      deps.apiKeyPools!.get(c.req.param("pool"))!.accounts!.setStrategy(parsed.data.strategy),
    );
  });
  app.post("/admin/api/api-key-pools/:pool/accounts", async (c) => {
    const parsed = z
      .object({ accounts: z.array(ApiKeyAccountInputSchema).min(1).max(50) })
      .strict()
      .safeParse(await c.req.json().catch(() => null));
    if (!parsed.success)
      return c.json(
        { error: "Supply account names and valid model API keys; Admin keys are not accepted" },
        400,
      );
    return apply(c, () =>
      deps.apiKeyPools!.get(c.req.param("pool"))!.accounts!.add(parsed.data.accounts),
    );
  });
  app.patch("/admin/api/api-key-pools/:pool/accounts/:id", async (c) => {
    const parsed = ApiKeyAccountPatchSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "Invalid API key account settings" }, 400);
    return apply(c, () =>
      deps.apiKeyPools!.get(c.req.param("pool"))!.accounts!.update(c.req.param("id"), parsed.data),
    );
  });
  app.delete("/admin/api/api-key-pools/:pool/accounts/:id", async (c) => {
    return apply(c, () =>
      deps.apiKeyPools!.get(c.req.param("pool"))!.accounts!.remove(c.req.param("id")),
    );
  });
  app.post("/admin/api/api-key-pools/:pool/accounts/:id/retry", async (c) => {
    return apply(c, () =>
      deps.apiKeyPools!.get(c.req.param("pool"))!.accounts!.retry(c.req.param("id")),
    );
  });
}
