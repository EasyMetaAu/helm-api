import { cp, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createSqliteDb, hashKey, SqliteKeyStore } from "@helm/core";
import { expect, it, vi } from "vitest";
import { buildServer, type ServerHandle } from "./server.js";

it("enforces client policy across HTTP model boundaries while preserving portal access", async () => {
  const dir = await mkdtemp(join(tmpdir(), "helm-client-policy-"));
  const db = createSqliteDb(join(dir, "helm.db"));
  let server: ServerHandle | undefined;
  try {
    await cp(resolve("config"), join(dir, "config"), { recursive: true });
    await new SqliteKeyStore(db).createKey({
      keyId: "restricted",
      hash: hashKey("test-only-key"),
      prefix: "test",
      accountId: "test",
      role: "user",
      clientPolicy: { allowed_clients: ["codex_app"] },
    });
    await new SqliteKeyStore(db).createKey({
      keyId: "corrupt",
      hash: hashKey("corrupt-test-key"),
      prefix: "test",
      accountId: "test",
      role: "user",
    });
    db.$sqlite
      .prepare("UPDATE api_keys SET client_policy = ? WHERE key_id = ?")
      .run("not-json", "corrupt");
    vi.stubEnv("HELM_ADMIN_USER", "test-admin");
    vi.stubEnv("HELM_ADMIN_PASSWORD", "test-password");
    vi.stubEnv("HELM_DATA_DIR", dir);
    vi.stubEnv("HELM_SIGNALS_DISABLED", "1");
    vi.stubEnv("HELM_OAUTH_ENC_KEY", "11".repeat(32));
    vi.stubEnv("HELM_AUTH_CACHE_TTL_MS", "0");
    const upstream = vi.fn<typeof fetch>(async () => {
      throw new Error("Unexpected upstream call");
    });
    vi.stubGlobal("fetch", upstream);
    const log = vi.fn();
    server = await buildServer({
      configDir: join(dir, "config"),
      resourcePressure: { shouldRun: async () => false, shouldRunHeavy: async () => false },
      logger: { log },
    });
    const headers = {
      Authorization: "Bearer test-only-key",
      "x-api-key": "test-only-key",
      "x-goog-api-key": "test-only-key",
      "content-type": "application/json",
      "user-agent": "curl/8",
    };
    const paths = [
      "/v1/decisions",
      "/v1/chat/completions",
      "/chat/completions",
      "/engines/test/chat/completions",
      "/openai/deployments/test/chat/completions",
      "/v1/messages",
      "/v1/messages/count_tokens",
      "/v1/responses",
      "/responses",
      "/openai/v1/responses",
      "/v1/responses/compact",
      "/v1/responses/input_tokens",
      "/v1beta/models/gemini:generateContent",
      "/v1beta/models/gemini:countTokens",
      "/v1beta/interactions",
      "/v1/images/generations",
      "/v1/images/edits",
      "/v1/videos/generations",
      "/v1/3d/generations",
      "/v1/tts",
      "/v1/realtime/calls",
    ];
    for (const path of paths) {
      const response = await server.app.request(path, { method: "POST", headers, body: "{}" });
      expect(response.status, path).toBe(403);
      const body = (await response.json()) as {
        error: { type?: string; status?: string; code?: string };
      };
      if (path.startsWith("/v1/messages")) expect(body.error.type).toBe("permission_error");
      else if (path.startsWith("/v1beta/")) expect(body.error.status).toBe("PERMISSION_DENIED");
      else expect(body.error.code).toBe("client_not_allowed");
    }
    for (const path of [
      "/v1/models",
      "/v1/responses/resp_test",
      "/v1/videos/vid_test",
      "/v1/3d/task_test",
    ]) {
      expect((await server.app.request(path, { headers })).status, path).toBe(403);
    }
    const corruptHeaders = {
      ...headers,
      Authorization: "Bearer corrupt-test-key",
      "x-api-key": "corrupt-test-key",
      "x-goog-api-key": "corrupt-test-key",
      "user-agent": "Codex Desktop/0.162.0",
    };
    for (const path of paths) {
      expect(
        (await server.app.request(path, { method: "POST", headers: corruptHeaders, body: "{}" }))
          .status,
        path,
      ).toBe(403);
    }
    await expect(
      server.resolveRealtimeKey?.("corrupt-test-key", "Codex Desktop/0.162.0"),
    ).rejects.toMatchObject({ helm: { http_status: 403 } });
    const adminHeaders = {
      Authorization: `Basic ${Buffer.from("test-admin:test-password").toString("base64")}`,
      "content-type": "application/json",
    };
    const listed = await server.app.request("/admin/api/keys", { headers: adminHeaders });
    expect(listed.status).toBe(200);
    expect(await listed.json()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key_id: "corrupt", client_policy: { allowed_clients: [] } }),
      ]),
    );
    expect(
      (
        await server.app.request("/admin/api/keys/corrupt", {
          method: "PATCH",
          headers: adminHeaders,
          body: JSON.stringify({ client_policy: null }),
        })
      ).status,
    ).toBe(200);
    expect((await server.app.request("/v1/models", { headers: corruptHeaders })).status).toBe(200);
    expect(upstream).not.toHaveBeenCalled();
    await expect(server.resolveRealtimeKey?.("test-only-key", "curl/8")).rejects.toMatchObject({
      helm: { http_status: 403 },
    });
    expect(await server.resolveRealtimeKey?.("test-only-key", "Codex Desktop/0.162.0")).toBe(
      "restricted",
    );
    expect(
      (
        await server.app.request("/v1/models", {
          headers: { ...headers, "user-agent": "Codex Desktop/0.162.0" },
        })
      ).status,
    ).toBe(200);
    expect((await server.app.request("/portal/api/me", { headers })).status).toBe(200);
    const invalid = await server.app.request("/v1/responses", {
      method: "POST",
      headers: { Authorization: "Bearer invalid" },
      body: "{}",
    });
    expect(invalid.status).toBe(401);
    expect(JSON.stringify(log.mock.calls)).not.toContain("test-only-key");
    await new SqliteKeyStore(db).updateKey("restricted", { clientPolicy: null });
    expect((await server.app.request("/v1/models", { headers })).status).toBe(200);
  } finally {
    await server?.dispose?.();
    db.$sqlite.close();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    await rm(dir, { recursive: true, force: true });
  }
});

