import type {
  CreateKeyInput,
  KeyStore,
  Lane,
  PoliciesConfig,
  SessionRevisionRecord,
  TelemetryStore,
} from "@helm/core";
import { DEFAULT_LANES, parseLanesConfig } from "@helm/core";
import type { ApiKeyRecord, ClassifierConfig, DecisionRecord, RuntimeSettings } from "@helm/shared";
import { ClassifierConfigSchema, RuntimeSettingsSchema } from "@helm/shared";
import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppEnv } from "../../app.js";
import { basicAuth } from "../../middleware/basic-auth.js";
import { handleError } from "../../middleware/error-handler.js";
import type { AdminApiDeps, RuleStore, SettingsAccess } from "./deps.js";
import { registerAdminApi } from "./index.js";
import { createRuntimeRuleStore } from "./rule-store.js";

// admin.api — the gateway management API. These tests pin the CONTRACT (DoD
// scenarios 1-8): CRUD lanes/policies/classifier persist to config; keys/requests
// persist to the Store; invalid input -> 400 with nothing written; keys never echo
// plaintext/full hash; revocation does not rewrite in place; requests are read-only
// and include trace_id; all endpoints behind basicAuth.

// ── In-memory fakes (no IO; routes are pure glue) ────────────────────────────

// In-memory settings seam: validates+persists into a closure, mirroring server.ts.
function makeSettings(): SettingsAccess {
  let current: RuntimeSettings = RuntimeSettingsSchema.parse({});
  return {
    get: () => current,
    save: async (next) => {
      current = RuntimeSettingsSchema.parse(next);
      return current;
    },
  };
}

