import { cp, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  createRuntimeMemoryCoordinator,
  createSqliteDb,
  hashKey,
  SqliteKeyStore,
} from "@helm/core";
import { evaluateClientPolicy } from "@helm/shared";
import { expect, it, vi } from "vitest";
import { buildServer, type ServerHandle } from "./server.js";

it.each([
  "helm",
  "openai-responses-generic",
])("preserves translated Chat client identity only for %s relays", async (type) => {
  const directory = await mkdtemp(join(tmpdir(), "helm-chat-relay-"));
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
            name: "relay",
            type,
            target_provider_protocol: "openai_responses",
            base_url: "https://upstream.test/v1",
            api_key_env: "CHAT_RELAY_KEY",
            models: [{ alias: "relay/grok", provider_model: "grok" }],
          },
        ],
      }),
    );
    await writeFile(
      join(configDir, "capabilities.yaml"),
      JSON.stringify({
        "relay/grok": { supportsStreaming: true, maxContextTokens: 100000 },
      }),
    );
    await new SqliteKeyStore(db).createKey({
      keyId: "relay-test",
      hash: hashKey("synthetic-inbound-key"),
      prefix: "test",
      accountId: "test",
      role: "root",
      allowCustomModel: true,
    });
    vi.stubEnv("HELM_DATA_DIR", directory);
    vi.stubEnv("HELM_SIGNALS_DISABLED", "1");
    vi.stubEnv("HELM_OAUTH_ENC_KEY", Buffer.alloc(32, 11).toString("base64"));
    vi.stubEnv("CHAT_RELAY_KEY", "synthetic-upstream-key");
    const calls: { headers: Headers; body: Record<string, unknown> }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async (url, init) => {
        expect(String(url)).toBe("https://upstream.test/v1/responses");
        const headers = new Headers(init?.headers);
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        calls.push({ headers, body });
        const response = {
          id: "resp_test",
          object: "response",
          status: "completed",
          model: "grok",
          output: [
            { type: "message", role: "assistant", content: [{ type: "output_text", text: "OK" }] },
          ],
          usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
        };
        if (body.stream) {
          return new Response(
            [
              { type: "response.output_text.delta", delta: "OK" },
              { type: "response.completed", response },
            ]
              .map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
              .join(""),
            {
              headers: { "content-type": "text/event-stream" },
            },
          );
        }
        return Response.json(response);
      }),
    );
    server = await buildServer({
      configDir,
      memoryCoordinator: createRuntimeMemoryCoordinator({
        capacityBytes: () => Number.MAX_SAFE_INTEGER,
      }),
      resourcePressure: { shouldRun: async () => false, shouldRunHeavy: async () => false },
      logger: { log() {} },
    });
    const identities = [
      "grok-shell/1.0.77 (macos; aarch64)",
      "codex_cli_rs/0.167.0 (linux; x86_64)",
    ];
    for (const stream of [false, true]) {
      for (const ua of [...identities, undefined]) {
        const result = await server.app.request("/v1/chat/completions", {
          method: "POST",
          headers: {
            authorization: "Bearer synthetic-inbound-key",
            "content-type": "application/json",
            ...(ua ? { "user-agent": ua } : {}),
          },
          body: JSON.stringify({
            model: "relay/grok",
            stream,
            messages: [{ role: "user", content: "Reply OK only." }],
            metadata: { client_user_agent: "forged-body-agent" },
            client_user_agent: "forged-body-agent",
          }),
        });
        const text = await result.text();
        expect(result.status, text).toBe(200);
        expect(text).toContain("OK");
        const call = calls.at(-1);
        expect(call?.headers.get("authorization")).toBe("Bearer synthetic-upstream-key");
        expect(call?.headers.get("user-agent")).toBe(type === "helm" ? (ua ?? "") : null);
        expect(call?.headers.get("user-agent")).not.toBe("forged-body-agent");
        expect(JSON.stringify(call?.body)).not.toContain("grok-shell");
        if (type === "helm" && ua === identities[0]) {
          expect(
            evaluateClientPolicy(
              { allowed_clients: ["grok_cli"] },
              call?.headers.get("user-agent"),
            ),
          ).toMatchObject({ allowed: true, client: "grok_cli" });
        }
      }
    }
    expect(calls).toHaveLength(6);
  } finally {
    await server?.dispose?.();
    db.$sqlite.close();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    await rm(directory, { recursive: true, force: true });
  }
});
