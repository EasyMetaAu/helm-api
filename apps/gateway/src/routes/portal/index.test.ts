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
        bytes: Buffer.from(
          JSON.stringify({ [part === "upstream_request" ? "input" : "body"]: `of ${part}` }),
        ),
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
  extra: Partial<PortalApiDeps> = {},
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
    ...extra,
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
      expect(body).not.toContain("SECRET_ACCT");
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
    revision.responseJson =
      '{"error":{"message":"owner@gmail.com rejected","codex_installation_id":"PRIVATE"}}';
    for (const path of ["session-revisions", "payload?part=response"]) {
      const response = await app.request(`/portal/api/requests/trace_1/${path}`, { headers: AUTH });
      expect(await response.text()).not.toMatch(/gmail.com|PRIVATE/);
    }
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

describe("portal debug API security", () => {
  it("pseudonymizes accounts consistently and allow-lists error diagnostics", async () => {
    const rec = decision({ codex_installation_id: "installation-private" });
    rec.serving_account = {
      provider_id: "claude",
      account: "owner@gmail.com",
      selection: {
        strategy: "balanced",
        reason: "strategy",
        captured_at_ms: 10,
        omitted_candidates: 0,
        candidates: ["owner@gmail.com", "other@gmail.com"].map((account) => ({
          account,
          selected: account.startsWith("owner"),
          priority: 2,
          exclusion: null,
          quota_fresh: true,
          quota_pressure: 0.5,
          expiring_value: null,
          next_reset_ms: null,
          ttft_ms: 100,
          tokens_per_second: 30,
        })),
      },
    };
    rec.provider_attempts[0]!.error_detail = {
      upstream_status: 429,
      message: "owner@gmail.com exhausted",
      provider_raw: { error: "quota" },
      stack: "private stack",
      cause: { internal: true },
      provider_headers: {
        "X-Request-Id": "req-upstream",
        "cf-ray": "ray",
        "retry-after": "10",
        "anthropic-ratelimit-tokens-remaining": "0",
        "x-ratelimit-limit-requests": "60",
        "openai-organization": "private-org",
        "set-cookie": "private-cookie",
      },
    };
    rec.final.error_detail = rec.provider_attempts[0]!.error_detail;
    const app = buildApp(record(), telemetry({ getByRequestId: async () => rec }));
    const read = async () =>
      (await app.request("/portal/api/requests/trace_1", { headers: AUTH })).json() as Promise<{
        decision: DecisionRecord;
      }>;
    const a = await read();
    const b = await read();
    const account = a.decision.serving_account!;
    expect(account.account).toMatch(/^acct_[a-f0-9]{24}$/);
    expect(account.account).toBe(b.decision.serving_account!.account);
    expect(account.selection!.candidates[0]!.account).toBe(account.account);
    expect(account.selection!.candidates[1]!.account).not.toBe(account.account);
    expect(account.selection!.candidates[0]).toMatchObject({
      quota_pressure: 0.5,
      ttft_ms: 100,
      priority: 2,
    });
    for (const error of [
      a.decision.provider_attempts[0]!.error_detail,
      a.decision.final.error_detail,
    ]) {
      expect(error).not.toHaveProperty("stack");
      expect(error).not.toHaveProperty("cause");
      expect(error?.provider_headers).toEqual({
        "x-request-id": "req-upstream",
        "cf-ray": "ray",
        "retry-after": "10",
        "anthropic-ratelimit-tokens-remaining": "0",
        "x-ratelimit-limit-requests": "60",
      });
    }
    expect(JSON.stringify(a)).not.toMatch(
      /gmail|private-org|private-cookie|installation-private|codex_installation_id/,
    );
    expect(rec.serving_account.account).toBe("owner@gmail.com"); // admin/source unchanged
  });

  it("forwards classification filters with forced key scope and widens list diagnostics", async () => {
    const queryPage = vi.fn(telemetry().queryPage);
    const res = await buildApp(record(), telemetry({ queryPage })).request(
      "/portal/api/requests?lane=coding&decided_by=rules&key_id=k2",
      { headers: AUTH },
    );
    expect(queryPage).toHaveBeenCalledWith(
      expect.objectContaining({ apiKeyId: "k1", lane: "coding", decidedBy: "rules" }),
    );
    expect(((await res.json()) as { items: unknown[] }).items[0]).toMatchObject({
      decided_by: "rules",
      fallback_count: 0,
      stream_outcome: "completed",
      partial: false,
      serving_provider: "SECRET_PROVIDER",
      session_label: null,
    });
  });

  it("exposes cache series and prompt/completion model totals only for the caller", async () => {
    const aggregate = vi.fn(telemetry().aggregate);
    const res = await buildApp(record(), telemetry({ aggregate })).request(
      "/portal/api/usage/stats?key_id=k2",
      { headers: AUTH },
    );
    const body = (await res.json()) as { totals: unknown; series: unknown[]; by_model: unknown[] };
    expect(aggregate).toHaveBeenCalledWith(0, 10000, "day", 0, "k1");
    expect(body.totals).toMatchObject({
      error_count: 0,
      avg_latency_ms: 500,
      avg_tps: null,
      cache_hit_rate: 0,
    });
    expect(body.series[0]).toMatchObject({ cached_tokens: 0, cache_creation_tokens: 0 });
    expect(body.by_model[0]).toMatchObject({ prompt_tokens: 10, completion_tokens: 5 });
  });

  it("exposes the caller's read-only caps", async () => {
    const res = await buildApp(
      record({
        concurrency_limit: 3,
        allow_custom_model: true,
        allow_fast_mode: true,
        request_content_mode: "none",
      }),
    ).request("/portal/api/me?key_id=k2", { headers: AUTH });
    expect(await res.json()).toMatchObject({
      concurrency_limit: 3,
      allow_custom_model: true,
      allow_fast_mode: true,
      request_content: { mode: "none" },
    });
  });
});

