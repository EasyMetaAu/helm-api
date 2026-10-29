import type { ConfigStore } from "@helm/core";
import { ApiKeyAccounts } from "@helm/core";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import type { AppEnv } from "../../app.js";
import { registerApiKeyPoolRoutes } from "./api-key-pools.js";
import type { AdminApiDeps } from "./deps.js";

function setup() {
  const rows = new Map<string, string>();
  const store: ConfigStore = {
    get: async (k) => rows.get(k) ?? null,
    set: async (k, v) => {
      rows.set(k, v);
    },
    compareAndSet: async (k, old, v) => {
      if ((rows.get(k) ?? null) !== old) return false;
      rows.set(k, v);
      return true;
    },
  };
  const accounts = new ApiKeyAccounts({
    store,
    encKey: Buffer.alloc(32, 1),
    poolId: "openai",
    timezone: "Asia/Shanghai",
  });
  const app = new Hono<AppEnv>();
  registerApiKeyPoolRoutes(app, {
    apiKeyPools: new Map([
      ["openai", { accounts, models: ["m"], timezone: "Asia/Shanghai", strategy: "round_robin" }],
    ]),
  } as unknown as AdminApiDeps);
  return { app, accounts, rows };
}
const body = (value: unknown) => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(value),
});
describe("admin API key pools", () => {
  it("adds keys without echoing or storing plaintext and exposes live account actions", async () => {
    const { app, rows } = setup();
    const key = "sk-proj-route-test-key";
    expect(
      (
        await app.request(
          "/admin/api/api-key-pools/openai/accounts",
          body({ accounts: [{ name: "one", key }] }),
        )
      ).status,
    ).toBe(204);
    const overview = await app.request("/admin/api/api-key-pools");
    const text = await overview.text();
    expect(text).not.toContain(key);
    expect(JSON.stringify([...rows.values()])).not.toContain(key);
    const id = JSON.parse(text).pools[0].accounts[0].id;
    expect(
      (
        await app.request(`/admin/api/api-key-pools/openai/accounts/${id}`, {
          ...body({ enabled: false }),
          method: "PATCH",
        })
      ).status,
    ).toBe(204);
    expect(
      (await app.request(`/admin/api/api-key-pools/openai/accounts/${id}/retry`, body({}))).status,
    ).toBe(204);
    expect(
      (await app.request(`/admin/api/api-key-pools/openai/accounts/${id}`, { method: "DELETE" }))
        .status,
    ).toBe(204);
  });
  it("rejects Admin keys, unknown pools, malformed payloads and duplicate imports without leaking secrets", async () => {
    const { app } = setup();
    const secret = "sk-admin-do-not-echo-me";
    const res = await app.request(
      "/admin/api/api-key-pools/openai/accounts",
      body({ accounts: [{ name: "admin", key: secret }] }),
    );
    expect(res.status).toBe(400);
    expect(await res.text()).not.toContain(secret);
    expect(
      (await app.request("/admin/api/api-key-pools/unknown/accounts", body({ accounts: [] })))
        .status,
    ).toBe(404);
    const payload = body({ accounts: [{ name: "one", key: "sk-proj-duplicate-test" }] });
    expect((await app.request("/admin/api/api-key-pools/openai/accounts", payload)).status).toBe(
      204,
    );
    expect((await app.request("/admin/api/api-key-pools/openai/accounts", payload)).status).toBe(
      409,
    );
  });
});
