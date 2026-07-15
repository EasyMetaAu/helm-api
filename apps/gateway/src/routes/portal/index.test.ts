import {
  type ApiKeyRecord,
  type DecisionRecord,
  hashKey,
  type RequestPayloadPartRecord,
  type TelemetryStore,
} from "@helm/core";
import { describe, expect, it, vi } from "vitest";
import { createApp } from "../../app.js";
import { authMiddleware } from "../../middleware/auth.js";
import { registerPortalApi } from "./index.js";

const AUTH = { Authorization: "Bearer helm_live_secret" } as const;
type MemoryPatch = {
  memoryMode?: "off" | "observe" | "inject";
  memoryProjectId?: string | null;
  memoryThreadSource?: "header" | "auto";
};

function record(overrides: Partial<ApiKeyRecord> = {}): ApiKeyRecord {
  return {
    key_id: "k1",
    hash: hashKey("helm_live_secret"),
    prefix: "helm_live_ab",
    account_id: "acct",
    role: "user",
    name: "my key",
    allowed_lanes: ["balanced", "coding"],
    allow_custom_model: false,
    blocked_models: null,
    allow_fast_mode: false,
    disabled: false,
    rate_limit_rpm: 60,
    rate_limit_tpm: null,
    budget_requests: null,
    budget_tokens: null,
    budget_spend_usd: 100,
    budget_window_seconds: 86_400,
    over_budget_behavior: "degrade",
    degrade_lane: null,
    concurrency_limit: null,
    memory_mode: "inject",
    memory_project_id: null,
    memory_thread_source: "header",
    ...overrides,
  };
}

function decision(overrides: Partial<DecisionRecord> = {}): DecisionRecord {
  return {
    request_id: "trace_1",
    trace_id: "trace_1",
    requested_model: "auto",
    protocol: "openai_chat",
    key_prefix: "helm_live_ab",
    classifier: {
      task_type: "coding",
      complexity: "high",
      confidence: 0.9,
      decided_by: "rules",
      rules_confidence: 0.9,
      eval_cache_hit: null,
      eval_model: "SECRET_EVAL",
      eval_latency_ms: null,
      fallback_reason: null,
      constraints: {},
      explanation: [],
    },
    policy: { matched_policy_id: null, reason: "" },
    lane: { selected_lane: "coding", candidate_chain: ["SECRET_ALIAS"] },
    provider_attempts: [
      {
        alias: "SECRET_ALIAS",
        skipped: false,
        skip_reason: null,
        status: "ok",
        error_class: null,
        latency_ms: 500,
        cost_usd: 0.02,
        error_detail: null,
        provider_name: "SECRET_PROVIDER",
        provider_model: "SECRET_WIRE",
      },
    ],
    final: {
      model_alias: "gpt-5.5",
      provider_model: "SECRET_WIRE",
      status: "ok",
      error_reason: null,
    },
    serving_account: { provider_id: "SECRET_PID", account: "SECRET_ACCT" },
    latency_total_ms: 500,
    fallback_count: 0,
    cost_breakdown: { eval_usd: null, completion_usd: 0.02, total_usd: 0.02 },
    memory: null,
    usage: {
      measurement: "reported",
      cost_basis: null,
      prompt_tokens: 10,
      completion_tokens: 5,
      cached_tokens: 0,
      cache_creation_tokens: 0,
      service_tier: null,
      inference_geo: null,
      cache_creation_5m_tokens: null,
      cache_creation_1h_tokens: null,
      audio_prompt_tokens: null,
      cached_audio_prompt_tokens: null,
      image_output_tokens: null,
      billed_cost_usd: null,
    },
    stream_outcome: "completed",
    generation_ms: 300,
    ...overrides,
  };
}

type PortalTelemetry = Pick<
  TelemetryStore,
  | "aggregate"
  | "queryPage"
  | "getByRequestId"
  | "getApiKeyId"
  | "getPayload"
  | "getPayloadMeta"
  | "getPayloadPart"
>;

