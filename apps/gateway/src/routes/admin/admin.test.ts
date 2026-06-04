import type { CreateKeyInput, KeyStore, Lane, PoliciesConfig, TelemetryStore } from "@helm/core";
import { DEFAULT_LANES, parseLanesConfig } from "@helm/core";
import type { ApiKeyRecord, ClassifierConfig, DecisionRecord, RuntimeSettings } from "@helm/shared";
import { ClassifierConfigSchema, RuntimeSettingsSchema } from "@helm/shared";
import { Hono } from "hono";
import { beforeEach, describe, expect, it } from "vitest";
import type { AppEnv } from "../../app.js";
import { basicAuth } from "../../middleware/basic-auth.js";
import type { AdminApiDeps, RuleStore, SettingsAccess } from "./deps.js";
import { registerAdminApi } from "./index.js";

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
    getPolicies: async () => policies,
    setPolicies: async (p) => {
      policies = p;
    },
    getClassifier: async () => classifier,
    setClassifier: async (c) => {
      classifier = c;
    },
  };
}

function makeKeyStore(): KeyStore & { rows: ApiKeyRecord[] } {
  const rows: ApiKeyRecord[] = [];
  return {
    rows,
    async createKey(input: CreateKeyInput): Promise<ApiKeyRecord> {
      const rec: ApiKeyRecord = {
        key_id: input.keyId,
        hash: input.hash,
        prefix: input.prefix,
        account_id: input.accountId,
        role: input.role,
        allowed_lanes: input.allowedLanes ?? null,
        allow_custom_model: input.allowCustomModel ?? false,
        disabled: false,
        rate_limit_rpm: input.rateLimitRpm ?? null,
        rate_limit_tpm: input.rateLimitTpm ?? null,
        budget_requests: input.budgetRequests ?? null,
        budget_tokens: input.budgetTokens ?? null,
        budget_spend_usd: input.budgetSpendUsd ?? null,
        budget_window_seconds: input.budgetWindowSeconds ?? null,
        over_budget_behavior: input.overBudgetBehavior ?? "degrade",
        degrade_lane: input.degradeLane ?? null,
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
    async updateKey(keyId, patch) {
      const row = rows.find((r) => r.key_id === keyId);
      if (!row) throw new Error(`key not found: ${keyId}`);
      // PARTIAL: only supplied fields change; absent fields untouched (never role
      // or the immutable identity). null clears a cap/override.
      if (patch.allowedLanes !== undefined) row.allowed_lanes = patch.allowedLanes;
      if (patch.allowCustomModel !== undefined) row.allow_custom_model = patch.allowCustomModel;
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
    async queryWindow() {
      return [...rows];
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
    classifier: {
      task_type: "coding",
      complexity: "complex",
      confidence: 0.9,
      decided_by: "rules",
      eval_cache_hit: null,
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
  };
}

let keyStore: KeyStore & { rows: ApiKeyRecord[] };
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

  it("DELETE removes a lane", async () => {
    const app = buildApp(buildDeps());
    const res = await app.request("/admin/api/lanes/economy", { method: "DELETE" });
    expect(res.status).toBe(200);
    expect((await rules.getLanes()).economy).toBeUndefined();
  });

  it("refuses to DELETE the `balanced` fallback terminal (409) and writes nothing", async () => {
    // Principle 5: `balanced` is the classification-fallback terminal; deleting it would
    // leave LanesConfigSchema unsatisfiable. The whole-map re-validation must catch
    // this and leave config untouched (fail-closed).
    const deps = buildDeps();
    const app = buildApp(deps);
    const before = await rules.getLanes();
    const res = await app.request("/admin/api/lanes/balanced", { method: "DELETE" });
    expect(res.status).toBe(409);
    expect(await rules.getLanes()).toEqual(before); // nothing written
    expect((await rules.getLanes()).balanced).toBeDefined();
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
      { match: { org_id: "acme" }, max_lane: "balanced" },
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
      body: JSON.stringify({ role: "user", allowed_lanes: ["balanced"] }),
    });
    expect(created.status).toBe(201);
    const body = (await created.json()) as { key_id: string; plaintext: string; prefix: string };
    expect(body.plaintext).toBe("helm_live_PLAINTEXT_SECRET");
    expect(body.key_id).toBe("key_1");
    // The server-minted non-sensitive prefix is returned so the SPA need not slice
    // the plaintext (a redaction footgun); it is the same display prefix stored.
    expect(body.prefix).toBe("helm_live_PLAI");
    // Stored as hash + prefix only — never the plaintext.
    expect(keyStore.rows[0]?.hash).toBe("hash_of_plaintext_full");
    expect(JSON.stringify(keyStore.rows[0])).not.toContain("PLAINTEXT_SECRET");

    const list = (await (await app.request("/admin/api/keys")).json()) as Array<
      Record<string, unknown>
    >;
    const raw = JSON.stringify(list);
    expect(raw).not.toContain("PLAINTEXT_SECRET");
    expect(raw).not.toContain("hash_of_plaintext_full"); // no hash full-text
    expect(list[0]?.prefix).toBe("helm_live_PLAI");
    expect(list[0]).not.toHaveProperty("hash");
    expect(list[0]).not.toHaveProperty("plaintext");
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

  it("PATCH edits a key's caps (allowed_lanes, allow_custom_model; null clears)", async () => {
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
      }),
    });
    expect(set.status).toBe(200);
    expect(keyStore.rows[0]?.allowed_lanes).toEqual(["economy", "balanced"]);
    expect(keyStore.rows[0]?.allow_custom_model).toBe(true);
    expect(keyStore.rows[0]?.rate_limit_rpm).toBe(7); // unrelated field untouched
    expect(keyStore.rows[0]?.role).toBe("user"); // role never rewritten
    // null clears the whitelist back to "no cap".
    const clear = await app.request("/admin/api/keys/key_1", {
      method: "PATCH",
      headers: JSON_HEADERS,
      body: JSON.stringify({ allowed_lanes: null }),
    });
    expect(clear.status).toBe(200);
    expect(keyStore.rows[0]?.allowed_lanes).toBeNull();
    expect(keyStore.rows[0]?.allow_custom_model).toBe(true); // omitted → untouched
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
    ).json()) as DecisionRecord;
    expect(detail.trace_id).toBe("trace-1");
    expect(detail.classifier.task_type).toBe("coding"); // classification stage
    expect(detail.lane.candidate_chain).toEqual(["premium", "balanced"]); // lane candidate chain
    expect(detail.provider_attempts).toHaveLength(1); // provider attempts
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
    expect(body.capture_payloads).toBe(true); // factory default ON
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
});