function makeRuleStore(): RuleStore {
  // Seed with the checked-in defaults so reads have a baseline.
  let lanes: Record<string, Lane> = structuredClone(parseLanesConfig(DEFAULT_LANES)) as Record<
    string,
    Lane
  >;
  let policies: PoliciesConfig = { policies: [] };
  let classifier: ClassifierConfig = ClassifierConfigSchema.parse({});
  return {
    getLanes: async () => lanes,
    setLanes: async (l) => {
      lanes = l;
    },
    updateLanes: async (mutate) => {
      lanes = await mutate(lanes);
      return lanes;
    },
    getPolicies: async () => policies,
    setPolicies: async (p) => {
      policies = p;
    },
    updatePolicies: async (mutate) => {
      policies = await mutate(policies);
      return policies;
    },
    getClassifier: async () => classifier,
    setClassifier: async (c) => {
      classifier = c;
    },
  };
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function singleSessionRevisionPage(revisions: SessionRevisionRecord[]) {
  return async () => ({ revisions, nextSequence: null, limited: false });
}

type TestKeyRecord = ApiKeyRecord & { secret_enc: string | null };

function makeKeyStore(): KeyStore & { rows: TestKeyRecord[] } {
  const rows: TestKeyRecord[] = [];
  return {
    rows,
    async createKey(input: CreateKeyInput): Promise<ApiKeyRecord> {
      const rec: TestKeyRecord = {
        key_id: input.keyId,
        hash: input.hash,
        prefix: input.prefix,
        secret_enc: input.secretEnc ?? null,
        account_id: input.accountId,
        role: input.role,
        name: input.name ?? null,
        allowed_lanes: input.allowedLanes ?? null,
        allow_custom_model: input.allowCustomModel ?? false,
        blocked_models: input.blockedModels ?? null,
        allow_fast_mode: input.allowFastMode ?? false,
        disabled: false,
        rate_limit_rpm: input.rateLimitRpm ?? null,
        rate_limit_tpm: input.rateLimitTpm ?? null,
        budget_requests: input.budgetRequests ?? null,
        budget_tokens: input.budgetTokens ?? null,
        budget_spend_usd: input.budgetSpendUsd ?? null,
        budget_window_seconds: input.budgetWindowSeconds ?? null,
        over_budget_behavior: input.overBudgetBehavior ?? "degrade",
        degrade_lane: input.degradeLane ?? null,
        concurrency_limit: input.concurrencyLimit ?? null,
        memory_mode: input.memoryMode ?? "off",
        memory_project_id: input.memoryProjectId ?? null,
        memory_thread_source: input.memoryThreadSource ?? "auto",
      };
      rows.push(rec);
      return rec;
    },
    async getByHash(hash) {
      return rows.find((r) => r.hash === hash) ?? null;
    },
    async list() {
      return [...rows];
    },
    async disable(keyId) {
      const row = rows.find((r) => r.key_id === keyId);
      if (!row) throw new Error(`key not found: ${keyId}`);
      // Soft revoke: flip disabled ONLY, never rewrite other fields in place.
      row.disabled = true;
    },
    async deleteKey(keyId) {
      const idx = rows.findIndex((r) => r.key_id === keyId);
      if (idx === -1) throw new Error(`key not found: ${keyId}`);
      rows.splice(idx, 1);
    },
    async updateKey(keyId, patch) {
      const row = rows.find((r) => r.key_id === keyId);
      if (!row) throw new Error(`key not found: ${keyId}`);
      // PARTIAL: only supplied fields change; absent fields untouched (never role
      // or the immutable identity). null clears a cap/override.
      if (patch.name !== undefined) row.name = patch.name;
      if (patch.allowedLanes !== undefined) row.allowed_lanes = patch.allowedLanes;
      if (patch.allowCustomModel !== undefined) row.allow_custom_model = patch.allowCustomModel;
      if (patch.blockedModels !== undefined) row.blocked_models = patch.blockedModels;
      if (patch.allowFastMode !== undefined) row.allow_fast_mode = patch.allowFastMode;
      if (patch.rateLimitRpm !== undefined) row.rate_limit_rpm = patch.rateLimitRpm;
      if (patch.rateLimitTpm !== undefined) row.rate_limit_tpm = patch.rateLimitTpm;
      if (patch.budgetRequests !== undefined) row.budget_requests = patch.budgetRequests;
      if (patch.budgetTokens !== undefined) row.budget_tokens = patch.budgetTokens;
      if (patch.budgetSpendUsd !== undefined) row.budget_spend_usd = patch.budgetSpendUsd;
      if (patch.budgetWindowSeconds !== undefined)
        row.budget_window_seconds = patch.budgetWindowSeconds;
      if (patch.overBudgetBehavior !== undefined)
        row.over_budget_behavior = patch.overBudgetBehavior;
      if (patch.degradeLane !== undefined) row.degrade_lane = patch.degradeLane;
      if (patch.concurrencyLimit !== undefined) row.concurrency_limit = patch.concurrencyLimit;
      if (patch.memoryMode !== undefined) row.memory_mode = patch.memoryMode;
      if (patch.memoryProjectId !== undefined) row.memory_project_id = patch.memoryProjectId;
      if (patch.memoryThreadSource !== undefined)
        row.memory_thread_source = patch.memoryThreadSource;
    },
    async rotateKey(keyId, input) {
      const row = rows.find((r) => r.key_id === keyId);
      if (!row) throw new Error(`key not found: ${keyId}`);
      row.hash = input.hash;
      row.prefix = input.prefix;
      row.secret_enc = input.secretEnc ?? null;
    },
    async getSecretEnc(keyId) {
      const row = rows.find((r) => r.key_id === keyId);
      if (!row) throw new Error(`key not found: ${keyId}`);
      return row.secret_enc;
    },
  };
}

function makeTelemetry(seed: DecisionRecord[] = []): TelemetryStore {
  const rows = [...seed];
  return {
    async insert() {
      return { id: "x" };
    },
    async queryRecent(limit) {
      // Pair each seeded record with a deterministic timestamp so the route's
      // created_at projection is exercised (most-recent-first → descending ms).
      return rows
        .slice(0, limit)
        .map((record, i) => ({ record, createdAt: new Date(1_700_000_000_000 - i * 1000) }));
    },
    async queryPage(query) {
      // Faithful in-memory mirror of the SQL adapters so the route's filter +
      // pagination passthrough is exercised. Seed order is treated as most-recent
      // first (descending deterministic timestamps).
      const stamped = rows.map((record, i) => ({
        record,
        createdAt: new Date(1_700_000_000_000 - i * 1000),
        apiKeyId: "k1",
      }));
      const m = query.model?.toLowerCase();
      const matched = stamped.filter(({ record, createdAt }) => {
        const ms = createdAt.getTime();
        if (query.startMs !== undefined && ms < query.startMs) return false;
        if (query.endMs !== undefined && ms >= query.endMs) return false;
        if (query.status !== undefined && record.final.status !== query.status) return false;
        if (query.decidedBy !== undefined && record.classifier.decided_by !== query.decidedBy)
          return false;
        if (query.lane !== undefined && record.lane.selected_lane !== query.lane) return false;
        if (m !== undefined) {
          const hit =
            record.requested_model.toLowerCase().includes(m) ||
            (record.final.model_alias ?? "").toLowerCase().includes(m);
          if (!hit) return false;
        }
        return true;
      });
      return {
        rows: matched.slice(query.offset, query.offset + query.limit),
        total: matched.length,
      };
    },
    async getByRequestId(id) {
      return rows.find((r) => r.request_id === id) ?? null;
    },
    async getApiKeyId(id) {
      return rows.some((r) => r.request_id === id) ? "k1" : null;
    },
    async getCreatedAt(id) {
      // Mirror the deterministic per-row timestamp used by queryRecent/queryPage
      // so the detail route's created_at projection lines up with the list.
      const i = rows.findIndex((r) => r.request_id === id);
      return i >= 0 ? new Date(1_700_000_000_000 - i * 1000) : null;
    },
    async queryWindow() {
      return [...rows];
    },
    async aggregate() {
      return {
        totals: {
          requests: 0,
          okCount: 0,
          errorCount: 0,
          totalCostUsd: null,
          promptTokens: 0,
          completionTokens: 0,
          cachedTokens: 0,
          cacheCreationTokens: 0,
          avgLatencyMs: null,
          avgTps: null,
        },
        series: [],
        byModel: [],
      };
    },
    async usageByKey() {
      return [];
    },
    async insertPayload() {},
    async getPayload() {
      return null;
    },
    async prunePayloads() {},
  };
}

function decision(traceId: string, lane: string): DecisionRecord {
  return {
    request_id: traceId,
    trace_id: traceId,
    requested_model: "auto",
    protocol: "openai_chat",
    classifier: {
      task_type: "coding",
      complexity: "complex",
      confidence: 0.9,
      decided_by: "rules",
      rules_confidence: null,
      eval_cache_hit: null,
      eval_model: null,
      eval_latency_ms: null,
      constraints: {},
      explanation: [],
    },
    policy: { matched_policy_id: "policy[0]", reason: "matched" },
    lane: { selected_lane: lane, candidate_chain: [lane, "balanced"] },
    provider_attempts: [
      {
        alias: "best_reasoning_model",
        skipped: false,
        skip_reason: null,
        status: "ok",
        error_class: null,
        latency_ms: 12,
        cost_usd: 0.002,
        error_detail: null,
      },
    ],
    final: {
      model_alias: "best_reasoning_model",
      provider_model: "best_reasoning_model",
      status: "ok",
      error_reason: null,
    },
    key_prefix: null,
    latency_total_ms: 12,
    fallback_count: 0,
    cost_breakdown: { eval_usd: null, completion_usd: 0.002, total_usd: 0.002 },
    memory: null,
    usage: null,
    stream_outcome: null,
    generation_ms: null,
    serving_account: null,
  };
}

let keyStore: KeyStore & { rows: TestKeyRecord[] };
let rules: RuleStore;

function buildDeps(over: Partial<AdminApiDeps> = {}): AdminApiDeps {
  keyStore = makeKeyStore();
  rules = makeRuleStore();
  let n = 0;
  return {
    rules,
    keyStore,
    telemetry: makeTelemetry(),
    genKey: () => ({
      plaintext: "helm_live_PLAINTEXT_SECRET",
      hash: "hash_of_plaintext_full",
      prefix: "helm_live_PLAI",
    }),
    genKeyId: () => `key_${++n}`,
    keySecrets: {
      encrypt: (plaintext) => `enc:${Buffer.from(plaintext, "utf8").toString("base64")}`,
      decrypt: (blob) => Buffer.from(blob.slice("enc:".length), "base64").toString("utf8"),
    },
    accountId: "acct_default",
    modelAliases: () =>
      Promise.resolve(
        ["deepseek/deepseek-v4-flash", "deepseek/deepseek-v4-pro", "zenmux/auto"].map((alias) => ({
          alias,
          accounts: [],
        })),
      ),
    settings: makeSettings(),
    ...over,
  };
}

// Build an admin app. By default basicAuth is DISABLED (enabled:false passes
// through) so resource tests can hit endpoints without credentials; the auth
// isolation test enables it explicitly.
function buildApp(deps: AdminApiDeps, authEnabled = false) {
  const app = new Hono<AppEnv>();
  app.use(
    "/admin/api/*",
    basicAuth(
      authEnabled
        ? { enabled: true, username: "admin", password: "pw" }
        : { enabled: false, username: null, password: null },
    ),
  );
  registerAdminApi(app, deps);
  return app;
}

const JSON_HEADERS = { "Content-Type": "application/json" };

describe("admin.api lanes", () => {
  it("PUT then GET round-trips a lane to config (not DB)", async () => {
    const deps = buildDeps();
    const app = buildApp(deps);
    const body: Lane = {
      primary: "best_reasoning_model",
      fallback: ["balanced"],
      constraints: { require_tools: false, require_json: false, require_vision: false },
    };
    const put = await app.request("/admin/api/lanes/balanced", {
      method: "PUT",
      headers: JSON_HEADERS,
      body: JSON.stringify(body),
    });
    expect(put.status).toBe(200);

    const got = await app.request("/admin/api/lanes/balanced");
    expect(got.status).toBe(200);
    const lane = (await got.json()) as Lane;
    expect(lane.primary).toBe("best_reasoning_model");
    expect(lane.fallback).toEqual(["balanced"]);
    // Persisted via RuleStore (config), NOT the keyStore/telemetry.
    expect((await rules.getLanes()).balanced?.primary).toBe("best_reasoning_model");
  });

  it("GET /lanes lists all lanes", async () => {
    const app = buildApp(buildDeps());
    const res = await app.request("/admin/api/lanes");
    expect(res.status).toBe(200);
    const list = (await res.json()) as Array<{ name: string }>;
    const names = list.map((l) => l.name);
    expect(names).toContain("balanced");
  });

  it("PUT /lanes replaces the complete lane set atomically", async () => {
    const deps = buildDeps();
    const app = buildApp(deps);
    const current = await rules.getLanes();
    const body = {
      balanced: { ...current.balanced, primary: "new-balanced" },
      coding: { ...current.coding, primary: "new-coding" },
    };

    const res = await app.request("/admin/api/lanes", {
      method: "PUT",
      headers: JSON_HEADERS,
      body: JSON.stringify(body),
    });

    expect(res.status).toBe(200);
    const saved = await rules.getLanes();
    expect(Object.keys(saved)).toEqual(["balanced", "coding"]);
    expect(saved.balanced?.primary).toBe("new-balanced");
    expect(saved.coding?.primary).toBe("new-coding");
  });

  it("PUT /lanes rejects a complete set without runtime.default_lane and writes nothing", async () => {
    const deps = buildDeps();
    const app = buildApp(deps);
    const before = structuredClone(await rules.getLanes());

    const res = await app.request("/admin/api/lanes", {
      method: "PUT",
      headers: JSON_HEADERS,
      body: JSON.stringify({ economy: before.economy }),
    });

    expect(res.status).toBe(409);
    expect(await rules.getLanes()).toEqual(before);
  });

  it("rejects an invalid lane body with 400 and does not write", async () => {
    const deps = buildDeps();
    const app = buildApp(deps);
    const before = (await rules.getLanes()).balanced;
    const res = await app.request("/admin/api/lanes/balanced", {
      method: "PUT",
      headers: JSON_HEADERS,
      body: JSON.stringify({ primary: "" }), // empty primary -> invalid
    });
    expect(res.status).toBe(400);
    expect((await rules.getLanes()).balanced).toEqual(before);
  });

  it("serializes concurrent PUTs to different lanes so both edits survive", async () => {
    const firstPersist = deferred();
    let persistCalls = 0;
    const runtimeRules = createRuntimeRuleStore({
      lanes: structuredClone(parseLanesConfig(DEFAULT_LANES)) as Record<string, Lane>,
      policies: { policies: [] },
      classifier: ClassifierConfigSchema.parse({}),
      persistLanes: async () => {
        persistCalls += 1;
        if (persistCalls === 1) await firstPersist.promise;
      },
    });
    const app = buildApp(buildDeps({ rules: runtimeRules }));
    const initialLanes = await runtimeRules.getLanes();
    const balancedBase = initialLanes.balanced;
    const economyBase = initialLanes.economy;
    if (!balancedBase || !economyBase) throw new Error("default lanes missing test baseline");
    const balanced: Lane = {
      ...structuredClone(balancedBase),
      primary: "model-from-balanced-put",
    };
    const economy: Lane = {
      ...structuredClone(economyBase),
      primary: "model-from-economy-put",
    };

    const putBalanced = app.request("/admin/api/lanes/balanced", {
      method: "PUT",
      headers: JSON_HEADERS,
      body: JSON.stringify(balanced),
    });
    const putEconomy = app.request("/admin/api/lanes/economy", {
      method: "PUT",
      headers: JSON_HEADERS,
      body: JSON.stringify(economy),
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    firstPersist.resolve();

    const [balancedRes, economyRes] = await Promise.all([putBalanced, putEconomy]);
    expect([balancedRes.status, economyRes.status]).toEqual([200, 200]);
    const lanes = await runtimeRules.getLanes();
    expect(lanes.balanced?.primary).toBe("model-from-balanced-put");
    expect(lanes.economy?.primary).toBe("model-from-economy-put");
  });

  it("DELETE removes a lane", async () => {
    const app = buildApp(buildDeps());
    const res = await app.request("/admin/api/lanes/economy", { method: "DELETE" });
    expect(res.status).toBe(200);
    expect((await rules.getLanes()).economy).toBeUndefined();
  });

  it("refuses to DELETE the configured default lane (409) and writes nothing", async () => {
    const deps = buildDeps();
    const app = buildApp(deps);
    const before = await rules.getLanes();
    const res = await app.request("/admin/api/lanes/balanced", { method: "DELETE" });
    expect(res.status).toBe(409);
    expect(await rules.getLanes()).toEqual(before); // nothing written
    expect((await rules.getLanes()).balanced).toBeDefined();
  });

  it("allows deleting balanced after another lane becomes runtime.default_lane", async () => {
    const deps = buildDeps();
    await deps.settings.save({ ...deps.settings.get(), default_lane: "premium" });
    const app = buildApp(deps);

    const res = await app.request("/admin/api/lanes/balanced", { method: "DELETE" });

    expect(res.status).toBe(200);
    expect((await deps.rules.getLanes()).balanced).toBeUndefined();
    expect((await deps.rules.getLanes()).premium).toBeDefined();
  });
});

describe("admin.api models", () => {
  it("GET /models returns the injected model-option catalog as a JSON array", async () => {
    const options = [
      { alias: "zenmux/auto", accounts: [] },
      { alias: "anthropic/claude-opus-4-8", accounts: ["default", "work"] },
    ];
    const deps = buildDeps({ modelAliases: () => Promise.resolve(options) });
    const app = buildApp(deps);
    const res = await app.request("/admin/api/models");
    expect(res.status).toBe(200);
    const list = (await res.json()) as Array<{ alias: string; accounts: string[] }>;
    expect(list).toEqual(options);
  });

  it("is gated behind admin basicAuth like every sibling endpoint", async () => {
    const app = buildApp(buildDeps(), true);
    const res = await app.request("/admin/api/models");
    expect(res.status).toBe(401);
  });
});

describe("admin.api policies", () => {
  it("PUT then GET round-trips policies", async () => {
    const deps = buildDeps();
    const app = buildApp(deps);
    const policies = [
      { match: { task_type: "coding" }, use_lane: "premium" },
      { match: { complexity: "complex" }, allowed_lanes: ["economy", "balanced"] },
    ];
    const put = await app.request("/admin/api/policies", {
      method: "PUT",
      headers: JSON_HEADERS,
      body: JSON.stringify(policies),
    });
    expect(put.status).toBe(200);
    const got = await app.request("/admin/api/policies");
    const list = (await got.json()) as Array<{ use_lane?: string }>;
    expect(list).toHaveLength(2);
    expect(list[0]?.use_lane).toBe("premium");
  });

  it("rejects a policy with an unknown match field (400) and keeps config", async () => {
    const deps = buildDeps();
    const app = buildApp(deps);
    const before = await rules.getPolicies();
    const res = await app.request("/admin/api/policies", {
      method: "PUT",
      headers: JSON_HEADERS,
      body: JSON.stringify([{ match: { bogus_field: "x" }, use_lane: "premium" }]),
    });
    expect(res.status).toBe(400);
    expect(await rules.getPolicies()).toEqual(before);
  });

  it("DELETE by id removes a policy", async () => {
    const deps = buildDeps();
    const app = buildApp(deps);
    await app.request("/admin/api/policies", {
      method: "PUT",
      headers: JSON_HEADERS,
      body: JSON.stringify([{ id: "p1", match: { task_type: "coding" }, use_lane: "premium" }]),
    });
    const res = await app.request("/admin/api/policies/p1", { method: "DELETE" });
    expect(res.status).toBe(200);
    expect((await rules.getPolicies()).policies).toHaveLength(0);
  });

  it("DELETE returns 422 (not a silent 404) when no policy carries the given id", async () => {
    // id is optional in the schema; explicit-id DELETE cannot target an id-less
    // policy. Surface a clear 422 instead of a misleading 404 + no-op filter.
    const deps = buildDeps();
    const app = buildApp(deps);
    await app.request("/admin/api/policies", {
      method: "PUT",
      headers: JSON_HEADERS,
      body: JSON.stringify([{ match: { task_type: "coding" }, use_lane: "premium" }]),
    });
    const res = await app.request("/admin/api/policies/p1", { method: "DELETE" });
    expect(res.status).toBe(422);
    expect((await rules.getPolicies()).policies).toHaveLength(1); // unchanged
  });
});

describe("admin.api classifier", () => {
  it("PUT updates confidence_threshold + disables eval, GET reflects it", async () => {
    const deps = buildDeps();
    const app = buildApp(deps);
    const current = await rules.getClassifier();
    const next = structuredClone(current);
    next.rules.confidence_threshold = 0.7;
    next.eval.enabled = false;
    const put = await app.request("/admin/api/classifier", {
      method: "PUT",
      headers: JSON_HEADERS,
      body: JSON.stringify(next),
    });
    expect(put.status).toBe(200);
    const got = (await (await app.request("/admin/api/classifier")).json()) as ClassifierConfig;
    expect(got.rules.confidence_threshold).toBe(0.7);
    expect(got.eval.enabled).toBe(false);
  });

  it("rejects a wrong-shaped patch body with 400 instead of silently writing defaults", async () => {
    // Footgun guard (principle 2 fail-closed): a sparse/mis-keyed patch like
    // {eval_enabled, confidence_threshold} must NOT parse to an all-defaults
    // config and overwrite the live one — the strict full-replace schema rejects
    // it (unknown keys + missing rules/eval) and leaves config untouched.
    const deps = buildDeps();
    const app = buildApp(deps);
    const before = structuredClone(await rules.getClassifier());
    const res = await app.request("/admin/api/classifier", {
      method: "PUT",
      headers: JSON_HEADERS,
      body: JSON.stringify({ eval_enabled: true, confidence_threshold: 0.5 }),
    });
    expect(res.status).toBe(400);
    expect(await rules.getClassifier()).toEqual(before);
  });

  it("rejects an out-of-range confidence_threshold with 400", async () => {
    const deps = buildDeps();
    const app = buildApp(deps);
    const current = await rules.getClassifier();
    const before = structuredClone(current);
    const next = structuredClone(current) as unknown as { rules: { confidence_threshold: number } };
    next.rules.confidence_threshold = 5; // > 1 -> invalid
    const res = await app.request("/admin/api/classifier", {
      method: "PUT",
      headers: JSON_HEADERS,
      body: JSON.stringify(next),
    });
    expect(res.status).toBe(400);
    expect(await rules.getClassifier()).toEqual(before);
  });
});

describe("admin.api keys", () => {
  it("POST returns plaintext ONCE; GET list never exposes plaintext or hash", async () => {
    const deps = buildDeps();
    const app = buildApp(deps);
    const created = await app.request("/admin/api/keys", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({
        role: "user",
        allowed_lanes: ["balanced"],
        blocked_models: ["gpt-4o"],
      }),
    });
    expect(created.status).toBe(201);
    const body = (await created.json()) as { key_id: string; plaintext: string; prefix: string };
    expect(body.plaintext).toBe("helm_live_PLAINTEXT_SECRET");
    expect(body.key_id).toBe("key_1");
    // The server-minted non-sensitive prefix is returned so the SPA need not slice
    // the plaintext (a redaction footgun); it is the same display prefix stored.
    expect(body.prefix).toBe("helm_live_PLAI");
    // Stored as hash + prefix plus encrypted recovery material — never plaintext.
    expect(keyStore.rows[0]?.hash).toBe("hash_of_plaintext_full");
    expect(keyStore.rows[0]?.secret_enc).toMatch(/^enc:/);
    expect(keyStore.rows[0]?.blocked_models).toEqual(["gpt-4o"]);
    expect(JSON.stringify(keyStore.rows[0])).not.toContain("PLAINTEXT_SECRET");
    expect(keyStore.rows[0]?.memory_mode).toBe("off");
    expect(keyStore.rows[0]?.memory_thread_source).toBe("auto");

    const list = (await (await app.request("/admin/api/keys")).json()) as Array<
      Record<string, unknown>
    >;
    const raw = JSON.stringify(list);
    expect(raw).not.toContain("PLAINTEXT_SECRET");
    expect(raw).not.toContain("hash_of_plaintext_full"); // no hash full-text
    expect(list[0]?.prefix).toBe("helm_live_PLAI");
    expect(list[0]?.blocked_models).toEqual(["gpt-4o"]);
    expect(list[0]).not.toHaveProperty("hash");
    expect(list[0]).not.toHaveProperty("plaintext");
    expect(list[0]).not.toHaveProperty("secret_enc");
  });

  it("GET /keys/:id/secret reveals encrypted key material and rejects hash-only rows", async () => {
    const deps = buildDeps();
    const app = buildApp(deps);
    await app.request("/admin/api/keys", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ role: "user" }),
    });
    const reveal = await app.request("/admin/api/keys/key_1/secret");
    expect(reveal.status).toBe(200);
    expect(await reveal.json()).toEqual({
      key_id: "key_1",
      plaintext: "helm_live_PLAINTEXT_SECRET",
    });

    const row = keyStore.rows[0];
    expect(row).toBeDefined();
    if (!row) throw new Error("expected key row");
    row.secret_enc = null;
    const old = await app.request("/admin/api/keys/key_1/secret");
    expect(old.status).toBe(409);
  });

  it("POST /keys/:id/rotate replaces hash/prefix/secret while preserving the key row", async () => {
    let i = 0;
    const deps = buildDeps({
      genKey: () => {
        i += 1;
        return {
          plaintext: `helm_live_ROTATED_SECRET_${i}`,
          hash: `hash_${i}`,
          prefix: `helm_live_R${i}`,
        };
      },
    });
    const app = buildApp(deps);
    await app.request("/admin/api/keys", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({
        role: "user",
        name: "Production",
        allowed_lanes: ["balanced"],
        rate_limit_rpm: 7,
      }),
    });
    const beforeId = keyStore.rows[0]?.key_id;
    const beforeCreated = keyStore.rows[0]?.disabled;

    const rotated = await app.request("/admin/api/keys/key_1/rotate", { method: "POST" });
    expect(rotated.status).toBe(200);
    expect(await rotated.json()).toEqual({
      key_id: "key_1",
      plaintext: "helm_live_ROTATED_SECRET_2",
      prefix: "helm_live_R2",
      recoverable: true,
    });
    expect(keyStore.rows).toHaveLength(1);
    expect(keyStore.rows[0]?.key_id).toBe(beforeId);
    expect(keyStore.rows[0]?.name).toBe("Production");
    expect(keyStore.rows[0]?.allowed_lanes).toEqual(["balanced"]);
    expect(keyStore.rows[0]?.rate_limit_rpm).toBe(7);
    expect(keyStore.rows[0]?.disabled).toBe(beforeCreated);
    expect(keyStore.rows[0]?.hash).toBe("hash_2");
    expect(keyStore.rows[0]?.prefix).toBe("helm_live_R2");
    expect(JSON.stringify(keyStore.rows[0])).not.toContain("ROTATED_SECRET_2");
    expect(await deps.keyStore.getByHash("hash_1")).toBeNull();
    expect((await deps.keyStore.getByHash("hash_2"))?.key_id).toBe("key_1");
  });

  it("POST persists per-key memory defaults and the LIST surfaces them (issue #97)", async () => {
    // Regression: the list view must echo the configured memory defaults, or the
    // admin UI re-reads off/null/header and silently wipes them on the next save.
    const deps = buildDeps();
    const app = buildApp(deps);
    const created = await app.request("/admin/api/keys", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({
        role: "user",
        memory_mode: "inject",
        memory_project_id: "proj-1",
        memory_thread_source: "auto",
      }),
    });
    expect(created.status).toBe(201);
    expect(keyStore.rows[0]?.memory_mode).toBe("inject");
    const list = (await (await app.request("/admin/api/keys")).json()) as Array<
      Record<string, unknown>
    >;
    expect(list[0]?.memory_mode).toBe("inject");
    expect(list[0]?.memory_project_id).toBe("proj-1");
    expect(list[0]?.memory_thread_source).toBe("auto");
  });

  it("POST persists a key name and the LIST surfaces it; PATCH renames + clears it", async () => {
    const deps = buildDeps();
    const app = buildApp(deps);
    const created = await app.request("/admin/api/keys", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ role: "user", name: "Production backend" }),
    });
    expect(created.status).toBe(201);
    expect(keyStore.rows[0]?.name).toBe("Production backend");
    let list = (await (await app.request("/admin/api/keys")).json()) as Array<
      Record<string, unknown>
    >;
    expect(list[0]?.name).toBe("Production backend");
    // PATCH renames…
    const renamed = await app.request("/admin/api/keys/key_1", {
      method: "PATCH",
      headers: JSON_HEADERS,
      body: JSON.stringify({ name: "Mobile app" }),
    });
    expect(renamed.status).toBe(200);
    expect(keyStore.rows[0]?.name).toBe("Mobile app");
    // …and null clears it back to unnamed.
    const cleared = await app.request("/admin/api/keys/key_1", {
      method: "PATCH",
      headers: JSON_HEADERS,
      body: JSON.stringify({ name: null }),
    });
    expect(cleared.status).toBe(200);
    expect(keyStore.rows[0]?.name).toBeNull();
    list = (await (await app.request("/admin/api/keys")).json()) as Array<Record<string, unknown>>;
    expect(list[0]?.name).toBeNull();
  });

  it("POST without a name leaves it null (unnamed)", async () => {
    const deps = buildDeps();
    const app = buildApp(deps);
    await app.request("/admin/api/keys", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ role: "user" }),
    });
    expect(keyStore.rows[0]?.name).toBeNull();
  });

  it("POST persists per-key rate limits and the list surfaces them", async () => {
    const deps = buildDeps();
    const app = buildApp(deps);
    const created = await app.request("/admin/api/keys", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ role: "user", rate_limit_rpm: 60, rate_limit_tpm: 0 }),
    });
    expect(created.status).toBe(201);
    expect(keyStore.rows[0]?.rate_limit_rpm).toBe(60);
    expect(keyStore.rows[0]?.rate_limit_tpm).toBe(0);
    const list = (await (await app.request("/admin/api/keys")).json()) as Array<
      Record<string, unknown>
    >;
    expect(list[0]?.rate_limit_rpm).toBe(60);
    expect(list[0]?.rate_limit_tpm).toBe(0);
  });

  it("POST without rate limits leaves them null (inherit system default)", async () => {
    const deps = buildDeps();
    const app = buildApp(deps);
    await app.request("/admin/api/keys", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ role: "user" }),
    });
    expect(keyStore.rows[0]?.rate_limit_rpm).toBeNull();
    expect(keyStore.rows[0]?.rate_limit_tpm).toBeNull();
  });

  it("POST persists allow_fast_mode and the list surfaces it", async () => {
    const deps = buildDeps();
    const app = buildApp(deps);
    const created = await app.request("/admin/api/keys", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ role: "user", allow_fast_mode: true }),
    });
    expect(created.status).toBe(201);
    expect(keyStore.rows[0]?.allow_fast_mode).toBe(true);
    const list = (await (await app.request("/admin/api/keys")).json()) as Array<
      Record<string, unknown>
    >;
    expect(list[0]?.allow_fast_mode).toBe(true);
  });

  it("PATCH edits a key's rate limits (number sets, null clears) without touching caps", async () => {
    const deps = buildDeps();
    const app = buildApp(deps);
    await app.request("/admin/api/keys", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ role: "user", allowed_lanes: ["balanced"] }),
    });
    const set = await app.request("/admin/api/keys/key_1", {
      method: "PATCH",
      headers: JSON_HEADERS,
      body: JSON.stringify({ rate_limit_rpm: 120, rate_limit_tpm: 5000 }),
    });
    expect(set.status).toBe(200);
    expect(keyStore.rows[0]?.rate_limit_rpm).toBe(120);
    expect(keyStore.rows[0]?.rate_limit_tpm).toBe(5000);
    expect(keyStore.rows[0]?.allowed_lanes).toEqual(["balanced"]); // caps untouched
    // null clears one dimension back to inheriting the system default.
    const clear = await app.request("/admin/api/keys/key_1", {
      method: "PATCH",
      headers: JSON_HEADERS,
      body: JSON.stringify({ rate_limit_rpm: null, rate_limit_tpm: 5000 }),
    });
    expect(clear.status).toBe(200);
    expect(keyStore.rows[0]?.rate_limit_rpm).toBeNull();
    expect(keyStore.rows[0]?.rate_limit_tpm).toBe(5000);
  });

  it("PATCH edits a key's caps (allowed_lanes, blocked_models, allow_custom_model, allow_fast_mode; null clears)", async () => {
    const deps = buildDeps();
    const app = buildApp(deps);
    await app.request("/admin/api/keys", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ role: "user", allowed_lanes: ["balanced"], rate_limit_rpm: 7 }),
    });
    const set = await app.request("/admin/api/keys/key_1", {
      method: "PATCH",
      headers: JSON_HEADERS,
      body: JSON.stringify({
        allowed_lanes: ["economy", "balanced"],
        allow_custom_model: true,
        blocked_models: ["gpt-4o"],
        allow_fast_mode: true,
      }),
    });
    expect(set.status).toBe(200);
    expect(keyStore.rows[0]?.allowed_lanes).toEqual(["economy", "balanced"]);
    expect(keyStore.rows[0]?.allow_custom_model).toBe(true);
    expect(keyStore.rows[0]?.blocked_models).toEqual(["gpt-4o"]);
    expect(keyStore.rows[0]?.allow_fast_mode).toBe(true);
    expect(keyStore.rows[0]?.rate_limit_rpm).toBe(7); // unrelated field untouched
    expect(keyStore.rows[0]?.role).toBe("user"); // role never rewritten
    // null clears the whitelist back to "no cap".
    const clear = await app.request("/admin/api/keys/key_1", {
      method: "PATCH",
      headers: JSON_HEADERS,
      body: JSON.stringify({ allowed_lanes: null, blocked_models: null }),
    });
    expect(clear.status).toBe(200);
    expect(keyStore.rows[0]?.allowed_lanes).toBeNull();
    expect(keyStore.rows[0]?.blocked_models).toBeNull();
    expect(keyStore.rows[0]?.allow_custom_model).toBe(true); // omitted → untouched
    expect(keyStore.rows[0]?.allow_fast_mode).toBe(true); // omitted → untouched
  });

  it("PATCH rejects role and other unknown fields with 400 (fail-closed, strict)", async () => {
    const deps = buildDeps();
    const app = buildApp(deps);
    await app.request("/admin/api/keys", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ role: "user" }),
    });
    // role is immutable — cannot escalate to root via the edit path.
    const role = await app.request("/admin/api/keys/key_1", {
      method: "PATCH",
      headers: JSON_HEADERS,
      body: JSON.stringify({ role: "root" }),
    });
    expect(role.status).toBe(400);
    const unknown = await app.request("/admin/api/keys/key_1", {
      method: "PATCH",
      headers: JSON_HEADERS,
      body: JSON.stringify({ nope: 1 }),
    });
    expect(unknown.status).toBe(400);
  });

  it("PATCH on an unknown key id returns 404", async () => {
    const deps = buildDeps();
    const app = buildApp(deps);
    const res = await app.request("/admin/api/keys/nope", {
      method: "PATCH",
      headers: JSON_HEADERS,
      body: JSON.stringify({ rate_limit_rpm: 10 }),
    });
    expect(res.status).toBe(404);
  });

  it("DELETE revokes (disabled:true) without removing or rewriting the row", async () => {
    const deps = buildDeps();
    const app = buildApp(deps);
    await app.request("/admin/api/keys", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ role: "user" }),
    });
    const before = structuredClone(keyStore.rows[0]);
    const res = await app.request("/admin/api/keys/key_1", { method: "DELETE" });
    expect(res.status).toBe(200);
    expect(keyStore.rows).toHaveLength(1); // still present (rotation semantics)
    expect(keyStore.rows[0]?.disabled).toBe(true);
    // Only `disabled` changed; everything else untouched.
    expect({ ...keyStore.rows[0], disabled: before?.disabled }).toEqual(before);
  });

  it("DELETE ?purge=true permanently removes a REVOKED key", async () => {
    const deps = buildDeps();
    const app = buildApp(deps);
    await app.request("/admin/api/keys", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ role: "user" }),
    });
    // Two-step destroy: revoke first (soft), then purge.
    await app.request("/admin/api/keys/key_1", { method: "DELETE" });
    expect(keyStore.rows[0]?.disabled).toBe(true);
    const res = await app.request("/admin/api/keys/key_1?purge=true", { method: "DELETE" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ deleted: "key_1" });
    expect(keyStore.rows).toHaveLength(0); // physically gone
  });

  it("DELETE ?purge=true on an ACTIVE key is refused (409) and keeps the row", async () => {
    const deps = buildDeps();
    const app = buildApp(deps);
    await app.request("/admin/api/keys", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ role: "user" }),
    });
    const res = await app.request("/admin/api/keys/key_1?purge=true", { method: "DELETE" });
    expect(res.status).toBe(409);
    expect(keyStore.rows).toHaveLength(1);
    expect(keyStore.rows[0]?.disabled).toBe(false);
  });

  it("DELETE ?purge=true on an unknown id returns 404", async () => {
    const deps = buildDeps();
    const app = buildApp(deps);
    const res = await app.request("/admin/api/keys/nope?purge=true", { method: "DELETE" });
    expect(res.status).toBe(404);
  });

  it("DELETE refuses to revoke the internal system key (k_internal) with 403", async () => {
    const deps = buildDeps();
    const app = buildApp(deps);
    await deps.keyStore.createKey({
      keyId: "k_internal",
      hash: "h_int",
      prefix: "helm_live_int",
      accountId: "default",
      role: "user",
      name: "internal-llm",
      allowCustomModel: true,
    });
    const res = await app.request("/admin/api/keys/k_internal", { method: "DELETE" });
    expect(res.status).toBe(403);
    // untouched — still active so internal LLM calls keep authenticating.
    expect(keyStore.rows.find((r) => r.key_id === "k_internal")?.disabled).toBe(false);
  });

  it("DELETE ?purge=true refuses to delete the internal system key (k_internal) with 403", async () => {
    const deps = buildDeps();
    const app = buildApp(deps);
    await deps.keyStore.createKey({
      keyId: "k_internal",
      hash: "h_int",
      prefix: "helm_live_int",
      accountId: "default",
      role: "user",
      name: "internal-llm",
      allowCustomModel: true,
    });
    const res = await app.request("/admin/api/keys/k_internal?purge=true", { method: "DELETE" });
    expect(res.status).toBe(403);
    expect(keyStore.rows.find((r) => r.key_id === "k_internal")).toBeDefined();
  });

  it("GET /keys/:id returns the full redacted record, 404 on unknown", async () => {
    const deps = buildDeps();
    const app = buildApp(deps);
    await app.request("/admin/api/keys", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ role: "user", name: "proj-x" }),
    });
    const res = await app.request("/admin/api/keys/key_1");
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.key_id).toBe("key_1");
    expect(body.name).toBe("proj-x");
    expect(body.prefix).toBe("helm_live_PLAI");
    // Never the plaintext nor the full hash (principle 7).
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain("PLAINTEXT_SECRET");
    expect(serialized).not.toContain("hash_of_plaintext_full");

    expect((await app.request("/admin/api/keys/nope")).status).toBe(404);
  });

  it("GET /keys/usage returns per-key window rollup (not matched as :id)", async () => {
    const windows: Array<{ start: number; end: number }> = [];
    const telemetry: TelemetryStore = {
      ...makeTelemetry(),
      async usageByKey(start: number, end: number) {
        windows.push({ start, end });
        return [
          { apiKeyId: "key_1", requests: 7, errorCount: 1, totalCostUsd: 0.042, totalTokens: 1500 },
          { apiKeyId: "key_2", requests: 2, errorCount: 0, totalCostUsd: null, totalTokens: 30 },
        ];
      },
    };
    const app = buildApp(buildDeps({ telemetry }));
    const res = await app.request("/admin/api/keys/usage?start=1000&end=5000");
    expect(res.status).toBe(200);
    expect(windows[0]).toEqual({ start: 1000, end: 5000 }); // "usage" is NOT treated as a key id
    expect(await res.json()).toEqual([
      { key_id: "key_1", requests: 7, error_count: 1, cost_usd: 0.042, total_tokens: 1500 },
      { key_id: "key_2", requests: 2, error_count: 0, cost_usd: null, total_tokens: 30 },
    ]);
  });

  it("GET /keys/usage defaults to today in the viewer's local day when the window is omitted", async () => {
    const now = Date.UTC(2026, 5, 1, 20, 0, 0);
    const todayStartUtc = Date.UTC(2026, 5, 1, 16, 0, 0); // UTC+8 local midnight
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(now);
    const windows: Array<{ start: number; end: number }> = [];
    const telemetry: TelemetryStore = {
      ...makeTelemetry(),
      async usageByKey(start: number, end: number) {
        windows.push({ start, end });
        return [];
      },
    };
    try {
      const app = buildApp(buildDeps({ telemetry }));
      const res = await app.request("/admin/api/keys/usage?tzOffsetMinutes=480");
      expect(res.status).toBe(200);
      expect(windows[0]).toEqual({ start: todayStartUtc, end: now });
      expect(
        (await app.request("/admin/api/keys/usage?tzOffsetMinutes=480")).headers.get(
          "x-helm-cache",
        ),
      ).toBe("fresh");
      expect(windows).toHaveLength(1);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it("caches the live per-key usage window instead of regrouping telemetry on every read", async () => {
    const now = Date.UTC(2026, 5, 1, 20, 0, 0);
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(now);
    const usageByKey = vi.fn(async () => []);
    const telemetry: TelemetryStore = { ...makeTelemetry(), usageByKey };
    try {
      const app = buildApp(buildDeps({ telemetry }));
      const first = await app.request("/admin/api/keys/usage?start=1000");
      const second = await app.request("/admin/api/keys/usage?start=1000");
      expect(first.headers.get("x-helm-cache")).toBe("miss");
      expect(second.headers.get("x-helm-cache")).toBe("fresh");
      expect(usageByKey).toHaveBeenCalledTimes(1);
    } finally {
      nowSpy.mockRestore();
    }
  });
});

describe("admin.api requests", () => {
  it("lists summaries and fetches a detail with the full decision trail", async () => {
    const seed = [decision("trace-1", "premium"), decision("trace-2", "economy")];
    const app = buildApp(buildDeps({ telemetry: makeTelemetry(seed) }));

    // The list returns a paginated envelope; each item is the full (already-
    // redacted) DecisionRecord so the SPA can surface the classification stage /
    // candidate chain / cost without recomputing them (Principle 1, Principle 5).
    // It carries no plaintext key/payload (Principle 7).
    const page = (await (await app.request("/admin/api/requests")).json()) as {
      items: Array<DecisionRecord & { created_at: number }>;
      total: number;
      page: number;
      pageSize: number;
    };
    expect(page.total).toBe(2);
    expect(page.page).toBe(1);
    expect(page.items).toHaveLength(2);
    const list = page.items;
    expect(list[0]?.trace_id).toBe("trace-1");
    expect(list[0]?.lane.selected_lane).toBe("premium");
    expect(list[0]?.classifier.decided_by).toBe("rules");
    expect(list[0]?.provider_attempts[0]?.cost_usd).toBeCloseTo(0.002);
    // Each row carries the recorded timestamp (epoch ms) for the UI "Time" column.
    expect(typeof list[0]?.created_at).toBe("number");

    const detail = (await (
      await app.request("/admin/api/requests/trace-1")
    ).json()) as DecisionRecord & { created_at: number };
    expect(detail.trace_id).toBe("trace-1");
    expect(detail.classifier.task_type).toBe("coding"); // classification stage
    expect(detail.lane.candidate_chain).toEqual(["premium", "balanced"]); // lane candidate chain
    expect(detail.provider_attempts).toHaveLength(1); // provider attempts
    // The detail also carries the recorded timestamp (epoch ms) so the SPA header
    // shows the request time instead of "time not recorded" (same source as the
    // list "Time" column; the DecisionRecord itself has no timestamp field).
    expect(detail.created_at).toBe(1_700_000_000_000);
  });

  it("keeps the raw Session ID out of telemetry and enriches it from the Session store", async () => {
    const rec = decision("trace-session", "balanced");
    rec.session = { ref: "opaque-session-ref", source: "x-thread-id" };
    const session = {
      sessionRef: "opaque-session-ref",
      accountId: "acct",
      apiKeyId: "k1",
      source: "x-thread-id",
      externalSessionId: "customer@example.com",
      createdAt: new Date(1000),
      lastSeenAt: new Date(2000),
      headRequestId: "trace-session",
      revisionCount: 1,
      storedBytes: 100,
    };
    const telemetry = {
      ...makeTelemetry([rec]),
      listSessionsByRefs: vi.fn(async () => [session]),
      getSessionByRef: vi.fn(async () => session),
    } as unknown as TelemetryStore;
    const app = buildApp(buildDeps({ telemetry }));

    const page = (await (await app.request("/admin/api/requests")).json()) as {
      items: Array<{ session?: { ref: string; label?: string } }>;
    };
    expect(rec.session).toEqual({ ref: "opaque-session-ref", source: "x-thread-id" });
    expect(page.items[0]?.session).toMatchObject({
      ref: "opaque-session-ref",
      label: "customer@example.com",
    });
    const detail = (await (await app.request("/admin/api/requests/trace-session")).json()) as {
      session: { label: string };
    };
    expect(detail.session.label).toBe("customer@example.com");
  });

  it("forwards filters + pagination to the store and returns the page envelope", async () => {
    const ok1 = decision("ok-1", "premium");
    const err = decision("err-1", "balanced");
    err.final = { ...err.final, status: "error", error_reason: "upstream_error" };
    const ok2 = decision("ok-2", "economy");
    const app = buildApp(buildDeps({ telemetry: makeTelemetry([ok1, err, ok2]) }));

    // status filter narrows to the single error row (total reflects the filter).
    const filtered = (await (await app.request("/admin/api/requests?status=error")).json()) as {
      items: Array<{ trace_id: string }>;
      total: number;
    };
    expect(filtered.total).toBe(1);
    expect(filtered.items.map((r) => r.trace_id)).toEqual(["err-1"]);

    // pageSize=2 page=2 → the 3rd row only; total stays the full unfiltered count.
    const p2 = (await (await app.request("/admin/api/requests?pageSize=2&page=2")).json()) as {
      items: Array<{ trace_id: string }>;
      total: number;
      page: number;
      pageSize: number;
    };
    expect(p2.total).toBe(3);
    expect(p2.page).toBe(2);
    expect(p2.pageSize).toBe(2);
    expect(p2.items.map((r) => r.trace_id)).toEqual(["ok-2"]);
  });

  it("resolves each row's api_key_id to the key's name (falls back to prefix when unnamed/deleted)", async () => {
    const deps = buildDeps({ telemetry: makeTelemetry([decision("trace-1", "premium")]) });
    // The fake telemetry records every row under api_key_id "k1"; give that key a
    // human name so the route surfaces it for the SPA. A second, differently-id'd
    // key proves we join by the RECORDED id, not just "any name".
    await deps.keyStore.createKey({
      keyId: "k1",
      hash: "h_named",
      prefix: "helm_live_aaaa",
      accountId: "acct",
      role: "user",
      name: "Production backend",
    });
    const app = buildApp(deps);
    const named = (await (await app.request("/admin/api/requests")).json()) as {
      items: Array<{ key_name: string | null; key_id: string }>;
    };
    expect(named.items[0]?.key_name).toBe("Production backend");
    // The row also carries the recorded api_key_id (internal UUID, not key material)
    // so the SPA can offer "filter by this key".
    expect(named.items[0]?.key_id).toBe("k1");

    // An UNNAMED key (or one since deleted) → key_name null, so the SPA shows the prefix.
    const depsUnnamed = buildDeps({ telemetry: makeTelemetry([decision("trace-2", "premium")]) });
    const unnamed = (await (await buildApp(depsUnnamed).request("/admin/api/requests")).json()) as {
      items: Array<{ key_name: string | null }>;
    };
    expect(unnamed.items[0]?.key_name).toBeNull();
  });

  it("resolves the detail's api_key_id to the key's name (null when unnamed/deleted)", async () => {
    const deps = buildDeps({ telemetry: makeTelemetry([decision("trace-1", "premium")]) });
    // The fake telemetry records the row under api_key_id "k1"; name that key so the
    // detail route surfaces it — the SAME join the list does (the redacted record
    // carries key_prefix but not the key_id/name; the route owns keyStore, Principle 1).
    await deps.keyStore.createKey({
      keyId: "k1",
      hash: "h_named",
      prefix: "helm_live_aaaa",
      accountId: "acct",
      role: "user",
      name: "Production backend",
    });
    const named = (await (await buildApp(deps).request("/admin/api/requests/trace-1")).json()) as {
      key_name: string | null;
    };
    expect(named.key_name).toBe("Production backend");

    // No matching/named key → key_name null, so the SPA falls back to the prefix.
    const unnamed = (await (
      await buildApp(
        buildDeps({ telemetry: makeTelemetry([decision("trace-2", "premium")]) }),
      ).request("/admin/api/requests/trace-2")
    ).json()) as { key_name: string | null };
    expect(unnamed.key_name).toBeNull();
  });

  it("fails open on a malformed query (never 5xx) and serves page 1", async () => {
    const app = buildApp(buildDeps({ telemetry: makeTelemetry([decision("t", "premium")]) }));
    const res = await app.request("/admin/api/requests?page=abc&pageSize=-9&status=bogus");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { total: number; page: number };
    expect(body.page).toBe(1);
    expect(body.total).toBe(1);
  });

  it("returns 404 for an unknown trace id", async () => {
    const app = buildApp(buildDeps());
    const res = await app.request("/admin/api/requests/nope");
    expect(res.status).toBe(404);
  });
});

describe("admin.api stats (dashboard token accounting)", () => {
  // A minimal aggregate result the stub returns verbatim — the route is pure glue
  // (parse window → call store → return JSON), so the assertion is on the
  // passthrough, not the SQL (that is the store-contract test's job).
  const AGG = {
    totals: {
      requests: 3,
      okCount: 2,
      errorCount: 1,
      totalCostUsd: 0.05,
      promptTokens: 1200,
      completionTokens: 340,
      cachedTokens: 800,
      cacheCreationTokens: 64,
      avgLatencyMs: 410,
    },
    series: [
      {
        bucketStartMs: 86_400_000,
        promptTokens: 1200,
        completionTokens: 340,
        cachedTokens: 800,
        cacheCreationTokens: 64,
        requests: 3,
      },
    ],
    byModel: [
      {
        servedModel: "gpt-4o",
        promptTokens: 1200,
        completionTokens: 340,
        totalTokens: 1540,
        requests: 3,
      },
    ],
  };

  // Telemetry stub that records the aggregate(start,end,bucket,tz) args so the test
  // can assert the route parsed the window + tz offset correctly, and returns AGG.
  function statsTelemetry(
    calls: Array<{ start: number; end: number; bucket: string; tz: number; keyId?: string }>,
  ): TelemetryStore {
    return {
      async aggregate(
        start: number,
        end: number,
        bucket: "hour" | "day",
        tzOffsetMinutes = 0,
        keyId?: string,
      ) {
        calls.push({ start, end, bucket, tz: tzOffsetMinutes, keyId });
        return AGG;
      },
    } as unknown as TelemetryStore;
  }

  it("returns the aggregate JSON for an explicit window + bucket", async () => {
    const calls: Array<{ start: number; end: number; bucket: string; tz: number; keyId?: string }> =
      [];
    const app = buildApp(buildDeps({ telemetry: statsTelemetry(calls) }));
    const res = await app.request("/admin/api/stats?start=1000&end=5000&bucket=hour");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(AGG);
    // The route parsed the explicit window + bucket and passed them through (tz → 0).
    expect(calls).toEqual([{ start: 1000, end: 5000, bucket: "hour", tz: 0 }]);
  });

  it("caches a live stats window instead of repeating three SQLite aggregates", async () => {
    const now = Date.UTC(2026, 5, 1, 20, 0, 0);
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(now);
    const calls: Array<{ start: number; end: number; bucket: string; tz: number; keyId?: string }> =
      [];
    try {
      const app = buildApp(buildDeps({ telemetry: statsTelemetry(calls) }));
      const url = `/admin/api/stats?start=1000&end=${now}&bucket=hour`;
      const first = await app.request(url);
      const second = await app.request(url);
      expect(first.headers.get("x-helm-cache")).toBe("miss");
      expect(second.headers.get("x-helm-cache")).toBe("fresh");
      expect(calls).toHaveLength(1);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it("forwards the client tz offset and fails open to 0 on junk", async () => {
    const calls: Array<{ start: number; end: number; bucket: string; tz: number; keyId?: string }> =
      [];
    const app = buildApp(buildDeps({ telemetry: statsTelemetry(calls) }));
    await app.request("/admin/api/stats?tzOffsetMinutes=480");
    expect(calls[0]?.tz).toBe(480); // UTC+8 reaches the store
    await app.request("/admin/api/stats?tzOffsetMinutes=banana");
    expect(calls[1]?.tz).toBe(0); // malformed offset degrades to UTC, never 5xx
  });

  it("forwards key_id to scope the aggregate to one key (omitted = global)", async () => {
    const calls: Array<{ start: number; end: number; bucket: string; tz: number; keyId?: string }> =
      [];
    const app = buildApp(buildDeps({ telemetry: statsTelemetry(calls) }));
    await app.request("/admin/api/stats?key_id=key_abc");
    expect(calls[0]?.keyId).toBe("key_abc"); // scopes to the detail page's key
    await app.request("/admin/api/stats");
    expect(calls[1]?.keyId).toBeUndefined(); // global dashboard view
  });

  it("defaults to the last 24h / day bucket when the window is omitted", async () => {
    const calls: Array<{ start: number; end: number; bucket: string; tz: number; keyId?: string }> =
      [];
    const app = buildApp(buildDeps({ telemetry: statsTelemetry(calls) }));
    const res = await app.request("/admin/api/stats");
    expect(res.status).toBe(200);
    const c = calls[0];
    expect(c?.bucket).toBe("day");
    // end defaults to ~now, start to ~now-24h: assert the span, not the absolute ms.
    expect((c?.end ?? 0) - (c?.start ?? 0)).toBe(86_400_000);
  });

  it("fails open on a malformed query (never 5xx): junk bucket → day", async () => {
    const calls: Array<{ start: number; end: number; bucket: string; tz: number; keyId?: string }> =
      [];
    const app = buildApp(buildDeps({ telemetry: statsTelemetry(calls) }));
    const res = await app.request("/admin/api/stats?bucket=decade&start=-9");
    expect(res.status).toBe(200);
    // bucket coerces to the "day" default; the negative start is dropped → 24h default span.
    expect(calls[0]?.bucket).toBe("day");
    expect((calls[0]?.end ?? 0) - (calls[0]?.start ?? 0)).toBe(86_400_000);
  });
});

describe("admin.api auth isolation", () => {
  beforeEach(() => {
    // ensure module-level vars don't leak between cases
  });

  it("rejects unauthenticated requests with 401 when basicAuth is enabled", async () => {
    const app = buildApp(buildDeps(), true);
    const res = await app.request("/admin/api/lanes");
    expect(res.status).toBe(401);
  });

  it("allows the request through with valid Basic credentials", async () => {
    const app = buildApp(buildDeps(), true);
    const creds = `Basic ${Buffer.from("admin:pw").toString("base64")}`;
    const res = await app.request("/admin/api/lanes", { headers: { Authorization: creds } });
    expect(res.status).toBe(200);
  });
});

describe("admin.api settings (System Settings)", () => {
  it("GET returns the live runtime settings", async () => {
    const app = buildApp(buildDeps());
    const res = await app.request("/admin/api/settings");
    expect(res.status).toBe(200);
    const body = (await res.json()) as RuntimeSettings;
    expect(body.capture_payloads).toBe(false);
    expect(body.capture_sessions).toBe(true); // factory content mode
    expect(body.log_level).toBe("info");
  });

  it("PUT validates, persists and echoes the new settings", async () => {
    const settings = makeSettings();
    const app = buildApp(buildDeps({ settings }));
    const res = await app.request("/admin/api/settings", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        capture_payloads: false,
        payload_retention_days: 7,
        rate_limit_enabled: true,
        log_level: "debug",
      }),
    });
    expect(res.status).toBe(200);
    expect((await res.json()) as RuntimeSettings).toMatchObject({
      capture_payloads: false,
      payload_retention_days: 7,
      log_level: "debug",
    });
    // The save seam applied it: a subsequent GET reflects the change.
    const after = (await (await app.request("/admin/api/settings")).json()) as RuntimeSettings;
    expect(after.capture_payloads).toBe(false);
  });

  it("PUT rejects an invalid body with 400 and does not persist (fail-closed)", async () => {
    const settings = makeSettings();
    const app = buildApp(buildDeps({ settings }));
    const res = await app.request("/admin/api/settings", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ log_level: "verbose" }),
    });
    expect(res.status).toBe(400);
    expect(settings.get().log_level).toBe("info"); // unchanged
  });

  it("PUT accepts a default_lane that names an existing lane", async () => {
    const settings = makeSettings();
    const app = buildApp(buildDeps({ settings }));
    const res = await app.request("/admin/api/settings", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ default_lane: "economy" }), // exists in DEFAULT_LANES
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as RuntimeSettings).default_lane).toBe("economy");
    expect(settings.get().default_lane).toBe("economy");
  });

  it("PUT rejects a default_lane that is not a defined lane (400, not persisted)", async () => {
    const settings = makeSettings();
    const app = buildApp(buildDeps({ settings }));
    const res = await app.request("/admin/api/settings", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ default_lane: "ghostlane" }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()) as { error: string }).toMatchObject({ error: "unknown lane" });
    expect(settings.get().default_lane).toBe("balanced"); // unchanged factory default
  });
});

