import { ApiKeyAccounts, type ConfigStore } from "@helm/core";
import type { DecisionRecord } from "@helm/shared";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import type { AppEnv } from "../../app.js";
import type { AdminApiDeps } from "./deps.js";
import { registerRequestsRoutes } from "./requests.js";

async function setup() {
  const values = new Map<string, string>();
  const store: ConfigStore = {
    get: async (key) => values.get(key) ?? null,
    set: async (key, value) => {
      values.set(key, value);
    },
    compareAndSet: async (key, before, after) => {
      if ((values.get(key) ?? null) !== before) return false;
      values.set(key, after);
      return true;
    },
  };
  const accounts = new ApiKeyAccounts({
    store,
    encKey: Buffer.alloc(32, 1),
    poolId: "openai",
    timezone: "Asia/Shanghai",
  });
  await accounts.add([{ name: "OpenAI work", key: "sk-proj-private-test-key-1234" }]);
  const account = accounts.entries()[0];
  if (!account) throw new Error("test account missing");
  const record = {
    request_id: "req-1",
    serving_account: { provider_id: "openai", account: `${account.id}@${account.generation}` },
  } as DecisionRecord;
  const deps = {
    apiKeyPools: new Map([["openai", { accounts }]]),
    keyStore: { list: async () => [] },
    telemetry: {
      queryPage: async () => ({
        rows: [{ record, apiKeyId: "k1", createdAt: new Date(1000) }],
        total: 1,
      }),
      getByRequestId: async () => record,
      getCreatedAt: async () => new Date(1000),
      getApiKeyId: async () => "k1",
    },
  } as unknown as AdminApiDeps;
  const app = new Hono<AppEnv>();
  registerRequestsRoutes(app, deps);
  return { app, accounts, record, account };
}

describe("request upstream account labels", () => {
  it("resolves existing list/detail records to the API key name and suffix without changing telemetry", async () => {
    const { app, accounts, record } = await setup();
    const refresh = vi.spyOn(accounts, "refresh");
    for (const url of ["/admin/api/requests", "/admin/api/requests/req-1"]) {
      const response = await app.request(url);
      expect(response.status).toBe(200);
      const text = await response.text();
      expect(text).not.toContain("sk-proj-private-test-key-1234");
      const json = JSON.parse(text);
      expect((json.items?.[0] ?? json).serving_account).toMatchObject({
        kind: "api_key",
        label: "OpenAI work · ••••1234",
      });
    }
    expect(refresh).toHaveBeenCalledTimes(2);
    expect(record.serving_account).not.toHaveProperty("label");
  });

  it("does not show a replacement key suffix on an older generation", async () => {
    const { app, accounts, account } = await setup();
    await accounts.update(account.id, { key: "sk-proj-replacement-key-9876" });
    const json = JSON.parse(await (await app.request("/admin/api/requests/req-1")).text());
    expect(json.serving_account).toMatchObject({ kind: "api_key", label: "OpenAI work" });
    expect(JSON.stringify(json)).not.toContain("9876");
  });

  it("keeps removed keys identifiable as API keys and preserves subscription names", async () => {
    const { app, accounts, account, record } = await setup();
    await accounts.remove(account.id);
    expect(
      JSON.parse(await (await app.request("/admin/api/requests/req-1")).text()).serving_account,
    ).toMatchObject({ kind: "api_key" });
    record.serving_account = { provider_id: "anthropic", account: "claude-work" };
    expect(
      JSON.parse(await (await app.request("/admin/api/requests/req-1")).text()).serving_account,
    ).toEqual(record.serving_account);
  });
});