describe("admin.api request payload", () => {
  it("returns captured:false when no payload was stored", async () => {
    const app = buildApp(buildDeps());
    const res = await app.request("/admin/api/requests/req_x/payload");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ captured: false });
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
              createdAt: new Date(1234),
            }
          : null,
    } as unknown as TelemetryStore;
    const app = buildApp(buildDeps({ telemetry }));
    const res = await app.request("/admin/api/requests/req_1/payload");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      captured: true,
      request: { model: "auto" },
      response: { ok: true },
      created_at: 1234,
    });
  });
});

describe("admin.api oauth usage", () => {
  it("GET /oauth/usage returns today's per-account rows + derived RPM", async () => {
    const day = Date.now() - (Date.now() % 86_400_000);
    const oauthUsage = {
      record: async () => {},
      queryDay: async () => [
        {
          providerId: "anthropic",
          account: "default",
          day,
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

  it("GET /oauth/usage fails open to [] when no usage store is wired", async () => {
    const app = buildApp(buildDeps());
    const res = await app.request("/admin/api/oauth/usage");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ usage: [] });
  });
});

describe("admin.api oauth quota", () => {
  it("GET /oauth/quota refreshes Anthropic, returns only BOUND accounts, and prunes orphans", async () => {
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
      listStatus: async () => [
        { id: "anthropic", name: "A", flow: "manual_paste", accounts: [acct("mylukin")] },
        { id: "openai-codex", name: "C", flow: "manual_paste", accounts: [acct("mylukin")] },
      ],
      fetchAnthropicQuota: async () => [
        { key: "5h", usedPercent: 6, resetsAtMs: 5_000, windowMinutes: null },
      ],
    } as unknown as AdminApiDeps["oauth"];
    const app = buildApp(buildDeps({ oauthQuota, oauth }));
    const res = await app.request("/admin/api/oauth/quota");
    expect(res.status).toBe(200);
    // The Anthropic pull was upserted with source "anthropic".
    expect(upserts).toHaveLength(1);
    expect(upserts[0]).toMatchObject({
      providerId: "anthropic",
      account: "mylukin",
      source: "anthropic",
    });
    // Only BOUND snapshots are returned; the orphan codex/default is dropped.
    const body = (await res.json()) as { quota: Array<{ providerId: string; account: string }> };
    expect(body.quota.map((q) => `${q.providerId}/${q.account}`)).toEqual(["openai-codex/mylukin"]);
    // …and the orphan row is pruned from the store.
    expect(deletes).toEqual([["openai-codex", "default"]]);
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