describe("admin.api request payload", () => {
  it("returns captured:false when no payload was stored", async () => {
    const app = buildApp(buildDeps());
    const res = await app.request("/admin/api/requests/req_x/payload");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      captured: false,
      source: "unavailable",
      reason: "no_session",
    });
  });

  it("returns the parsed request/response when a payload exists", async () => {
    const telemetry = {
      ...makeTelemetry(),
      getPayload: async (id: string) =>
        id === "req_1"
          ? {
              requestId: "req_1",
              requestJson: JSON.stringify({ model: "auto" }),
              responseJson: JSON.stringify({ ok: true }),
              upstreamRequestJson: JSON.stringify({ model: "gpt-resolved", injected: true }),
              createdAt: new Date(1234),
            }
          : null,
    } as unknown as TelemetryStore;
    const app = buildApp(buildDeps({ telemetry }));
    const res = await app.request("/admin/api/requests/req_1/payload");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      captured: true,
      source: "payload",
      exact: true,
      fidelity: "exact",
      request: { model: "auto" },
      response: { ok: true },
      upstream_request: { model: "gpt-resolved", injected: true },
      created_at: 1234,
    });
  });

  it("returns upstream_request:null when the forwarded body was not captured", async () => {
    const telemetry = {
      ...makeTelemetry(),
      getPayload: async (id: string) =>
        id === "req_2"
          ? {
              requestId: "req_2",
              requestJson: JSON.stringify({ model: "auto" }),
              responseJson: null,
              upstreamRequestJson: null,
              createdAt: new Date(1234),
            }
          : null,
    } as unknown as TelemetryStore;
    const app = buildApp(buildDeps({ telemetry }));
    const res = await app.request("/admin/api/requests/req_2/payload");
    expect(res.status).toBe(200);
    expect(((await res.json()) as { upstream_request: unknown }).upstream_request).toBeNull();
  });

  it("returns lightweight payload metadata without reading the full body", async () => {
    const telemetry = {
      ...makeTelemetry(),
      getPayload: async () => {
        throw new Error("full payload should not be read");
      },
      getPayloadMeta: async (id: string) =>
        id === "req_3"
          ? {
              requestId: "req_3",
              createdAt: new Date(1234),
              parts: { request: true, response: false, upstreamRequest: true },
            }
          : null,
    } as unknown as TelemetryStore;
    const app = buildApp(buildDeps({ telemetry }));
    const res = await app.request("/admin/api/requests/req_3/payload?part=meta");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      captured: true,
      source: "payload",
      exact: true,
      fidelity: "exact",
      created_at: 1234,
      parts: { request: true, response: false, upstream_request: true },
    });
  });

  it("returns one requested payload part", async () => {
    const telemetry = {
      ...makeTelemetry(),
      getPayloadPart: async (id: string, part: "request" | "response" | "upstream_request") =>
        id === "req_4" && part === "upstream_request"
          ? {
              requestId: "req_4",
              part,
              json: JSON.stringify({ model: "gpt-resolved" }),
              createdAt: new Date(1234),
            }
          : null,
    } as unknown as TelemetryStore;
    const app = buildApp(buildDeps({ telemetry }));
    const res = await app.request("/admin/api/requests/req_4/payload?part=upstream_request");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      captured: true,
      source: "payload",
      exact: true,
      fidelity: "exact",
      part: "upstream_request",
      value: { model: "gpt-resolved" },
      created_at: 1234,
    });
  });

  it("recovers a semantic request and response from the session when no full payload exists", async () => {
    let responseJson: string | null =
      '{"choices":[{"message":{"role":"assistant","content":"hello back"}}]}';
    const rec = {
      ...decision("req_session", "balanced"),
      session: { ref: "session-ref", label: "thread-1", source: "x-thread-id" as const },
    };
    const telemetry = {
      ...makeTelemetry([rec]),
      getPayload: async () => null,
      listSessionRevisionsPage: async () => ({
        revisions: [
          {
            sessionRef: "session-ref",
            requestId: "req_session",
            sequence: 1,
            parentRequestId: null,
            retainCount: 0,
            requestDeltaJson: '[{"role":"user","content":"hello"}]',
            requestEnvelopeJson: '{"model":"auto","messages":[]}',
            responseId: null,
            responseJson,
            fidelity: "semantic",
            createdAt: new Date(1234),
          },
        ],
        nextSequence: null,
        limited: false,
      }),
    } as unknown as TelemetryStore;
    const app = buildApp(buildDeps({ telemetry }));
    const res = await app.request("/admin/api/requests/req_session/payload");
    expect(await res.json()).toEqual({
      captured: true,
      source: "session",
      exact: false,
      fidelity: "semantic",
      request: { model: "auto", messages: [{ role: "user", content: "hello" }] },
      response: {
        choices: [{ message: { role: "assistant", content: "hello back" } }],
      },
      upstream_request: null,
      created_at: 1234,
    });

    const meta = await app.request("/admin/api/requests/req_session/payload?part=meta");
    expect(await meta.json()).toMatchObject({
      captured: true,
      source: "session",
      exact: false,
      parts: { request: true, response: true, upstream_request: false },
    });

    const response = await app.request("/admin/api/requests/req_session/payload?part=response");
    expect(await response.json()).toMatchObject({
      captured: true,
      source: "session",
      exact: false,
      part: "response",
      value: { choices: [{ message: { role: "assistant", content: "hello back" } }] },
    });

    responseJson = null;
    const unavailable = await app.request("/admin/api/requests/req_session/payload?part=response");
    expect(await unavailable.json()).toEqual({
      captured: false,
      source: "unavailable",
      reason: "response_unavailable",
    });
  });

  it("recovers Session revisions through bounded keyset pages without listing the whole Session", async () => {
    const rec = {
      ...decision("req_child", "balanced"),
      session: { ref: "session-ref", label: "thread-1", source: "x-thread-id" as const },
    };
    const pages: Array<{ afterSequence?: number; limit: number; maxBytes: number }> = [];
    const root = {
      sessionRef: "session-ref",
      requestId: "req_root",
      sequence: 1,
      parentRequestId: null,
      retainCount: 0,
      requestDeltaJson: '[{"role":"user","content":"root"}]',
      requestEnvelopeJson: '{"model":"auto","messages":[]}',
      responseId: null,
      responseJson: null,
      fidelity: "semantic",
      createdAt: new Date(1000),
    };
    const child = {
      ...root,
      requestId: "req_child",
      sequence: 2,
      parentRequestId: "req_root",
      retainCount: 1,
      requestDeltaJson: '[{"role":"user","content":"child"}]',
      responseJson: '{"choices":[]}',
      createdAt: new Date(2000),
    };
    const telemetry = {
      ...makeTelemetry([rec]),
      getPayload: async () => null,
      listSessionRevisions: async () => {
        throw new Error("unbounded Session read must not be used");
      },
      listSessionRevisionsPage: async (
        _sessionRef: string,
        options: { afterSequence?: number; limit: number; maxBytes: number },
      ) => {
        pages.push(options);
        return options.afterSequence === undefined
          ? { revisions: [root], nextSequence: 1, limited: false }
          : { revisions: [child], nextSequence: null, limited: false };
      },
    } as unknown as TelemetryStore;
    const response = await buildApp(buildDeps({ telemetry })).request(
      "/admin/api/requests/req_child/payload",
    );

    expect(await response.json()).toMatchObject({
      captured: true,
      source: "session",
      exact: false,
      request: {
        model: "auto",
        messages: [
          { role: "user", content: "root" },
          { role: "user", content: "child" },
        ],
      },
    });
    expect(pages).toHaveLength(2);
    expect(pages[0]?.limit).toBeGreaterThan(0);
    expect(pages[0]?.maxBytes).toBeGreaterThan(0);
    expect(pages[1]?.afterSequence).toBe(1);
    expect(pages[1]?.maxBytes).toBeLessThan(pages[0]?.maxBytes ?? 0);
  });

  it("returns an honest limited result when Session recovery exceeds the runtime byte budget", async () => {
    const rec = {
      ...decision("req_session", "balanced"),
      session: { ref: "session-ref", source: "x-thread-id" as const },
    };
    let maxBytes = 0;
    const telemetry = {
      ...makeTelemetry([rec]),
      getPayload: async () => null,
      listSessionRevisionsPage: async (
        _sessionRef: string,
        options: { afterSequence?: number; limit: number; maxBytes: number },
      ) => {
        maxBytes = options.maxBytes;
        return { revisions: [], nextSequence: null, limited: true };
      },
    } as unknown as TelemetryStore;
    const response = await buildApp(buildDeps({ telemetry })).request(
      "/admin/api/requests/req_session/payload",
    );

    expect(maxBytes).toBeGreaterThan(0);
    expect(await response.json()).toEqual({
      captured: false,
      source: "unavailable",
      reason: "session_recovery_limited",
    });
  });

  it("allows two bounded Session recoveries while a third fails before reading", async () => {
    const rec = {
      ...decision("req_session", "balanced"),
      session: { ref: "session-ref", source: "x-thread-id" as const },
    };
    const pageEntered = deferred();
    const secondPageEntered = deferred();
    const releasePage = deferred();
    let pageReads = 0;
    const telemetry = {
      ...makeTelemetry([rec]),
      getPayload: async () => null,
      listSessionRevisionsPage: async () => {
        pageReads++;
        pageEntered.resolve();
        if (pageReads === 2) secondPageEntered.resolve();
        await releasePage.promise;
        return {
          revisions: [
            {
              sessionRef: "session-ref",
              requestId: "req_session",
              sequence: 1,
              parentRequestId: null,
              retainCount: 0,
              requestDeltaJson: '[{"role":"user","content":"hello"}]',
              requestEnvelopeJson: '{"model":"auto","messages":[]}',
              responseId: null,
              responseJson: null,
              fidelity: "semantic",
              createdAt: new Date(1234),
            },
          ],
          nextSequence: null,
          limited: false,
        };
      },
    } as unknown as TelemetryStore;
    const app = buildApp(buildDeps({ telemetry }));
    const first = app.request("/admin/api/requests/req_session/payload");
    await pageEntered.promise;
    const second = app.request("/admin/api/requests/req_session/payload");
    await secondPageEntered.promise;

    const competing = await app.request("/admin/api/requests/req_session/payload");
    expect(await competing.json()).toEqual({
      captured: false,
      source: "unavailable",
      reason: "session_recovery_limited",
    });
    expect(pageReads).toBe(2);

    releasePage.resolve();
    expect(await (await first).json()).toMatchObject({ captured: true, source: "session" });
    expect(await (await second).json()).toMatchObject({ captured: true, source: "session" });
  });

  it("distinguishes a cleaned session from a corrupt session chain", async () => {
    const rec = {
      ...decision("req_session", "balanced"),
      session: { ref: "session-ref", source: "x-thread-id" as const },
    };
    const unavailable = {
      ...makeTelemetry([rec]),
      getPayload: async () => null,
      listSessionRevisionsPage: singleSessionRevisionPage([]),
    } as unknown as TelemetryStore;
    const unavailableApp = buildApp(buildDeps({ telemetry: unavailable }));
    expect(
      await (await unavailableApp.request("/admin/api/requests/req_session/payload")).json(),
    ).toEqual({
      captured: false,
      source: "unavailable",
      reason: "session_unavailable",
    });

    const incomplete = {
      ...makeTelemetry([rec]),
      getPayload: async () => null,
      listSessionRevisionsPage: singleSessionRevisionPage([
        {
          sessionRef: "session-ref",
          requestId: "req_session",
          sequence: 1,
          parentRequestId: "req_session",
          retainCount: 0,
          requestDeltaJson: "[]",
          requestEnvelopeJson: '{"messages":[]}',
          responseId: null,
          responseJson: null,
          fidelity: "semantic",
          createdAt: new Date(1234),
        },
      ]),
    } as unknown as TelemetryStore;
    const incompleteApp = buildApp(buildDeps({ telemetry: incomplete }));
    expect(
      await (await incompleteApp.request("/admin/api/requests/req_session/payload")).json(),
    ).toEqual({
      captured: false,
      source: "unavailable",
      reason: "session_incomplete",
    });

    const unknownContinuation = {
      ...makeTelemetry([rec]),
      getPayload: async () => null,
      listSessionRevisionsPage: singleSessionRevisionPage([
        {
          sessionRef: "session-ref",
          requestId: "req_session",
          sequence: 1,
          parentRequestId: null,
          retainCount: 0,
          requestDeltaJson: '[{"role":"user","content":"child"}]',
          requestEnvelopeJson: '{"previous_response_id":"resp_missing","input":[]}',
          responseId: "resp_child",
          responseJson: '{"id":"resp_child","output":[]}',
          fidelity: "partial",
          createdAt: new Date(1234),
        },
      ]),
    } as unknown as TelemetryStore;
    const unknownContinuationApp = buildApp(buildDeps({ telemetry: unknownContinuation }));
    expect(
      await (
        await unknownContinuationApp.request("/admin/api/requests/req_session/payload")
      ).json(),
    ).toEqual({
      captured: false,
      source: "unavailable",
      reason: "session_incomplete",
    });
  });
});