describe("portal scoped debugging endpoints", () => {
  const ownedSession = {
    sessionRef: "sa",
    accountId: "acct",
    apiKeyId: "k1",
    source: "x-thread-id",
    externalSessionId: "my session",
    createdAt: new Date(0),
    lastSeenAt: new Date(0),
    headRequestId: "trace_1",
    revisionCount: 1,
    storedBytes: 10,
    eventHead: null,
  };
  it("resolves a session label within the caller key and decorates only owned sessions", async () => {
    const findSessionRefsForKey = vi.fn(async () => ["sa"]);
    const queryPage = vi.fn(async () => ({
      rows: [
        {
          record: decision({ session: { ref: "sa", source: "x-thread-id" } }),
          apiKeyId: "k1",
          createdAt: new Date(0),
        },
      ],
      total: 1,
    }));
    const tel = telemetry({
      findSessionRefsForKey,
      queryPage,
      listSessionsByRefs: async () => [ownedSession],
    });
    const app = buildApp(record(), tel);
    const body = (await (
      await app.request("/portal/api/requests?session=my%20session&key_id=k2", { headers: AUTH })
    ).json()) as { items: Array<{ session_label: string | null }> };
    expect(findSessionRefsForKey).toHaveBeenCalledWith("k1", "my session");
    expect(queryPage).toHaveBeenCalledWith(
      expect.objectContaining({ apiKeyId: "k1", sessionRefs: ["sa"] }),
    );
    expect(body.items[0]?.session_label).toBe("my session");
    tel.listSessionsByRefs = async () => [
      { ...ownedSession, apiKeyId: "k2", externalSessionId: "foreign" },
    ];
    expect(
      (
        (await (await app.request("/portal/api/requests", { headers: AUTH })).json()) as {
          items: Array<{ session_label: string | null }>;
        }
      ).items[0]?.session_label,
    ).toBeNull();
  });

  it("looks up unique client traces within the key, with typed missing, ambiguous and pending outcomes", async () => {
    const queryPage = vi.fn(async (q) => ({
      rows:
        q.traceId === "owned"
          ? [{ record: decision(), createdAt: new Date(0), apiKeyId: q.apiKeyId }]
          : [],
      total: q.traceId === "ambiguous" ? 2 : q.traceId === "owned" ? 1 : 0,
    }));
    const app = buildApp(
      record(),
      telemetry({ queryPage, getApiKeyId: async (id) => (id === "trace_1" ? "k1" : null) }),
      undefined,
      undefined,
      undefined,
      {
        pendingRequests: (key, q) =>
          key === "k1" && (q.traceId === "pending" || q.requestId === "pending") ? ["pending"] : [],
      },
    );
    const get = (id: string) =>
      app.request(`/portal/api/requests/by-trace/${id}`, { headers: AUTH });
    expect(((await (await get("owned")).json()) as { request_id: string }).request_id).toBe(
      "trace_1",
    );
    expect(queryPage).toHaveBeenCalledWith(
      expect.objectContaining({ apiKeyId: "k1", traceId: "owned", limit: 2 }),
    );
    const missing = await get("missing");
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: "request not found", code: "request_not_found" });
    expect(await (await get("foreign")).json()).toEqual({
      error: "request not found",
      code: "request_not_found",
    });
    expect((await get("ambiguous")).status).toBe(409);
    const pending = await get("pending");
    expect(pending.status).toBe(202);
    expect(await pending.json()).toEqual({
      status: "in_progress",
      request_id: "pending",
      phase: "telemetry_pending",
    });
    expect((await app.request("/portal/api/requests/pending", { headers: AUTH })).status).toBe(202);
  });

  it("forces memory account/project scope, including intentional shared projects", async () => {
    const getMemoryAdminStats = vi.fn(async (scope) => ({
      generatedAt: scope.now,
      scope,
      storage: {
        threads: 1,
        messages: 2,
        observations: 0,
        facts: 3,
        activeFacts: 2,
        reflections: 0,
        activeReflections: 0,
      },
      queue: {
        pending: 2,
        running: 3,
        done: 4,
        failed: 0,
        open: 5,
        staleRunning: 1,
        oldestPendingAt: null,
        oldestRunningAt: null,
        newestDoneAt: null,
        newestFailedAt: null,
        byType: [],
      },
      activity: {
        lastMessageAt: null,
        lastObservationAt: null,
        lastFactUpdatedAt: null,
        lastReflectionUpdatedAt: null,
      },
    }));
    for (const key of [record(), record({ key_id: "k2", memory_project_id: "shared" })]) {
      const app = buildApp(key, undefined, undefined, undefined, undefined, {
        memoryStore: { getMemoryAdminStats },
      });
      const res = await app.request(
        "/portal/api/memory/stats?account_id=foreign&project_id=foreign",
        { headers: AUTH },
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as { leases: unknown };
      expect(body.leases).toEqual({ running: 3, stale: 1 });
      expect(getMemoryAdminStats).toHaveBeenLastCalledWith({
        accountId: "acct",
        projectId: key.memory_project_id ?? key.key_id,
        now: new Date(10000),
      });
    }
  });

  it("normalizes malformed blob MIME and releases its response lease", async () => {
    const admission = createResponseWorkAdmission({
      capacityBytes: 8192,
      jsonAmplification: 1,
      minChargeBytes: 1,
    });
    const app = buildApp(
      record(),
      telemetry({
        hasPayloadBlobReference: async () => true,
        getPayloadBlob: async () => ({
          sha256: "a".repeat(64),
          bytes: Buffer.from("image"),
          mime: "image/png\r\nx-injected: bad",
        }),
      }),
      undefined,
      undefined,
      admission,
    );
    const res = await app.request(`/portal/api/requests/trace_1/payload-blobs/${"a".repeat(64)}`, {
      headers: AUTH,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/octet-stream");
    await res.text();
    expect(admission.reservedBytes).toBe(0);
  });
  it("serves proven owned blobs and returns identical 404s for missing, foreign and forged references", async () => {
    const sha = "a".repeat(64);
    const getPayloadBlob = vi.fn(async () => ({
      sha256: sha,
      bytes: Buffer.from("image"),
      mime: "image/png",
      size: 5,
      createdAt: new Date(0),
    }));
    const app = buildApp(
      record(),
      telemetry({
        getApiKeyId: async (id) => (id === "foreign" ? "k2" : id === "missing" ? null : "k1"),
        hasPayloadBlobReference: async (id) => id === "owned",
        getPayloadBlob,
      }),
    );
    const fetch = (id: string) =>
      app.request(`/portal/api/requests/${id}/payload-blobs/${sha}`, { headers: AUTH });
    const own = await fetch("owned");
    expect(own.status).toBe(200);
    expect(await own.text()).toBe("image");
    expect(own.headers.get("cache-control")).toBe("no-store");
    for (const id of ["foreign", "missing", "forged"]) {
      const res = await fetch(id);
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: "request not found", code: "request_not_found" });
    }
    expect(getPayloadBlob).toHaveBeenCalledTimes(1);
  });
});