function telemetry(over: Partial<PortalTelemetry> = {}): PortalTelemetry {
  return {
    async aggregate() {
      return {
        totals: {
          requests: 1,
          okCount: 1,
          errorCount: 0,
          totalCostUsd: 0.02,
          promptTokens: 10,
          completionTokens: 5,
          cachedTokens: 0,
          cacheCreationTokens: 0,
          avgLatencyMs: 500,
          avgTps: null,
        },
        series: [
          {
            bucketStartMs: 0,
            promptTokens: 10,
            completionTokens: 5,
            cachedTokens: 0,
            cacheCreationTokens: 0,
            requests: 1,
            costUsd: 0.02,
          },
        ],
        byModel: [
          {
            // Stored served_model is the internal WIRE model id (provider_model),
            // NOT the public alias — the portal must never leak this verbatim.
            servedModel: "SECRET_WIRE_MODEL",
            promptTokens: 10,
            completionTokens: 5,
            totalTokens: 15,
            requests: 1,
            costUsd: 0.02,
          },
        ],
      };
    },
    async queryPage(q) {
      return {
        rows: [{ record: decision(), createdAt: new Date(1000), apiKeyId: q.apiKeyId ?? "?" }],
        total: 1,
      };
    },
    async getByRequestId() {
      return decision();
    },
    async getApiKeyId() {
      return "k1";
    },
    async getPayload() {
      return {
        requestId: "trace_1",
        requestJson: '{"body":"of request"}',
        responseJson: '{"body":"of response"}',
        upstreamRequestJson: '{"body":"of upstream_request"}',
        createdAt: new Date(1000),
      };
    },
    async getPayloadMeta() {
      return {
        requestId: "trace_1",
        parts: { request: true, response: true, upstreamRequest: true },
        createdAt: new Date(1000),
      };
    },
    async getPayloadPart(_id, part): Promise<RequestPayloadPartRecord | null> {
      return {
        requestId: "trace_1",
        part,
        json: `{"body":"of ${part}"}`,
        createdAt: new Date(1000),
      };
    },
    ...over,
  };
}

function buildApp(
  rec: ApiKeyRecord | null,
  tel: PortalTelemetry = telemetry(),
  updateKey: (keyId: string, patch: MemoryPatch) => Promise<void> = vi.fn(async () => {}),
) {
  const getByHash = vi.fn().mockResolvedValue(rec);
  const app = createApp({ logger: { log: () => {} } });
  app.use("/portal/api/*", authMiddleware({ keyStore: { getByHash }, log: () => {} }));
  registerPortalApi(app, { telemetry: tel, keyStore: { updateKey }, now: () => 10_000 });
  return app;
}