describe("admin.api oauth cached overview and refresh queue", () => {
  const account = (name: string) => ({
    account: name,
    expiresAt: null,
    updatedAt: 0,
    healthy: true,
    priority: 50,
    schedulable: true,
    autoReset: false,
    fastMode: false,
    proxy: null,
    models: [],
  });

  const status = {
    selectionStrategy: "balanced" as const,
    providers: [
      {
        id: "anthropic",
        name: "Anthropic",
        flow: "manual_paste" as const,
        accounts: [account("claude-a")],
      },
      {
        id: "openai-codex",
        name: "Codex",
        flow: "manual_paste" as const,
        accounts: [account("codex-a")],
      },
    ],
  };
  const quotaWindow = {
    key: "5h",
    usedPercent: 10,
    resetsAtMs: Date.now() + 3_600_000,
    windowMinutes: 300,
  };

  it("GET /oauth/overview reads cached local state without touching upstream refresh methods", async () => {
    const listCachedStatus = vi.fn().mockResolvedValue(status);
    const listStatus = vi.fn(() => Promise.reject(new Error("must not refresh on page open")));
    const fetchAnthropicQuota = vi.fn(() =>
      Promise.reject(new Error("must not pull quota on page open")),
    );
    const oauth = {
      listCachedStatus,
      listStatus,
      fetchAnthropicQuota,
      getCachedCodexQuota: async () => null,
    } as unknown as AdminApiDeps["oauth"];
    const oauthUsage = {
      queryRange: async () => [
        {
          providerId: "anthropic",
          account: "claude-a",
          requests: 2,
          tokens: 12,
          costUsd: null,
          firstSeenMs: Date.now() - 60_000,
          updatedAt: Date.now(),
        },
      ],
    } as unknown as AdminApiDeps["oauthUsage"];
    const oauthQuota = {
      getAll: async () => [
        {
          providerId: "anthropic",
          account: "claude-a",
          windows: [],
          capturedAt: 123,
          source: "anthropic" as const,
          usageLimitedUntilMs: null,
          resetCredits: null,
        },
      ],
    } as unknown as AdminApiDeps["oauthQuota"];
    const app = buildApp(buildDeps({ oauth, oauthUsage, oauthQuota }));

    const res = await app.request("/admin/api/oauth/overview?tzOffsetMinutes=480");

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      configured: true,
      selectionStrategy: "balanced",
      providers: status.providers,
      usage: [{ providerId: "anthropic", account: "claude-a", requests: 2 }],
      quota: [{ providerId: "anthropic", account: "claude-a", capturedAt: 123 }],
      refresh: { state: "idle", jobId: null },
    });
    expect(listCachedStatus).toHaveBeenCalledOnce();
    expect(listStatus).not.toHaveBeenCalled();
    expect(fetchAnthropicQuota).not.toHaveBeenCalled();
  });

  it("POST /oauth/refresh coalesces concurrent clicks into one refresh job", async () => {
    const gate = deferred();
    const listStatus = vi.fn(async () => {
      await gate.promise;
      return status;
    });
    const oauth = {
      listCachedStatus: async () => status,
      listStatus,
      fetchAnthropicQuota: async () => [quotaWindow],
      fetchCodexQuota: async () => ({
        windows: [quotaWindow],
        additionalLimits: [],
        resetCredits: null,
        resetCreditDetails: null,
        credits: null,
        individualLimit: null,
        planType: null,
        rateLimitReachedType: null,
      }),
    } as unknown as AdminApiDeps["oauth"];
    const oauthQuota = {
      getAll: async () => [],
      upsert: async () => {},
      delete: async () => {},
      get: async () => null,
    } as unknown as AdminApiDeps["oauthQuota"];
    const app = buildApp(buildDeps({ oauth, oauthQuota }));

    const responses = await Promise.all(
      Array.from({ length: 20 }, () => app.request("/admin/api/oauth/refresh", { method: "POST" })),
    );
    await vi.waitFor(() => expect(listStatus).toHaveBeenCalledOnce());
    const bodies = await Promise.all(
      responses.map(
        (response) => response.json() as Promise<{ coalesced: boolean; status: { jobId: string } }>,
      ),
    );

    expect(responses.every((response) => response.status === 202)).toBe(true);
    expect(bodies.filter((body) => !body.coalesced)).toHaveLength(1);
    expect(new Set(bodies.map((body) => body.status.jobId)).size).toBe(1);

    gate.resolve();
    await vi.waitFor(async () => {
      const overview = await app.request("/admin/api/oauth/overview");
      expect(await overview.json()).toMatchObject({ refresh: { state: "succeeded" } });
    });
  });

  it("runs account quota refreshes serially with force enabled", async () => {
    let active = 0;
    let maxActive = 0;
    const calls: string[] = [];
    const run = async (label: string) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      calls.push(label);
      await new Promise((resolve) => setTimeout(resolve, 0));
      active -= 1;
      return [];
    };
    const serialStatus = {
      ...status,
      providers: [
        { ...status.providers[0], accounts: [account("claude-a"), account("claude-b")] },
        { ...status.providers[1], accounts: [account("codex-a")] },
      ],
    };
    const oauth = {
      listCachedStatus: async () => serialStatus,
      listStatus: async () => serialStatus,
      fetchAnthropicQuota: async ({
        account: name,
        force,
      }: {
        account: string;
        force?: boolean;
      }) => {
        expect(force).toBe(true);
        await run(`anthropic/${name}`);
        return [quotaWindow];
      },
      fetchCodexQuota: async ({ account: name, force }: { account: string; force?: boolean }) => {
        expect(force).toBe(true);
        await run(`openai-codex/${name}`);
        return {
          windows: [quotaWindow],
          additionalLimits: [],
          resetCredits: null,
          resetCreditDetails: null,
          credits: null,
          individualLimit: null,
          planType: null,
          rateLimitReachedType: null,
        };
      },
    } as unknown as AdminApiDeps["oauth"];
    const oauthQuota = {
      getAll: async () => [],
      upsert: async () => {},
      delete: async () => {},
      get: async () => null,
    } as unknown as AdminApiDeps["oauthQuota"];
    const app = buildApp(buildDeps({ oauth, oauthQuota }));

    await app.request("/admin/api/oauth/refresh", { method: "POST" });
    await vi.waitFor(async () => {
      const overview = await app.request("/admin/api/oauth/overview");
      expect(await overview.json()).toMatchObject({ refresh: { state: "succeeded" } });
    });

    expect(maxActive).toBe(1);
    expect(calls).toEqual(["anthropic/claude-a", "anthropic/claude-b", "openai-codex/codex-a"]);
  });

  it("marks a partial upstream refresh failure while preserving stale cached quota", async () => {
    const stale = {
      providerId: "anthropic",
      account: "claude-a",
      windows: [{ key: "5h", usedPercent: 40, resetsAtMs: 123, windowMinutes: 300 }],
      capturedAt: 100,
      source: "anthropic" as const,
      usageLimitedUntilMs: null,
      resetCredits: null,
    };
    const oauth = {
      listCachedStatus: async () => status,
      listStatus: async () => status,
      fetchAnthropicQuota: async () => {
        throw new Error("anthropic quota timeout");
      },
      fetchCodexQuota: async () => null,
      getCachedCodexQuota: async () => null,
    } as unknown as AdminApiDeps["oauth"];
    const oauthQuota = {
      getAll: async () => [stale],
      upsert: async () => {},
      delete: async () => {},
      get: async () => stale,
    } as unknown as AdminApiDeps["oauthQuota"];
    const app = buildApp(buildDeps({ oauth, oauthQuota }));

    const response = await app.request("/admin/api/oauth/refresh", { method: "POST" });
    expect(response.status).toBe(202);

    await vi.waitFor(async () => {
      const overview = await app.request("/admin/api/oauth/overview");
      expect(await overview.json()).toMatchObject({
        quota: [{ providerId: "anthropic", account: "claude-a", capturedAt: 100 }],
        refresh: { state: "failed", error: expect.stringContaining("anthropic quota timeout") },
      });
    });
  });
});

