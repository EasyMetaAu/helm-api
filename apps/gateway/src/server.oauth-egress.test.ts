import { type ConfigStore, encryptSecret, type OAuthTokenStore } from "@helm/core";
import { ProviderConfigSchema } from "@helm/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadAccountSettings, setAccountSettings } from "./oauth/account-settings.js";
import { buildProviderClients, guardResponsesConnector } from "./server.js";

const network = vi.hoisted(() => vi.fn<typeof fetch>());
vi.mock("undici", async (load) => ({ ...(await load<typeof import("undici")>()), fetch: network }));
const KEY = Buffer.alloc(32, 5);
const A = { type: "http" as const, host: "proxy-a.invalid", port: 8080 };
const B = { ...A, host: "proxy-b.invalid" };
afterEach(() => {
  vi.unstubAllGlobals();
  network.mockReset();
});
async function fixture() {
  const values = new Map<string, string>();
  const config: ConfigStore = {
    get: async (k) => values.get(k) ?? null,
    set: async (k, v) => {
      values.set(k, v);
    },
  };
  const store: OAuthTokenStore = {
    get: async () => ({
      providerId: "github-copilot",
      account: "work",
      accessEnc: encryptSecret("tid=test;proxy-ep=proxy.individual.githubcopilot.com;", KEY),
      refreshEnc: encryptSecret("test", KEY),
      expiresAt: Date.now() + 3600000,
      meta: null,
      updatedAt: 1,
    }),
    upsert: async () => {},
    delete: async () => {},
    list: async () => [],
  };
  const p = ProviderConfigSchema.parse({
    name: "declared-copilot",
    type: "openai",
    oauth: { provider: "github-copilot", account: "work" },
    models: [],
  });
  network.mockImplementation(
    async () =>
      new Response(JSON.stringify({ id: "r", choices: [], model: "test" }), {
        headers: { "content-type": "application/json" },
      }),
  );
  vi.stubGlobal("fetch", network);
  const build = async () =>
    buildProviderClients(
      [p],
      "https://api.individual.githubcopilot.com",
      1000,
      { store, config, encKey: KEY },
      await loadAccountSettings(config, KEY),
    ).get(p.name)!;
  return { config, build };
}
const req = { model: "test", messages: [{ role: "user" as const, content: "hello" }] };
describe("configured subscription egress", () => {
  it("stops old direct clients after a proxy edit, while a new client uses the proxy", async () => {
    const f = await fixture();
    const old = await f.build();
    await old.chatCompletion(req);
    expect(network).toHaveBeenCalledTimes(1);
    network.mockClear();
    await setAccountSettings(f.config, KEY, "github-copilot", "work", { proxy: A });
    await expect(old.chatCompletion(req)).rejects.toThrow(/egress.*changed/);
    expect(network).not.toHaveBeenCalled();
    await (await f.build()).chatCompletion(req);
    expect(network).toHaveBeenCalledTimes(1);
    expect(network.mock.calls[0]?.[1]).toHaveProperty("dispatcher");
  });
  it("does not revive an old proxy client after A to B to A", async () => {
    const f = await fixture();
    await setAccountSettings(f.config, KEY, "github-copilot", "work", { proxy: A });
    const old = await f.build();
    await setAccountSettings(f.config, KEY, "github-copilot", "work", { proxy: B });
    await setAccountSettings(f.config, KEY, "github-copilot", "work", { proxy: A });
    await expect(old.chatCompletion(req)).rejects.toThrow(/egress.*changed/);
    expect(network).not.toHaveBeenCalled();
  });
});