describe("portal replay", () => {
  const token = "00000000-0000-4000-8000-000000000001";
  function fixture(key = record(), admission?: ResponseWorkAdmission) {
    let now = 10000;
    const expiry = new Map<string, number>();
    const state = new Map<string, string>();
    const configStore = {
      get: async (k: string) => state.get(k) ?? null,
      set: async (k: string, value: string) => {
        state.set(k, value);
      },
      compareAndSet: async (
        k: string,
        expected: string | null,
        value: string,
        expiresAt?: number,
      ) => {
        if ((state.get(k) ?? null) !== expected) return false;
        state.set(k, value);
        if (expiresAt !== undefined) expiry.set(k, expiresAt);
        return true;
      },
      deleteIfValue: async (k: string, expected: string) => {
        if (state.get(k) !== expected) return false;
        expiry.delete(k);
        return state.delete(k);
      },
      pruneExpired: async (time: number) => {
        for (const [k, until] of expiry)
          if (until <= time) {
            state.delete(k);
            expiry.delete(k);
          }
      },
      setIfMissingOrNumericLte: async (
        k: string,
        value: string,
        lte: number,
        expiresAt?: number,
      ) => {
        if (state.has(k) && Number(state.get(k)) > lte) return false;
        state.set(k, value);
        if (expiresAt !== undefined) expiry.set(k, expiresAt);
        return true;
      },
    };
    const sent: Request[] = [];
    const records = new Map([["trace_1", decision()]]);
    const tel = telemetry({
      getByRequestId: async (id) => records.get(id) ?? null,
      getApiKeyId: async (id) => (records.has(id) ? "k1" : null),
      getPayloadPartEncoded: async () => ({
        requestId: "trace_1",
        part: "request",
        codec: "raw",
        createdAt: new Date(0),
        bytes: Buffer.from(
          JSON.stringify({
            model: "auto",
            messages: [{ role: "user", content: "replay me" }],
            stream: true,
          }),
        ),
      }),
    });
    const app = buildApp(key, tel, undefined, undefined, admission, {
      now: () => now,
      keyStore: { updateKey: async () => {}, getById: async () => key },
      replay: { configStore, afterResponse: async () => {} },
    });
    app.post("/v1/chat/completions", async (c) => {
      sent.push(c.req.raw);
      expect(c.req.header("authorization")).toBe(AUTH.Authorization);
      expect((await c.req.json()).messages[0].content).toBe("replay me");
      const id = c.get("request_id");
      records.set(id, decision({ request_id: id }));
      return c.text("data: [DONE]\n\n", 200, { "content-type": "text/event-stream" });
    });
    const post = (id = "trace_1", idempotencyKey = token) =>
      app.request(`/portal/api/requests/${id}/replay`, {
        method: "POST",
        headers: { ...AUTH, "idempotency-key": idempotencyKey },
      });
    return {
      app,
      post,
      sent,
      configStore,
      records,
      tel,
      key,
      state,
      advance: (ms: number) => {
        now += ms;
      },
    };
  }
  it("dispatches the captured body with only caller credentials, records a new request and deduplicates", async () => {
    const f = fixture();
    const first = await f.post();
    expect(first.status).toBe(200);
    const body = (await first.json()) as { request_id: string };
    expect(body).toMatchObject({
      status: "recorded",
      source_request_id: "trace_1",
      upstream_status: 200,
    });
    expect(body.request_id).not.toBe("trace_1");
    expect(f.records.has(body.request_id)).toBe(true);
    const second = await f.post();
    expect(await second.json()).toEqual(body);
    expect(f.sent).toHaveLength(1);
    expect((await f.post("trace_1", "00000000-0000-4000-8000-000000000002")).status).toBe(429);
  });
  it("allows safe same-token retry after capacity rejection without a terminal receipt", async () => {
    const admission = createResponseWorkAdmission({
      capacityBytes: 8192,
      jsonAmplification: 1,
      minChargeBytes: 1,
    });
    const held = admission.acquire(8192);
    expect(held.ok).toBe(true);
    const f = fixture(record(), admission);
    const rejected = await f.post();
    expect(rejected.status).toBe(503);
    expect(await rejected.json()).toMatchObject({ code: "response_capacity" });
    expect(f.sent).toHaveLength(0);
    expect([...f.state.keys()].filter((k) => k.startsWith("portal.replay."))).toHaveLength(0);
    if (held.ok) held.lease.release();
    expect((await f.post()).status).toBe(200);
    expect(f.sent).toHaveLength(1);
  });
  it("keeps duplicate prevention for seven days then expires receipt and throttle rows", async () => {
    const f = fixture();
    const first = await (await f.post()).json();
    f.advance(7 * 86400_000 - 1);
    expect(await (await f.post()).json()).toEqual(first);
    expect(f.sent).toHaveLength(1);
    f.advance(1);
    expect((await f.post()).status).toBe(200);
    expect(f.sent).toHaveLength(2);
  });
  it("budgets every occurrence before restoring a repeated detached image", async () => {
    const f = fixture();
    const sha = "a".repeat(64);
    const json = JSON.stringify({
      model: "auto",
      messages: [
        {
          role: "user",
          content: Array.from({ length: 4 }, () => ({
            type: "image",
            source: { type: "base64", media_type: "image/png", data: `helm-blob:sha256:${sha}` },
          })),
        },
      ],
    });
    f.tel.getPayloadPartEncoded = async () => ({
      requestId: "trace_1",
      part: "request",
      codec: "raw",
      bytes: Buffer.from(json),
      createdAt: new Date(0),
    });
    f.tel.hasPayloadBlobReference = async () => true;
    const getPayloadBlob = vi.fn(async (_sha: string, maxBytes?: number) =>
      (maxBytes ?? Infinity) < 1024
        ? null
        : { sha256: sha, bytes: Buffer.alloc(1024), mime: "image/png" },
    );
    f.tel.getPayloadBlob = getPayloadBlob;
    const app = buildApp(
      record(),
      f.tel,
      undefined,
      undefined,
      createResponseWorkAdmission({
        capacityBytes: 65536,
        jsonAmplification: 1,
        minChargeBytes: 1,
      }),
      {
        keyStore: { updateKey: async () => {}, getById: async () => record() },
        replay: { configStore: f.configStore, afterResponse: async () => {} },
      },
    );
    const res = await app.request("/portal/api/requests/trace_1/replay", {
      method: "POST",
      headers: { ...AUTH, "idempotency-key": token },
    });
    expect(res.status).toBe(409);
    expect(getPayloadBlob.mock.calls[0]?.[1]).toBeLessThan(1024);
  });
  it("keeps idempotency receipts across route instances", async () => {
    const f = fixture();
    const first = await (await f.post()).json();
    const app = buildApp(record(), f.tel, undefined, undefined, undefined, {
      keyStore: { updateKey: async () => {}, getById: async () => record() },
      replay: { configStore: f.configStore, afterResponse: async () => {} },
    });
    const repeated = await app.request("/portal/api/requests/trace_1/replay", {
      method: "POST",
      headers: { ...AUTH, "idempotency-key": token },
    });
    expect(await repeated.json()).toEqual(first);
    expect(f.sent).toHaveLength(1);
  });
  it("reports expired unfinished receipts as unknown without sending again", async () => {
    const f = fixture();
    await f.post();
    for (const [key, value] of f.state)
      if (key.startsWith("portal.replay.receipt.")) {
        const receipt = JSON.parse(value);
        receipt.body.status = "in_progress";
        receipt.body.request_id = null;
        receipt.http_status = 202;
        receipt.started_at_ms = 10000;
        f.state.set(key, JSON.stringify(receipt));
      }
    const app = buildApp(record(), f.tel, undefined, undefined, undefined, {
      now: () => 1_000_000,
      keyStore: { updateKey: async () => {}, getById: async () => record() },
      replay: { configStore: f.configStore, afterResponse: async () => {} },
    });
    const response = await app.request("/portal/api/requests/trace_1/replay", {
      method: "POST",
      headers: { ...AUTH, "idempotency-key": token },
    });
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      status: "outcome_unknown",
      code: "replay_outcome_unknown",
    });
    expect(f.sent).toHaveLength(1);
  });
  it("replays Responses compact on its original operation", async () => {
    const f = fixture();
    f.records.set(
      "trace_1",
      decision({
        protocol: "openai_responses",
        policy: { matched_policy_id: null, reason: "responses_compact" },
        lane: { selected_lane: "responses_compact", candidate_chain: [] },
      }),
    );
    let compactCalls = 0;
    f.app.post("/v1/responses/compact", (c) => {
      compactCalls++;
      f.records.set(c.get("request_id"), decision({ request_id: c.get("request_id") }));
      return c.json({ output: [] });
    });
    const res = await f.post();
    expect(res.status).toBe(200);
    expect(compactCalls).toBe(1);
    expect(f.sent).toHaveLength(0);
  });
  it("rejects missing confirmation and isolates missing vs foreign requests", async () => {
    const f = fixture(record({ key_id: "k2" }));
    const foreign = await f.post();
    const missing = await f.post("missing");
    expect(foreign.status).toBe(404);
    expect(missing.status).toBe(404);
    expect(await foreign.json()).toEqual(await missing.json());
    expect(f.sent).toHaveLength(0);
    const own = fixture();
    expect((await own.post("trace_1", "")).status).toBe(400);
    expect(own.sent).toHaveLength(0);
  });
  it("rechecks fresh key state and never substitutes a root identity", async () => {
    const f = fixture();
    f.key.disabled = true;
    expect((await f.post()).status).toBe(401);
    expect(f.sent).toHaveLength(0);
    const rotated = fixture();
    rotated.key.hash = hashKey("rotated-secret");
    expect((await rotated.post()).status).toBe(401);
    expect(rotated.sent).toHaveLength(0);
  });
  it("rejects replay when the recorded request is metadata-only", async () => {
    const f = fixture();
    f.records.set("trace_1", decision({ request_content_mode: "none" }));
    expect((await f.post()).status).toBe(409);
    expect(f.sent).toHaveLength(0);
  });
});