describe("admin.api oauth usage", () => {
  it("GET /oauth/usage returns today's per-account rows + derived RPM", async () => {
    const oauthUsage = {
      record: async () => {},
      queryRange: async () => [
        {
          providerId: "anthropic",
          account: "default",
          requests: 120,
          tokens: 240_000,
          costUsd: null, // flat-rate subscription → unpriced
          firstSeenMs: Date.now() - 60 * 60_000, // 60 min ago
          updatedAt: Date.now(),
        },
      ],
    } as unknown as AdminApiDeps["oauthUsage"];
    const app = buildApp(buildDeps({ oauthUsage }));
    const res = await app.request("/admin/api/oauth/usage");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      usage: Array<{
        providerId: string;
        account: string;
        requests: number;
        tokens: number;
        costUsd: number | null;
        rpm: number;
      }>;
    };
    expect(body.usage).toHaveLength(1);
    expect(body.usage[0]).toMatchObject({
      providerId: "anthropic",
      account: "default",
      requests: 120,
      tokens: 240_000,
      costUsd: null,
    });
    // ~120 requests over ~60 min ⇒ ~2 rpm (allow a wide band — clock-driven).
    expect(body.usage[0]?.rpm).toBeGreaterThan(0);
    expect(body.usage[0]?.rpm).toBeLessThan(5);
  });

  it("GET /oauth/usage returns only BOUND accounts (drops orphan rows)", async () => {
    const row = (account: string, requests: number) => ({
      providerId: "openai-codex",
      account,
      requests,
      tokens: 0,
      costUsd: null,
      firstSeenMs: Date.now() - 60 * 60_000,
      updatedAt: Date.now(),
    });
    const oauthUsage = {
      record: async () => {},
      queryRange: async () => [row("mylukin", 4), row("default", 9)], // default = orphan
    } as unknown as AdminApiDeps["oauthUsage"];
    const acct = (account: string) => ({
      account,
      expiresAt: null,
      updatedAt: 0,
      healthy: true,
      priority: 50,
      schedulable: true,
    });
    const oauth = {
      listCachedStatus: async () => ({
        selectionStrategy: "balanced",
        providers: [
          { id: "openai-codex", name: "C", flow: "manual_paste", accounts: [acct("mylukin")] },
        ],
      }),
    } as unknown as AdminApiDeps["oauth"];
    const app = buildApp(buildDeps({ oauthUsage, oauth }));
    const res = await app.request("/admin/api/oauth/usage");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { usage: Array<{ account: string }> };
    expect(body.usage.map((u) => u.account)).toEqual(["mylukin"]);
  });

  it("GET /oauth/usage fails open to [] when no usage store is wired", async () => {
    const app = buildApp(buildDeps());
    const res = await app.request("/admin/api/oauth/usage");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ usage: [] });
  });
});