it.each([
  false,
  true,
])("preserves execution fallback for an admitted Codex client (stream=%s)", async (stream) => {
  const dir = await mkdtemp(join(tmpdir(), "helm-client-fallback-"));
  const db = createSqliteDb(join(dir, "helm.db"));
  let server: ServerHandle | undefined;
  try {
    const configDir = join(dir, "config");
    await cp(resolve("config"), configDir, { recursive: true });
    await writeFile(
      join(configDir, "providers.yaml"),
      JSON.stringify({
        providers: [
          {
            name: "first",
            type: "openai",
            base_url: "https://first.test/v1",
            api_key_env: "FALLBACK_TEST_KEY",
            models: [{ alias: "first/gpt", provider_model: "gpt-test" }],
          },
          {
            name: "second",
            type: "anthropic",
            base_url: "https://second.test",
            api_key_env: "FALLBACK_TEST_KEY",
            models: [{ alias: "second/claude", provider_model: "claude-test" }],
          },
        ],
      }),
    );
    await writeFile(
      join(configDir, "lanes.yaml"),
      JSON.stringify({
        balanced: { primary: "first/gpt", fallback: ["second/claude"], constraints: {} },
      }),
    );
    await writeFile(join(configDir, "policies.yaml"), JSON.stringify({ policies: [] }));
    await writeFile(join(configDir, "model-aliases.yaml"), "{}");
    await new SqliteKeyStore(db).createKey({
      keyId: "allowed",
      hash: hashKey("fallback-key"),
      prefix: "test",
      accountId: "test",
      role: "user",
      allowCustomModel: true,
      clientPolicy: { allowed_clients: ["codex_app"] },
    });
    vi.stubEnv("HELM_DATA_DIR", dir);
    vi.stubEnv("HELM_SIGNALS_DISABLED", "1");
    vi.stubEnv("HELM_OAUTH_ENC_KEY", "11".repeat(32));
    vi.stubEnv("FALLBACK_TEST_KEY", "test-upstream");
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async (url) => {
        const host = new URL(String(url)).hostname;
        calls.push(host);
        if (host === "first.test")
          return Response.json({ error: { message: "temporarily unavailable" } }, { status: 503 });
        if (host !== "second.test") throw new Error("Unexpected upstream");
        if (!stream)
          return Response.json({
            id: "msg_1",
            type: "message",
            role: "assistant",
            model: "claude-test",
            content: [{ type: "text", text: "fallback worked" }],
            stop_reason: "end_turn",
            usage: { input_tokens: 1, output_tokens: 2 },
          });
        return new Response(
          [
            'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","type":"message","role":"assistant","model":"claude-test","content":[],"usage":{"input_tokens":1,"output_tokens":0}}}\n\n',
            'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
            'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"fallback worked"}}\n\n',
            'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
            'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":2}}\n\n',
            'event: message_stop\ndata: {"type":"message_stop"}\n\n',
          ].join(""),
          { headers: { "content-type": "text/event-stream" } },
        );
      }),
    );
    server = await buildServer({
      configDir,
      resourcePressure: { shouldRun: async () => false, shouldRunHeavy: async () => false },
      logger: { log: vi.fn() },
    });
    const response = await server.app.request("/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: "Bearer fallback-key",
        "Content-Type": "application/json",
        "User-Agent": "Codex Desktop/0.162.0",
      },
      body: JSON.stringify({
        model: "balanced",
        messages: [{ role: "user", content: "hello" }],
        stream,
      }),
    });
    const text = await response.text();
    expect(response.status, text).toBe(200);
    expect(text).toContain("fallback worked");
    expect(calls[0]).toBe("first.test");
    expect(calls.at(-1)).toBe("second.test");
    if (stream) expect(text).toContain("[DONE]");
  } finally {
    await server?.dispose?.();
    db.$sqlite.close();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    await rm(dir, { recursive: true, force: true });
  }
});
