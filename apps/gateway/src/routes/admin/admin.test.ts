import type { CreateKeyInput, KeyStore, Lane, PoliciesConfig, TelemetryStore } from "@helm/core";
import { DEFAULT_LANES, parseLanesConfig } from "@helm/core";
import type { ApiKeyRecord, ClassifierConfig, DecisionRecord } from "@helm/shared";
import { ClassifierConfigSchema } from "@helm/shared";
import { Hono } from "hono";
import { beforeEach, describe, expect, it } from "vitest";
import type { AppEnv } from "../../app.js";
import { basicAuth } from "../../middleware/basic-auth.js";
import type { AdminApiDeps, RuleStore } from "./deps.js";
import { registerAdminApi } from "./index.js";

// admin.api — the gateway management API. These tests pin the CONTRACT (DoD
// scenarios 1-8): CRUD lanes/policies/classifier落到 config; keys/requests落到
// Store; invalid input -> 400 不落地; keys绝不回显明文/hash全文; 吊销不就地改写;
// requests只读含 trace_id; all端点 behind basicAuth.

// ── In-memory fakes (no IO; routes are pure glue) ────────────────────────────

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
        max_lane: input.maxLane ?? null,
        allowed_lanes: input.allowedLanes ?? null,
        allow_custom_model: input.allowCustomModel ?? false,
        disabled: false,
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
  };
}

function makeTelemetry(seed: DecisionRecord[] = []): TelemetryStore {
  const rows = [...seed];
  return {
    async insert() {
      return { id: "x" };
    },
    async queryRecent(limit) {
      return rows.slice(0, limit);
    },
    async getByRequestId(id) {
      return rows.find((r) => r.request_id === id) ?? null;
    },
    async queryWindow() {
      return [...rows];
    },
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
      body: JSON.stringify({ role: "user", max_lane: "balanced" }),
    });
    expect(created.status).toBe(201);
    const body = (await created.json()) as { key_id: string; plaintext: string };
    expect(body.plaintext).toBe("helm_live_PLAINTEXT_SECRET");
    expect(body.key_id).toBe("key_1");
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

    // The list returns the full (already-redacted) DecisionRecord per row so the
    // SPA can surface the classification stage / candidate chain / cost without
    // recomputing them (原则1, 原则5). It carries no plaintext key/payload (原则7).
    const list = (await (await app.request("/admin/api/requests")).json()) as DecisionRecord[];
    expect(list).toHaveLength(2);
    expect(list[0]?.trace_id).toBe("trace-1");
    expect(list[0]?.lane.selected_lane).toBe("premium");
    expect(list[0]?.classifier.decided_by).toBe("rules");
    expect(list[0]?.provider_attempts[0]?.cost_usd).toBeCloseTo(0.002);

    const detail = (await (
      await app.request("/admin/api/requests/trace-1")
    ).json()) as DecisionRecord;
    expect(detail.trace_id).toBe("trace-1");
    expect(detail.classifier.task_type).toBe("coding"); // 分类层级
    expect(detail.lane.candidate_chain).toEqual(["premium", "balanced"]); // lane 候选链
    expect(detail.provider_attempts).toHaveLength(1); // provider 尝试
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