describe("admin.api oauth quota", () => {
  it("GET /oauth/quota returns only cached BOUND rows without pulling or pruning", async () => {
    const upserts: unknown[] = [];
    const deletes: Array<[string, string]> = [];
    const acct = (account: string) => ({
      account,
      expiresAt: null,
      updatedAt: 0,
      healthy: true,
      priority: 50,
      schedulable: true,
    });
    const stored = [
      {
        providerId: "openai-codex",
        account: "mylukin", // BOUND → kept
        windows: [{ key: "primary", usedPercent: 5, resetsAtMs: 9_000, windowMinutes: 300 }],
        capturedAt: 1,
        source: "codex-headers" as const,
      },
      {
        providerId: "openai-codex",
        account: "default", // ORPHAN (no token) → filtered out + pruned
        windows: [{ key: "primary", usedPercent: 9, resetsAtMs: 9_000, windowMinutes: 300 }],
        capturedAt: 1,
        source: "codex-headers" as const,
      },
    ];
    const oauthQuota = {
      upsert: async (s: unknown) => {
        upserts.push(s);
      },
      get: async () => null,
      getAll: async () => stored,
      delete: async (providerId: string, account: string) => {
        deletes.push([providerId, account]);
      },
    } as unknown as AdminApiDeps["oauthQuota"];
    // Bound accounts: anthropic/mylukin + openai-codex/mylukin (NOT codex/default).
    const oauth = {
      listCachedStatus: async () => ({
        selectionStrategy: "balanced",
        providers: [
          { id: "anthropic", name: "A", flow: "manual_paste", accounts: [acct("mylukin")] },
          { id: "openai-codex", name: "C", flow: "manual_paste", accounts: [acct("mylukin")] },
        ],
      }),
      fetchAnthropicQuota: async () => [
        { key: "5h", usedPercent: 6, resetsAtMs: 5_000, windowMinutes: null },
      ],
    } as unknown as AdminApiDeps["oauth"];
    const app = buildApp(buildDeps({ oauthQuota, oauth }));
    const res = await app.request("/admin/api/oauth/quota");
    expect(res.status).toBe(200);
    expect(upserts).toHaveLength(0);
    // Only BOUND snapshots are returned; the orphan codex/default is dropped.
    const body = (await res.json()) as { quota: Array<{ providerId: string; account: string }> };
    expect(body.quota.map((q) => `${q.providerId}/${q.account}`)).toEqual(["openai-codex/mylukin"]);
    // Cache reads are side-effect free; orphan cleanup belongs to the refresh job.
    expect(deletes).toEqual([]);
  });

  it("POST /oauth/refresh refreshes the Codex PULL (source 'codex')", async () => {
    const upserts: unknown[] = [];
    const oauthQuota = {
      upsert: async (s: unknown) => {
        upserts.push(s);
      },
      get: async () => null,
      getAll: async () => [],
      delete: async () => {},
    } as unknown as AdminApiDeps["oauthQuota"];
    const status = {
      selectionStrategy: "balanced" as const,
      providers: [
        {
          id: "openai-codex",
          name: "C",
          flow: "manual_paste" as const,
          accounts: [
            {
              account: "mylukin",
              expiresAt: null,
              updatedAt: 0,
              healthy: true,
              priority: 50,
              schedulable: true,
            },
          ],
        },
      ],
    };
    const oauth = {
      listCachedStatus: async () => status,
      listStatus: async () => status,
      // The PULL twin of the x-codex-* header PUSH: windows + reset-credit count.
      fetchCodexQuota: async () => ({
        windows: [
          { key: "primary", usedPercent: 1, resetsAtMs: 9_000, windowMinutes: 300 },
          { key: "secondary", usedPercent: 14, resetsAtMs: 99_000, windowMinutes: 10_080 },
        ],
        resetCredits: 2,
      }),
    } as unknown as AdminApiDeps["oauth"];
    const app = buildApp(buildDeps({ oauthQuota, oauth }));
    const res = await app.request("/admin/api/oauth/refresh", { method: "POST" });
    expect(res.status).toBe(202);
    await vi.waitFor(() => expect(upserts).toHaveLength(1));
    expect(upserts).toHaveLength(1);
    expect(upserts[0]).toMatchObject({
      providerId: "openai-codex",
      account: "mylukin",
      source: "codex",
      resetCredits: 2,
    });
  });

  it("GET /oauth/quota fails open to [] when no quota store is wired", async () => {
    const app = buildApp(buildDeps());
    const res = await app.request("/admin/api/oauth/quota");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ quota: [] });
  });
});