describe("portal API", () => {
  it("all endpoints require API-key auth (401)", async () => {
    const app = buildApp(record());
    for (const path of [
      "/portal/api/me",
      "/portal/api/memory-settings",
      "/portal/api/usage/stats",
      "/portal/api/requests",
      "/portal/api/requests/trace_1",
      "/portal/api/requests/trace_1/payload?part=request",
    ]) {
      const res = await app.request(path);
      expect(res.status, path).toBe(401);
    }
  });

  describe("GET /portal/api/me", () => {
    it("projects the identity caps, never any secret / hash / plaintext", async () => {
      const res = await buildApp(record()).request("/portal/api/me", { headers: AUTH });
      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.key_prefix).toBe("helm_live_ab");
      expect(body.role).toBe("user");
      expect(body.allowed_lanes).toEqual(["balanced", "coding"]);
      expect((body.budget as Record<string, unknown>).spend_usd).toBe(100);
      expect((body.memory as Record<string, unknown>).mode).toBe("inject");
      expect((body.memory as Record<string, unknown>).thread_source).toBe("header");
      const serialized = JSON.stringify(body);
      expect(serialized).not.toContain(hashKey("helm_live_secret"));
      expect(serialized).not.toContain("helm_live_secret");
      expect(serialized.toLowerCase()).not.toContain("hash");
    });
  });

  describe("PATCH /portal/api/memory-settings", () => {
    it("updates only the authenticated key's memory defaults", async () => {
      const updateKey = vi.fn(async () => {});
      const res = await buildApp(record(), telemetry(), updateKey).request(
        "/portal/api/memory-settings",
        {
          method: "PATCH",
          headers: { ...AUTH, "content-type": "application/json" },
          body: JSON.stringify({
            memory_mode: "observe",
            memory_project_id: "project-a",
            memory_thread_source: "auto",
          }),
        },
      );

      expect(res.status).toBe(200);
      expect(updateKey).toHaveBeenCalledWith("k1", {
        memoryMode: "observe",
        memoryProjectId: "project-a",
        memoryThreadSource: "auto",
      });
      await expect(res.json()).resolves.toEqual({
        memory: {
          mode: "observe",
          project_id: "project-a",
          project_name: "project-a",
          thread_source: "auto",
        },
      });
    });

    it("clears the project and disables memory without accepting admin fields", async () => {
      const updateKey = vi.fn(async () => {});
      const app = buildApp(record(), telemetry(), updateKey);
      const ok = await app.request("/portal/api/memory-settings", {
        method: "PATCH",
        headers: { ...AUTH, "content-type": "application/json" },
        body: JSON.stringify({
          memory_mode: "off",
          memory_project_id: null,
          memory_thread_source: "header",
        }),
      });
      expect(ok.status).toBe(200);
      expect(updateKey).toHaveBeenCalledWith("k1", {
        memoryMode: "off",
        memoryProjectId: null,
        memoryThreadSource: "header",
      });

      const invalid = await app.request("/portal/api/memory-settings", {
        method: "PATCH",
        headers: { ...AUTH, "content-type": "application/json" },
        body: JSON.stringify({
          memory_mode: "inject",
          memory_project_id: null,
          memory_thread_source: "magic",
        }),
      });
      expect(invalid.status).toBe(400);
      expect(updateKey).toHaveBeenCalledTimes(1);

      const adminField = await app.request("/portal/api/memory-settings", {
        method: "PATCH",
        headers: { ...AUTH, "content-type": "application/json" },
        body: JSON.stringify({
          memory_mode: "inject",
          memory_project_id: null,
          memory_thread_source: "auto",
          allowed_lanes: ["premium"],
        }),
      });
      expect(adminField.status).toBe(400);
      expect(updateKey).toHaveBeenCalledTimes(1);
    });

    it("preserves the current thread source for an older portal request that omits it", async () => {
      const updateKey = vi.fn(async () => {});
      const res = await buildApp(
        record({ memory_thread_source: "header" }),
        telemetry(),
        updateKey,
      ).request("/portal/api/memory-settings", {
        method: "PATCH",
        headers: { ...AUTH, "content-type": "application/json" },
        body: JSON.stringify({ memory_mode: "observe", memory_project_id: null }),
      });
      expect(res.status).toBe(200);
      expect(updateKey).toHaveBeenCalledWith("k1", {
        memoryMode: "observe",
        memoryProjectId: null,
      });
      expect(await res.json()).toEqual({
        memory: {
          mode: "observe",
          project_id: "k1",
          project_name: null,
          thread_source: "header",
        },
      });
    });

    it("keeps the management-plane root key memory-inert", async () => {
      const updateKey = vi.fn(async () => {});
      const res = await buildApp(
        record({ role: "root", memory_mode: "off" }),
        telemetry(),
        updateKey,
      ).request("/portal/api/memory-settings", {
        method: "PATCH",
        headers: { ...AUTH, "content-type": "application/json" },
        body: JSON.stringify({
          memory_mode: "inject",
          memory_project_id: "root-project",
          memory_thread_source: "auto",
        }),
      });
      expect(res.status).toBe(403);
      expect(updateKey).not.toHaveBeenCalled();
    });
  });

  describe("GET /portal/api/usage/stats", () => {
    it("write-forces identity.keyId and透出 series + byModel + budget (R5)", async () => {
      const res = await buildApp(record()).request(
        "/portal/api/usage/stats?key_id=other&bucket=hour",
        { headers: AUTH },
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.api_key_id).toBe("k1");
      expect(Array.isArray(body.series)).toBe(true);
      expect(Array.isArray(body.by_model)).toBe(true);
      // budget cap echoed so the UI can render the "remaining" progress bar.
      expect((body.budget as Record<string, unknown>).spend_usd).toBe(100);
    });

    it("NEVER leaks the wire provider_model in by_model — no resolver → 'other' (原则6/R7)", async () => {
      const res = await buildApp(record()).request("/portal/api/usage/stats", { headers: AUTH });
      const body = await res.text();
      expect(body).not.toContain("SECRET_WIRE_MODEL");
      const parsed = JSON.parse(body) as { by_model: { model: string }[] };
      expect(parsed.by_model[0]?.model).toBe("other");
    });

    it("relabels by_model to the PUBLIC alias when a resolver is provided", async () => {
      const getByHash = vi.fn().mockResolvedValue(record());
      const app = createApp({ logger: { log: () => {} } });
      app.use("/portal/api/*", authMiddleware({ keyStore: { getByHash }, log: () => {} }));
      registerPortalApi(app, {
        keyStore: { updateKey: vi.fn(async () => {}) },
        telemetry: telemetry(),
        now: () => 10_000,
        resolveModelLabel: (wire: string) => (wire === "SECRET_WIRE_MODEL" ? "gpt-5.5" : null),
      });
      const body = await (await app.request("/portal/api/usage/stats", { headers: AUTH })).text();
      expect(body).not.toContain("SECRET_WIRE_MODEL");
      const parsed = JSON.parse(body) as { by_model: { model: string }[] };
      expect(parsed.by_model[0]?.model).toBe("gpt-5.5"); // public alias, not the wire id
    });

    it("MERGES by_model rows that resolve to the same label (no duplicate keys → SPA crash)", async () => {
      // Real production data has MANY distinct wire models that map to 'other'
      // (unmapped/retired ids). Without merging, the doughnut gets N same-named
      // slices → the keyed {#each} throws each_key_duplicate. Assert one row/label.
      const tel = telemetry({
        async aggregate() {
          const row = (servedModel: string | null, totalTokens: number, requests: number) => ({
            servedModel,
            promptTokens: totalTokens,
            completionTokens: 0,
            totalTokens,
            requests,
            costUsd: 0.01,
          });
          return {
            totals: {
              requests: 6,
              okCount: 6,
              errorCount: 0,
              totalCostUsd: 0.06,
              promptTokens: 60,
              completionTokens: 0,
              cachedTokens: 0,
              cacheCreationTokens: 0,
              avgLatencyMs: null,
              avgTps: null,
            },
            series: [],
            byModel: [
              row("WIRE_A", 30, 3), // → gpt-5.5
              row("UNMAPPED_1", 10, 1), // → other
              row("UNMAPPED_2", 15, 1), // → other
              row(null, 5, 1), // → other (unstamped)
            ],
          };
        },
      });
      const getByHash = vi.fn().mockResolvedValue(record());
      const app = createApp({ logger: { log: () => {} } });
      app.use("/portal/api/*", authMiddleware({ keyStore: { getByHash }, log: () => {} }));
      registerPortalApi(app, {
        keyStore: { updateKey: vi.fn(async () => {}) },
        telemetry: tel,
        now: () => 10_000,
        resolveModelLabel: (wire: string) => (wire === "WIRE_A" ? "gpt-5.5" : null),
      });
      const body = (await (
        await app.request("/portal/api/usage/stats", { headers: AUTH })
      ).json()) as {
        by_model: { model: string; total_tokens: number; requests: number }[];
      };
      const labels = body.by_model.map((m) => m.model);
      // Exactly one row per label — no duplicates.
      expect(new Set(labels).size).toBe(labels.length);
      const other = body.by_model.find((m) => m.model === "other");
      expect(other?.total_tokens).toBe(30); // 10 + 15 + 5 merged
      expect(other?.requests).toBe(3); // 1 + 1 + 1 merged
      // Ordered by total tokens desc: gpt-5.5 (30) ties other (30) — both present, unique.
      expect(labels).toContain("gpt-5.5");
      expect(labels).toContain("other");
    });
  });

  describe("GET /portal/api/requests", () => {
    it("write-forces apiKeyId scope, ignoring caller key_id (R5)", async () => {
      const seen: string[] = [];
      const tel = telemetry({
        async queryPage(q) {
          seen.push(q.apiKeyId ?? "MISSING");
          return { rows: [], total: 0 };
        },
      });
      const res = await buildApp(record(), tel).request(
        "/portal/api/requests?key_id=someone_else",
        { headers: AUTH },
      );
      expect(res.status).toBe(200);
      expect(seen).toEqual(["k1"]);
    });

    it("passes safe list filters while keeping apiKeyId server-scoped", async () => {
      const seen: unknown[] = [];
      const tel = telemetry({
        async queryPage(q) {
          seen.push(q);
          return { rows: [], total: 0 };
        },
      });
      const res = await buildApp(record(), tel).request(
        "/portal/api/requests?page=2&pageSize=25&start=100&end=200&status=error&model=sonnet&key_id=someone_else",
        { headers: AUTH },
      );
      expect(res.status).toBe(200);
      expect(seen).toEqual([
        expect.objectContaining({
          limit: 25,
          offset: 25,
          startMs: 100,
          endMs: 200,
          status: "error",
          model: "sonnet",
          apiKeyId: "k1",
        }),
      ]);
    });

    it("returns the portal-projected rows, never provider aliases (R7)", async () => {
      const res = await buildApp(record()).request("/portal/api/requests", { headers: AUTH });
      const body = await res.text();
      expect(body).not.toContain("SECRET_ALIAS");
      expect(body).not.toContain("SECRET_WIRE");
      expect(body).not.toContain("SECRET_EVAL");
    });
  });

  describe("GET /portal/api/requests/:traceId", () => {
    it("404s (not 403) when the trace belongs to another key (R1/R2)", async () => {
      const tel = telemetry({
        async getApiKeyId() {
          return "someone_else";
        },
      });
      const res = await buildApp(record(), tel).request("/portal/api/requests/trace_1", {
        headers: AUTH,
      });
      expect(res.status).toBe(404);
    });

    it("checks ownership BEFORE reading the record (R1)", async () => {
      const order: string[] = [];
      const tel = telemetry({
        async getApiKeyId() {
          order.push("owner");
          return "someone_else";
        },
        async getByRequestId() {
          order.push("read");
          return decision();
        },
      });
      const res = await buildApp(record(), tel).request("/portal/api/requests/trace_1", {
        headers: AUTH,
      });
      expect(res.status).toBe(404);
      expect(order).toEqual(["owner"]); // read never happened
    });

    it("returns the whitelist projection for an owned trace, no supply chain", async () => {
      const res = await buildApp(record()).request("/portal/api/requests/trace_1", {
        headers: AUTH,
      });
      expect(res.status).toBe(200);
      const body = await res.text();
      expect(JSON.parse(body).served_model).toBe("gpt-5.5");
      expect(body).not.toContain("SECRET_ALIAS");
      expect(body).not.toContain("SECRET_WIRE");
    });
  });

  describe("GET /portal/api/requests/:traceId/payload", () => {
    it("404s for another key's trace before reading payload (R1/R2)", async () => {
      const readParts: string[] = [];
      const tel = telemetry({
        async getApiKeyId() {
          return "someone_else";
        },
        async getPayloadPart(_id, part) {
          readParts.push(part);
          return null;
        },
      });
      const res = await buildApp(record(), tel).request(
        "/portal/api/requests/trace_1/payload?part=request",
        { headers: AUTH },
      );
      expect(res.status).toBe(404);
      expect(readParts).toEqual([]);
    });

    it("serves request + response parts", async () => {
      for (const part of ["request", "response"]) {
        const res = await buildApp(record()).request(
          `/portal/api/requests/trace_1/payload?part=${part}`,
          { headers: AUTH },
        );
        expect(res.status, part).toBe(200);
        expect(await res.text()).toContain(`of ${part}`);
      }
    });

    it("serves customer-safe payload metadata without revealing upstream availability", async () => {
      const res = await buildApp(record()).request(
        "/portal/api/requests/trace_1/payload?part=meta",
        { headers: AUTH },
      );
      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toEqual({
        captured: true,
        created_at: 1000,
        parts: { request: true, response: true },
      });
    });

    it("keeps the metadata whitelist when an adapter falls back to the full payload read", async () => {
      const tel = telemetry({ getPayloadMeta: undefined });
      const res = await buildApp(record(), tel).request(
        "/portal/api/requests/trace_1/payload?part=meta",
        { headers: AUTH },
      );
      expect(res.status).toBe(200);
      const body = await res.text();
      expect(JSON.parse(body).parts).toEqual({ request: true, response: true });
      expect(body).not.toContain("upstream");
    });

    it("checks ownership before reading payload metadata", async () => {
      const reads: string[] = [];
      const tel = telemetry({
        async getApiKeyId() {
          reads.push("owner");
          return "someone_else";
        },
        async getPayloadMeta() {
          reads.push("meta");
          return null;
        },
      });
      const res = await buildApp(record(), tel).request(
        "/portal/api/requests/trace_1/payload?part=meta",
        { headers: AUTH },
      );
      expect(res.status).toBe(404);
      expect(reads).toEqual(["owner"]);
    });

    it("REJECTS the upstream_request part — supply chain, admin-only (R7)", async () => {
      const readParts: string[] = [];
      const tel = telemetry({
        async getPayloadPart(_id, part) {
          readParts.push(part);
          return { requestId: "trace_1", part, json: "{}", createdAt: new Date() };
        },
      });
      const res = await buildApp(record(), tel).request(
        "/portal/api/requests/trace_1/payload?part=upstream_request",
        { headers: AUTH },
      );
      expect(res.status).toBe(400);
      // never even reached the store with an upstream read
      expect(readParts).toEqual([]);
    });
  });
});
