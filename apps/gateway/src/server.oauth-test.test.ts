import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  createRuntimeMemoryCoordinator,
  createSqliteDb,
  DEFAULT_OPENAI_CODEX_CLIENT_VERSION,
  encryptSecret,
  hashKey,
  SqliteKeyStore,
  SqliteOAuthTokenStore,
} from "@helm/core";
import { expect, it, vi } from "vitest";
import { loadBundledCodexModels } from "./oauth/codex-bundled-models.js";
import { buildServer, type ServerHandle } from "./server.js";

it.each([
  DEFAULT_OPENAI_CODEX_CLIENT_VERSION,
  "0.160.1",
])("uses the account catalog and configured Codex version %s in the admin connectivity test", async (version) => {
  const directory = await mkdtemp(join(tmpdir(), "helm-oauth-test-"));
  const db = createSqliteDb(join(directory, "helm.db"));
  const encKey = Buffer.alloc(32, 11);
  let server: ServerHandle | undefined;
  try {
    await new SqliteKeyStore(db).createKey({
      keyId: "test-root",
      hash: hashKey("synthetic-root-key"),
      prefix: "helm_test",
      accountId: "test",
      role: "root",
    });
    await new SqliteOAuthTokenStore(db).upsert({
      providerId: "openai-codex",
      account: "test-account",
      accessEnc: encryptSecret("opaque-test-access", encKey),
      refreshEnc: encryptSecret("test-refresh", encKey),
      expiresAt: 9_999_999_999_999,
      meta: JSON.stringify({ accountId: "test-workspace", isFedramp: true }),
      updatedAt: 1,
    });
    vi.stubEnv("HELM_DATA_DIR", directory);
    vi.stubEnv("HELM_SIGNALS_DISABLED", "1");
    vi.stubEnv("HELM_OAUTH_ENC_KEY", encKey.toString("base64"));
    vi.stubEnv("HELM_OPENAI_CODEX_CLIENT_VERSION", version);
    vi.stubEnv("HELM_ADMIN_USER", "test-admin");
    vi.stubEnv("HELM_ADMIN_PASSWORD", "test-password");
    const model = loadBundledCodexModels().find((entry) => entry.slug === "gpt-6.1-sol");
    if (!model) throw new Error("Missing bundled GPT-6.1 Sol");
    const requests: Array<{ headers: Headers; body: Record<string, unknown> }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async (input, init) => {
        if (String(input).includes("/models?")) {
          return Response.json({ models: [{ ...model, use_responses_lite: true }] });
        }
        if (!String(input).endsWith("/responses")) throw new Error("Unexpected network request");
        requests.push({
          headers: new Headers(init?.headers),
          body: JSON.parse(String(init?.body)),
        });
        return new Response(
          [
            { type: "response.output_text.delta", delta: "Hello!" },
            { type: "response.completed", response: { id: "test-response", output: [] } },
          ]
            .map((event) => `data: ${JSON.stringify(event)}\n\n`)
            .join(""),
          { headers: { "Content-Type": "text/event-stream" } },
        );
      }),
    );
    server = await buildServer({
      configDir: resolve("config"),
      memoryCoordinator: createRuntimeMemoryCoordinator({
        capacityBytes: () => Number.MAX_SAFE_INTEGER,
      }),
      resourcePressure: { shouldRun: async () => false, shouldRunHeavy: async () => false },
      logger: { log: () => {} },
    });
    const response = await server.app.request("/admin/api/oauth/openai-codex/test", {
      method: "POST",
      headers: {
        Authorization: `Basic ${Buffer.from("test-admin:test-password").toString("base64")}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ account: "test-account", model: "gpt-6.1-sol" }),
    });
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('"text":"Hello!"');
    expect(requests).toHaveLength(1);
    expect(requests[0]?.headers.get("version")).toBe(version);
    expect(requests[0]?.headers.get("user-agent")).toContain(`codex_cli_rs/${version}`);
    expect(requests[0]?.headers.get("chatgpt-account-id")).toBe("test-workspace");
    expect(requests[0]?.headers.get("X-OpenAI-Fedramp")).toBe("true");
    expect(requests[0]?.headers.get("x-openai-internal-codex-responses-lite")).toBe("true");
    expect(requests[0]?.body).toMatchObject({ model: "gpt-6.1-sol", stream: true, store: false });
    expect(requests[0]?.body).not.toHaveProperty("max_output_tokens");
    expect(db.$sqlite.prepare("SELECT COUNT(*) AS n FROM telemetry").get()).toEqual({ n: 0 });
  } finally {
    await server?.dispose?.();
    db.$sqlite.close();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    await rm(directory, { recursive: true, force: true });
  }
});
