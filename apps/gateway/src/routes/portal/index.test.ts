import {
  type ApiKeyRecord,
  createResponseWorkAdmission,
  type DecisionRecord,
  hashKey,
  type RequestPayloadPartRecord,
  type ResponseWorkAdmission,
} from "@helm/core";
import { describe, expect, it, vi } from "vitest";
import { createApp } from "../../app.js";
import { authMiddleware } from "../../middleware/auth.js";
import {
  type BodyMemoryAdmission,
  createBodyMemoryAdmission,
} from "../../runtime/memory-admission.js";
import { type PortalApiDeps, registerPortalApi } from "./index.js";

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
    request_content_mode: null,
    max_reasoning_effort: null,
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

type PortalTelemetry = PortalApiDeps["telemetry"];

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
    async getCreatedAt() {
      return new Date(1000);
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
    async getPayloadPartEncoded(_id, part) {
      return {
        requestId: "trace_1",
        part,
        bytes: Buffer.from(`{"body":"of ${part}"}`),
        codec: "raw",
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
  memoryAdmission?: BodyMemoryAdmission,
  responseWorkAdmission?: ResponseWorkAdmission,
) {
  const getByHash = vi.fn().mockResolvedValue(rec);
  const app = createApp({ logger: { log: () => {} } });
  app.use("/portal/api/*", authMiddleware({ keyStore: { getByHash }, log: () => {} }));
  registerPortalApi(app, {
    telemetry: tel,
    keyStore: { updateKey },
    now: () => 10_000,
    memoryAdmission,
    responseWorkAdmission,
  });
  return app;
}

describe("portal API", () => {
  it("includes the owned request's full decision trail", async () => {
    const res = await buildApp(record()).request("/portal/api/requests/trace_1", { headers: AUTH });
    const body = await res.json();
    expect(body).toMatchObject({
      decision: {
        request_id: "trace_1",
        classifier: decision().classifier,
        provider_attempts: decision().provider_attempts,
        cost_breakdown: decision().cost_breakdown,
      },
    });
  });

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

    it("returns the complete owned trail with request and client correlation ids", async () => {
      const tel = telemetry({
        async getByRequestId() {
          return decision({ request_id: "req_internal_1", trace_id: "client_trace_1" });
        },
      });
      const res = await buildApp(record(), tel).request("/portal/api/requests/req_internal_1", {
        headers: AUTH,
      });
      expect(res.status).toBe(200);
      const body = await res.text();
      expect(JSON.parse(body)).toMatchObject({
        request_id: "req_internal_1",
        trace_id: "client_trace_1",
        served_model: "gpt-5.5",
        created_at: 1000,
      });
      expect(body).toContain("SECRET_ALIAS");
      expect(body).toContain("SECRET_WIRE");
      expect(body).toContain("SECRET_PROVIDER");
      expect(body).toContain("SECRET_PID");
      expect(body).toContain("SECRET_ACCT");
    });

    it("retains legacy outcomes and includes full provider attempts in the owned decision", async () => {
      const tel = telemetry({
        async getByRequestId() {
          return decision({
            provider_attempts: [
              {
                alias: "SECRET_ALIAS",
                skipped: false,
                skip_reason: null,
                status: "error",
                error_class: "timeout",
                latency_ms: 800,
                cost_usd: null,
                error_detail: null,
                provider_name: "SECRET_PROVIDER",
                provider_model: "SECRET_WIRE",
              },
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
          });
        },
      });
      const res = await buildApp(record(), tel).request("/portal/api/requests/trace_1", {
        headers: AUTH,
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { attempts: unknown };
      expect(body.attempts).toEqual([
        { outcome: "timeout", latency_ms: 800 },
        { outcome: "success", latency_ms: 500 },
      ]);
      const serialized = JSON.stringify(body);
      expect(serialized).toContain("SECRET_ALIAS");
      expect(serialized).toContain("SECRET_PROVIDER");
      expect(serialized).toContain("SECRET_WIRE");
    });

    it("never returns another key's data even when both records share a request_id shape (cross-key isolation)", async () => {
      const tel = telemetry({
        async getApiKeyId() {
          return "some_other_key";
        },
        async getByRequestId() {
          return decision({ request_id: "trace_1" });
        },
      });
      const res = await buildApp(record(), tel).request("/portal/api/requests/trace_1", {
        headers: AUTH,
      });
      expect(res.status).toBe(404);
      const body = await res.text();
      expect(body).not.toContain("gpt-5.5");
      expect(body).not.toContain("coding");
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
          { headers: { ...AUTH, accept: "application/vnd.helm.payload" } },
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
        source: "payload",
        exact: true,
        fidelity: "exact",
        created_at: 1000,
        parts: { request: true, response: true, upstream_request: true },
      });
    });

    it("fails closed instead of expanding legacy blobs when an adapter lacks metadata", async () => {
      const read = vi.fn();
      const res = await buildApp(
        record(),
        telemetry({ getPayloadMeta: undefined, getPayload: read }),
      ).request("/portal/api/requests/trace_1/payload?part=meta", { headers: AUTH });
      expect(await res.json()).toMatchObject({ captured: false });
      expect(read).not.toHaveBeenCalled();
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

    it("serves the owned upstream part using encoded transport without global blob expansion", async () => {
      const decode = vi.fn();
      const res = await buildApp(record(), telemetry({ getPayloadPart: decode })).request(
        "/portal/api/requests/trace_1/payload?part=upstream_request",
        { headers: { ...AUTH, accept: "application/vnd.helm.payload" } },
      );
      expect(res.status).toBe(200);
      expect(await res.text()).toContain("of upstream_request");
      expect(decode).not.toHaveBeenCalled();
    });
  });
});

it("accounts for portal bodies without adding a wire-size limit", async () => {
  let capacity = 0;
  const memoryAdmission = createBodyMemoryAdmission({
    activeRequestBytes: 1024,
    capacityBytes: () => capacity,
    jsonAmplification: 1,
    minRequestChargeBytes: 1,
  });
  const updateKey = vi.fn(async () => {});
  const app = buildApp(record(), undefined, updateKey, memoryAdmission);
  const request = {
    method: "PATCH",
    headers: AUTH,
    body: " ".repeat(256 * 1024) + JSON.stringify({ memory_mode: "off", memory_project_id: null }),
  };
  const denied = await app.request("/portal/api/memory-settings", request);
  expect(denied.status).toBe(503);
  expect(denied.headers.get("retry-after")).toBe("1");
  expect(updateKey).not.toHaveBeenCalled();
  expect(memoryAdmission.reservedBytes).toBe(0);
  capacity = 1024 * 1024;
  const accepted = await app.request("/portal/api/memory-settings", request);
  expect(accepted.status).toBe(200);
  expect(updateKey).toHaveBeenCalledTimes(1);
  expect(memoryAdmission.reservedBytes).toBe(0);
});

describe("Portal full-detail boundaries", () => {
  it.each([
    "request",
    "response",
    "upstream_request",
    "meta",
  ])("denies other keys before reading %s", async (part) => {
    const read = vi.fn();
    const app = buildApp(
      record(),
      telemetry({
        getApiKeyId: async () => "other",
        getByRequestId: read,
        getPayloadPartEncoded: read,
        getPayloadMeta: read,
      }),
    );
    expect(
      (await app.request(`/portal/api/requests/trace_1/payload?part=${part}`, { headers: AUTH }))
        .status,
    ).toBe(404);
    expect(read).not.toHaveBeenCalled();
  });
  it("does not expand arbitrary blob references through JSON parts or a global blob route", async () => {
    const decode = vi.fn();
    const app = buildApp(record(), telemetry({ getPayloadPart: decode, getPayload: decode }));
    const result = await app.request("/portal/api/requests/trace_1/payload?part=request", {
      headers: AUTH,
    });
    expect(result.status).toBe(406);
    expect(decode).not.toHaveBeenCalled();
    expect(
      (await app.request(`/portal/api/payload-blobs/${"a".repeat(64)}`, { headers: AUTH })).status,
    ).toBe(404);
  });
  it("preserves metadata-only even if old payload rows remain", async () => {
    const read = vi.fn();
    const app = buildApp(
      record(),
      telemetry({
        getByRequestId: async () => decision({ request_content_mode: "none" }),
        getPayloadPartEncoded: read,
        getPayloadMeta: read,
      }),
    );
    const result = await app.request("/portal/api/requests/trace_1/payload?part=request", {
      headers: AUTH,
    });
    expect(await result.json()).toMatchObject({ captured: false, reason: "metadata_only" });
    expect(read).not.toHaveBeenCalled();
  });
  it("redacts credential-bearing error fields while retaining upstream status", async () => {
    const rec = decision();
    rec.provider_attempts[0]!.error_detail = {
      upstream_status: 401,
      message: "rejected",
      provider_raw: {
        error: { code: "auth_failed" },
        api_key: "NEVER_SHOW_KEY",
        authorization: "Bearer NEVER_SHOW_TOKEN",
      },
    };
    const result = await buildApp(record(), telemetry({ getByRequestId: async () => rec })).request(
      "/portal/api/requests/trace_1",
      { headers: AUTH },
    );
    const body = await result.text();
    expect(body).toContain('"upstream_status":401');
    expect(body).not.toContain("NEVER_SHOW");
  });
  it("denies session reads if an owned trace references another key's session", async () => {
    const read = vi.fn();
    const app = buildApp(
      record(),
      telemetry({
        getByRequestId: async () =>
          decision({ session: { ref: "foreign", source: "x-thread-id" } }),
        getSessionByRef: async () => ({
          sessionRef: "foreign",
          apiKeyId: "other",
          accountId: "acct",
          source: "x-thread-id",
          externalSessionId: "same-label",
          createdAt: new Date(),
          lastSeenAt: new Date(),
          headRequestId: null,
          revisionCount: 1,
          storedBytes: 1,
          eventHead: null,
        }),
        streamSessionRevisionsPage: read,
        getPayloadMeta: async () => null,
      }),
    );
    for (const path of ["session-revisions"])
      expect(
        (await app.request(`/portal/api/requests/trace_1/${path}`, { headers: AUTH })).status,
      ).toBe(404);
    expect(read).not.toHaveBeenCalled();
  });
  it("recovers the owned session with fidelity and bounded revision pagination", async () => {
    const revision = {
      sessionRef: "mine",
      requestId: "trace_1",
      sequence: 1,
      parentRequestId: null,
      retainCount: 0,
      requestDeltaJson: '[{"role":"user","content":"hello"}]',
      requestEnvelopeJson: '{"model":"auto","messages":[]}',
      responseId: null,
      responseJson: '{"output":"answer"}',
      fidelity: "semantic",
      createdAt: new Date(1000),
    };
    const app = buildApp(
      record(),
      telemetry({
        getByRequestId: async () => decision({ session: { ref: "mine", source: "x-thread-id" } }),
        getSessionByRef: async () => ({
          sessionRef: "mine",
          apiKeyId: "k1",
          accountId: "acct",
          source: "x-thread-id",
          externalSessionId: "same-label",
          createdAt: new Date(),
          lastSeenAt: new Date(),
          headRequestId: "trace_1",
          revisionCount: 1,
          storedBytes: 100,
          eventHead: null,
        }),
        getPayloadMeta: async () => null,
        getPayloadPartEncoded: async () => null,
        listSessionRevisionsPage: async () => ({
          revisions: [revision],
          nextSequence: null,
          limited: false,
        }),
        streamSessionRevisionsPage: async () => ({
          revisions: [revision],
          nextSequence: null,
          limited: false,
        }),
      }),
    );
    const payload = await app.request("/portal/api/requests/trace_1/payload?part=request", {
      headers: AUTH,
    });
    expect(await payload.json()).toMatchObject({
      captured: true,
      source: "session",
      exact: false,
      value: { messages: [{ role: "user", content: "hello" }] },
    });
    const page = await app.request("/portal/api/requests/trace_1/session-revisions", {
      headers: AUTH,
    });
    expect(await page.json()).toMatchObject({
      captured: true,
      targetRequestId: "trace_1",
      revisions: [{ requestId: "trace_1" }],
    });
  });
});

it("reads exact payloads with a session reference even when no session row was stored", async () => {
  const app = buildApp(
    record(),
    telemetry({
      getByRequestId: async () =>
        decision({ session: { ref: "not-stored", source: "x-thread-id" } }),
      getSessionByRef: async () => null,
    }),
  );
  const result = await app.request("/portal/api/requests/trace_1/payload?part=request", {
    headers: { ...AUTH, accept: "application/vnd.helm.payload" },
  });
  expect(result.status).toBe(200);
  expect(await result.text()).toContain("of request");
});
it("never falls through to global blob decoding when payload metadata appears between reads", async () => {
  const decode = vi.fn();
  let reads = 0;
  const app = buildApp(
    record(),
    telemetry({
      getPayloadMeta: async () =>
        ++reads === 1
          ? null
          : {
              requestId: "trace_1",
              parts: { request: true, response: false, upstreamRequest: false },
              createdAt: new Date(),
            },
      getPayloadPartEncoded: async () => null,
      getPayloadPart: decode,
      getPayload: decode,
    }),
  );
  await app.request("/portal/api/requests/trace_1/payload?part=request", { headers: AUTH });
  expect(decode).not.toHaveBeenCalled();
});
it("admits encoded payload reads before accessing stored bytes", async () => {
  const admission = createResponseWorkAdmission({
    capacityBytes: 1024,
    jsonAmplification: 1,
    minChargeBytes: 1,
  });
  const held = admission.acquire(1024);
  if (!held.ok) throw Error("fixture admission failed");
  const encoded = vi.fn();
  try {
    const app = buildApp(
      record(),
      telemetry({ getPayloadPartEncoded: encoded }),
      undefined,
      undefined,
      admission,
    );
    const result = await app.request("/portal/api/requests/trace_1/payload?part=request", {
      headers: { ...AUTH, accept: "application/vnd.helm.payload" },
    });
    expect(await result.json()).toMatchObject({
      captured: false,
      reason: "payload_recovery_limited",
    });
    expect(encoded).not.toHaveBeenCalled();
  } finally {
    held.lease.release();
  }
});

it("releases the encoded response budget after the body is consumed", async () => {
  const admission = createResponseWorkAdmission({
    capacityBytes: 4096,
    jsonAmplification: 1,
    minChargeBytes: 1,
  });
  const app = buildApp(record(), telemetry(), undefined, undefined, admission);
  const result = await app.request("/portal/api/requests/trace_1/payload?part=request", {
    headers: { ...AUTH, accept: "application/vnd.helm.payload" },
  });
  expect(result.status).toBe(200);
  expect(admission.reservedBytes).toBeGreaterThan(0);
  await result.arrayBuffer();
  expect(admission.reservedBytes).toBe(0);
});
