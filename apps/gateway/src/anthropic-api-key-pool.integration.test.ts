import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSqliteDb, hashKey, SqliteKeyStore } from "@helm/core";
import { ApiKeyPoolsViewSchema } from "@helm/shared";
import { afterEach, expect, it, vi } from "vitest";
import { buildServer } from "./server.js";

afterEach(() => vi.unstubAllEnvs());
it("routes native Messages and Chat through paid Anthropic keys and tests exactly one key", async () => {
  const calls: Array<{ key: string; authorization: string | undefined; model: string }> = [];
  const upstream = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw) as { model: string; stream?: boolean };
    const key = String(req.headers["x-api-key"] ?? "");
    if (req.url?.endsWith("/count_tokens")) {
      res.setHeader("content-type", "application/json");
      res.end('{"input_tokens":4}');
      return;
    }
    calls.push({ key, authorization: req.headers.authorization, model: body.model });
    const message = {
      id: "msg_mock",
      type: "message",
      role: "assistant",
      model: body.model,
      content: [{ type: "text", text: "OK" }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 4, output_tokens: 1 },
    };
    if (body.stream) {
      res.setHeader("content-type", "text/event-stream");
      for (const event of [
        { type: "message_start", message: { ...message, content: [], stop_reason: null } },
        { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "OK" } },
        { type: "content_block_stop", index: 0 },
        {
          type: "message_delta",
          delta: { stop_reason: "end_turn", stop_sequence: null },
          usage: { output_tokens: 1 },
        },
        { type: "message_stop" },
      ])
        res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      res.end();
      return;
    }
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(message));
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const address = upstream.address();
  if (!address || typeof address === "string") throw Error("no upstream port");
  const dir = mkdtempSync(join(tmpdir(), "helm-anthropic-pool-"));
  const configDir = join(dir, "config");
  mkdirSync(configDir);
  const files = {
    "server.yaml": "host: 127.0.0.1\nport: 8099\nbase_path: /\n",
    "auth.yaml":
      "require_api_key: true\nbootstrap:\n  generate_if_missing: false\n  print_once: false\n  persist_to: unused\n",
    "runtime.yaml":
      "request_timeout_ms: 10000\nrate_limit:\n  enabled: false\n  default: { rpm: 0, tpm: 0 }\n",
    "providers.yaml": `providers:\n  - name: anthropic-api\n    type: anthropic\n    base_url: http://127.0.0.1:${address.port}\n    api_key_pool: { id: anthropic-api }\n    models:\n      - { alias: anthropic-api/claude-test, provider_model: claude-test }\n`,
    "capabilities.yaml":
      "anthropic-api/claude-test:\n  supportsStreaming: true\n  maxContextTokens: 8192\n  maxOutputTokens: 1000\n",
  };
  for (const [name, content] of Object.entries(files))
    writeFileSync(join(configDir, name), content);
  for (const [key, value] of Object.entries({
    HELM_DATA_DIR: dir,
    HELM_OAUTH_ENC_KEY: Buffer.alloc(32, 8).toString("base64"),
    HELM_ADMIN_ENABLED: "true",
    HELM_ADMIN_USER: "test",
    HELM_ADMIN_PASSWORD: "test-password",
    HELM_SIGNALS_DISABLED: "1",
    HELM_PROVIDER_BASE_URL: "",
  }))
    vi.stubEnv(key, value);
  const db = createSqliteDb(join(dir, "helm.db"));
  await new SqliteKeyStore(db).createKey({
    keyId: "test-key",
    hash: hashKey("helm_pool_test"),
    prefix: "helm_pool",
    accountId: "test",
    role: "root",
    allowCustomModel: true,
    memoryMode: "off",
  });
  db.$sqlite.close();
  let handle: Awaited<ReturnType<typeof buildServer>> | undefined;
  try {
    handle = await buildServer({ configDir, logger: { log: () => {} } });
    const admin = {
      authorization: `Basic ${Buffer.from("test:test-password").toString("base64")}`,
      "content-type": "application/json",
    };
    const post = (path: string, body: unknown, headers = admin) =>
      handle!.app.request(path, { method: "POST", headers, body: JSON.stringify(body) });
    expect(
      (
        await post("/admin/api/api-key-pools/anthropic-api/accounts", {
          accounts: [{ name: "wrong", key: "sk-proj-wrong-type" }],
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await post("/admin/api/api-key-pools/anthropic-api/accounts", {
          accounts: [
            { name: "A", key: "sk-ant-usr-test-first" },
            { name: "B", key: "sk-ant-api03-test-second" },
          ],
        })
      ).status,
    ).toBe(204);
    const headers = { authorization: "Bearer helm_pool_test", "content-type": "application/json" };
    for (const stream of [false, true]) {
      const response = await post(
        "/v1/messages",
        {
          model: "anthropic-api/claude-test",
          messages: [{ role: "user", content: "Hello" }],
          max_tokens: 32,
          stream,
        },
        headers,
      );
      expect(response.status).toBe(200);
      expect(await response.text()).toContain('"text":"OK"');
    }
    expect(new Set(calls.map((c) => c.key)).size).toBe(2);
    expect(calls.every((c) => c.authorization === undefined && c.model === "claude-test")).toBe(
      true,
    );
    const chat = await post(
      "/v1/chat/completions",
      {
        model: "anthropic-api/claude-test",
        messages: [{ role: "user", content: "Hello" }],
        max_tokens: 32,
      },
      headers,
    );
    expect(chat.status).toBe(200);
    expect(await chat.json()).toMatchObject({ choices: [{ message: { content: "OK" } }] });
    const overview = ApiKeyPoolsViewSchema.parse(
      await (await handle.app.request("/admin/api/api-key-pools", { headers: admin })).json(),
    );
    const pool = overview.pools[0]!;
    expect(pool.type).toBe("anthropic");
    expect(JSON.stringify(pool)).not.toContain("sk-ant-");
    const before = calls.length;
    const test = await post(
      `/admin/api/api-key-pools/anthropic-api/accounts/${pool.accounts[0]!.id}/test`,
      { model: "claude-test" },
    );
    expect(await test.json()).toMatchObject({ ok: true, response: "OK" });
    expect(calls.slice(before).map((c) => c.key)).toEqual(["sk-ant-usr-test-first"]);
  } finally {
    await handle?.dispose?.();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  }
});
