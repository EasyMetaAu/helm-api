import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ApiKeyAccounts,
  createSqliteDb,
  hashKey,
  SqliteConfigStore,
  SqliteKeyStore,
  UpstreamError,
} from "@helm/core";
import { ApiKeyPoolsViewSchema } from "@helm/shared";
import { afterEach, expect, it, vi } from "vitest";
import { buildServer } from "./server.js";

afterEach(() => vi.unstubAllEnvs());
it("manages custom providers end to end without env keys, applies edits live and persists across restart", async () => {
  const calls: Array<{
    url: string | undefined;
    auth: string | undefined;
    body: Record<string, unknown>;
  }> = [];
  const upstream = createServer(async (req, res) => {
    let raw = "";
    for await (const c of req) raw += c;
    const body = JSON.parse(raw);
    calls.push({ url: req.url, auth: req.headers.authorization, body });
    if (body.stream) {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(
        'data: {"id":"c","choices":[{"index":0,"delta":{"content":"OK"},"finish_reason":null}]}\n\ndata: {"id":"c","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
      );
    } else {
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          id: "test",
          model: body.model,
          choices: [
            { index: 0, message: { role: "assistant", content: "OK" }, finish_reason: "stop" },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
      );
    }
  });
  await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
  const address = upstream.address();
  if (!address || typeof address === "string") throw Error("address");
  const dir = mkdtempSync(join(tmpdir(), "helm-managed-"));
  const configDir = join(dir, "config");
  mkdirSync(configDir);
  for (const [file, content] of Object.entries({
    "server.yaml": "host: 127.0.0.1\nport: 8099\nbase_path: /",
    "providers.yaml":
      "providers: [{name: placeholder, api_key_env: UNUSED_MANAGED_TEST_KEY}, {name: dormant, api_key_env: DORMANT_TEST_KEY, api_key_pool: {id: dormant, credential_type: compatible}, models: [{alias: dormant/pro, provider_model: wire-pro}]}]",
    "lanes.yaml": "balanced: {primary: kimi/pro}",
    "auth.yaml":
      "require_api_key: true\nbootstrap: {generate_if_missing: false, print_once: false, persist_to: unused}",
    "runtime.yaml": "rate_limit: {enabled: false, default: {rpm: 0, tpm: 0}}",
  }))
    writeFileSync(join(configDir, file), content);
  for (const [k, v] of Object.entries({
    DORMANT_TEST_KEY: "vendor-dormant-key",
    HELM_DATA_DIR: dir,
    HELM_OAUTH_ENC_KEY: Buffer.alloc(32, 3).toString("base64"),
    HELM_ADMIN_USER: "test",
    HELM_ADMIN_PASSWORD: "test-password",
    HELM_SIGNALS_DISABLED: "1",
    HELM_PROVIDER_BASE_URL: "",
  }))
    vi.stubEnv(k, v);
  const db = createSqliteDb(join(dir, "helm.db"));
  await new SqliteKeyStore(db).createKey({
    keyId: "test",
    hash: hashKey("helm_managed_test"),
    prefix: "helm_test",
    accountId: "test",
    role: "root",
    allowCustomModel: true,
    memoryMode: "off",
  });
  await new ApiKeyAccounts({
    store: new SqliteConfigStore(db),
    encKey: Buffer.alloc(32, 3),
    poolId: "dormant",
    providerType: "compatible",
    timezone: "Asia/Shanghai",
  }).setStrategy("manual_priority");
  db.$sqlite.close();
  const admin = {
    authorization: `Basic ${Buffer.from("test:test-password").toString("base64")}`,
    "content-type": "application/json",
  };
  let handle: Awaited<ReturnType<typeof buildServer>> | undefined;
  let replica: Awaited<ReturnType<typeof buildServer>> | undefined;
  const request = (path: string, init?: RequestInit) => handle!.app.request(path, init);
  const profile = {
    id: "kimi",
    label: "Kimi",
    type: "openai",
    base_url: `http://127.0.0.1:${address.port}/coding/v1`,
    models: [
      {
        alias: "kimi/pro",
        provider_model: "wire-pro",
        capabilities: {
          supportsTools: true,
          jsonOutput: "schema",
          supportsVision: false,
          supportsStreaming: true,
          maxContextTokens: 131072,
          maxOutputTokens: 8192,
        },
      },
    ],
  };
  const save = () =>
    request("/admin/api/providers", {
      method: "POST",
      headers: admin,
      body: JSON.stringify({
        provider: profile,
        key: "vendor-kimi-private-key",
        accountName: "Main",
      }),
    });
  const chat = (stream = false, model = "kimi/pro") =>
    request("/v1/chat/completions", {
      method: "POST",
      headers: { authorization: "Bearer helm_managed_test", "content-type": "application/json" },
      body: JSON.stringify({ model, messages: [{ role: "user", content: "hello" }], stream }),
    });
  try {
    handle = await buildServer({ configDir, logger: { log: () => {} } });
    replica = await buildServer({ configDir, logger: { log: () => {} } });
    expect(
      (
        await request("/admin/api/providers", {
          method: "POST",
          body: "{}",
          headers: { "content-type": "application/json" },
        })
      ).status,
    ).toBe(401);
    const crossOrigin = await request("/admin/api/providers", {
      method: "POST",
      headers: { ...admin, origin: "https://untrusted.example", "content-type": "text/plain" },
      body: JSON.stringify({ provider: profile }),
    });
    expect(crossOrigin.status).toBe(403);
    const listing = (await (await request("/admin/api/providers", { headers: admin })).json()) as {
      providers: Array<{ id: string; legacyCredentialAvailable: boolean }>;
    };
    expect(listing.providers.find((p) => p.id === "dormant")?.legacyCredentialAvailable).toBe(
      false,
    );
    expect(
      (
        await request("/admin/api/providers", {
          method: "POST",
          headers: admin,
          body: JSON.stringify({
            provider: {
              ...profile,
              id: "dormant",
              models: [{ alias: "dormant/pro", provider_model: "wire-pro" }],
            },
            importLegacy: true,
          }),
        })
      ).status,
    ).toBe(200);
    const dormant = ApiKeyPoolsViewSchema.parse(
      await (await request("/admin/api/api-key-pools", { headers: admin })).json(),
    ).pools.find((p) => p.id === "dormant")!;
    expect(dormant.accounts).toHaveLength(0);
    const saved = await save();
    expect(await saved.clone().text()).not.toContain("vendor-kimi-private-key");
    expect(saved.status).toBe(200);
    const pools = ApiKeyPoolsViewSchema.parse(
      await (await request("/admin/api/api-key-pools", { headers: admin })).json(),
    );
    const account = pools.pools.find((p: { id: string }) => p.id === "kimi")!.accounts[0]!;
    expect(
      (
        await request(`/admin/api/api-key-pools/kimi/accounts/${account.id}/test`, {
          method: "POST",
          headers: { ...admin, origin: "https://untrusted.example" },
          body: JSON.stringify({ model: "wire-pro" }),
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await request(`/admin/api/api-key-pools/kimi/accounts/${account.id}`, {
          method: "PATCH",
          headers: admin,
          body: JSON.stringify({ priority: 2, parameters: { temperature: 0.25 } }),
        })
      ).status,
    ).toBe(204);
    let response = await chat();
    expect(await response.clone().text()).toContain("OK");
    expect(response.status).toBe(200);
    expect(calls.at(-1)).toMatchObject({
      url: "/coding/v1/chat/completions",
      auth: "Bearer vendor-kimi-private-key",
      body: { model: "wire-pro", temperature: 0.25 },
    });
    const replicaChat = () =>
      replica!.app.request("/v1/chat/completions", {
        method: "POST",
        headers: { authorization: "Bearer helm_managed_test", "content-type": "application/json" },
        body: JSON.stringify({ model: "kimi/pro", messages: [{ role: "user", content: "hello" }] }),
      });
    expect((await replicaChat()).status).toBe(200);
    expect(calls.at(-1)?.body.temperature).toBe(0.25);
    // A due recovery lease must reach the provider even while it belongs to this request.
    const stateDb = createSqliteDb(join(dir, "helm.db"));
    const accounts = new ApiKeyAccounts({
      store: new SqliteConfigStore(stateDb),
      encKey: Buffer.alloc(32, 3),
      poolId: "kimi",
      providerType: "compatible",
      timezone: "Asia/Shanghai",
      now: () => 0,
    });
    await accounts.refresh();
    const entry = accounts.entries()[0]!;
    await accounts.settle(
      (await accounts.acquire(entry.id))!,
      new UpstreamError("upstream_error", "temporary failure", undefined, 429),
      "wire-pro",
    );
    expect(accounts.entries()[0]!.state).toBe("cooldown");
    expect((await chat()).status).toBe(200);
    await accounts.refresh();
    expect(accounts.entries()[0]!.state).toBe("ready");
    stateDb.$sqlite.close();
    response = await chat(true);
    expect(await response.text()).toContain("[DONE]");
    const listed = await (await request("/admin/api/providers", { headers: admin })).text();
    expect(listed).not.toContain("vendor-kimi-private-key");
    expect(listed).toContain("Kimi");
    await handle.dispose?.();
    handle = await buildServer({ configDir, logger: { log: () => {} } });
    expect((await chat()).status).toBe(200);
    profile.models[0]!.alias = "kimi/new";
    expect(
      (
        await request("/admin/api/providers", {
          method: "POST",
          headers: admin,
          body: JSON.stringify({ provider: profile }),
        })
      ).status,
    ).toBe(200);
    const count = calls.length;
    expect((await chat()).status).not.toBe(200);
    expect(calls.length).toBe(count);
    expect((await chat(false, "kimi/new")).status).toBe(200);
    expect(
      (await request("/admin/api/providers/kimi", { method: "DELETE", headers: admin })).status,
    ).toBe(204);
    const afterDelete = calls.length;
    expect((await chat(false, "kimi/new")).status).not.toBe(200);
    expect(calls.length).toBe(afterDelete);
    vi.stubEnv("UNUSED_MANAGED_TEST_KEY", "vendor-legacy-private-key");
    expect(
      (
        await request("/admin/api/providers", {
          method: "POST",
          headers: admin,
          body: JSON.stringify({
            provider: {
              ...profile,
              id: "placeholder",
              label: "Imported",
              models: [{ alias: "legacy/pro", provider_model: "wire-pro" }],
            },
            importLegacy: true,
          }),
        })
      ).status,
    ).toBe(200);
    vi.stubEnv("UNUSED_MANAGED_TEST_KEY", "vendor-should-never-be-used");
    expect((await chat(false, "legacy/pro")).status).toBe(200);
    expect(calls.at(-1)?.auth).toBe("Bearer vendor-legacy-private-key");
    vi.stubEnv("UNUSED_MANAGED_TEST_KEY", "");
    await handle.dispose?.();
    handle = await buildServer({ configDir, logger: { log: () => {} } });
    expect((await chat(false, "legacy/pro")).status).toBe(200);
    expect(calls.at(-1)?.auth).toBe("Bearer vendor-legacy-private-key");
    const migrated = ApiKeyPoolsViewSchema.parse(
      await (await request("/admin/api/api-key-pools", { headers: admin })).json(),
    ).pools.find((p) => p.id === "placeholder")!.accounts[0]!;
    expect(
      (
        await request(`/admin/api/api-key-pools/placeholder/accounts/${migrated.id}`, {
          method: "DELETE",
          headers: admin,
        })
      ).status,
    ).toBe(204);
    const beforeEmpty = calls.length;
    expect((await chat(false, "legacy/pro")).status).not.toBe(200);
    expect(calls.length).toBe(beforeEmpty);
  } finally {
    await replica?.dispose?.();
    await handle?.dispose?.();
    await new Promise<void>((r) => upstream.close(() => r()));
    rmSync(dir, { recursive: true, force: true });
  }
});
