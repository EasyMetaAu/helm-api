import { randomUUID } from "node:crypto";
import { cp, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  createRuntimeMemoryCoordinator,
  createSqliteDb,
  hashKey,
  RUNTIME_SETTINGS_KEY,
  SqliteBudgetStore,
  SqliteConfigStore,
  SqliteKeyStore,
  SqliteTelemetryStore,
} from "@helm/core";
import { DecisionRecordSchema } from "@helm/shared";
import { expect, it, vi } from "vitest";
import { buildServer, type ServerHandle } from "./server.js";

it("replays through real client auth, caps, budgets, rate and concurrency gates under the caller", async () => {
  const dir = await mkdtemp(join(tmpdir(), "helm-portal-replay-"));
  const db = createSqliteDb(join(dir, "helm.db"));
  const keys = new SqliteKeyStore(db);
  const telemetry = new SqliteTelemetryStore(db);
  const budget = new SqliteBudgetStore(db);
  let server: ServerHandle | undefined;
  let releaseHold: (() => void) | undefined;
  try {
    await cp(resolve("config"), join(dir, "config"), { recursive: true });
    await writeFile(
      join(dir, "config/providers.yaml"),
      JSON.stringify({
        providers: [
          {
            name: "debug",
            type: "openai",
            base_url: "https://portal-upstream.invalid/v1",
            api_key_env: "PORTAL_TEST_UPSTREAM_KEY",
            models: [{ alias: "debug-model", provider_model: "debug-model" }],
          },
        ],
      }),
    );
    await writeFile(
      join(dir, "config/capabilities.yaml"),
      JSON.stringify({ "debug-model": { supportsStreaming: true, maxContextTokens: 100000 } }),
    );
    await new SqliteConfigStore(db).set(
      RUNTIME_SETTINGS_KEY,
      JSON.stringify({
        rate_limit_enabled: true,
        concurrency_queue_enabled: true,
        concurrency_queue_wait_timeout_ms: 5000,
        capture_payloads: true,
        capture_sessions: false,
      }),
    );
    const sourceBody = {
      model: "debug-model",
      messages: [{ role: "user", content: "replay" }],
      stream: false,
    };
    for (const keyId of [
      "a",
      "b",
      "budget",
      "rate",
      "caps",
      "revoked",
      "concurrent",
      "stream",
      "root",
    ]) {
      await keys.createKey({
        keyId,
        hash: hashKey(`test-${keyId}`),
        prefix: `test-${keyId}`,
        accountId: "account",
        role: keyId === "root" ? "root" : "user",
        clientPolicy: keyId === "caps" ? { allowed_clients: ["codex_app"] } : undefined,
        allowCustomModel: keyId !== "caps",
        requestContentMode: "payload",
        rateLimitRpm: keyId === "rate" ? 1 : 0,
        concurrencyLimit: keyId === "concurrent" ? 1 : undefined,
        budgetRequests: keyId === "budget" ? 1 : 10,
        overBudgetBehavior: "degrade",
        budgetWindowSeconds: 86400,
      });
      const id = `source-${keyId}`;
      await telemetry.insert({
        apiKeyId: keyId,
        createdAt: new Date(),
        decision: DecisionRecordSchema.parse({
          request_id: id,
          trace_id: id,
          requested_model: "debug-model",
          protocol: "openai_chat",
          request_content_mode: "payload",
          classifier: {
            task_type: "chat",
            complexity: "low",
            confidence: 1,
            decided_by: "rules",
            eval_cache_hit: null,
            constraints: {},
            explanation: [],
          },
          policy: { matched_policy_id: null, reason: "" },
          lane: { selected_lane: "balanced", candidate_chain: [] },
          provider_attempts: [],
          final: {
            status: "ok",
            model_alias: "debug-model",
            provider_model: "debug-model",
            error_reason: null,
          },
        }),
      });
      await telemetry.insertPayload({
        requestId: id,
        requestJson: JSON.stringify({ ...sourceBody, stream: keyId === "stream" }),
        responseJson: null,
        createdAt: new Date(),
      });
    }
    await budget.debit("budget", "req", 1, 86400000, Date.now(), 1);
    vi.stubEnv("HELM_DATA_DIR", dir);
    vi.stubEnv("HELM_SIGNALS_DISABLED", "1");
    vi.stubEnv("HELM_OAUTH_ENC_KEY", "11".repeat(32));
    vi.stubEnv("PORTAL_TEST_UPSTREAM_KEY", "test-upstream");
    let signalHold!: () => void;
    const held = new Promise<void>((resolve) => {
      signalHold = resolve;
    });
    const upstream = vi.fn<typeof fetch>(async (url, init) => {
      expect(String(url)).toBe("https://portal-upstream.invalid/v1/chat/completions");
      const body = JSON.parse(String(init?.body));
      if (body.messages.some((m: { content: unknown }) => m.content === "hold")) {
        signalHold();
        await new Promise<void>((resolve) => {
          releaseHold = resolve;
        });
      }
      if (body.stream)
        return new Response(
          [
            {
              id: "chat-stream",
              object: "chat.completion.chunk",
              model: "debug-model",
              choices: [
                { index: 0, delta: { role: "assistant", content: "OK" }, finish_reason: null },
              ],
            },
            {
              id: "chat-stream",
              object: "chat.completion.chunk",
              model: "debug-model",
              choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
              usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
            },
          ]
            .map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`)
            .join("") + "data: [DONE]\n\n",
          { headers: { "content-type": "text/event-stream" } },
        );
      return Response.json({
        id: "chat-test",
        object: "chat.completion",
        model: "debug-model",
        choices: [
          { index: 0, message: { role: "assistant", content: "OK" }, finish_reason: "stop" },
        ],
        usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
      });
    });
    vi.stubGlobal("fetch", upstream);
    server = await buildServer({
      configDir: join(dir, "config"),
      memoryCoordinator: createRuntimeMemoryCoordinator({
        capacityBytes: () => Number.MAX_SAFE_INTEGER,
      }),
      resourcePressure: { shouldRun: async () => false, shouldRunHeavy: async () => false },
      logger: { log() {} },
    });
    expect(await new SqliteConfigStore(db).get("portal.pseudonym-secret.v1")).toMatch(/^v1:/);
    const app = server.app;
    const headers = (key: string) => ({
      authorization: `Bearer test-${key}`,
      "content-type": "application/json",
    });
    const replay = (key: string, source = `source-${key}`, token = randomUUID()) =>
      app.request(`/portal/api/requests/${source}/replay`, {
        method: "POST",
        headers: { ...headers(key), "idempotency-key": token },
      });
    const token = randomUUID();
    const ok = await replay("a", "source-a", token);
    expect(ok.status).toBe(200);
    const result = (await ok.json()) as { request_id: string; status: string };
    expect(result.status).toBe("recorded");
    expect(await telemetry.getApiKeyId(result.request_id)).toBe("a");
    expect(result.request_id).not.toBe("source-a");
    expect((await telemetry.getByRequestId(result.request_id))?.final.status).toBe("ok");
    expect((await budget.peek("a", "req", 10, 86400000, Date.now())).remaining).toBeLessThan(10);
    expect((await budget.peek("root", "req", 10, 86400000, Date.now())).remaining).toBe(10);
    expect(await (await replay("a", "source-a", token)).json()).toEqual(result);
    expect(upstream).toHaveBeenCalledTimes(1);
    const foreign = await replay("b", "source-a");
    const missing = await replay("b", "missing");
    expect(foreign.status).toBe(404);
    expect(await foreign.json()).toEqual(await missing.json());
    const over = await replay("budget");
    expect(((await over.json()) as { upstream_status: number }).upstream_status).toBe(429);
    expect(upstream).toHaveBeenCalledTimes(1);
    const caps = await replay("caps");
    expect(((await caps.json()) as { upstream_status: number }).upstream_status).toBe(403);
    await app.request("/portal/api/me", { headers: headers("revoked") });
    await keys.disable("revoked");
    expect((await replay("revoked")).status).toBe(401);
    expect(upstream).toHaveBeenCalledTimes(1);
    const normal = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: headers("rate"),
      body: JSON.stringify(sourceBody),
    });
    expect(normal.status).toBe(200);
    await normal.text();
    const rate = await replay("rate");
    expect(((await rate.json()) as { upstream_status: number }).upstream_status).toBe(429);
    expect(upstream).toHaveBeenCalledTimes(2);
    const holding = app.request("/v1/chat/completions", {
      method: "POST",
      headers: headers("concurrent"),
      body: JSON.stringify({ ...sourceBody, messages: [{ role: "user", content: "hold" }] }),
    });
    await held;
    const concurrent = await replay("concurrent");
    expect(((await concurrent.json()) as { upstream_status: number }).upstream_status).toBe(429);
    expect(upstream).toHaveBeenCalledTimes(3);
    releaseHold?.();
    await (await holding).text();
    const streaming = await replay("stream");
    expect(streaming.status).toBe(200);
    const streamed = (await streaming.json()) as { request_id: string; status: string };
    expect(streamed.status).toBe("recorded");
    expect(await telemetry.getApiKeyId(streamed.request_id)).toBe("stream");
    expect((await telemetry.getByRequestId(streamed.request_id))?.usage?.completion_tokens).toBe(1);
    expect((await telemetry.getPayload(streamed.request_id))?.responseJson).toContain("[DONE]");
    const capture = await app.request(
      `/portal/api/requests/${streamed.request_id}/payload?part=response`,
      {
        headers: { ...headers("stream"), Accept: "application/vnd.helm.payload" },
      },
    );
    expect(capture.status).toBe(200);
    expect(capture.headers.get("content-type")).toBe("application/vnd.helm.payload");
    expect(await capture.text()).toContain("[DONE]");
    expect((await budget.peek("stream", "req", 10, 86400000, Date.now())).remaining).toBeLessThan(
      10,
    );
    for (const key of ["a", "b"]) {
      const list = (await (
        await app.request("/portal/api/requests?key_id=root", { headers: headers(key) })
      ).json()) as { items: Array<{ request_id: string }> };
      for (const item of list.items) expect(await telemetry.getApiKeyId(item.request_id)).toBe(key);
      const stats = (await (
        await app.request("/portal/api/usage/stats?key_id=root", { headers: headers(key) })
      ).json()) as { api_key_id: string; totals: { requests: number } };
      expect(stats.api_key_id).toBe(key);
      expect(stats.totals.requests).toBe(list.items.length);
      const memory = (await (
        await app.request("/portal/api/memory/stats?account_id=other&project_id=root", {
          headers: headers(key),
        })
      ).json()) as { project_id: string };
      expect(memory.project_id).toBe(key);
    }
    // A custom ConfigStore can omit atomic CAS. Verify the real composition root
    // still starts and serves ordinary traffic while Portal decisions fail closed.
    await server.dispose?.();
    server = undefined;
    const configStore = new SqliteConfigStore(db);
    const secret = await configStore.get("portal.pseudonym-secret.v1");
    if (secret) await configStore.deleteIfValue("portal.pseudonym-secret.v1", secret);
    const descriptor = Object.getOwnPropertyDescriptor(
      SqliteConfigStore.prototype,
      "compareAndSet",
    );
    if (!descriptor) throw new Error("missing test ConfigStore descriptor");
    Object.defineProperty(SqliteConfigStore.prototype, "compareAndSet", {
      ...descriptor,
      value: undefined,
    });
    try {
      server = await buildServer({
        configDir: join(dir, "config"),
        memoryCoordinator: createRuntimeMemoryCoordinator({
          capacityBytes: () => Number.MAX_SAFE_INTEGER,
        }),
        resourcePressure: { shouldRun: async () => false, shouldRunHeavy: async () => false },
        logger: { log() {} },
      });
      expect((await server.app.request("/healthz")).status).toBe(200);
      expect(
        (await server.app.request("/portal/api/requests/source-b", { headers: headers("b") }))
          .status,
      ).toBe(503);
      const ordinary = await server.app.request("/v1/chat/completions", {
        method: "POST",
        headers: headers("b"),
        body: JSON.stringify(sourceBody),
      });
      expect(ordinary.status).toBe(200);
      await ordinary.text();
    } finally {
      Object.defineProperty(SqliteConfigStore.prototype, "compareAndSet", descriptor);
    }
  } finally {
    releaseHold?.();
    await server?.dispose?.();
    db.$sqlite.close();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    await rm(dir, { recursive: true, force: true });
  }
}, 60000);