it("removes generated identities from forwarded payload metadata and captured errors", async () => {
  const upstream = {
    messages: [{ role: "user", content: "my email user@example.com" }],
    client_metadata: { "x-codex-installation-id": "rebound-installation", other: "kept" },
    metadata: { user_id: '{"account_uuid":"upstream-account","session_id":"session"}' },
  };
  const tel = telemetry({
    getPayloadPartEncoded: async (_id, part) => ({
      requestId: "trace_1",
      part,
      codec: "raw",
      createdAt: new Date(0),
      bytes: Buffer.from(
        JSON.stringify(
          part === "upstream_request"
            ? upstream
            : {
                error: {
                  message: "owner@gmail.com exhausted",
                  stack: "PRIVATE",
                  provider_headers: { "openai-organization": "PRIVATE" },
                },
              },
        ),
      ),
    }),
  });
  const app = buildApp(record(), tel);
  for (const part of ["upstream_request", "response"]) {
    const res = await app.request(`/portal/api/requests/trace_1/payload?part=${part}`, {
      headers: { ...AUTH, Accept: "application/vnd.helm.payload" },
    });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toMatch(/rebound-installation|upstream-account|owner@gmail.com|PRIVATE/);
    expect(res.headers.get("x-helm-payload-projection")).toBe("portal");
    if (part === "upstream_request") expect(text).toContain("my email user@example.com");
  }
});

