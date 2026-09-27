import { cp, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  createRuntimeMemoryCoordinator,
  createSqliteDb,
  hashKey,
  SqliteKeyStore,
} from "@helm/core";
import { expect, it, vi } from "vitest";
import { buildServer, type ServerHandle } from "./server.js";

it("routes native counters by alias or unique wire model, never by provider order", async () => {
  const directory = await mkdtemp(join(tmpdir(), "helm-token-count-"));
  const configDir = join(directory, "config");
  const db = createSqliteDb(join(directory, "helm.db"));
  let server: ServerHandle | undefined;
  try {
    await cp(resolve("config"), configDir, { recursive: true });
    await writeFile(
      join(configDir, "providers.yaml"),
      JSON.stringify({
        providers: [
          {
            name: "gemini-a",
            type: "gemini",
            base_url: "https://gemini-a.test",
            api_key_env: "COUNTER_TEST_KEY",
            models: [
              { alias: "first/gemini", provider_model: "gemini-a" },
              { alias: "first/shared", provider_model: "shared" },
            ],
          },
          {
            name: "gemini-b",
            type: "gemini",
            base_url: "https://gemini-b.test",
            api_key_env: "COUNTER_TEST_KEY",
            models: [
              { alias: "second/gemini", provider_model: "gemini-b" },
              { alias: "second/shared", provider_model: "shared" },
              { alias: "second/blocked", provider_model: "blocked" },
            ],
          },
          {
            name: "anthropic-a",
            type: "anthropic",
            base_url: "https://anthropic-a.test",
            api_key_env: "COUNTER_TEST_KEY",
            models: [{ alias: "first/claude", provider_model: "claude-a" }],
          },
          {
            name: "anthropic-b",
            type: "anthropic",
            base_url: "https://anthropic-b.test",
            api_key_env: "COUNTER_TEST_KEY",
            models: [{ alias: "second/claude", provider_model: "claude-b" }],
          },
        ],
      }),
    );
    await new SqliteKeyStore(db).createKey({
      keyId: "counter-test",
      hash: hashKey("synthetic-test-key"),
      prefix: "helm_test",
      accountId: "test",
      role: "root",
      allowCustomModel: true,
      blockedModels: ["second/blocked"],
    });
    for (const caps of [
      { keyId: "no-custom", allowCustomModel: false },
      { keyId: "lane-capped", allowCustomModel: true, allowedLanes: ["economy"] },
      {
        keyId: "budget-capped",
        allowCustomModel: true,
        budgetRequests: 1,
        overBudgetBehavior: "degrade" as const,
        degradeLane: "economy",
      },
    ]) {
      await new SqliteKeyStore(db).createKey({
        ...caps,
        hash: hashKey(caps.keyId),
        prefix: "helm_test",
        accountId: "test",
        role: "user",
      });
    }
    vi.stubEnv("HELM_DATA_DIR", directory);
    vi.stubEnv("HELM_SIGNALS_DISABLED", "1");
    vi.stubEnv("HELM_OAUTH_ENC_KEY", Buffer.alloc(32, 11).toString("base64"));
    vi.stubEnv("COUNTER_TEST_KEY", "synthetic-upstream-key");
    const fetcher = vi.fn<typeof fetch>(async (url, init) => {
      const address = new URL(String(url));
      const body = JSON.parse(String(init?.body));
      if (address.hostname.startsWith("gemini-")) {
        return Response.json({ totalTokens: 42, counter_url: address.href });
      }
      if (address.hostname.startsWith("anthropic-")) {
        return Response.json({
          input_tokens: 42,
          counter_url: address.href,
          wire_model: body.model,
        });
      }
      throw new Error("Unexpected external request");
    });
    vi.stubGlobal("fetch", fetcher);
    server = await buildServer({
      configDir,
      memoryCoordinator: createRuntimeMemoryCoordinator({
        capacityBytes: () => Number.MAX_SAFE_INTEGER,
      }),
      resourcePressure: { shouldRun: async () => false, shouldRunHeavy: async () => false },
      logger: { log() {} },
    });
    const headers = {
      Authorization: "Bearer synthetic-test-key",
      "content-type": "application/json",
    };
    for (const model of ["second/gemini", "gemini-b"]) {
      const res = await server.app.request(
        `/v1beta/models/${encodeURIComponent(model)}:countTokens`,
        {
          method: "POST",
          headers,
          body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: "hi" }] }] }),
        },
      );
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        totalTokens: 42,
        counter_url: "https://gemini-b.test/models/gemini-b:countTokens",
      });
    }
    for (const model of ["second/claude", "claude-b"]) {
      const res = await server.app.request("/v1/messages/count_tokens", {
        method: "POST",
        headers,
        body: JSON.stringify({ model, messages: [{ role: "user", content: "hi" }] }),
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        input_tokens: 42,
        counter_url: "https://anthropic-b.test/v1/messages/count_tokens",
        wire_model: "claude-b",
      });
    }
    const calls = fetcher.mock.calls.length;
    const blocked = await server.app.request("/v1beta/models/second%2Fblocked:countTokens", {
      method: "POST",
      headers,
      body: JSON.stringify({ contents: [{ parts: [{ text: "hi" }] }] }),
    });
    expect(blocked.status).toBe(403);
    for (const model of ["shared", "unknown-model", "second/claude", "balanced"]) {
      const res = await server.app.request(
        `/v1beta/models/${encodeURIComponent(model)}:countTokens`,
        {
          method: "POST",
          headers,
          body: JSON.stringify({ contents: [{ parts: [{ text: "hi" }] }] }),
        },
      );
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ estimated: true });
    }
    for (const key of ["no-custom", "lane-capped", "budget-capped"]) {
      for (const [path, body] of [
        [
          "/v1/messages/count_tokens",
          { model: "second/claude", messages: [{ role: "user", content: "private text" }] },
        ],
        [
          "/v1beta/models/second%2Fgemini:countTokens",
          { contents: [{ parts: [{ text: "private text" }] }] },
        ],
      ] as const) {
        const res = await server.app.request(path, {
          method: "POST",
          headers: { ...headers, Authorization: `Bearer ${key}` },
          body: JSON.stringify(body),
        });
        expect(res.status).toBe(200);
        expect(await res.json()).toMatchObject({ estimated: true });
      }
    }
    expect(fetcher).toHaveBeenCalledTimes(calls);
  } finally {
    await server?.dispose?.();
    db.$sqlite.close();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    await rm(directory, { recursive: true, force: true });
  }
});
