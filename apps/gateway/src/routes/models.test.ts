import {
  type ApiKeyRecord,
  type CodexModelInfo,
  hashKey,
  type OpenAICodexModelsResult,
  parseLanesConfig,
} from "@helm/core";
import type { CatalogEntry, ModelsList } from "@helm/shared";
import { describe, expect, it, vi } from "vitest";
import { createApp } from "../app.js";
import { authMiddleware } from "../middleware/auth.js";
import { type ModelsRouteDeps, registerModelsRoute } from "./models.js";

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
        jsonOutput: "schema",
        supportsVision: false,
        supportsStreaming: true,
        maxContextTokens: 128_000,
        maxOutputTokens: 8_000,
      },
      pricing: {
        inputPerMTokUsd: 0.5,
        outputPerMTokUsd: 1.5,
        cacheReadPerMTokUsd: null,
        cacheWritePerMTokUsd: null,
      },
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

function buildApp(
  rec: ApiKeyRecord | null,
  oauthAliases?: () => Iterable<string>,
  lanesThunk: () => typeof lanes = () => lanes,
  codexModels?: ModelsRouteDeps["codexModels"],
  onCodexModelsListed?: (keyId: string, clientVersion: string, etag: string) => void,
) {
  const getByHash = vi.fn().mockResolvedValue(rec);
  const app = createApp({ logger: { log: () => {} } });
  const auth = authMiddleware({ keyStore: { getByHash }, log: () => {} });
  app.use("/v1/models", auth);
  app.use("/v1/models/*", auth);
  registerModelsRoute(app, {
    lanes: lanesThunk,
    catalog,
    providerAliases,
    oauthAliases,
    codexModels,
    onCodexModelsListed,
  });
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

  it("keeps null and empty allowed_lanes in separate cache buckets", async () => {
    const unrestrictedSecret = "helm_live_unrestricted";
    const deniedSecret = "helm_live_denied";
    const unrestricted = record({
      key_id: "free",
      hash: hashKey(unrestrictedSecret),
      allowed_lanes: null,
    });
    const denied = record({ key_id: "denied", hash: hashKey(deniedSecret), allowed_lanes: [] });
    const getByHash = vi.fn(async (hash: string) => {
      if (hash === unrestricted.hash) return unrestricted;
      if (hash === denied.hash) return denied;
      return null;
    });
    const lanesSpy = vi.fn(() => lanes);
    const app = createApp({ logger: { log: () => {} } });
    app.use("/v1/models", authMiddleware({ keyStore: { getByHash }, log: () => {} }));
    registerModelsRoute(app, { lanes: lanesSpy, catalog, providerAliases });

    const free = (await (
      await app.request("/v1/models", {
        headers: { Authorization: `Bearer ${unrestrictedSecret}` },
      })
    ).json()) as ModelsList;
    const none = (await (
      await app.request("/v1/models", { headers: { Authorization: `Bearer ${deniedSecret}` } })
    ).json()) as ModelsList;

    expect(free.data.map((model) => model.id)).toEqual(["economy", "balanced", "auto"]);
    expect(none.data).toEqual([]);
    expect(lanesSpy).toHaveBeenCalledTimes(2);
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

  it("allow_custom_model key: hides blocked aliases from model discovery", async () => {
    const res = await buildApp(
      record({ allow_custom_model: true, blocked_models: ["deepseek/pro"] }),
    ).request("/v1/models", {
      headers: AUTH,
    });
    const body = (await res.json()) as ModelsList;
    const ids = body.data.map((m) => m.id);
    expect(ids).toContain("economy");
    expect(ids).not.toContain("balanced");
    expect(ids).toContain("deepseek/flash");
    expect(ids).not.toContain("deepseek/pro");
  });

  it("allow_custom_model key: includes live subscription (OAuth) aliases", async () => {
    // Real subscription alias shape: `<providerId>/<model>` where providerId can
    // contain a hyphen (ROUTABLE_OAUTH keys, e.g. `openai-codex`). owned_by must be
    // the FULL prefix before the first slash, not a truncation.
    const res = await buildApp(record({ allow_custom_model: true }), () => [
      "openai-codex/gpt-5.6-sol",
      "deepseek/pro", // overlaps a configured alias -> deduped, listed once
    ]).request("/v1/models", { headers: AUTH });
    const body = (await res.json()) as ModelsList;
    const ids = body.data.map((m) => m.id);
    expect(ids).toContain("openai-codex/gpt-5.6-sol");
    expect(ids.filter((id) => id === "deepseek/pro")).toHaveLength(1);
    const codex = body.data.find((m) => m.id === "openai-codex/gpt-5.6-sol");
    expect(codex?.type).toBe("model");
    expect(codex?.owned_by).toBe("openai-codex");
  });

  it("normal key: subscription aliases stay hidden (lane abstraction)", async () => {
    const res = await buildApp(record(), () => ["openai-codex/gpt-5.6-sol"]).request("/v1/models", {
      headers: AUTH,
    });
    const body = (await res.json()) as ModelsList;
    expect(body.data.map((m) => m.id)).toEqual(["economy", "balanced", "auto"]);
  });

  it("returns the Codex ModelInfo envelope and ETag when client_version is present", async () => {
    const codexModel = {
      slug: "gpt-5.6-sol",
      display_name: "GPT-5.6 Sol",
      priority: 1,
      use_responses_lite: true,
    } as CodexModelInfo;
    const codexModels = vi.fn(
      async (): Promise<OpenAICodexModelsResult> => ({
        models: [codexModel],
        etag: '"helm-codex-test"',
        reasoningIncluded: true,
      }),
    );
    const onCodexModelsListed = vi.fn();
    const app = buildApp(
      record({ allow_custom_model: true }),
      () => ["openai-codex/gpt-5.6-sol"],
      () => lanes,
      codexModels,
      onCodexModelsListed,
    );

    const res = await app.request("/v1/models?client_version=0.145.0", { headers: AUTH });

    expect(res.status).toBe(200);
    expect(res.headers.get("etag")).toBe('"helm-codex-test"');
    expect(res.headers.get("x-reasoning-included")).toBe("true");
    expect(await res.json()).toEqual({ models: [codexModel] });
    expect(codexModels).toHaveBeenCalledWith({
      clientVersion: "0.145.0",
      allowCustomModel: true,
      allowedLanes: null,
      blockedModels: null,
      signal: expect.any(AbortSignal),
    });
    expect(onCodexModelsListed).toHaveBeenCalledWith("k1", "0.145.0", '"helm-codex-test"');
  });

  it("omits x-reasoning-included unless native discovery explicitly enables it", async () => {
    const app = buildApp(
      record({ allow_custom_model: true }),
      undefined,
      () => lanes,
      () => ({
        models: [{ slug: "gpt-5.6-sol" } as CodexModelInfo],
        reasoningIncluded: false,
      }),
    );

    const res = await app.request("/v1/models?client_version=0.145.0", { headers: AUTH });

    expect(res.status).toBe(200);
    expect(res.headers.get("x-reasoning-included")).toBeNull();
  });

  it("normalizes prerelease client_version before discovery and ETag tracking", async () => {
    const codexModels = vi.fn(
      async (): Promise<OpenAICodexModelsResult> => ({
        models: [],
        etag: '"helm-codex-prerelease"',
      }),
    );
    const onCodexModelsListed = vi.fn();
    const app = buildApp(
      record({ allow_custom_model: true }),
      () => [],
      () => lanes,
      codexModels,
      onCodexModelsListed,
    );

    const res = await app.request("/v1/models?client_version=0.145.0-alpha.4", {
      headers: AUTH,
    });

    expect(res.status).toBe(200);
    expect(codexModels).toHaveBeenCalledWith(expect.objectContaining({ clientVersion: "0.145.0" }));
    expect(onCodexModelsListed).toHaveBeenCalledWith("k1", "0.145.0", '"helm-codex-prerelease"');
  });

  it("rejects an invalid client_version before model discovery", async () => {
    const codexModels = vi.fn();
    const app = buildApp(
      record({ allow_custom_model: true }),
      () => [],
      () => lanes,
      codexModels,
    );

    const res = await app.request("/v1/models?client_version=latest", { headers: AUTH });

    expect(res.status).toBe(400);
    expect(codexModels).not.toHaveBeenCalled();
  });

  it("passes key lane/model restrictions into native Codex discovery", async () => {
    const codexModels = vi.fn(
      (): OpenAICodexModelsResult => ({
        models: [],
      }),
    );
    const app = buildApp(
      record({
        allow_custom_model: true,
        allowed_lanes: ["economy"],
        blocked_models: ["openai-codex/gpt-5.6-sol"],
      }),
      () => ["openai-codex/gpt-5.6-sol"],
      () => lanes,
      codexModels,
    );

    const res = await app.request("/v1/models?client_version=0.145.0", { headers: AUTH });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ models: [] });
    expect(codexModels).toHaveBeenCalledWith({
      clientVersion: "0.145.0",
      allowCustomModel: true,
      allowedLanes: ["economy"],
      blockedModels: ["openai-codex/gpt-5.6-sol"],
      signal: expect.any(AbortSignal),
    });
  });

  it("propagates caller cancellation into native Codex discovery", async () => {
    const caller = new AbortController();
    let received: AbortSignal | undefined;
    const app = buildApp(
      record({ allow_custom_model: true }),
      undefined,
      () => lanes,
      (input) => {
        received = (input as { signal?: AbortSignal }).signal;
        return { models: [] };
      },
    );

    const response = await app.request("/v1/models?client_version=0.145.0", {
      headers: AUTH,
      signal: caller.signal,
    });
    caller.abort();

    expect(response.status).toBe(200);
    expect(received).toBeInstanceOf(AbortSignal);
    expect(received?.aborted).toBe(true);
  });

  it("keeps the native Codex envelope when no model is available to the key", async () => {
    const app = buildApp(
      record(),
      undefined,
      () => lanes,
      () => null,
    );

    const res = await app.request("/v1/models?client_version=0.145.0", { headers: AUTH });

    expect(res.status).toBe(200);
    expect(res.headers.get("etag")).toBeNull();
    expect(await res.json()).toEqual({ models: [] });
  });

  it("keeps the OpenAI model-list envelope when client_version is absent", async () => {
    const codexModels = vi.fn(
      (): OpenAICodexModelsResult => ({
        models: [{ slug: "gpt-5.6-sol" } as CodexModelInfo],
        etag: '"helm-codex-test"',
      }),
    );
    const res = await buildApp(
      record({ allow_custom_model: true }),
      undefined,
      () => lanes,
      codexModels,
    ).request("/v1/models", { headers: AUTH });

    expect(((await res.json()) as ModelsList).object).toBe("list");
    expect(codexModels).not.toHaveBeenCalled();
  });

  it("retrieve: GET /v1/models/:id returns one model", async () => {
    const res = await buildApp(record()).request("/v1/models/balanced", { headers: AUTH });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { id: string }).id).toBe("balanced");
  });

  it("caches the listing per caps within TTL (rebuild skipped on repeat hits)", async () => {
    // A misbehaving client hammering /v1/models must not re-run buildModelsList each
    // time. Probe via the lanes thunk: cache hits never touch it.
    const lanesSpy = vi.fn(() => lanes);
    const app = buildApp(record(), undefined, lanesSpy);
    for (let i = 0; i < 5; i++) {
      const res = await app.request("/v1/models", { headers: AUTH });
      expect(res.status).toBe(200);
    }
    expect(lanesSpy).toHaveBeenCalledTimes(1);
  });

  it("retrieve: unknown/forbidden id -> structured error (OpenAI envelope)", async () => {
    // A normal key cannot see concrete aliases, so this id is not in its listing.
    const res = await buildApp(record()).request("/v1/models/deepseek%2Fpro", { headers: AUTH });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { type: string; trace_id: string } };
    expect(body.error.trace_id.length).toBeGreaterThan(0);
  });
});
