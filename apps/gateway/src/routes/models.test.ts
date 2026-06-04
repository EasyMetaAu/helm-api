import { type ApiKeyRecord, hashKey, parseLanesConfig } from "@helm/core";
import type { CatalogEntry, ModelsList } from "@helm/shared";
import { describe, expect, it, vi } from "vitest";
import { createApp } from "../app.js";
import { authMiddleware } from "../middleware/auth.js";
import { registerModelsRoute } from "./models.js";

const lanes = parseLanesConfig({
  economy: { primary: "deepseek/flash", fallback: ["balanced"] },
  balanced: { primary: "deepseek/pro", fallback: [] },
});

const catalog = new Map<string, CatalogEntry>([
  [
    "deepseek/pro",
    {
      modelKey: "deepseek/pro",
      capabilities: {
        supportsTools: true,
        supportsJsonMode: true,
        supportsVision: false,
        supportsStreaming: true,
        maxContextTokens: 128_000,
        maxOutputTokens: 8_000,
      },
      pricing: { inputPerMTokUsd: 0.5, outputPerMTokUsd: 1.5 },
      source: "override",
    },
  ],
]);

const providerAliases = ["deepseek/pro", "deepseek/flash"];

function record(overrides: Partial<ApiKeyRecord> = {}): ApiKeyRecord {
  return {
    key_id: "k1",
    hash: hashKey("helm_live_secret"),
    prefix: "helm_live_ab",
    account_id: "acct",
    role: "user",
    allowed_lanes: null,
    allow_custom_model: false,
    disabled: false,
    rate_limit_rpm: null,
    rate_limit_tpm: null,
    budget_requests: null,
    budget_tokens: null,
    budget_spend_usd: null,
    budget_window_seconds: null,
    over_budget_behavior: "degrade",
    degrade_lane: null,
    ...overrides,
  };
}

function buildApp(rec: ApiKeyRecord | null) {
  const getByHash = vi.fn().mockResolvedValue(rec);
  const app = createApp({ logger: { log: () => {} } });
  const auth = authMiddleware({ keyStore: { getByHash }, log: () => {} });
  app.use("/v1/models", auth);
  app.use("/v1/models/*", auth);
  registerModelsRoute(app, { lanes: () => lanes, catalog, providerAliases });
  return app;
}

const AUTH = { Authorization: "Bearer helm_live_secret" } as const;

describe("GET /v1/models", () => {
  it("requires auth: 401 without a key", async () => {
    const res = await buildApp(record()).request("/v1/models");
    expect(res.status).toBe(401);
    expect(((await res.json()) as Record<string, unknown>).error_class).toBe("auth_error");
  });

  it("normal key: lists lanes + auto only (no concrete aliases)", async () => {
    const res = await buildApp(record()).request("/v1/models", { headers: AUTH });
    expect(res.status).toBe(200);
    const body = (await res.json()) as ModelsList;
    expect(body.object).toBe("list");
    expect(body.data.map((m) => m.id)).toEqual(["economy", "balanced", "auto"]);
    expect(body.data.every((m) => m.type === "lane")).toBe(true);
  });

  it("allow_custom_model key: appends aliases with capabilities + pricing", async () => {
    const res = await buildApp(record({ allow_custom_model: true })).request("/v1/models", {
      headers: AUTH,
    });
    const body = (await res.json()) as ModelsList;
    const ids = body.data.map((m) => m.id);
    expect(ids).toContain("deepseek/pro");
    expect(ids).toContain("deepseek/flash");
    const pro = body.data.find((m) => m.id === "deepseek/pro");
    expect(pro?.type).toBe("model");
    expect(pro?.pricing?.inputPerMTokUsd).toBe(0.5);
    expect(pro?.lanes?.sort()).toEqual(["balanced", "economy"]);
  });

  it("retrieve: GET /v1/models/:id returns one model", async () => {
    const res = await buildApp(record()).request("/v1/models/balanced", { headers: AUTH });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { id: string }).id).toBe("balanced");
  });

  it("retrieve: unknown/forbidden id -> structured error (OpenAI envelope)", async () => {
    // A normal key cannot see concrete aliases, so this id is not in its listing.
    const res = await buildApp(record()).request("/v1/models/deepseek%2Fpro", { headers: AUTH });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { type: string; trace_id: string } };
    expect(body.error.trace_id.length).toBeGreaterThan(0);
  });
});