it("projects small chunked captures and rejects oversized ones before consuming chunks", async () => {
  let reads = 0;
  const json = 'event: error\ndata: {"error":{"message":"owner@gmail.com","stack":"PRIVATE"}}\n\n';
  let byteLength = Buffer.byteLength(json);
  const admission = createResponseWorkAdmission({
    capacityBytes: 65536,
    jsonAmplification: 1,
    minChargeBytes: 1,
  });
  const app = buildApp(
    record(),
    telemetry({
      getPayloadPartEncoded: async () => null,
      getPayloadPartStream: async (requestId, part) => ({
        requestId,
        part,
        createdAt: new Date(0),
        byteLength,
        stream: (async function* () {
          reads++;
          yield Buffer.from(json);
        })(),
      }),
    }),
    undefined,
    undefined,
    admission,
  );
  const read = () =>
    app.request("/portal/api/requests/trace_1/payload?part=response", {
      headers: { ...AUTH, Accept: "application/vnd.helm.payload" },
    });
  const response = await read();
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toBe("application/vnd.helm.payload");
  expect(await response.text()).not.toMatch(/gmail.com|PRIVATE/);
  expect(reads).toBe(1);
  expect(admission.reservedBytes).toBe(0);
  byteLength = 1_000_000;
  const tooLarge = await read();
  expect(await tooLarge.json()).toMatchObject({
    captured: false,
    reason: "payload_recovery_limited",
  });
  expect(reads).toBe(1);
  expect(admission.reservedBytes).toBe(0);
});

