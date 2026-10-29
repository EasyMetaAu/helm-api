import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSqliteDb, hashKey, SqliteKeyStore } from "@helm/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildServer } from "./server.js";

afterEach(() => vi.unstubAllEnvs());
describe("API key pools through the real gateway", () => {
  it("protects admin writes, rotates Chat and Responses credentials, persists quota and attributes usage", async () => {
    const calls: string[] = [];
    let failTest = false;
    const events: unknown[] = [];
    const upstream = createServer(async (req, res) => {
      let raw = "";
      for await (const chunk of req) raw += chunk;
      const body = JSON.parse(raw) as {
        stream?: boolean;
        model: string;
        messages?: Array<{ content: string }>;
      };
      const key = req.headers.authorization ?? "";
      calls.push(key);
      if (
        failTest ||
        (body.messages?.some((m) => m.content === "exhaust") && key.endsWith("first"))
      ) {
        res.writeHead(429, { "content-type": "application/json" });
        res.end(
          JSON.stringify({ error: { code: "credit_balance_exhausted", message: "out of credit" } }),
        );
        return;
      }
      if (req.url?.endsWith("/responses")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            id: "resp_mock",
            object: "response",
            status: "completed",
            model: body.model,
            output: [
              {
                type: "message",
                role: "assistant",
                content: [{ type: "output_text", text: "OK" }],
              },
            ],
            usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
          }),
        );
        return;
      }
      if (body.stream) {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.end(
          'data: {"id":"c","choices":[{"index":0,"delta":{"content":"OK"},"finish_reason":null}]}\n\ndata: {"id":"c","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}\n\ndata: [DONE]\n\n',
        );
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          id: "chat_mock",
          model: body.model,
          object: "chat.completion",
          choices: [
            { index: 0, message: { role: "assistant", content: "OK" }, finish_reason: "stop" },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
      );
    });
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    const address = upstream.address();
    if (!address || typeof address === "string") throw new Error("missing upstream address");
    const dir = mkdtempSync(join(tmpdir(), "helm-api-pool-test-"));
    const configDir = join(dir, "config");
    const { mkdirSync } = await import("node:fs");
    mkdirSync(configDir);
    const upstreamBase = `http://127.0.0.1:${address.port}/v1`;
    const files: Record<string, string> = {
      "server.yaml": "host: 127.0.0.1\nport: 8099\nbase_path: /\n",
      "auth.yaml":
        "require_api_key: true\nbootstrap:\n  generate_if_missing: false\n  print_once: false\n  persist_to: unused-key-file\n",
      "runtime.yaml":
        "request_timeout_ms: 10000\nrate_limit:\n  enabled: false\n  default: { rpm: 0, tpm: 0 }\n",
      "providers.yaml": `providers:\n  - name: openai\n    type: openai\n    base_url: ${upstreamBase}\n    api_key_pool: { id: openai }\n    models:\n      - { alias: 'openai/test-chat', provider_model: test-chat }\n  - name: openai-responses\n    type: openai-responses-generic\n    base_url: ${upstreamBase}\n    api_key_pool: { id: openai }\n    models:\n      - { alias: 'openai/test-responses', provider_model: test-responses }\n`,
      "capabilities.yaml":
        "openai/test-chat:\n  supportsStreaming: true\n  maxContextTokens: 8192\n  maxOutputTokens: 1000\nopenai/test-responses:\n  supportsStreaming: true\n  maxContextTokens: 8192\n  maxOutputTokens: 1000\n",
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
    }))
      vi.stubEnv(key, value);
    vi.stubEnv("HELM_PROVIDER_BASE_URL", "");
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
      handle = await buildServer({
        configDir,
        logger: {
          log: (_level, event, fields) => {
            events.push({ event, fields });
          },
        },
      });
      const admin = {
        authorization: `Basic ${Buffer.from("test:test-password").toString("base64")}`,
        "content-type": "application/json",
      };
      const request = (path: string, init?: RequestInit) => handle!.app.request(path, init);
      const input = {
        accounts: [
          { name: "first", key: "sk-proj-mock-first" },
          { name: "second", key: "sk-proj-mock-second" },
        ],
      };
      expect(
        (
          await request("/admin/api/api-key-pools/openai/accounts", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(input),
          })
        ).status,
      ).toBe(401);
      expect(
        (
          await request("/admin/api/api-key-pools/openai/accounts", {
            method: "POST",
            headers: admin,
            body: JSON.stringify(input),
          })
        ).status,
      ).toBe(204);
      const chat = (content: string, stream = false) =>
        request("/v1/chat/completions", {
          method: "POST",
          headers: { authorization: "Bearer helm_pool_test", "content-type": "application/json" },
          body: JSON.stringify({
            model: "openai/test-chat",
            messages: [{ role: "user", content }],
            stream,
          }),
        });
      for (let i = 0; i < 2; i++) {
        const res = await chat("hello", i === 1);
        if (res.status !== 200) {
          const diag = createSqliteDb(join(dir, "helm.db"));
          events.push(
            diag.$sqlite
              .prepare("SELECT decision_json FROM telemetry ORDER BY created_at DESC LIMIT 1")
              .get(),
          );
          diag.$sqlite.close();
        }
        expect(res.status, JSON.stringify(events.slice(-4)) + (await res.clone().text())).toBe(200);
        await res.text();
      }
      expect(calls).toEqual(["Bearer sk-proj-mock-first", "Bearer sk-proj-mock-second"]);
      const exhausted = await chat("exhaust");
      expect(exhausted.status, await exhausted.clone().text()).toBe(200);
      await exhausted.text();
      expect(calls.slice(-2)).toEqual(["Bearer sk-proj-mock-first", "Bearer sk-proj-mock-second"]);
      const response = await request("/v1/responses", {
        method: "POST",
        headers: { authorization: "Bearer helm_pool_test", "content-type": "application/json" },
        body: JSON.stringify({ model: "openai/test-responses", input: "hello" }),
      });
      expect(response.status, await response.clone().text()).toBe(200);
      await response.text();
      expect(calls.at(-1)).toBe("Bearer sk-proj-mock-second");
      const overview = await request("/admin/api/api-key-pools", { headers: admin });
      const text = await overview.text();
      expect(text).not.toContain("sk-proj-mock");
      expect(JSON.parse(text).pools[0].accounts[0].state).toBe("quota_exhausted");
      await vi.waitFor(async () => {
        const body = (await (
          await request("/admin/api/api-key-pools", { headers: admin })
        ).json()) as { pools: Array<{ usage: Array<{ requests: number }> }> };
        expect(body.pools[0]?.usage.reduce((n, row) => n + row.requests, 0)).toBe(4);
      });
      const accountId = JSON.parse(text).pools[0].accounts[0].id;
      const testPath = `/admin/api/api-key-pools/openai/accounts/${accountId}/test`;
      expect(
        (await request(testPath, { method: "POST", body: JSON.stringify({ model: "test-chat" }) }))
          .status,
      ).toBe(401);
      for (const model of ["test-chat", "test-responses"]) {
        const before = calls.length;
        const result = await request(testPath, {
          method: "POST",
          headers: admin,
          body: JSON.stringify({ model }),
        });
        expect(await result.json()).toMatchObject({ ok: true, model, response: "OK" });
        expect(calls.slice(before)).toEqual(["Bearer sk-proj-mock-first"]);
      }
      failTest = true;
      const before = calls.length;
      const failed = await request(testPath, {
        method: "POST",
        headers: admin,
        body: JSON.stringify({ model: "test-chat" }),
      });
      expect(await failed.json()).toMatchObject({
        ok: false,
        error: "credit_balance_exhausted",
        upstreamStatus: 429,
      });
      expect(calls.slice(before)).toEqual(["Bearer sk-proj-mock-first"]);
    } finally {
      await handle?.dispose?.();
      await new Promise<void>((resolve) => upstream.close(() => resolve()));
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
