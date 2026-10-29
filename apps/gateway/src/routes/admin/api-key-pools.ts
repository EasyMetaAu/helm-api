import { UpstreamError } from "@helm/core";
import { ApiKeyAccountInputSchema, ApiKeyAccountPatchSchema } from "@helm/shared";
import type { Context, Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../../app.js";
import type { AdminApiDeps } from "./deps.js";

export function registerApiKeyPoolRoutes(app: Hono<AppEnv>, deps: AdminApiDeps): void {
  const runningTests = new Set<string>();
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
  // Diagnostics deliberately bypass pool selection and do not alter account lifecycle.
  app.post("/admin/api/api-key-pools/:pool/accounts/:id/test", async (c) => {
    c.header("cache-control", "no-store");
    const parsed = z
      .object({ model: z.string().min(1).max(200) })
      .strict()
      .safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "Invalid test model" }, 400);
    const poolId = c.req.param("pool");
    const id = c.req.param("id");
    const pool = deps.apiKeyPools!.get(poolId)!;
    const model = parsed.data.model;
    await pool.accounts!.refresh();
    const account = pool.accounts!.entries().find((entry) => entry.id === id);
    if (!account) return c.json({ error: "API key account not found" }, 404);
    if (
      !pool.models.includes(model) ||
      (account.models !== null && !account.models.includes(model)) ||
      /image|realtime|audio|live|tts|whisper|transcri/i.test(model)
    )
      return c.json({ error: "Select a configured text model allowed for this account" }, 400);
    const lock = `${poolId}/${id}`;
    if (runningTests.has(lock)) return c.json({ error: "Account test already running" }, 409);
    const client = pool.createTestClient?.(account.key, model);
    if (!client) return c.json({ error: "Account tester unavailable" }, 503);
    runningTests.add(lock);
    const started = Date.now();
    const signal = AbortSignal.any([c.req.raw.signal, AbortSignal.timeout(30_000)]);
    try {
      const raw = await client.chatCompletion(
        {
          model,
          messages: [{ role: "user", content: "Reply with exactly OK." }],
          stream: false,
          max_completion_tokens: 256,
          ...(model === "gpt-6-luna" ? { reasoning_effort: "none" } : {}),
        },
        { signal },
      );
      const completion = z
        .object({
          choices: z.array(z.object({ message: z.object({ content: z.string().nullable() }) })),
          usage: z.object({ total_tokens: z.number().nonnegative() }).optional(),
        })
        .safeParse(raw);
      const response = completion.success
        ? completion.data.choices[0]?.message.content?.trim()
        : null;
      const nowMs = Date.now();
      // A completed request consumes quota even if its output is empty.
      await deps.oauthUsage
        ?.record({
          providerId: poolId,
          account: `${account.id}@${account.generation}`,
          bucketMs: nowMs - (nowMs % 3_600_000),
          tokens: completion.success ? (completion.data.usage?.total_tokens ?? 0) : 0,
          costUsd: null,
          nowMs,
        })
        .catch(() => {});
      if (!response)
        return c.json({
          ok: false,
          model,
          durationMs: Date.now() - started,
          error: "empty_response",
        });
      // Never relay an echoed credential, even from a misconfigured upstream.
      return c.json({
        ok: true,
        model,
        durationMs: Date.now() - started,
        response: response.replaceAll(account.key, "[redacted]").slice(0, 2000),
      });
    } catch (error) {
      const upstream = error instanceof UpstreamError ? error : null;
      const detail = z
        .object({ error: z.object({ code: z.string().optional(), type: z.string().optional() }) })
        .safeParse(upstream?.providerRaw);
      const code = detail.success ? (detail.data.error.code ?? detail.data.error.type) : undefined;
      const known = new Set([
        "insufficient_quota",
        "credit_balance_exhausted",
        "organization_spend_limit_exceeded",
        "project_spend_limit_exceeded",
        "invalid_api_key",
        "account_deactivated",
        "model_not_found",
        "model_not_allowed",
        "rate_limit_exceeded",
      ]);
      return c.json({
        ok: false,
        model,
        durationMs: Date.now() - started,
        upstreamStatus: upstream?.upstreamStatus ?? null,
        error:
          signal.aborted || upstream?.errorClass === "timeout"
            ? "timeout"
            : code && known.has(code)
              ? code
              : "upstream_error",
      });
    } finally {
      runningTests.delete(lock);
    }
  });
  app.post("/admin/api/api-key-pools/:pool/accounts/:id/retry", async (c) => {
    return apply(c, () =>
      deps.apiKeyPools!.get(c.req.param("pool"))!.accounts!.retry(c.req.param("id")),
    );
  });
}