it("applies an admin proxy edit to a YAML-declared primary before reporting success", async () => {
  const { cp, mkdtemp, rm, writeFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join, resolve } = await import("node:path");
  const {
    createSqliteDb,
    SqliteKeyStore,
    SqliteOAuthTokenStore,
    hashKey,
    createRuntimeMemoryCoordinator,
  } = await import("@helm/core");
  const { buildServer } = await import("./server.js");
  const dir = await mkdtemp(join(tmpdir(), "helm-proxy-update-"));
  const db = createSqliteDb(join(dir, "helm.db"));
  let server: Awaited<ReturnType<typeof buildServer>> | undefined;
  try {
    const configDir = join(dir, "config");
    await cp(resolve("config"), configDir, { recursive: true });
    await writeFile(
      join(configDir, "providers.yaml"),
      JSON.stringify({
        providers: [
          {
            name: "declared-copilot",
            type: "openai",
            oauth: { provider: "github-copilot", account: "work" },
            models: [{ alias: "declared-copilot/test", provider_model: "test" }],
          },
        ],
      }),
    );
    await writeFile(
      join(configDir, "capabilities.yaml"),
      JSON.stringify({
        "declared-copilot/test": { supportsStreaming: true, maxContextTokens: 100000 },
      }),
    );
    await new SqliteKeyStore(db).createKey({
      keyId: "test-root",
      hash: hashKey("synthetic-root"),
      prefix: "test",
      accountId: "test",
      role: "root",
      allowCustomModel: true,
    });
    await new SqliteOAuthTokenStore(db).upsert({
      providerId: "github-copilot",
      account: "work",
      accessEnc: encryptSecret("tid=test;proxy-ep=proxy.individual.githubcopilot.com;", KEY),
      refreshEnc: encryptSecret("refresh", KEY),
      expiresAt: Date.now() + 3600000,
      meta: null,
      updatedAt: 1,
    });
    vi.stubEnv("HELM_DATA_DIR", dir);
    vi.stubEnv("HELM_SIGNALS_DISABLED", "1");
    vi.stubEnv("HELM_OAUTH_ENC_KEY", KEY.toString("base64"));
    vi.stubEnv("HELM_ADMIN_USER", "admin");
    vi.stubEnv("HELM_ADMIN_PASSWORD", "test-password");
    network.mockImplementation(async () =>
      Response.json({
        id: "r",
        object: "chat.completion",
        model: "test",
        choices: [
          { index: 0, message: { role: "assistant", content: "OK" }, finish_reason: "stop" },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }),
    );
    vi.stubGlobal("fetch", network);
    server = await buildServer({
      configDir,
      memoryCoordinator: createRuntimeMemoryCoordinator({
        capacityBytes: () => Number.MAX_SAFE_INTEGER,
      }),
      resourcePressure: { shouldRun: async () => false, shouldRunHeavy: async () => false },
      logger: { log() {} },
    });
    const chat = () =>
      server!.app.request("/v1/chat/completions", {
        method: "POST",
        headers: { authorization: "Bearer synthetic-root", "content-type": "application/json" },
        body: JSON.stringify({
          model: "declared-copilot/test",
          messages: [{ role: "user", content: "hello" }],
          stream: false,
        }),
      });
    expect((await chat()).status).toBe(200);
    network.mockClear();
    let priorDispatcher: unknown;
    let priorProxy: unknown;
    for (const proxy of [A, A, B, null]) {
      const update = await server.app.request("/admin/api/oauth/github-copilot/proxy", {
        method: "PUT",
        headers: {
          authorization: `Basic ${Buffer.from("admin:test-password").toString("base64")}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ account: "work", proxy }),
      });
      expect(update.status).toBe(204);
      network.mockClear();
      const result = await chat();
      expect(await result.text()).toContain("OK");
      expect(result.status).toBe(200);
      expect(network).toHaveBeenCalledTimes(1);
      const dispatcher = Reflect.get(network.mock.calls[0]?.[1] ?? {}, "dispatcher");
      if (priorProxy === proxy) expect(dispatcher).toBe(priorDispatcher);
      priorProxy = proxy;
      priorDispatcher = dispatcher;
      if (proxy) expect(network.mock.calls[0]?.[1]).toHaveProperty("dispatcher");
      else expect(network.mock.calls[0]?.[1]).not.toHaveProperty("dispatcher");
    }
  } finally {
    await server?.dispose?.();
    db.$sqlite.close();
    vi.unstubAllEnvs();
    await rm(dir, { recursive: true, force: true });
  }
});

it("preserves class-based WebSocket connection methods while guarding sends", async () => {
  class Connection {
    responseHeaders = new Headers();
    sent = 0;
    closed = 0;
    async send(_text: string) {
      this.sent += 1;
    }
    async receive() {
      return "response";
    }
    async close() {
      this.closed += 1;
    }
    closeInfo() {
      return { code: 1000, reason: "done" };
    }
  }
  const connection = new Connection();
  let current = true;
  const connect = guardResponsesConnector(
    async () => connection,
    () => {
      if (!current) throw new Error("stale");
    },
  );
  const guarded = await connect({
    url: "wss://upstream.invalid/responses",
    headers: {},
    signal: new AbortController().signal,
  });
  await guarded.send("first");
  expect(await guarded.receive()).toBe("response");
  expect(guarded.closeInfo?.()).toEqual({ code: 1000, reason: "done" });
  current = false;
  await expect(guarded.send("second")).rejects.toThrow("stale");
  expect(connection.sent).toBe(1);
  expect(connection.closed).toBe(1);
});
