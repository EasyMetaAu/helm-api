import type { ConfigStore } from "@helm/core";
import { ApiKeyAccounts, UpstreamError } from "@helm/core";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
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
  const chatCompletion = vi.fn(async () => ({
    choices: [{ message: { content: "OK" }, finish_reason: "stop" }],
    usage: { total_tokens: 4 },
  }));
  const createTestClient = vi.fn(() => ({ chatCompletion }));
  const recordUsage = vi.fn(async () => {});
  const app = new Hono<AppEnv>();
  registerApiKeyPoolRoutes(app, {
    oauthUsage: { record: recordUsage, queryRange: async () => [] },
    apiKeyPools: new Map([
      [
        "openai",
        {
          accounts,
          models: ["m"],
          timezone: "Asia/Shanghai",
          strategy: "round_robin",
          createTestClient,
        },
      ],
    ]),
  } as unknown as AdminApiDeps);
  return { app, accounts, rows, chatCompletion, createTestClient, recordUsage };
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

describe("API key account connectivity test", () => {
  it("tests only the selected key, records usage and preserves a manual pause", async () => {
    const { app, accounts, createTestClient, recordUsage } = setup();
    await accounts.add([
      { name: "one", key: "sk-proj-first-test" },
      { name: "two", key: "sk-proj-second-test" },
    ]);
    const id = (await accounts.list())[1]!.id;
    await accounts.update(id, { enabled: false });
    const res = await app.request(
      `/admin/api/api-key-pools/openai/accounts/${id}/test`,
      body({ model: "m" }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, model: "m", response: "OK" });
    expect(createTestClient).toHaveBeenCalledExactlyOnceWith("sk-proj-second-test", "m");
    expect(recordUsage).toHaveBeenCalledWith(
      expect.objectContaining({
        providerId: "openai",
        account: expect.stringMatching(new RegExp(`^${id}@`)),
        tokens: 4,
      }),
    );
    expect((await accounts.list())[1]!.enabled).toBe(false);
  });
  it("rejects unknown accounts, invalid payloads and disallowed models before sending", async () => {
    const { app, accounts, createTestClient } = setup();
    await accounts.add([{ name: "one", key: "sk-proj-first-test" }]);
    const id = (await accounts.list())[0]!.id;
    for (const [account, payload, status] of [
      ["missing", { model: "m" }, 404],
      [id, {}, 400],
      [id, { model: "unconfigured" }, 400],
      [id, { model: "m", key: "secret" }, 400],
    ] as const) {
      expect(
        (
          await app.request(
            `/admin/api/api-key-pools/openai/accounts/${account}/test`,
            body(payload),
          )
        ).status,
      ).toBe(status);
    }
    await accounts.update(id, { models: [] });
    expect(
      (
        await app.request(
          `/admin/api/api-key-pools/openai/accounts/${id}/test`,
          body({ model: "m" }),
        )
      ).status,
    ).toBe(400);
    expect(createTestClient).not.toHaveBeenCalled();
  });
  it("returns a safe upstream failure without trying another key or changing routing state", async () => {
    const { app, accounts, chatCompletion, createTestClient } = setup();
    await accounts.add([
      { name: "one", key: "sk-proj-first-test" },
      { name: "two", key: "sk-proj-second-test" },
    ]);
    const id = (await accounts.list())[0]!.id;
    chatCompletion.mockRejectedValue(
      new UpstreamError(
        "upstream_error",
        "secret sk-proj-first-test",
        { error: { code: "insufficient_quota", message: "secret" } },
        429,
      ),
    );
    const res = await app.request(
      `/admin/api/api-key-pools/openai/accounts/${id}/test`,
      body({ model: "m" }),
    );
    const result = await res.json();
    expect(result).toMatchObject({ ok: false, error: "insufficient_quota", upstreamStatus: 429 });
    expect(JSON.stringify(result)).not.toMatch(/secret|sk-proj/);
    expect(createTestClient).toHaveBeenCalledTimes(1);
    expect((await accounts.list())[0]!.state).toBe("ready");
  });
  it("does not report an empty upstream response as success", async () => {
    const { app, accounts, chatCompletion } = setup();
    await accounts.add([{ name: "one", key: "sk-proj-first-test" }]);
    const id = (await accounts.list())[0]!.id;
    chatCompletion.mockResolvedValue({ choices: [], usage: { total_tokens: 4 } });
    const res = await app.request(
      `/admin/api/api-key-pools/openai/accounts/${id}/test`,
      body({ model: "m" }),
    );
    expect(await res.json()).toMatchObject({ ok: false, error: "empty_response" });
  });
});
