import { createHash } from "node:crypto";
import { ProviderUsageSnapshotSchema, UpstreamProviderUsageSchema } from "@helm/shared";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import type { AppEnv } from "../app.js";
import {
  providerUsageConfig,
  registerProviderUsageExport,
  registerUpstreamUsageProxy,
} from "./provider-usage.js";

const token = "test-usage-read-only-token";
const tokenHash = createHash("sha256").update(token).digest("hex");
const snapshot = {
  schemaVersion: 1,
  generatedAt: 123,
  providers: [
    {
      id: "anthropic",
      name: "Claude",
      accounts: [
        {
          account: "team",
          healthy: true,
          schedulable: true,
          anthropicPlanType: "max",
          proxy: { host: "private" },
          secret: "must-not-leak",
        },
      ],
    },
  ],
  usage: [
    { providerId: "anthropic", account: "team", requests: 4, tokens: 90, costUsd: null, rpm: 1 },
  ],
  quota: [],
};
function exported(hash: string | undefined = tokenHash) {
  const app = new Hono<AppEnv>();
  const overview = vi.fn(async () => snapshot);
  const periods = vi.fn(async () => ({ current: [], periods: [], daily: [], weekly: [] }));
  registerProviderUsageExport(app, { tokenHash: hash, overview, periods });
  return { app, overview, periods };
}
const headers = { authorization: `Bearer ${token}` };

describe("provider usage export", () => {
  it("requires the dedicated token and never reads stores for other credentials", async () => {
    const { app, overview } = exported();
    for (const authorization of [undefined, "Bearer ordinary-inference-key", "Basic admin"]) {
      const response = await app.request("/v1/provider-usage", {
        headers: authorization ? { authorization } : {},
      });
      expect(response.status).toBe(401);
    }
    expect(overview).not.toHaveBeenCalled();
  });
  it("is disabled without the export hash", async () => {
    const { app } = exported("");
    expect((await app.request("/v1/provider-usage", { headers })).status).toBe(404);
  });
  it("returns only the read-only projection and forwards timezone", async () => {
    const { app, overview } = exported();
    const response = await app.request("/v1/provider-usage?tzOffsetMinutes=480", { headers });
    expect(response.status).toBe(200);
    expect(overview).toHaveBeenCalledWith(480);
    const body = ProviderUsageSnapshotSchema.parse(await response.json());
    expect(body.providers[0]?.accounts[0]).not.toHaveProperty("proxy");
    expect(JSON.stringify(body)).not.toContain("must-not-leak");
    expect(body.usage[0]?.costUsd).toBeNull();
    expect(response.headers.get("cache-control")).toBe("no-store");
  });
  it("validates parameters and does not expose mutations", async () => {
    const { app, periods } = exported();
    expect((await app.request("/v1/provider-usage?tzOffsetMinutes=9999", { headers })).status).toBe(
      400,
    );
    expect((await app.request("/v1/provider-usage/periods", { headers })).status).toBe(400);
    expect(
      (await app.request("/v1/provider-usage/periods?provider=anthropic&account=team", { headers }))
        .status,
    ).toBe(200);
    expect(periods).toHaveBeenCalledWith("anthropic", "team", 0);
    expect(
      (await app.request("/v1/provider-usage/refresh", { method: "POST", headers })).status,
    ).toBe(404);
  });
  it("reports read failures without leaking errors or turning failure into zero usage", async () => {
    const { app, overview } = exported();
    overview.mockRejectedValue(new Error("database password"));
    const response = await app.request("/v1/provider-usage", { headers });
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain("password");
  });
});

describe("upstream usage proxy", () => {
  it("rejects incomplete configuration and unsafe credential destinations", () => {
    expect(() =>
      providerUsageConfig({ HELM_UPSTREAM_USAGE_URL: "https://helm.example" }),
    ).toThrow();
    expect(() => providerUsageConfig({ HELM_USAGE_EXPORT_TOKEN_SHA256: "not-a-hash" })).toThrow();
    for (const url of [
      "http://example.com",
      "https://user:pass@example.com",
      "https://example.com/other",
    ]) {
      expect(() =>
        providerUsageConfig({ HELM_UPSTREAM_USAGE_URL: url, HELM_UPSTREAM_USAGE_TOKEN: token }),
      ).toThrow();
    }
  });
  it("fetches only a fixed read path, validates the result and never returns the credential", async () => {
    const app = new Hono<AppEnv>();
    const fetcher = vi.fn(async () => Response.json(snapshot));
    registerUpstreamUsageProxy(app, { origin: "https://helm.example", token }, fetcher);
    const response = await app.request(
      "/admin/api/upstream/provider-usage?tzOffsetMinutes=480&url=https://evil.example",
    );
    expect(response.status).toBe(200);
    expect(fetcher).toHaveBeenCalledWith(
      "https://helm.example/v1/provider-usage?tzOffsetMinutes=480",
      expect.objectContaining({
        redirect: "error",
        headers: { authorization: `Bearer ${token}`, accept: "application/json" },
      }),
    );
    const body = UpstreamProviderUsageSchema.parse(await response.json());
    if (!body.configured) throw new Error("expected upstream configuration");
    expect(body.source).toBe("https://helm.example");
    expect(body.snapshot.usage[0]?.tokens).toBe(90);
    expect(JSON.stringify(body)).not.toContain(token);
  });
  it("shows upstream auth and malformed-response failures as errors", async () => {
    for (const response of [
      new Response("secret", { status: 401 }),
      Response.json({ broken: true }),
    ]) {
      const app = new Hono<AppEnv>();
      registerUpstreamUsageProxy(
        app,
        { origin: "https://helm.example", token },
        vi.fn(async () => response),
      );
      const result = await app.request("/admin/api/upstream/provider-usage");
      expect(result.status).toBe(502);
      expect(await result.text()).not.toContain("secret");
    }
  });
  it("returns an explicit unconfigured result without network work", async () => {
    const app = new Hono<AppEnv>();
    const fetcher = vi.fn();
    registerUpstreamUsageProxy(app, undefined, fetcher);
    expect(await (await app.request("/admin/api/upstream/provider-usage")).json()).toEqual({
      configured: false,
    });
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe("API key pool export projection", () => {
  it("includes usage without key masks, credentials or management settings", async () => {
    const { app, overview } = exported();
    overview.mockResolvedValue({
      ...snapshot,
      apiKeyPools: [
        {
          id: "openai",
          type: "openai",
          accounts: [
            {
              id: "a",
              name: "Primary",
              enabled: true,
              state: "ready",
              nextRetryAt: null,
              mask: "sk-secret-prefix",
              priority: 10,
            },
          ],
          usage: [{ account: "a", requests: 9, tokens: 80, costUsd: 0.2 }],
        },
      ],
    } as typeof snapshot);
    const response = await app.request("/v1/provider-usage", { headers });
    const body = ProviderUsageSnapshotSchema.parse(await response.json());
    expect(body.apiKeyPools[0]?.usage[0]?.requests).toBe(9);
    expect(JSON.stringify(body)).not.toContain("sk-secret-prefix");
    expect(body.apiKeyPools[0]?.accounts[0]).not.toHaveProperty("priority");
  });
});
