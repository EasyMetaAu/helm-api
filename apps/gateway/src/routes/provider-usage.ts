import { createHash, timingSafeEqual } from "node:crypto";
import { OAuthUsagePeriodsSchema, ProviderUsageSnapshotSchema } from "@helm/shared";
import type { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../app.js";

const OriginSchema = z
  .url()
  .refine((value) => {
    const url = new URL(value);
    return (
      (url.protocol === "https:" ||
        (url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      url.pathname === "/"
    );
  }, "usage origin must be HTTPS (or loopback HTTP), without credentials, path, query or fragment")
  .transform((value) => new URL(value).origin);
const ConfigSchema = z
  .object({
    HELM_USAGE_EXPORT_TOKEN_SHA256: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    HELM_UPSTREAM_USAGE_URL: OriginSchema.optional(),
    HELM_UPSTREAM_USAGE_TOKEN: z
      .string()
      .min(16)
      .regex(/^[\x21-\x7e]+$/)
      .optional(),
  })
  .refine(
    (value) => Boolean(value.HELM_UPSTREAM_USAGE_URL) === Boolean(value.HELM_UPSTREAM_USAGE_TOKEN),
    "upstream usage URL and token must be configured together",
  );
export function providerUsageConfig(env: Record<string, string | undefined>) {
  const result = ConfigSchema.safeParse(env);
  if (!result.success)
    throw new Error(
      "Invalid provider usage configuration: check HELM_USAGE_EXPORT_TOKEN_SHA256 and the HELM_UPSTREAM_USAGE_URL / HELM_UPSTREAM_USAGE_TOKEN pair",
    );
  return result.data;
}
const QuerySchema = z.object({
  tzOffsetMinutes: z.coerce.number().int().min(-720).max(840).default(0),
});
const PeriodQuerySchema = QuerySchema.extend({
  provider: z.string().min(1).max(256),
  account: z.string().min(1).max(256),
});

export function registerProviderUsageExport(
  app: Hono<AppEnv>,
  deps: {
    tokenHash?: string;
    overview: (tz: number) => Promise<unknown>;
    periods: (provider: string, account: string, tz: number) => Promise<unknown>;
  },
): void {
  const auth = (authorization: string | undefined): boolean => {
    if (!deps.tokenHash || !authorization?.startsWith("Bearer ")) return false;
    const actual = createHash("sha256").update(authorization.slice(7)).digest();
    return timingSafeEqual(actual, Buffer.from(deps.tokenHash, "hex"));
  };
  for (const path of ["/v1/provider-usage", "/v1/provider-usage/periods"]) {
    app.get(path, async (c) => {
      c.header("Cache-Control", "no-store");
      if (!deps.tokenHash) return c.json({ error: "Provider usage export is disabled" }, 404);
      if (!auth(c.req.header("authorization"))) return c.json({ error: "Unauthorized" }, 401);
      const periods = path.endsWith("/periods");
      const parsed = (periods ? PeriodQuerySchema : QuerySchema).safeParse(c.req.query());
      if (!parsed.success) return c.json({ error: "Invalid usage query" }, 400);
      try {
        if (periods) {
          const q = PeriodQuerySchema.parse(parsed.data);
          return c.json(
            OAuthUsagePeriodsSchema.parse(
              await deps.periods(q.provider, q.account, q.tzOffsetMinutes),
            ),
          );
        }
        return c.json(
          ProviderUsageSnapshotSchema.parse(await deps.overview(parsed.data.tzOffsetMinutes)),
        );
      } catch {
        return c.json({ error: "Provider usage is unavailable" }, 503);
      }
    });
  }
}

// Mount only behind the existing admin authentication. The browser supplies no URL
// or credentials; redirects are rejected so the dedicated token stays on its origin.
export function registerUpstreamUsageProxy(
  app: Hono<AppEnv>,
  upstream: { origin: string; token: string } | undefined,
  fetcher: typeof fetch = fetch,
): void {
  for (const path of [
    "/admin/api/upstream/provider-usage",
    "/admin/api/upstream/provider-usage/periods",
  ]) {
    app.get(path, async (c) => {
      c.header("Cache-Control", "no-store");
      if (!upstream) return c.json({ configured: false });
      const periods = path.endsWith("/periods");
      const parsed = (periods ? PeriodQuerySchema : QuerySchema).safeParse(c.req.query());
      if (!parsed.success) return c.json({ error: "Invalid usage query" }, 400);
      const query = new URLSearchParams(
        Object.entries(parsed.data).map(([key, value]) => [key, String(value)] as [string, string]),
      );
      try {
        const response = await fetcher(
          `${upstream.origin}/v1/provider-usage${periods ? "/periods" : ""}?${query}`,
          {
            headers: { authorization: `Bearer ${upstream.token}`, accept: "application/json" },
            redirect: "error",
            signal: AbortSignal.timeout(8_000),
          },
        );
        if (!response.ok) throw new Error("upstream usage unavailable");
        const body: unknown = await response.json();
        if (periods) return c.json(OAuthUsagePeriodsSchema.parse(body));
        return c.json({
          configured: true,
          source: upstream.origin,
          snapshot: ProviderUsageSnapshotSchema.parse(body),
        });
      } catch {
        return c.json(
          {
            error:
              "Upstream usage is unavailable; check its version, connection and read-only credential",
          },
          502,
        );
      }
    });
  }
}