it("fails closed for owned decisions when durable pseudonyms are unavailable", async () => {
  const app = buildApp(
    record(),
    telemetry({ getApiKeyId: async (id) => (id === "trace_1" ? "k1" : null) }),
    undefined,
    undefined,
    undefined,
    { pseudonymSecret: null },
  );
  expect((await app.request("/portal/api/me", { headers: AUTH })).status).toBe(200);
  expect((await app.request("/portal/api/requests/trace_1", { headers: AUTH })).status).toBe(503);
  expect((await app.request("/portal/api/requests", { headers: AUTH })).status).toBe(503);
  expect((await app.request("/portal/api/requests/foreign", { headers: AUTH })).status).toBe(404);
});

it("limits memory stats to one scan per key per ten seconds", async () => {
  let now = 10000;
  const scan = vi.fn(async () => {
    throw new Error("store unavailable");
  });
  const key = record();
  const app = buildApp(key, undefined, undefined, undefined, undefined, {
    now: () => now,
    memoryStore: { getMemoryAdminStats: scan },
  });
  expect((await app.request("/portal/api/memory/stats", { headers: AUTH })).status).toBe(502);
  const second = await app.request("/portal/api/memory/stats?project_id=other", { headers: AUTH });
  expect(second.status).toBe(429);
  expect(second.headers.get("retry-after")).toBe("10");
  expect(scan).toHaveBeenCalledTimes(1);
  key.key_id = "k2";
  await app.request("/portal/api/memory/stats", { headers: AUTH });
  expect(scan).toHaveBeenCalledTimes(2);
  key.key_id = "k1";
  now += 10000;
  await app.request("/portal/api/memory/stats", { headers: AUTH });
  expect(scan).toHaveBeenCalledTimes(3);
});

it("holds no more than two blob response leases per key and releases on cancel", async () => {
  const admission = createResponseWorkAdmission({
    capacityBytes: 8192,
    jsonAmplification: 1,
    minChargeBytes: 1,
  });
  const tel = telemetry({
    hasPayloadBlobReference: async () => true,
    getPayloadBlob: async (sha256) => ({ sha256, bytes: Buffer.from("image"), mime: "image/png" }),
  });
  const app = buildApp(record(), tel, undefined, undefined, admission);
  const url = `/portal/api/requests/trace_1/payload-blobs/${"a".repeat(64)}`;
  const first = await app.request(url, { headers: AUTH });
  const second = await app.request(url, { headers: AUTH });
  expect(first.status).toBe(200);
  expect(second.status).toBe(200);
  expect((await app.request(url, { headers: AUTH })).status).toBe(429);
  await first.body?.cancel();
  const next = await app.request(url, { headers: AUTH });
  expect(next.status).toBe(200);
  await second.body?.cancel();
  await next.body?.cancel();
});
