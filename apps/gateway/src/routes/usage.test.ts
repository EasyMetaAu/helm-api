import { type ApiKeyRecord, hashKey, type TelemetryStore } from "@helm/core";
import { describe, expect, it, vi } from "vitest";
import { createApp } from "../app.js";
import { authMiddleware } from "../middleware/auth.js";
import { registerUsageStatsRoute } from "./usage.js";

const AUTH = { Authorization: "Bearer helm_live_secret" } as const;

function record(overrides: Partial<ApiKeyRecord> = {}): ApiKeyRecord {
  return {
    key_id: "k1",
    hash: hashKey("helm_live_secret"),
    prefix: "helm_live_ab",
    account_id: "acct",
    role: "user",
    name: null,
    allowed_lanes: null,
    allow_custom_model: false,
    blocked_models: null,
    allow_fast_mode: false,
    disabled: false,
    rate_limit_rpm: null,
    rate_limit_tpm: null,
    budget_requests: null,
    budget_tokens: null,
    budget_spend_usd: null,
    budget_window_seconds: null,
    over_budget_behavior: "degrade",
    degrade_lane: null,
    concurrency_limit: null,
    memory_mode: "off" as const,
    memory_project_id: null,
    memory_thread_source: "header" as const,
    request_content_mode: null,
    ...overrides,
  };
}

type AggregateCall = {
  start: number;
  end: number;
  bucket: "hour" | "day";
  tzOffsetMinutes: number;
  keyId?: string;
};

function statsTelemetry(calls: AggregateCall[]): Pick<TelemetryStore, "aggregate"> {
  return {
    async aggregate(start, end, bucket, tzOffsetMinutes = 0, keyId) {
      calls.push({ start, end, bucket, tzOffsetMinutes, keyId });
      return {
        totals: {
          requests: 3,
          okCount: 2,
          errorCount: 1,
          totalCostUsd: 12.34,
          promptTokens: 1_000,
          completionTokens: 250,
          cachedTokens: 40,
          cacheCreationTokens: 9,
          avgLatencyMs: null,
          avgTps: null,
        },
        series: [],
        byModel: [],
      };
    },
  };
}

function buildApp(rec: ApiKeyRecord | null, calls: AggregateCall[] = [], now = () => 10_000) {
  const getByHash = vi.fn().mockResolvedValue(rec);
  const app = createApp({ logger: { log: () => {} } });
  app.use("/v1/usage/*", authMiddleware({ keyStore: { getByHash }, log: () => {} }));
  registerUsageStatsRoute(app, { telemetry: statsTelemetry(calls), now });
  return app;
}

describe("GET /v1/usage/stats", () => {
  it("requires API-key auth", async () => {
    const res = await buildApp(record()).request("/v1/usage/stats");
    expect(res.status).toBe(401);
    expect(((await res.json()) as Record<string, unknown>).error_class).toBe("auth_error");
  });

  it("returns compact cumulative usage totals for the authenticated key", async () => {
    const calls: AggregateCall[] = [];
    const res = await buildApp(record(), calls).request("/v1/usage/stats?end=2000", {
      headers: AUTH,
    });
    expect(res.status).toBe(200);
    expect(calls).toEqual([
      { start: 0, end: 2000, bucket: "day", tzOffsetMinutes: 0, keyId: "k1" },
    ]);
    expect(await res.json()).toEqual({
      object: "usage_stats",
      api_key_id: "k1",
      range: {
        start_ms: 0,
        end_ms: 2000,
        bucket: "day",
        tz_offset_minutes: 0,
      },
      totals: {
        requests: 3,
        ok_count: 2,
        error_count: 1,
        prompt_tokens: 1_000,
        completion_tokens: 250,
        total_tokens: 1_250,
        cached_tokens: 40,
        cache_creation_tokens: 9,
        cost_usd: 12.34,
      },
    });
  });

  it("ignores caller-supplied key_id and fails open on malformed query params", async () => {
    const calls: AggregateCall[] = [];
    const res = await buildApp(record(), calls, () => 12_345).request(
      "/v1/usage/stats?key_id=other&start=-9&bucket=decade&tzOffsetMinutes=banana",
      { headers: AUTH },
    );
    expect(res.status).toBe(200);
    expect(calls).toEqual([
      { start: 0, end: 12_345, bucket: "day", tzOffsetMinutes: 0, keyId: "k1" },
    ]);
  });
});