describe("admin.api oauth schedule validation", () => {
  function oauthSeam(captured: { priority?: number }[]): AdminApiDeps["oauth"] {
    return {
      setAccountSchedule: async (i: { priority?: number }) => {
        captured.push({ priority: i.priority });
      },
    } as unknown as AdminApiDeps["oauth"];
  }

  it("rejects a negative or non-integer priority (400) and never persists it", async () => {
    const captured: { priority?: number }[] = [];
    const app = buildApp(buildDeps({ oauth: oauthSeam(captured) }));
    for (const bad of [-1, 1.9]) {
      const res = await app.request("/admin/api/oauth/anthropic/account", {
        method: "PUT",
        headers: JSON_HEADERS,
        body: JSON.stringify({ account: "default", priority: bad }),
      });
      expect(res.status).toBe(400);
    }
    expect(captured).toHaveLength(0);
  });

  it("accepts a non-negative integer priority (0 is valid)", async () => {
    const captured: { priority?: number }[] = [];
    const app = buildApp(buildDeps({ oauth: oauthSeam(captured) }));
    const res = await app.request("/admin/api/oauth/anthropic/account", {
      method: "PUT",
      headers: JSON_HEADERS,
      body: JSON.stringify({ account: "default", priority: 0 }),
    });
    expect(res.status).toBe(204);
    expect(captured).toEqual([{ priority: 0 }]);
  });
});

describe("admin.api rule persist failures", () => {
  // The YAML write-back (yaml-writeback.ts) throws when config/*.yaml cannot be
  // written — most commonly EACCES: the mounted ./config dir is owned by root
  // while the container runs as uid 10001. That is a LOCAL fault: it must
  // surface as a 500 with an operator-actionable message, NOT fall through
  // app.onError's redacted upstream_error(502) fallback and masquerade as a
  // provider outage (observed in production: PUT /admin/api/classifier -> 502).
  function eacces(): Error {
    const err: Error & { code?: string } = new Error(
      "EACCES: permission denied, open '/app/config/lanes.yaml.tmp-7'",
    );
    err.code = "EACCES";
    return err;
  }

  // RuleStore whose writes fail like a root-owned ./config mount; reads work.
  function failingRules(err: Error): RuleStore {
    const inner = makeRuleStore();
    return {
      ...inner,
      setLanes: async () => {
        throw err;
      },
      updateLanes: async () => {
        throw err;
      },
      setPolicies: async () => {
        throw err;
      },
      updatePolicies: async () => {
        throw err;
      },
      setClassifier: async () => {
        throw err;
      },
    };
  }

  // Mirror production wiring: logger + trace_id context vars and the global
  // onError fallback (app.ts), so an uncaught route throw renders exactly as it
  // would on a deployed gateway (502 upstream_error) — pinning the regression.
  function buildAppWithOnError(deps: AdminApiDeps) {
    const app = new Hono<AppEnv>();
    app.use("*", async (c, next) => {
      c.set("trace_id", "trace-test");
      c.set("logger", { log: () => {} });
      await next();
    });
    registerAdminApi(app, deps);
    app.onError((err, c) => handleError(err, c));
    return app;
  }

  async function expectActionable500(res: Response): Promise<void> {
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error?: unknown };
    // Admin error shape ({ error: string }), not the OpenAI envelope.
    expect(typeof body.error).toBe("string");
    const msg = body.error as string;
    expect(msg).toContain("EACCES");
    expect(msg).toContain("not writable"); // actionable hint, not redacted
  }

  it("PUT /lanes/:name surfaces a persist EACCES as an actionable 500, not 502", async () => {
    const app = buildAppWithOnError(buildDeps({ rules: failingRules(eacces()) }));
    const body: Lane = {
      primary: "best_reasoning_model",
      fallback: [],
      constraints: { require_tools: false, require_json: false, require_vision: false },
    };
    const res = await app.request("/admin/api/lanes/balanced", {
      method: "PUT",
      headers: JSON_HEADERS,
      body: JSON.stringify(body),
    });
    await expectActionable500(res);
  });

  it("DELETE /lanes/:name surfaces a persist EACCES as an actionable 500, not 502", async () => {
    const app = buildAppWithOnError(buildDeps({ rules: failingRules(eacces()) }));
    const res = await app.request("/admin/api/lanes/economy", { method: "DELETE" });
    await expectActionable500(res);
  });

  it("PUT /policies surfaces a persist EACCES as an actionable 500, not 502", async () => {
    const app = buildAppWithOnError(buildDeps({ rules: failingRules(eacces()) }));
    const res = await app.request("/admin/api/policies", {
      method: "PUT",
      headers: JSON_HEADERS,
      body: JSON.stringify([]),
    });
    await expectActionable500(res);
  });

  it("DELETE /policies/:id surfaces a persist EACCES as an actionable 500, not 502", async () => {
    const store = failingRules(eacces());
    // Seed a deletable policy so the route reaches the failing write.
    const seeded: RuleStore = {
      ...store,
      getPolicies: async () => ({ policies: [{ id: "p1", match: {} }] }),
    };
    const app = buildAppWithOnError(buildDeps({ rules: seeded }));
    const res = await app.request("/admin/api/policies/p1", { method: "DELETE" });
    await expectActionable500(res);
  });

  it("PUT /classifier surfaces a persist EACCES as an actionable 500, not 502", async () => {
    const app = buildAppWithOnError(buildDeps({ rules: failingRules(eacces()) }));
    const res = await app.request("/admin/api/classifier", {
      method: "PUT",
      headers: JSON_HEADERS,
      body: JSON.stringify(ClassifierConfigSchema.parse({})),
    });
    await expectActionable500(res);
  });

  it("a non-permission persist failure still returns 500 with the message, no chown hint", async () => {
    const app = buildAppWithOnError(
      buildDeps({ rules: failingRules(new Error("disk full while writing lanes.yaml")) }),
    );
    const body: Lane = {
      primary: "best_reasoning_model",
      fallback: [],
      constraints: { require_tools: false, require_json: false, require_vision: false },
    };
    const res = await app.request("/admin/api/lanes/balanced", {
      method: "PUT",
      headers: JSON_HEADERS,
      body: JSON.stringify(body),
    });
    expect(res.status).toBe(500);
    const json = (await res.json()) as { error?: unknown };
    expect(typeof json.error).toBe("string");
    expect(json.error as string).toContain("disk full while writing lanes.yaml");
    expect(json.error as string).not.toContain("not writable");
  });
});
