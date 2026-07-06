import type { ApiKeyRecord, DecisionRecord, RoutingSignal } from "@helm/shared";
import { afterEach, describe, expect, it } from "vitest";
import type {
  ConfigStore,
  KeyStore,
  MemoryStore,
  RateLimitStore,
  SignalStore,
  TelemetryStore,
} from "./ports.js";
import { PgConfigStore } from "./postgres/config-store.js";
import { PgKeyStore } from "./postgres/keystore.js";
import { PgMemoryStore } from "./postgres/memory-store.js";
import { createPgliteDb } from "./postgres/migrate.js";
import { PgRateLimitStore } from "./postgres/rate-limit.js";
import { PgSignalStore } from "./postgres/signals.js";
import { PgTelemetryStore } from "./postgres/telemetry.js";
import { SqliteConfigStore } from "./sqlite/config-store.js";
import { SqliteKeyStore } from "./sqlite/keystore.js";
import { SqliteMemoryStore } from "./sqlite/memory-store.js";
import { createSqliteDb } from "./sqlite/migrate.js";
import { SqliteRateLimitStore } from "./sqlite/rate-limit.js";
import { SqliteSignalStore } from "./sqlite/signals.js";
import { SqliteTelemetryStore } from "./sqlite/telemetry.js";

// ONE contract, BOTH real drivers. The DoD ("sqlite and supabase share one contract test") is
// met here: the SAME assertions run against the sqlite adapter AND against the
// Postgres adapters on an in-process PGlite database. supabase == hosted
// Postgres, so the pglite pg-dialect coverage validates the supabase path WITHOUT
// a server. Stable genId/now injected so rows are deterministic across drivers.

interface Adapters {
  keys: KeyStore;
  telemetry: TelemetryStore;
  signals: SignalStore;
  rateLimit: RateLimitStore;
  memory: MemoryStore;
  config: ConfigStore;
}

interface Driver {
  name: string;
  make: () => Promise<{ stores: Adapters; close: () => Promise<void> }>;
}

const drivers: Driver[] = [
  {
    name: "sqlite",
    make: async () => {
      const db = createSqliteDb(":memory:");
      return {
        stores: {
          keys: new SqliteKeyStore(db),
          telemetry: new SqliteTelemetryStore(db),
          signals: new SqliteSignalStore(db),
          rateLimit: new SqliteRateLimitStore(db),
          memory: new SqliteMemoryStore(db),
          config: new SqliteConfigStore(db),
        },
        close: async () => {
          db.$sqlite.close();
        },
      };
    },
  },
  {
    name: "pglite-postgres",
    make: async () => {
      const db = await createPgliteDb();
      return {
        stores: {
          keys: new PgKeyStore(db),
          telemetry: new PgTelemetryStore(db),
          signals: new PgSignalStore(db),
          rateLimit: new PgRateLimitStore(db),
          memory: new PgMemoryStore(db),
          config: new PgConfigStore(db),
        },
        close: () => db.$close(),
      };
    },
  },
];

function decision(requestId: string, overrides: Partial<DecisionRecord> = {}): DecisionRecord {
  return {
    request_id: requestId,
    trace_id: requestId,
    requested_model: "gpt-4o",
    classifier: {
      task_type: "coding",
      complexity: "complex",
      confidence: 0.87,
      decided_by: "rules",
      rules_confidence: null,
      eval_cache_hit: null,
      eval_model: null,
      eval_latency_ms: null,
      constraints: { needs_tools: true },
      explanation: ["code-block"],
    },
    policy: { matched_policy_id: "p1", reason: "coding" },
    lane: { selected_lane: "coding", candidate_chain: ["coding_model", "premium"] },
    provider_attempts: [
      {
        alias: "coding_model",
        skipped: true,
        skip_reason: "circuit_open",
        status: "error",
        error_class: "upstream_error",
        latency_ms: 0,
        cost_usd: null,
        error_detail: null,
      },
      {
        alias: "premium",
        skipped: false,
        skip_reason: null,
        status: "ok",
        error_class: null,
        latency_ms: 1200,
        cost_usd: 0.004,
        error_detail: null,
      },
    ],
    final: { model_alias: "premium", provider_model: "claude-x", status: "ok", error_reason: null },
    key_prefix: "helm_live_ab12",
    protocol: "openai_chat",
    latency_total_ms: 1200,
    fallback_count: 0,
    cost_breakdown: { eval_usd: null, completion_usd: 0.004, total_usd: 0.004 },
    memory: null,
    usage: null,
    generation_ms: null,
    serving_account: null,
    ...overrides,
  };
}

function signal(over: Partial<RoutingSignal> = {}): RoutingSignal {
  return {
    taskType: "chat",
    lane: "balanced",
    windowStart: 1_000,
    windowEnd: 2_000,
    samples: 3,
    successRate: 0.66,
    fallbackRate: 0.1,
    classifierFallbackRate: 0.2,
    errorRate: 0.34,
    p50LatencyMs: 120,
    p95LatencyMs: 300,
    avgCostUsd: 0.0021,
    updatedAt: 5_000,
    ...over,
  };
}

describe.each(drivers)("Store port contract — $name", ({ make }) => {
  let ctx: { stores: Adapters; close: () => Promise<void> };
  afterEach(async () => {
    await ctx?.close();
  });

  // --- KeyStore -----------------------------------------------------------
  describe("KeyStore", () => {
    it("round-trips create -> getByHash with native boolean/array restored", async () => {
      ctx = await make();
      await ctx.stores.keys.createKey({
        keyId: "k1",
        hash: "sha256_h1",
        prefix: "helm_live_ab12",
        accountId: "acct",
        role: "user",
        allowedLanes: ["economy", "balanced"],
        allowCustomModel: true,
        allowFastMode: true,
      });
      const got = await ctx.stores.keys.getByHash("sha256_h1");
      expect(got).toMatchObject<Partial<ApiKeyRecord>>({
        key_id: "k1",
        hash: "sha256_h1",
        prefix: "helm_live_ab12",
        account_id: "acct",
        role: "user",
        allowed_lanes: ["economy", "balanced"],
        allow_custom_model: true,
        allow_fast_mode: true,
        disabled: false,
      });
    });

    it("never persists a plaintext key (only hash + prefix)", async () => {
      ctx = await make();
      await ctx.stores.keys.createKey({
        keyId: "k1",
        hash: "sha256_of_plaintext",
        prefix: "helm_live_ab12",
        accountId: "acct",
        role: "root",
      });
      const got = await ctx.stores.keys.getByHash("sha256_of_plaintext");
      expect(got && "plaintext" in got).toBe(false);
      expect(got?.hash).toBe("sha256_of_plaintext");
    });

    it("disable is a soft flag: key still retrievable, only disabled changes", async () => {
      ctx = await make();
      await ctx.stores.keys.createKey({
        keyId: "k1",
        hash: "h1",
        prefix: "helm_live_a",
        accountId: "acct",
        role: "user",
        allowedLanes: ["economy", "balanced"],
      });
      await ctx.stores.keys.disable("k1");
      const got = await ctx.stores.keys.getByHash("h1");
      expect(got?.disabled).toBe(true);
      expect(got?.allowed_lanes).toEqual(["economy", "balanced"]);
    });

    it("disable on a missing key rejects (not silently)", async () => {
      ctx = await make();
      await expect(ctx.stores.keys.disable("nope")).rejects.toThrow();
    });

    it("list returns [] when empty and all records when populated", async () => {
      ctx = await make();
      expect(await ctx.stores.keys.list()).toEqual([]);
      await ctx.stores.keys.createKey({
        keyId: "k1",
        hash: "h1",
        prefix: "p1",
        accountId: "a",
        role: "root",
      });
      await ctx.stores.keys.createKey({
        keyId: "k2",
        hash: "h2",
        prefix: "p2",
        accountId: "a",
        role: "user",
      });
      expect(await ctx.stores.keys.list()).toHaveLength(2);
    });

    it("getByHash returns null on a miss (no throw)", async () => {
      ctx = await make();
      expect(await ctx.stores.keys.getByHash("unknown")).toBeNull();
    });

    it("rejects a duplicate hash (unique constraint)", async () => {
      ctx = await make();
      await ctx.stores.keys.createKey({
        keyId: "k1",
        hash: "same",
        prefix: "p1",
        accountId: "a",
        role: "root",
      });
      await expect(
        ctx.stores.keys.createKey({
          keyId: "k2",
          hash: "same",
          prefix: "p2",
          accountId: "a",
          role: "user",
        }),
      ).rejects.toThrow();
    });

    it("stores optional encrypted recovery material and rotates secret identity in-place", async () => {
      ctx = await make();
      await ctx.stores.keys.createKey({
        keyId: "k1",
        hash: "h1",
        prefix: "helm_live_old",
        secretEnc: "enc:old",
        accountId: "a",
        role: "user",
        name: "Production",
        allowedLanes: ["balanced"],
        rateLimitRpm: 7,
      });
      expect(await ctx.stores.keys.getSecretEnc("k1")).toBe("enc:old");

      await ctx.stores.keys.rotateKey("k1", {
        hash: "h2",
        prefix: "helm_live_new",
        secretEnc: "enc:new",
      });

      expect(await ctx.stores.keys.getByHash("h1")).toBeNull();
      const got = await ctx.stores.keys.getByHash("h2");
      expect(got).toMatchObject<Partial<ApiKeyRecord>>({
        key_id: "k1",
        prefix: "helm_live_new",
        name: "Production",
        allowed_lanes: ["balanced"],
        rate_limit_rpm: 7,
      });
      expect(await ctx.stores.keys.getSecretEnc("k1")).toBe("enc:new");
    });

    it("per-key rate limits: omitted -> null, set at create round-trips, updateKey edits", async () => {
      ctx = await make();
      // omitted -> null (inherit system default)
      await ctx.stores.keys.createKey({
        keyId: "k1",
        hash: "h1",
        prefix: "p1",
        accountId: "a",
        role: "user",
      });
      let got = await ctx.stores.keys.getByHash("h1");
      expect(got?.rate_limit_rpm).toBeNull();
      expect(got?.rate_limit_tpm).toBeNull();
      // set at create (0 = explicit unlimited for that dimension)
      await ctx.stores.keys.createKey({
        keyId: "k2",
        hash: "h2",
        prefix: "p2",
        accountId: "a",
        role: "user",
        rateLimitRpm: 60,
        rateLimitTpm: 0,
      });
      got = await ctx.stores.keys.getByHash("h2");
      expect(got?.rate_limit_rpm).toBe(60);
      expect(got?.rate_limit_tpm).toBe(0);
      // edit + clear back to inherit
      await ctx.stores.keys.updateKey("k1", { rateLimitRpm: 100, rateLimitTpm: 5000 });
      got = await ctx.stores.keys.getByHash("h1");
      expect(got?.rate_limit_rpm).toBe(100);
      expect(got?.rate_limit_tpm).toBe(5000);
      // PARTIAL: patching only rpm leaves tpm untouched (no concurrent-clobber).
      await ctx.stores.keys.updateKey("k1", { rateLimitRpm: 7 });
      got = await ctx.stores.keys.getByHash("h1");
      expect(got?.rate_limit_rpm).toBe(7);
      expect(got?.rate_limit_tpm).toBe(5000);
      await ctx.stores.keys.updateKey("k1", { rateLimitRpm: null, rateLimitTpm: null });
      got = await ctx.stores.keys.getByHash("h1");
      expect(got?.rate_limit_rpm).toBeNull();
      expect(got?.rate_limit_tpm).toBeNull();
    });

    it("concurrency_limit: omitted -> null (unlimited), set at create round-trips, updateKey edits + clears", async () => {
      ctx = await make();
      // omitted -> null (unlimited)
      await ctx.stores.keys.createKey({
        keyId: "k1",
        hash: "h1",
        prefix: "p1",
        accountId: "a",
        role: "user",
      });
      let got = await ctx.stores.keys.getByHash("h1");
      expect(got?.concurrency_limit).toBeNull();
      // set at create
      await ctx.stores.keys.createKey({
        keyId: "k2",
        hash: "h2",
        prefix: "p2",
        accountId: "a",
        role: "user",
        concurrencyLimit: 4,
      });
      got = await ctx.stores.keys.getByHash("h2");
      expect(got?.concurrency_limit).toBe(4);
      // edit, then clear back to unlimited; sibling caps untouched (no clobber)
      await ctx.stores.keys.updateKey("k1", { concurrencyLimit: 2, rateLimitRpm: 9 });
      got = await ctx.stores.keys.getByHash("h1");
      expect(got?.concurrency_limit).toBe(2);
      expect(got?.rate_limit_rpm).toBe(9);
      await ctx.stores.keys.updateKey("k1", { concurrencyLimit: null });
      got = await ctx.stores.keys.getByHash("h1");
      expect(got?.concurrency_limit).toBeNull();
      expect(got?.rate_limit_rpm).toBe(9);
    });

    it("memory defaults: omitted -> off/null/auto, set at create round-trips, updateKey edits + clears", async () => {
      ctx = await make();
      // omitted -> a new key is fail-safe by default (memory off) while keeping
      // thread_source auto so an explicitly memory-enabled key can derive a thread.
      await ctx.stores.keys.createKey({
        keyId: "k1",
        hash: "h1",
        prefix: "p1",
        accountId: "a",
        role: "user",
      });
      let got = await ctx.stores.keys.getByHash("h1");
      expect(got?.memory_mode).toBe("off");
      expect(got?.memory_project_id).toBeNull();
      expect(got?.memory_thread_source).toBe("auto");
      // set at create
      await ctx.stores.keys.createKey({
        keyId: "k2",
        hash: "h2",
        prefix: "p2",
        accountId: "a",
        role: "user",
        memoryMode: "inject",
        memoryProjectId: "proj-1",
        memoryThreadSource: "auto",
      });
      got = await ctx.stores.keys.getByHash("h2");
      expect(got?.memory_mode).toBe("inject");
      expect(got?.memory_project_id).toBe("proj-1");
      expect(got?.memory_thread_source).toBe("auto");
      // edit; sibling caps untouched (no clobber)
      await ctx.stores.keys.updateKey("k1", { memoryMode: "observe", rateLimitRpm: 9 });
      got = await ctx.stores.keys.getByHash("h1");
      expect(got?.memory_mode).toBe("observe");
      expect(got?.rate_limit_rpm).toBe(9);
      // clear the project id back to null; mode/source keep their values
      await ctx.stores.keys.updateKey("k2", { memoryProjectId: null });
      got = await ctx.stores.keys.getByHash("h2");
      expect(got?.memory_project_id).toBeNull();
      expect(got?.memory_mode).toBe("inject");
      expect(got?.memory_thread_source).toBe("auto");
    });

    it("updateKey edits caps (allowed_lanes / allow_custom_model / allow_fast_mode) and clears with null", async () => {
      ctx = await make();
      await ctx.stores.keys.createKey({
        keyId: "k1",
        hash: "h1",
        prefix: "p1",
        accountId: "a",
        role: "user",
      });
      await ctx.stores.keys.updateKey("k1", {
        allowedLanes: ["economy", "balanced"],
        allowCustomModel: true,
        blockedModels: ["gpt-4o"],
        allowFastMode: true,
      });
      let got = await ctx.stores.keys.getByHash("h1");
      expect(got?.allowed_lanes).toEqual(["economy", "balanced"]);
      expect(got?.allow_custom_model).toBe(true);
      expect(got?.blocked_models).toEqual(["gpt-4o"]);
      expect(got?.allow_fast_mode).toBe(true);
      expect(got?.role).toBe("user"); // never rewritten by updateKey
      // null clears the whitelist back to "no cap"; an omitted field is left untouched.
      await ctx.stores.keys.updateKey("k1", { allowedLanes: null, blockedModels: null });
      got = await ctx.stores.keys.getByHash("h1");
      expect(got?.allowed_lanes).toBeNull();
      expect(got?.allow_custom_model).toBe(true);
      expect(got?.blocked_models).toBeNull();
      expect(got?.allow_fast_mode).toBe(true);
    });

    it("updateKey on a missing key rejects (not silently)", async () => {
      ctx = await make();
      await expect(
        ctx.stores.keys.updateKey("nope", { rateLimitRpm: 1, rateLimitTpm: 1 }),
      ).rejects.toThrow();
    });
  });

  // --- TelemetryStore -----------------------------------------------------
  describe("TelemetryStore", () => {
    it("round-trips insert -> queryRecent without losing nested structure", async () => {
      ctx = await make();
      await ctx.stores.telemetry.insert({
        decision: decision("req_1"),
        apiKeyId: "k1",
        createdAt: new Date(),
      });
      const recent = await ctx.stores.telemetry.queryRecent(10);
      expect(recent).toHaveLength(1);
      expect(recent[0]?.record).toEqual(decision("req_1"));
      expect(recent[0]?.createdAt).toBeInstanceOf(Date);
    });

    // Batch variants the deferred write queue prefers — both adapters implement
    // them and a batch must be indistinguishable from N single inserts/upserts.
    it("insertMany + insertPayloads batch identically to single writes", async () => {
      ctx = await make();
      const t = ctx.stores.telemetry;
      if (!t.insertMany || !t.insertPayloads) throw new Error("batch methods required");
      const at = new Date(1_700_000_000_000);
      await t.insertMany([
        { decision: decision("req_a"), apiKeyId: "k1", createdAt: at },
        { decision: decision("req_b"), apiKeyId: "k2", createdAt: at },
      ]);
      const recent = await t.queryRecent(10);
      expect(recent.map((r) => r.record.request_id).sort()).toEqual(["req_a", "req_b"]);
      expect(await t.getApiKeyId("req_b")).toBe("k2");

      await t.insertPayloads([
        { requestId: "req_a", requestJson: '{"q":1}', responseJson: '{"r":1}', createdAt: at },
        { requestId: "req_b", requestJson: '{"q":2}', responseJson: null, createdAt: at },
      ]);
      expect((await t.getPayload("req_a"))?.responseJson).toBe('{"r":1}');
      // Re-batch the same id with a backfilled response → upsert, not duplicate.
      await t.insertPayloads([
        { requestId: "req_b", requestJson: '{"q":2}', responseJson: '{"r":2}', createdAt: at },
      ]);
      expect((await t.getPayload("req_b"))?.responseJson).toBe('{"r":2}');

      await expect(t.insertMany([])).resolves.toBeUndefined();
      await expect(t.insertPayloads([])).resolves.toBeUndefined();
    });

    it("round-trips a populated per-attempt error_detail (upstream status + message + raw body)", async () => {
      ctx = await make();
      const withDetail = decision("req_detail", {
        provider_attempts: [
          {
            alias: "deepseek/deepseek-v4-flash",
            skipped: false,
            skip_reason: null,
            status: "error",
            error_class: "upstream_error",
            latency_ms: 306,
            cost_usd: null,
            error_detail: {
              upstream_status: 429,
              message: "upstream returned 429",
              provider_raw: { error: { message: "rate limit exceeded", type: "rate_limit_error" } },
            },
          },
          {
            alias: "deepseek/deepseek-v4-pro",
            skipped: false,
            skip_reason: null,
            status: "ok",
            error_class: null,
            latency_ms: 2675,
            cost_usd: 0.003,
            error_detail: null,
          },
        ],
      });
      await ctx.stores.telemetry.insert({
        decision: withDetail,
        apiKeyId: "k1",
        createdAt: new Date(),
      });
      const got = await ctx.stores.telemetry.getByRequestId("req_detail");
      expect(got?.provider_attempts[0]?.error_detail).toEqual({
        upstream_status: 429,
        message: "upstream returned 429",
        provider_raw: { error: { message: "rate limit exceeded", type: "rate_limit_error" } },
      });
      expect(got?.provider_attempts[1]?.error_detail).toBeNull();
    });

    it("getByRequestId returns the record, null on a miss", async () => {
      ctx = await make();
      await ctx.stores.telemetry.insert({
        decision: decision("req_1"),
        apiKeyId: "k1",
        createdAt: new Date(),
      });
      expect((await ctx.stores.telemetry.getByRequestId("req_1"))?.request_id).toBe("req_1");
      expect(await ctx.stores.telemetry.getByRequestId("nope")).toBeNull();
    });

    it("getApiKeyId returns the recorded key_id, null on a miss", async () => {
      ctx = await make();
      await ctx.stores.telemetry.insert({
        decision: decision("req_1"),
        apiKeyId: "key_abc",
        createdAt: new Date(),
      });
      // The redacted DecisionRecord carries key_prefix only — the replay path
      // needs the api_key_id (separate column) to reconstruct the original
      // identity, so it is surfaced by its own narrow lookup.
      expect(await ctx.stores.telemetry.getApiKeyId("req_1")).toBe("key_abc");
      expect(await ctx.stores.telemetry.getApiKeyId("nope")).toBeNull();
    });

    it("getCreatedAt returns the recorded timestamp, null on a miss", async () => {
      ctx = await make();
      const stamp = new Date(1_700_000_000_000);
      await ctx.stores.telemetry.insert({
        decision: decision("req_1"),
        apiKeyId: "k1",
        createdAt: stamp,
      });
      // The redacted DecisionRecord has no timestamp field; the detail header
      // resolves the request time through this narrow lookup (same column the
      // list endpoint flattens as created_at).
      expect((await ctx.stores.telemetry.getCreatedAt("req_1"))?.getTime()).toBe(stamp.getTime());
      expect(await ctx.stores.telemetry.getCreatedAt("nope")).toBeNull();
    });

    it("stores no plaintext key and no raw message payload", async () => {
      ctx = await make();
      await ctx.stores.telemetry.insert({
        decision: decision("req_1"),
        apiKeyId: "k1",
        createdAt: new Date(),
      });
      const got = await ctx.stores.telemetry.getByRequestId("req_1");
      const serialized = JSON.stringify(got);
      expect(serialized).not.toContain("sk-");
      expect(got && "messages" in got).toBe(false);
    });

    it("orders by created_at desc and respects limit", async () => {
      ctx = await make();
      await ctx.stores.telemetry.insert({
        decision: decision("old"),
        apiKeyId: "k1",
        createdAt: new Date(1000),
      });
      await ctx.stores.telemetry.insert({
        decision: decision("mid"),
        apiKeyId: "k1",
        createdAt: new Date(2000),
      });
      await ctx.stores.telemetry.insert({
        decision: decision("new"),
        apiKeyId: "k1",
        createdAt: new Date(3000),
      });
      const recent = await ctx.stores.telemetry.queryRecent(2);
      expect(recent.map((r) => r.record.request_id)).toEqual(["new", "mid"]);
    });

    it("queryWindow returns half-open [start, end) matches in asc order", async () => {
      ctx = await make();
      for (const [id, ms] of [
        ["a", 1000],
        ["b", 2000],
        ["c", 3000],
      ] as const) {
        await ctx.stores.telemetry.insert({
          decision: decision(id),
          apiKeyId: "k1",
          createdAt: new Date(ms),
        });
      }
      const win = await ctx.stores.telemetry.queryWindow(1000, 3000);
      expect(win.map((r) => r.request_id)).toEqual(["a", "b"]); // c at 3000 excluded
    });

    // Dashboard token-accounting aggregate (admin homepage). ONE method, three
    // shapes — totals / per-bucket series / per-served-model — all computed in SQL.
    // Runs against BOTH adapters so the integer-division bucketing + COALESCE/SUM
    // semantics are pinned identical across sqlite and postgres (the dialect-parity
    // guard the plan calls out). The fixture spans two UTC days with known
    // usage + served_model so every returned number is hand-checkable.
    it("aggregate rolls up totals, a day-bucketed series, and a by-model breakdown", async () => {
      ctx = await make();
      const DAY = 86_400_000;
      const day0 = 10 * DAY; // arbitrary UTC-midnight-aligned epoch ms
      const day1 = 11 * DAY;
      // Helper: a served decision carrying a token usage block + served model.
      const served = (
        id: string,
        servedModel: string,
        usage: { prompt: number; completion: number; cached?: number; cacheCreation?: number },
        status: "ok" | "error" = "ok",
      ) =>
        decision(id, {
          usage: {
            prompt_tokens: usage.prompt,
            completion_tokens: usage.completion,
            cached_tokens: usage.cached ?? null,
            cache_creation_tokens: usage.cacheCreation ?? null,
          },
          final: {
            model_alias: servedModel,
            provider_model: servedModel,
            status,
            error_reason: status === "error" ? "upstream_error" : null,
          },
        });
      // Day 0: two gpt-4o rows (one ok, one error) + one claude row.
      await ctx.stores.telemetry.insert({
        decision: served("d0a", "gpt-4o", { prompt: 100, completion: 20, cached: 80 }),
        apiKeyId: "k1",
        createdAt: new Date(day0 + 1000),
      });
      await ctx.stores.telemetry.insert({
        decision: served("d0b", "gpt-4o", { prompt: 50, completion: 10 }, "error"),
        apiKeyId: "k1",
        createdAt: new Date(day0 + 2000),
      });
      await ctx.stores.telemetry.insert({
        decision: served("d0c", "claude-x", { prompt: 200, completion: 40, cacheCreation: 16 }),
        apiKeyId: "k1",
        createdAt: new Date(day0 + 3000),
      });
      // Day 1: one gpt-4o row.
      await ctx.stores.telemetry.insert({
        decision: served("d1a", "gpt-4o", { prompt: 10, completion: 5 }),
        apiKeyId: "k1",
        createdAt: new Date(day1 + 1000),
      });

      const agg = await ctx.stores.telemetry.aggregate(day0, day1 + DAY, "day");

      // Totals: 4 requests, 1 error, summed tokens.
      expect(agg.totals.requests).toBe(4);
      expect(agg.totals.okCount).toBe(3);
      expect(agg.totals.errorCount).toBe(1);
      expect(agg.totals.promptTokens).toBe(360); // 100+50+200+10
      expect(agg.totals.completionTokens).toBe(75); // 20+10+40+5
      expect(agg.totals.cachedTokens).toBe(80);
      expect(agg.totals.cacheCreationTokens).toBe(16);
      expect(agg.totals.avgLatencyMs).toBe(1200);

      // Series: two day buckets, chronological, summed per day.
      expect(agg.series).toHaveLength(2);
      expect(agg.series[0]?.bucketStartMs).toBe(day0);
      expect(agg.series[0]?.requests).toBe(3);
      expect(agg.series[0]?.promptTokens).toBe(350); // 100+50+200
      expect(agg.series[0]?.completionTokens).toBe(70); // 20+10+40
      expect(agg.series[1]?.bucketStartMs).toBe(day1);
      expect(agg.series[1]?.requests).toBe(1);
      expect(agg.series[1]?.promptTokens).toBe(10);
      // Cost per bucket: each served row carries the default decision's $0.004 attempt.
      expect(agg.series[0]?.costUsd).toBeCloseTo(0.012, 10); // 3 rows × 0.004
      expect(agg.series[1]?.costUsd).toBeCloseTo(0.004, 10);

      // By-model: ordered by total tokens desc — gpt-4o (185) before claude-x (240)?
      // claude-x total = 200+40 = 240 > gpt-4o 100+20+50+10+10+5 = 195. claude first.
      expect(agg.byModel.map((m) => m.servedModel)).toEqual(["claude-x", "gpt-4o"]);
      const gpt = agg.byModel.find((m) => m.servedModel === "gpt-4o");
      expect(gpt?.requests).toBe(3);
      expect(gpt?.promptTokens).toBe(160); // 100+50+10
      expect(gpt?.completionTokens).toBe(35); // 20+10+5
      expect(gpt?.totalTokens).toBe(195);
      expect(gpt?.costUsd).toBeCloseTo(0.012, 10); // d0a + d0b + d1a, each 0.004
      const claude = agg.byModel.find((m) => m.servedModel === "claude-x");
      expect(claude?.totalTokens).toBe(240);
      expect(claude?.costUsd).toBeCloseTo(0.004, 10); // d0c only
    });

    // True-TPS dashboard average: an aggregate ratio Σcompletion / Σgeneration_ms ×
    // 1000, NOT a mean of per-request rates (which tiny requests would skew). The
    // numerator and denominator count the SAME rows — only streaming rows with a
    // measured generation window (generation_ms > 0) — so a non-streaming row (no
    // window) never dilutes the rate. Pinned identical across both adapters.
    it("aggregate computes avgTps = Σcompletion ÷ Σgeneration_ms (streaming rows only)", async () => {
      ctx = await make();
      const DAY = 86_400_000;
      const day0 = 20 * DAY;
      const streamed = (id: string, completion: number, generationMs: number | null) =>
        decision(id, {
          usage: {
            prompt_tokens: 10,
            completion_tokens: completion,
            cached_tokens: null,
            cache_creation_tokens: null,
          },
          generation_ms: generationMs,
        });
      // Two streaming rows (windowed) + one non-streaming row (generation_ms null,
      // must be EXCLUDED) + one degenerate zero-window row (excluded by > 0 guard).
      await ctx.stores.telemetry.insert({
        decision: streamed("g0", 100, 2000),
        apiKeyId: "k1",
        createdAt: new Date(day0 + 1000),
      });
      await ctx.stores.telemetry.insert({
        decision: streamed("g1", 50, 1000),
        apiKeyId: "k1",
        createdAt: new Date(day0 + 2000),
      });
      await ctx.stores.telemetry.insert({
        decision: streamed("g2", 999, null), // non-streaming — excluded entirely
        apiKeyId: "k1",
        createdAt: new Date(day0 + 3000),
      });
      await ctx.stores.telemetry.insert({
        decision: streamed("g3", 999, 0), // zero window — excluded by the > 0 guard
        apiKeyId: "k1",
        createdAt: new Date(day0 + 4000),
      });

      const agg = await ctx.stores.telemetry.aggregate(day0, day0 + DAY, "day");
      // (100 + 50) / (2000 + 1000) ms × 1000 = 150 / 3 s = 50 tok/s.
      expect(agg.totals.avgTps).toBeCloseTo(50);
    });

    it("aggregate avgTps is null when no row has a measured generation window", async () => {
      ctx = await make();
      const DAY = 86_400_000;
      const day0 = 30 * DAY;
      await ctx.stores.telemetry.insert({
        decision: decision("n0", {
          usage: {
            prompt_tokens: 10,
            completion_tokens: 40,
            cached_tokens: null,
            cache_creation_tokens: null,
          },
          generation_ms: null,
        }),
        apiKeyId: "k1",
        createdAt: new Date(day0 + 1000),
      });
      const agg = await ctx.stores.telemetry.aggregate(day0, day0 + DAY, "day");
      expect(agg.totals.avgTps).toBeNull();
    });

    it("aggregate reads an empty window as zeros (not nulls), hour buckets honored", async () => {
      ctx = await make();
      const HOUR = 3_600_000;
      const base = 100 * HOUR;
      // Two rows in the SAME hour + one the next hour, no usage block on one row
      // (legacy/forward-only): its token columns are null and must COALESCE to 0.
      await ctx.stores.telemetry.insert({
        decision: decision("h0", {
          usage: {
            prompt_tokens: 10,
            completion_tokens: 2,
            cached_tokens: null,
            cache_creation_tokens: null,
          },
        }),
        apiKeyId: "k1",
        createdAt: new Date(base + 60_000),
      });
      await ctx.stores.telemetry.insert({
        decision: decision("h0b"), // usage: null (legacy row)
        apiKeyId: "k1",
        createdAt: new Date(base + 120_000),
      });
      await ctx.stores.telemetry.insert({
        decision: decision("h1", {
          usage: {
            prompt_tokens: 5,
            completion_tokens: 1,
            cached_tokens: null,
            cache_creation_tokens: null,
          },
        }),
        apiKeyId: "k1",
        createdAt: new Date(base + HOUR + 1000),
      });

      const agg = await ctx.stores.telemetry.aggregate(base, base + 2 * HOUR, "hour");
      expect(agg.series).toHaveLength(2);
      expect(agg.series[0]?.bucketStartMs).toBe(base);
      expect(agg.series[0]?.requests).toBe(2);
      expect(agg.series[0]?.promptTokens).toBe(10); // legacy null row contributes 0
      expect(agg.series[1]?.bucketStartMs).toBe(base + HOUR);
      expect(agg.totals.promptTokens).toBe(15);

      // A window with no rows: zero counters, no buckets, no models.
      const empty = await ctx.stores.telemetry.aggregate(0, 1000, "day");
      expect(empty.totals.requests).toBe(0);
      expect(empty.totals.promptTokens).toBe(0);
      expect(empty.series).toEqual([]);
      expect(empty.byModel).toEqual([]);
    });

    // Offset-aware bucketing — the "8am boundary" fix. The SAME rows bucket
    // differently by the client's UTC offset: a row at 22:00 UTC day-19 sits in the
    // day-19 UTC bucket, but in the LOCAL day-20 bucket for a UTC+8 (+480) client
    // (it is 06:00 local on day 20). Runs against BOTH adapters so the
    // shift-floor-unshift math stays identical across sqlite + pg, and the in-memory
    // mock mirrors it. Hand-checkable: three rows straddling a UTC midnight.
    it("aggregate buckets the series in the client's local day (tzOffsetMinutes)", async () => {
      ctx = await make();
      const DAY = 86_400_000;
      const HOUR = 3_600_000;
      const OFFSET = 480; // UTC+8
      const offsetMs = OFFSET * 60_000; // 8h
      const d20 = 20 * DAY; // a UTC-midnight-aligned epoch ms
      const tok = (id: string, atMs: number, prompt: number) =>
        ctx.stores.telemetry.insert({
          decision: decision(id, {
            usage: {
              prompt_tokens: prompt,
              completion_tokens: 0,
              cached_tokens: null,
              cache_creation_tokens: null,
            },
          }),
          apiKeyId: "k1",
          createdAt: new Date(atMs),
        });
      // C: 14:00 UTC day-19 → 22:00 local day-19. B: 22:00 UTC day-19 → 06:00 local
      // day-20. A: 01:00 UTC day-20 → 09:00 local day-20.
      await tok("c", d20 - 10 * HOUR, 7);
      await tok("b", d20 - 2 * HOUR, 50);
      await tok("a", d20 + 1 * HOUR, 100);
      const start = 19 * DAY;
      const end = 21 * DAY;

      // UTC (offset 0 = legacy default): B groups with C in the day-19 UTC bucket.
      const utc = await ctx.stores.telemetry.aggregate(start, end, "day", 0);
      expect(utc.series.map((s) => [s.bucketStartMs, s.promptTokens])).toEqual([
        [19 * DAY, 57], // C(7) + B(50)
        [20 * DAY, 100], // A
      ]);

      // UTC+8: B moves to the LOCAL day-20 bucket with A; buckets floor to local
      // midnight (= UTC midnight − 8h).
      const local = await ctx.stores.telemetry.aggregate(start, end, "day", OFFSET);
      expect(local.series.map((s) => [s.bucketStartMs, s.promptTokens])).toEqual([
        [19 * DAY - offsetMs, 7], // C alone (local day-19)
        [20 * DAY - offsetMs, 150], // B(50) + A(100) (local day-20)
      ]);
      // Totals are window-wide and offset-independent.
      expect(local.totals.promptTokens).toBe(157);
    });

    // Per-key usage rollup (the /admin/keys list "Usage" column). ONE GROUP BY
    // api_key_id over the denormalized columns — runs against BOTH adapters so the
    // COUNT/SUM/COALESCE + nullable-cost semantics stay identical. The fixture mixes
    // two keys inside the window + one row outside it, so grouping + the half-open
    // bound are both hand-checkable.
    it("usageByKey rolls up requests/errors/cost/tokens per key over the window", async () => {
      ctx = await make();
      const served = (
        id: string,
        usage: { prompt: number; completion: number },
        status: "ok" | "error",
        cost: number | null,
      ) =>
        decision(id, {
          usage: {
            prompt_tokens: usage.prompt,
            completion_tokens: usage.completion,
            cached_tokens: null,
            cache_creation_tokens: null,
          },
          provider_attempts: [
            {
              alias: "premium",
              skipped: false,
              skip_reason: null,
              status,
              error_class: status === "error" ? "upstream_error" : null,
              latency_ms: 100,
              cost_usd: cost,
              error_detail: null,
            },
          ],
          final: {
            model_alias: "premium",
            provider_model: "claude-x",
            status,
            error_reason: status === "error" ? "upstream_error" : null,
          },
        });
      // k1: two rows (one ok, one error) inside [1000, 4000).
      await ctx.stores.telemetry.insert({
        decision: served("k1a", { prompt: 100, completion: 20 }, "ok", 0.004),
        apiKeyId: "k1",
        createdAt: new Date(1000),
      });
      await ctx.stores.telemetry.insert({
        decision: served("k1b", { prompt: 50, completion: 10 }, "error", null),
        apiKeyId: "k1",
        createdAt: new Date(2000),
      });
      // k2: one ok row inside the window.
      await ctx.stores.telemetry.insert({
        decision: served("k2a", { prompt: 10, completion: 5 }, "ok", 0.001),
        apiKeyId: "k2",
        createdAt: new Date(3000),
      });
      // k1: one row OUTSIDE the window (at the exclusive end) — must be ignored.
      await ctx.stores.telemetry.insert({
        decision: served("k1c", { prompt: 999, completion: 999 }, "ok", 9),
        apiKeyId: "k1",
        createdAt: new Date(4000),
      });

      const usage = await ctx.stores.telemetry.usageByKey(1000, 4000);
      // Ordered requests desc, then apiKeyId — k1 (2 reqs) before k2 (1 req).
      expect(usage.map((u) => u.apiKeyId)).toEqual(["k1", "k2"]);
      const k1 = usage.find((u) => u.apiKeyId === "k1");
      expect(k1?.requests).toBe(2);
      expect(k1?.errorCount).toBe(1);
      expect(k1?.totalCostUsd).toBeCloseTo(0.004, 6); // k1b cost null → only k1a
      expect(k1?.totalTokens).toBe(180); // (100+20) + (50+10)
      const k2 = usage.find((u) => u.apiKeyId === "k2");
      expect(k2?.requests).toBe(1);
      expect(k2?.errorCount).toBe(0);
      expect(k2?.totalCostUsd).toBeCloseTo(0.001, 6);
      expect(k2?.totalTokens).toBe(15);
    });

    it("usageByKey reports cost null when no priced row exists for a key", async () => {
      ctx = await make();
      await ctx.stores.telemetry.insert({
        decision: decision("np", {
          usage: {
            prompt_tokens: 5,
            completion_tokens: 5,
            cached_tokens: null,
            cache_creation_tokens: null,
          },
          provider_attempts: [
            {
              alias: "premium",
              skipped: false,
              skip_reason: null,
              status: "ok",
              error_class: null,
              latency_ms: 10,
              cost_usd: null, // unpriced model → never measured
              error_detail: null,
            },
          ],
        }),
        apiKeyId: "kx",
        createdAt: new Date(1000),
      });
      const usage = await ctx.stores.telemetry.usageByKey(0, 5000);
      expect(usage[0]?.totalCostUsd).toBeNull(); // honest "not measured", not 0
      expect(usage[0]?.totalTokens).toBe(10);
    });

    // The detail page reuses the dashboard aggregate scoped to ONE key. Same three
    // shapes, filtered to a single api_key_id — pinned across both adapters.
    it("aggregate scopes every shape to a single key when keyId is given", async () => {
      ctx = await make();
      const DAY = 86_400_000;
      const day0 = 30 * DAY;
      const served = (id: string, key: string, model: string, prompt: number) =>
        ctx.stores.telemetry.insert({
          decision: decision(id, {
            usage: {
              prompt_tokens: prompt,
              completion_tokens: 0,
              cached_tokens: null,
              cache_creation_tokens: null,
            },
            final: { model_alias: model, provider_model: model, status: "ok", error_reason: null },
          }),
          apiKeyId: key,
          createdAt: new Date(day0 + 1000),
        });
      await served("a", "k1", "gpt-4o", 100);
      await served("b", "k1", "gpt-4o", 50);
      await served("c", "k2", "claude-x", 999);

      const scoped = await ctx.stores.telemetry.aggregate(day0, day0 + DAY, "day", 0, "k1");
      expect(scoped.totals.requests).toBe(2); // k2's row excluded
      expect(scoped.totals.promptTokens).toBe(150);
      expect(scoped.byModel.map((m) => m.servedModel)).toEqual(["gpt-4o"]);

      // Omitting keyId keeps the global view (all keys).
      const global = await ctx.stores.telemetry.aggregate(day0, day0 + DAY, "day", 0);
      expect(global.totals.requests).toBe(3);
    });

    // queryPage drives the admin Debug list: numbered pagination + the error/role
    // filters. This runs against BOTH adapters so the JSON-path filtering (sqlite
    // json_extract vs postgres jsonb ->>) is verified against real engines.
    it("queryPage paginates createdAt DESC and reports the full filtered total", async () => {
      ctx = await make();
      for (let i = 0; i < 5; i++) {
        await ctx.stores.telemetry.insert({
          decision: decision(`r${i}`),
          apiKeyId: "k1",
          createdAt: new Date(1000 + i * 1000),
        });
      }
      const page1 = await ctx.stores.telemetry.queryPage({ limit: 2, offset: 0 });
      expect(page1.total).toBe(5);
      expect(page1.rows.map((r) => r.record.request_id)).toEqual(["r4", "r3"]);
      const page3 = await ctx.stores.telemetry.queryPage({ limit: 2, offset: 4 });
      expect(page3.rows.map((r) => r.record.request_id)).toEqual(["r0"]);
    });

    it("queryPage filters by status, decided_by, lane, model and date window", async () => {
      ctx = await make();
      const mk = (
        id: string,
        ms: number,
        f: {
          status?: "ok" | "error";
          decidedBy?: DecisionRecord["classifier"]["decided_by"];
          lane?: string;
          requested?: string;
          served?: string;
        },
      ) => {
        const base = decision(id);
        return ctx.stores.telemetry.insert({
          apiKeyId: "k1",
          createdAt: new Date(ms),
          decision: {
            ...base,
            requested_model: f.requested ?? base.requested_model,
            classifier: {
              ...base.classifier,
              decided_by: f.decidedBy ?? base.classifier.decided_by,
            },
            lane: { ...base.lane, selected_lane: f.lane ?? base.lane.selected_lane },
            final: {
              ...base.final,
              status: f.status ?? base.final.status,
              model_alias: f.served ?? base.final.model_alias,
              error_reason: (f.status ?? base.final.status) === "error" ? "upstream_error" : null,
            },
          },
        });
      };
      // ok_rules uses non-gpt models so the "gpt-4o" search below excludes it
      // (the shared decision() default requested_model is "gpt-4o").
      await mk("ok_rules", 1000, {
        status: "ok",
        decidedBy: "rules",
        lane: "balanced",
        requested: "claude-3",
        served: "claude-x",
      });
      await mk("err_eval", 2000, {
        status: "error",
        decidedBy: "eval",
        lane: "premium",
        served: "GPT-4o",
      });
      await mk("ok_eval", 3000, {
        status: "ok",
        decidedBy: "eval",
        lane: "premium",
        requested: "gpt-4o-mini",
      });

      expect(
        (await ctx.stores.telemetry.queryPage({ limit: 50, offset: 0, status: "error" })).rows.map(
          (r) => r.record.request_id,
        ),
      ).toEqual(["err_eval"]);
      expect(
        (await ctx.stores.telemetry.queryPage({ limit: 50, offset: 0, decidedBy: "eval" })).total,
      ).toBe(2);
      expect(
        (await ctx.stores.telemetry.queryPage({ limit: 50, offset: 0, lane: "premium" })).total,
      ).toBe(2);
      // model matches requested OR served OR lane/channel, case-insensitive
      expect(
        (await ctx.stores.telemetry.queryPage({ limit: 50, offset: 0, model: "gpt-4o" })).rows
          .map((r) => r.record.request_id)
          .sort(),
      ).toEqual(["err_eval", "ok_eval"]);
      expect(
        (await ctx.stores.telemetry.queryPage({ limit: 50, offset: 0, model: "prem" })).rows
          .map((r) => r.record.request_id)
          .sort(),
      ).toEqual(["err_eval", "ok_eval"]);
      // half-open [start, end)
      expect(
        (
          await ctx.stores.telemetry.queryPage({ limit: 50, offset: 0, startMs: 2000, endMs: 3000 })
        ).rows.map((r) => r.record.request_id),
      ).toEqual(["err_eval"]);
    });

    // The key detail page's request list scopes queryPage to one api_key_id —
    // EXACT equality on the denormalized column (not a JSON extract). Pinned across
    // both adapters; total reflects the same scope so "Page X of Y" stays right.
    it("queryPage filters by apiKeyId (exact key scope)", async () => {
      ctx = await make();
      await ctx.stores.telemetry.insert({
        decision: decision("ka1"),
        apiKeyId: "key_a",
        createdAt: new Date(1000),
      });
      await ctx.stores.telemetry.insert({
        decision: decision("ka2"),
        apiKeyId: "key_a",
        createdAt: new Date(2000),
      });
      await ctx.stores.telemetry.insert({
        decision: decision("kb1"),
        apiKeyId: "key_b",
        createdAt: new Date(3000),
      });
      const scoped = await ctx.stores.telemetry.queryPage({
        limit: 50,
        offset: 0,
        apiKeyId: "key_a",
      });
      expect(scoped.total).toBe(2);
      expect(scoped.rows.map((r) => r.record.request_id).sort()).toEqual(["ka1", "ka2"]);
      // Unknown key → empty page, not an error.
      expect(
        (await ctx.stores.telemetry.queryPage({ limit: 50, offset: 0, apiKeyId: "nope" })).total,
      ).toBe(0);
    });

    it("rejects a duplicate request_id (unique constraint)", async () => {
      ctx = await make();
      await ctx.stores.telemetry.insert({
        decision: decision("req_1"),
        apiKeyId: "k1",
        createdAt: new Date(),
      });
      await expect(
        ctx.stores.telemetry.insert({
          decision: decision("req_1"),
          apiKeyId: "k2",
          createdAt: new Date(),
        }),
      ).rejects.toThrow();
    });

    // --- full-payload capture (admin capture_payloads) ---
    it("round-trips a captured request/response payload verbatim", async () => {
      ctx = await make();
      const requestJson = JSON.stringify({
        model: "gpt",
        messages: [{ role: "user", content: "hi" }],
      });
      const responseJson = JSON.stringify({ choices: [{ message: { content: "yo" } }] });
      const upstreamRequestJson = JSON.stringify({
        model: "gpt-resolved",
        messages: [
          { role: "user", content: "hi" },
          { role: "user", content: "<system-reminder>memory</system-reminder>" },
        ],
      });
      await ctx.stores.telemetry.insertPayload({
        requestId: "req_1",
        requestJson,
        responseJson,
        upstreamRequestJson,
        createdAt: new Date(5000),
      });
      const got = await ctx.stores.telemetry.getPayload("req_1");
      expect(got?.requestJson).toBe(requestJson);
      expect(got?.responseJson).toBe(responseJson);
      expect(got?.upstreamRequestJson).toBe(upstreamRequestJson);
      expect(got?.createdAt.getTime()).toBe(5000);
      expect(await ctx.stores.telemetry.getPayloadMeta?.("req_1")).toEqual({
        requestId: "req_1",
        createdAt: new Date(5000),
        parts: { request: true, response: true, upstreamRequest: true },
      });
      expect(await ctx.stores.telemetry.getPayloadPart?.("req_1", "response")).toEqual({
        requestId: "req_1",
        part: "response",
        json: responseJson,
        createdAt: new Date(5000),
      });
      expect(await ctx.stores.telemetry.getPayload("nope")).toBeNull();
    });

    it("defaults the forwarded upstream request to null when omitted", async () => {
      ctx = await make();
      await ctx.stores.telemetry.insertPayload({
        requestId: "req_no_upstream",
        requestJson: "{}",
        responseJson: null,
        createdAt: new Date(5000),
      });
      const got = await ctx.stores.telemetry.getPayload("req_no_upstream");
      expect(got?.upstreamRequestJson ?? null).toBeNull();
    });

    it("upserts a payload by request_id (request first, response backfilled)", async () => {
      ctx = await make();
      await ctx.stores.telemetry.insertPayload({
        requestId: "req_1",
        requestJson: "{}",
        responseJson: null,
        createdAt: new Date(1000),
      });
      await ctx.stores.telemetry.insertPayload({
        requestId: "req_1",
        requestJson: "{}",
        responseJson: '{"done":true}',
        createdAt: new Date(1000),
      });
      const got = await ctx.stores.telemetry.getPayload("req_1");
      expect(got?.responseJson).toBe('{"done":true}');
    });

    it("prunePayloads drops rows strictly older than the cutoff", async () => {
      ctx = await make();
      for (const [id, ms] of [
        ["old", 1000],
        ["edge", 2000],
        ["new", 3000],
      ] as const) {
        await ctx.stores.telemetry.insertPayload({
          requestId: id,
          requestJson: "{}",
          responseJson: null,
          createdAt: new Date(ms),
        });
      }
      await ctx.stores.telemetry.prunePayloads(2000); // strictly older than 2000 → only "old"
      expect(await ctx.stores.telemetry.getPayload("old")).toBeNull();
      expect(await ctx.stores.telemetry.getPayload("edge")).not.toBeNull();
      expect(await ctx.stores.telemetry.getPayload("new")).not.toBeNull();
    });

    it("pruneTelemetry drops decision rows strictly older than the cutoff and returns the count", async () => {
      ctx = await make();
      const t = ctx.stores.telemetry;
      if (!t.pruneTelemetry) throw new Error("adapter must implement pruneTelemetry");
      for (const [id, ms] of [
        ["old", 1000],
        ["edge", 2000],
        ["new", 3000],
      ] as const) {
        await t.insert({ apiKeyId: "key_1", decision: decision(id), createdAt: new Date(ms) });
      }
      const deleted = await t.pruneTelemetry(2000); // strict → only "old"
      expect(deleted).toBe(1);
      expect(await ctx.stores.telemetry.getByRequestId("old")).toBeNull();
      expect(await ctx.stores.telemetry.getByRequestId("edge")).not.toBeNull();
      expect(await ctx.stores.telemetry.getByRequestId("new")).not.toBeNull();
    });

    it("count/select telemetry older-than: count matches and keyset paging covers every row once", async () => {
      ctx = await make();
      const t = ctx.stores.telemetry;
      if (!t.countTelemetryOlderThan || !t.selectTelemetryOlderThan)
        throw new Error("adapter must implement telemetry archive helpers");
      for (let i = 0; i < 5; i++) {
        await t.insert({
          apiKeyId: "key_1",
          decision: decision(`old_${i}`),
          createdAt: new Date(1000 + i),
        });
      }
      await t.insert({
        apiKeyId: "key_1",
        decision: decision("recent"),
        createdAt: new Date(9000),
      });
      expect(await t.countTelemetryOlderThan(5000)).toBe(5);
      // Page through in batches of 2 via the id cursor; expect all 5, no dupes.
      const seen: string[] = [];
      let after: string | undefined;
      for (let guard = 0; guard < 10; guard++) {
        const page = await t.selectTelemetryOlderThan(5000, 2, after);
        if (page.length === 0) break;
        for (const r of page) seen.push(r.requestId);
        after = page[page.length - 1]?.id;
      }
      expect(seen.sort()).toEqual(["old_0", "old_1", "old_2", "old_3", "old_4"]);
      expect(new Set(seen).size).toBe(5);
    });

    it("count/select payloads older-than: count matches and keyset paging covers every row once", async () => {
      ctx = await make();
      const t = ctx.stores.telemetry;
      if (!t.countPayloadsOlderThan || !t.selectPayloadsOlderThan)
        throw new Error("adapter must implement payload archive helpers");
      for (let i = 0; i < 5; i++) {
        await t.insertPayload({
          requestId: `p_old_${i}`,
          requestJson: "{}",
          responseJson: null,
          createdAt: new Date(1000 + i),
        });
      }
      await t.insertPayload({
        requestId: "p_recent",
        requestJson: "{}",
        responseJson: null,
        createdAt: new Date(9000),
      });
      expect(await t.countPayloadsOlderThan(5000)).toBe(5);
      const seen: string[] = [];
      let after: string | undefined;
      for (let guard = 0; guard < 10; guard++) {
        const page = await t.selectPayloadsOlderThan(5000, 2, after);
        if (page.length === 0) break;
        for (const r of page) seen.push(r.requestId);
        after = page[page.length - 1]?.id;
      }
      expect(seen.sort()).toEqual(["p_old_0", "p_old_1", "p_old_2", "p_old_3", "p_old_4"]);
      expect(new Set(seen).size).toBe(5);
    });
  });

  // --- RateLimitStore -----------------------------------------------------
  describe("RateLimitStore", () => {
    it("consume decrements and rejects when empty", async () => {
      ctx = await make();
      const a = await ctx.stores.rateLimit.consume("k1", "rpm", null, 2, 1, 0);
      expect(a.ok).toBe(true);
      expect(a.remaining).toBe(1);
      const b = await ctx.stores.rateLimit.consume("k1", "rpm", a.state, 2, 1, 0);
      expect(b.ok).toBe(true);
      expect(b.remaining).toBe(0);
      const c = await ctx.stores.rateLimit.consume("k1", "rpm", b.state, 2, 1, 0);
      expect(c.ok).toBe(false);
    });

    it("persists bucket state across fresh store instances (simulated restart)", async () => {
      ctx = await make();
      await ctx.stores.rateLimit.consume("k1", "rpm", null, 2, 1, 0);
      await ctx.stores.rateLimit.consume("k1", "rpm", null, 2, 1, 0);
      // A new call with no state hint must read the persisted (now-empty) bucket.
      const third = await ctx.stores.rateLimit.consume("k1", "rpm", null, 2, 1, 0);
      expect(third.ok).toBe(false);
    });

    it("N parallel consumes on a fresh capacity=1 bucket grant exactly one", async () => {
      ctx = await make();
      // Cold bucket (no row yet): concurrent transactions must serialize so the
      // first sighting cannot be seeded twice and over-spent. capacity=1, cost=1
      // => exactly one of N parallel consume()s may succeed.
      const N = 8;
      const results = await Promise.all(
        Array.from({ length: N }, () => ctx.stores.rateLimit.consume("hot", "rpm", null, 1, 1, 0)),
      );
      expect(results.filter((r) => r.ok)).toHaveLength(1);
    });
  });

  // --- SignalStore --------------------------------------------------------
  describe("SignalStore", () => {
    it("upsert then getSignal round-trips the full shape", async () => {
      ctx = await make();
      const sig = signal();
      await ctx.stores.signals.upsertSignals([sig]);
      expect(await ctx.stores.signals.getSignal("chat", "balanced")).toEqual(sig);
    });

    it("getSignal returns null for an unknown (taskType, lane)", async () => {
      ctx = await make();
      expect(await ctx.stores.signals.getSignal("nope", "nope")).toBeNull();
    });

    it("upsert overwrites the existing (taskType, lane) — never duplicates", async () => {
      ctx = await make();
      await ctx.stores.signals.upsertSignals([signal({ samples: 3, updatedAt: 1 })]);
      await ctx.stores.signals.upsertSignals([signal({ samples: 9, updatedAt: 2 })]);
      const got = await ctx.stores.signals.getSignal("chat", "balanced");
      expect(got?.samples).toBe(9);
      expect(got?.updatedAt).toBe(2);
    });

    it("preserves a null avgCostUsd through the round-trip", async () => {
      ctx = await make();
      await ctx.stores.signals.upsertSignals([signal({ avgCostUsd: null })]);
      expect((await ctx.stores.signals.getSignal("chat", "balanced"))?.avgCostUsd).toBeNull();
    });
  });

  // --- MemoryStore --------------------------------------------------------
  describe("MemoryStore", () => {
    it("ensureThread is idempotent and appendMessage -> listMessages round-trips", async () => {
      ctx = await make();
      await ctx.stores.memory.ensureThread({ id: "t1", ownerId: "acct-a", projectId: "p1" });
      await ctx.stores.memory.ensureThread({ id: "t1", ownerId: "acct-a", projectId: "p1" }); // no duplicate
      await ctx.stores.memory.appendMessage({
        threadId: "t1",
        role: "user",
        content: "hello",
        tokenEstimate: 2,
      });
      const msgs = await ctx.stores.memory.listMessages({ threadId: "t1", accountId: "acct-a" });
      expect(msgs).toHaveLength(1);
      expect(msgs[0]?.content).toBe("hello");
      expect(msgs[0]?.createdAt).toBeInstanceOf(Date);
    });

    it("appendMessages batches a whole turn in one commit and preserves insertion order", async () => {
      ctx = await make();
      const store = ctx.stores.memory;
      // Both real adapters MUST implement the batch path — it is the hot-path fix
      // (observe inbound runs before the upstream call). A missing impl here means
      // observe silently falls back to N synchronous commits.
      expect(typeof store.appendMessages).toBe("function");
      await store.ensureThread({ id: "batch-t", ownerId: "acct-a" });
      const ids = await store.appendMessages?.([
        { threadId: "batch-t", role: "user", content: "m0", tokenEstimate: 1 },
        { threadId: "batch-t", role: "assistant", content: "m1", tokenEstimate: 1 },
        { threadId: "batch-t", role: "user", content: "m2", tokenEstimate: 1 },
      ]);
      // Returns one generated id per input, in order.
      expect(ids).toHaveLength(3);
      expect(new Set(ids).size).toBe(3);
      const msgs = await store.listMessages({ threadId: "batch-t", accountId: "acct-a" });
      // listMessages orders by (createdAt, id); batched rows must come back in the
      // exact order they were appended even though they share one wall-clock now().
      expect(msgs.map((m) => m.content)).toEqual(["m0", "m1", "m2"]);
    });

    it("appendMessages on an empty batch writes nothing and returns []", async () => {
      ctx = await make();
      const store = ctx.stores.memory;
      await store.ensureThread({ id: "empty-t", ownerId: "acct-a" });
      const ids = await store.appendMessages?.([]);
      expect(ids).toEqual([]);
      expect(await store.listMessages({ threadId: "empty-t", accountId: "acct-a" })).toHaveLength(
        0,
      );
    });

    it("appendMessages where every input is an intra-batch duplicate collapses to one row, never throws (H4 parity)", async () => {
      // Same (threadId, messageIndex, role, content) repeated 3× in ONE batch. The pg
      // adapter dedupes in-memory before a single multi-row INSERT (Drizzle .values([])
      // would throw); sqlite inserts per-row with ON CONFLICT. BOTH must persist exactly
      // one row and must not throw — a cross-adapter parity guard.
      ctx = await make();
      const store = ctx.stores.memory;
      await store.ensureThread({ id: "dupbatch-t", ownerId: "acct-a" });
      const dup = {
        threadId: "dupbatch-t",
        role: "user" as const,
        content: "same",
        tokenEstimate: 1,
        messageIndex: 0,
      };
      const ids = await store.appendMessages?.([dup, { ...dup }, { ...dup }]);
      expect(ids).toHaveLength(3); // one id per input (caller contract), even when collapsed
      const msgs = await store.listMessages({ threadId: "dupbatch-t", accountId: "acct-a" });
      expect(msgs.map((m) => m.content)).toEqual(["same"]); // exactly one row persisted
    });

    it("appendMessage is idempotent on re-ingest of the same (thread, role, content)", async () => {
      // The re-ingestion fix: the client re-sends the whole transcript each turn.
      // Persisting the same message twice must collapse to ONE row, not two.
      ctx = await make();
      const store = ctx.stores.memory;
      await store.ensureThread({ id: "dup-t", ownerId: "acct-a" });
      await store.appendMessage({
        threadId: "dup-t",
        messageIndex: 0,
        role: "user",
        content: "same",
        tokenEstimate: 1,
      });
      await store.appendMessage({
        threadId: "dup-t",
        messageIndex: 0,
        role: "user",
        content: "same",
        tokenEstimate: 1,
      });
      const msgs = await store.listMessages({ threadId: "dup-t", accountId: "acct-a" });
      expect(msgs).toHaveLength(1);
    });

    it("appendMessages dedupes re-sent history and intra-batch duplicates, length preserved", async () => {
      ctx = await make();
      const store = ctx.stores.memory;
      await store.ensureThread({ id: "redup-t", ownerId: "acct-a" });
      // Turn 1 includes an intra-batch duplicate at the same transcript position.
      const ids1 = await store.appendMessages?.([
        { threadId: "redup-t", messageIndex: 0, role: "user", content: "m0", tokenEstimate: 1 },
        { threadId: "redup-t", messageIndex: 0, role: "user", content: "m0", tokenEstimate: 1 },
        {
          threadId: "redup-t",
          messageIndex: 1,
          role: "assistant",
          content: "m1",
          tokenEstimate: 1,
        },
      ]);
      // Contract: one id per input (length preserved), all distinct.
      expect(ids1).toHaveLength(3);
      expect(new Set(ids1).size).toBe(3);
      // Turn 2 re-sends the full history + one new message (mirrors a real client).
      await store.appendMessages?.([
        { threadId: "redup-t", messageIndex: 0, role: "user", content: "m0", tokenEstimate: 1 },
        {
          threadId: "redup-t",
          messageIndex: 1,
          role: "assistant",
          content: "m1",
          tokenEstimate: 1,
        },
        { threadId: "redup-t", messageIndex: 2, role: "user", content: "m2", tokenEstimate: 1 },
      ]);
      const msgs = await store.listMessages({ threadId: "redup-t", accountId: "acct-a" });
      // Only the 3 distinct contents survive — no O(n²) re-ingestion.
      expect(msgs.map((m) => m.content)).toEqual(["m0", "m1", "m2"]);
    });

    it("appendMessages preserves repeated content at different transcript positions", async () => {
      ctx = await make();
      const store = ctx.stores.memory;
      await store.ensureThread({ id: "repeat-t", ownerId: "acct-a" });
      await store.appendMessages?.([
        { threadId: "repeat-t", messageIndex: 0, role: "user", content: "yes", tokenEstimate: 1 },
        {
          threadId: "repeat-t",
          messageIndex: 1,
          role: "assistant",
          content: "ok",
          tokenEstimate: 1,
        },
        { threadId: "repeat-t", messageIndex: 2, role: "user", content: "yes", tokenEstimate: 1 },
      ]);
      const msgs = await store.listMessages({ threadId: "repeat-t", accountId: "acct-a" });
      expect(msgs.map((m) => m.content)).toEqual(["yes", "ok", "yes"]);
    });

    it("dedup is scoped by thread and by role (same content elsewhere still persists)", async () => {
      ctx = await make();
      const store = ctx.stores.memory;
      await store.ensureThread({ id: "scope-a", ownerId: "acct-a" });
      await store.ensureThread({ id: "scope-b", ownerId: "acct-a" });
      await store.appendMessage({
        threadId: "scope-a",
        role: "user",
        content: "x",
        tokenEstimate: 1,
      });
      // Same content, DIFFERENT thread -> distinct row.
      await store.appendMessage({
        threadId: "scope-b",
        role: "user",
        content: "x",
        tokenEstimate: 1,
      });
      // Same content + thread, DIFFERENT role -> distinct row.
      await store.appendMessage({
        threadId: "scope-a",
        role: "assistant",
        content: "x",
        tokenEstimate: 1,
      });
      expect(await store.listMessages({ threadId: "scope-a", accountId: "acct-a" })).toHaveLength(
        2,
      );
      expect(await store.listMessages({ threadId: "scope-b", accountId: "acct-a" })).toHaveLength(
        1,
      );
    });

    it("ensureThread fills missing owner/project/resource scope when the same id is re-seen", async () => {
      ctx = await make();
      await ctx.stores.memory.ensureThread({ id: "t-upsert" });
      await ctx.stores.memory.ensureThread({
        id: "t-upsert",
        ownerId: "acct-a",
        projectId: "p1",
        resourceId: "r1",
      });
      await ctx.stores.memory.appendMessage({
        threadId: "t-upsert",
        role: "user",
        content: "visible after owner upsert",
        tokenEstimate: 4,
      });
      await ctx.stores.memory.appendObservation({
        threadId: "t-upsert",
        sourceMessageRange: ["m1", "m1"],
        observationText: "visible after scope upsert",
        observedAt: new Date(1000),
      });

      expect(
        await ctx.stores.memory.listMessages({ threadId: "t-upsert", accountId: "acct-a" }),
      ).toHaveLength(1);
      expect(
        await ctx.stores.memory.listObservations({ accountId: "acct-a", projectId: "p1" }),
      ).toHaveLength(1);
      expect(
        await ctx.stores.memory.listObservations({ accountId: "acct-a", resourceId: "r1" }),
      ).toHaveLength(1);
    });

    it("ensureThread preserves existing scope when later calls omit owner/project/resource", async () => {
      ctx = await make();
      await ctx.stores.memory.ensureThread({
        id: "t-no-clear",
        ownerId: "acct-a",
        projectId: "p1",
        resourceId: "r1",
      });
      await ctx.stores.memory.ensureThread({ id: "t-no-clear" });
      await ctx.stores.memory.appendMessage({
        threadId: "t-no-clear",
        role: "user",
        content: "still scoped",
        tokenEstimate: 2,
      });
      await ctx.stores.memory.appendObservation({
        threadId: "t-no-clear",
        sourceMessageRange: ["m1", "m1"],
        observationText: "still scoped observation",
        observedAt: new Date(1000),
      });

      expect(
        await ctx.stores.memory.listMessages({ threadId: "t-no-clear", accountId: "acct-a" }),
      ).toHaveLength(1);
      expect(
        await ctx.stores.memory.listObservations({ accountId: "acct-a", projectId: "p1" }),
      ).toHaveLength(1);
      expect(
        await ctx.stores.memory.listObservations({ accountId: "acct-a", resourceId: "r1" }),
      ).toHaveLength(1);
    });

    it("ensureThread does not overwrite existing owner/project/resource for a different owner", async () => {
      ctx = await make();
      await ctx.stores.memory.ensureThread({
        id: "t-no-cross-owner",
        ownerId: "acct-a",
        projectId: "p1",
        resourceId: "r1",
      });
      await ctx.stores.memory.appendMessage({
        threadId: "t-no-cross-owner",
        role: "user",
        content: "acct-a scoped secret",
        tokenEstimate: 3,
      });
      await ctx.stores.memory.appendObservation({
        threadId: "t-no-cross-owner",
        sourceMessageRange: ["m1", "m1"],
        observationText: "acct-a scoped observation",
        observedAt: new Date(1000),
      });

      await ctx.stores.memory.ensureThread({
        id: "t-no-cross-owner",
        ownerId: "acct-b",
        projectId: "p2",
        resourceId: "r2",
      });

      expect(
        await ctx.stores.memory.listMessages({ threadId: "t-no-cross-owner", accountId: "acct-b" }),
      ).toEqual([]);
      expect(
        await ctx.stores.memory.listObservations({ accountId: "acct-b", projectId: "p2" }),
      ).toEqual([]);
      expect(
        await ctx.stores.memory.listObservations({ accountId: "acct-a", projectId: "p1" }),
      ).toHaveLength(1);
      expect(
        await ctx.stores.memory.listObservations({ accountId: "acct-a", resourceId: "r1" }),
      ).toHaveLength(1);
    });

    it("keeps raw messages and observations isolated by account for the same thread id", async () => {
      ctx = await make();
      await ctx.stores.memory.ensureThread({ id: "shared-thread", ownerId: "acct-a" });
      await ctx.stores.memory.appendMessage({
        threadId: "shared-thread",
        role: "user",
        content: "acct-a secret",
        tokenEstimate: 3,
      });
      await ctx.stores.memory.appendObservation({
        threadId: "shared-thread",
        sourceMessageRange: ["m1", "m1"],
        observationText: "acct-a observation",
        observedAt: new Date(1000),
      });
      await ctx.stores.memory.ensureThread({ id: "shared-thread", ownerId: "acct-b" });

      expect(
        await ctx.stores.memory.listMessages({ threadId: "shared-thread", accountId: "acct-b" }),
      ).toEqual([]);
      expect(
        await ctx.stores.memory.listObservations({
          threadId: "shared-thread",
          accountId: "acct-b",
        }),
      ).toEqual([]);
    });

    it("appendObservation -> listObservations preserves range + tags", async () => {
      ctx = await make();
      await ctx.stores.memory.ensureThread({ id: "t1", ownerId: "acct-a" });
      await ctx.stores.memory.appendObservation({
        threadId: "t1",
        sourceMessageRange: ["m1", "m2"],
        observationText: "summary",
        observedAt: new Date(1000),
        tags: ["x", "y"],
      });
      const obs = await ctx.stores.memory.listObservations({ threadId: "t1", accountId: "acct-a" });
      expect(obs).toHaveLength(1);
      expect(obs[0]?.sourceMessageRange).toEqual(["m1", "m2"]);
      expect(obs[0]?.tags).toEqual(["x", "y"]);
      expect(obs[0]?.observedAt).toBeInstanceOf(Date);
    });

    it("listObservations aggregates across a PROJECT's threads (reflector target scope)", async () => {
      // The reflector merges at the project level — it must see EVERY thread of
      // that project (same owner), never just the promoting thread, and never
      // another project's or another account's threads.
      ctx = await make();
      await ctx.stores.memory.ensureThread({ id: "t1", ownerId: "acct-a", projectId: "p1" });
      await ctx.stores.memory.ensureThread({ id: "t2", ownerId: "acct-a", projectId: "p1" });
      await ctx.stores.memory.ensureThread({ id: "t3", ownerId: "acct-a", projectId: "other" });
      await ctx.stores.memory.ensureThread({ id: "t4", ownerId: "acct-b", projectId: "p1" });
      const seed = async (threadId: string, text: string, at: number) =>
        ctx.stores.memory.appendObservation({
          threadId,
          sourceMessageRange: ["m1", "m1"],
          observationText: text,
          observedAt: new Date(at),
        });
      await seed("t1", "from-t1", 1000);
      await seed("t2", "from-t2", 2000);
      await seed("t3", "from-other-project", 3000);
      await seed("t4", "from-other-account", 4000);

      const obs = await ctx.stores.memory.listObservations({
        accountId: "acct-a",
        projectId: "p1",
      });
      expect(obs.map((o) => o.observationText)).toEqual(["from-t1", "from-t2"]);
    });

    it("listObservations aggregates across a RESOURCE's threads the same way", async () => {
      ctx = await make();
      await ctx.stores.memory.ensureThread({ id: "t1", ownerId: "acct-a", resourceId: "r1" });
      await ctx.stores.memory.ensureThread({ id: "t2", ownerId: "acct-a", resourceId: "r1" });
      await ctx.stores.memory.ensureThread({ id: "t3", ownerId: "acct-a", resourceId: "zz" });
      const seed = async (threadId: string, text: string, at: number) =>
        ctx.stores.memory.appendObservation({
          threadId,
          sourceMessageRange: ["m1", "m1"],
          observationText: text,
          observedAt: new Date(at),
        });
      await seed("t1", "res-a", 1000);
      await seed("t2", "res-b", 2000);
      await seed("t3", "res-other", 3000);

      const obs = await ctx.stores.memory.listObservations({
        accountId: "acct-a",
        resourceId: "r1",
      });
      expect(obs.map((o) => o.observationText)).toEqual(["res-a", "res-b"]);
    });

    it("upsertReflection -> getReflection returns the latest version for an exact scope", async () => {
      ctx = await make();
      await ctx.stores.memory.upsertReflection({
        accountId: "acct-a",
        projectId: "p1",
        reflectionText: "v1",
        version: 1,
        tokenEstimate: 5,
        updatedAt: new Date(1000),
      });
      await ctx.stores.memory.upsertReflection({
        accountId: "acct-a",
        projectId: "p1",
        reflectionText: "v2",
        version: 2,
        tokenEstimate: 6,
        updatedAt: new Date(2000),
      });
      const got = await ctx.stores.memory.getReflection({ projectId: "p1", accountId: "acct-a" });
      expect(got?.version).toBe(2);
      expect(got?.reflectionText).toBe("v2");
      // Scope isolation: a thread-scoped read must NOT see the project row.
      expect(
        await ctx.stores.memory.getReflection({ threadId: "p1", accountId: "acct-a" }),
      ).toBeNull();
      // Account isolation: same project id under another account must NOT see it.
      expect(
        await ctx.stores.memory.getReflection({ projectId: "p1", accountId: "acct-b" }),
      ).toBeNull();
    });

    // docs/12 (Codex review fix) — the reflection-rebuild half of forgetting:
    // listActiveReflectionScopes (what decay enqueues rebuilds for) + archiveReflections
    // (clears a forgotten scope) + getReflection filtering to ACTIVE only.
    it("archiveReflections clears every version of a scope; getReflection then returns null; listActiveReflectionScopes drops it", async () => {
      ctx = await make();
      const m = ctx.stores.memory;
      // Two scopes for one account: a project reflection (2 versions) + a resource one.
      await m.upsertReflection({
        accountId: "acct-a",
        projectId: "p1",
        reflectionText: "p-v1",
        version: 1,
        tokenEstimate: 4,
        updatedAt: new Date(1000),
      });
      await m.upsertReflection({
        accountId: "acct-a",
        projectId: "p1",
        reflectionText: "p-v2",
        version: 2,
        tokenEstimate: 4,
        updatedAt: new Date(2000),
      });
      await m.upsertReflection({
        accountId: "acct-a",
        resourceId: "r1",
        reflectionText: "r-v1",
        version: 1,
        tokenEstimate: 4,
        updatedAt: new Date(1000),
      });

      // Both scopes are active reflection targets the decay job would rebuild.
      const scopesBefore = await m.listActiveReflectionScopes?.("acct-a");
      expect(scopesBefore).toEqual(
        expect.arrayContaining([
          { accountId: "acct-a", projectId: "p1" },
          { accountId: "acct-a", resourceId: "r1" },
        ]),
      );
      expect(scopesBefore).toHaveLength(2);

      // Archive the project scope (its whole active observation set decayed).
      await m.archiveReflections?.({ accountId: "acct-a", projectId: "p1" });

      // getReflection now returns null for the archived scope (ALL versions cleared),
      // but the resource scope is untouched.
      expect(await m.getReflection({ accountId: "acct-a", projectId: "p1" })).toBeNull();
      expect(
        (await m.getReflection({ accountId: "acct-a", resourceId: "r1" }))?.reflectionText,
      ).toBe("r-v1");
      // Only the resource scope remains an active rebuild target.
      expect(await m.listActiveReflectionScopes?.("acct-a")).toEqual([
        { accountId: "acct-a", resourceId: "r1" },
      ]);

      // docs/12 (Codex review fix II) — the version HIGH-WATER survives the archive
      // (it counts every status), so a rebuild writes v3, never resetting to v1.
      expect(
        await m.getReflectionVersionHighWater?.({ accountId: "acct-a", projectId: "p1" }),
      ).toBe(2);
      await m.upsertReflection({
        accountId: "acct-a",
        projectId: "p1",
        reflectionText: "p-v3 (revived)",
        version: 3,
        tokenEstimate: 4,
        updatedAt: new Date(3000),
      });
      const revived = await m.getReflection({ accountId: "acct-a", projectId: "p1" });
      expect(revived?.version).toBe(3); // active again, sequence continued
      expect(revived?.reflectionText).toBe("p-v3 (revived)");
    });
  });

  // --- ConfigStore --------------------------------------------------------
  describe("ConfigStore", () => {
    it("get returns null on a miss, set then get round-trips, set upserts", async () => {
      ctx = await make();
      expect(await ctx.stores.config.get("k")).toBeNull();
      await ctx.stores.config.set("k", "v1");
      expect(await ctx.stores.config.get("k")).toBe("v1");
      await ctx.stores.config.set("k", "v2");
      expect(await ctx.stores.config.get("k")).toBe("v2");
    });

    it("atomically sets a numeric guard only when missing or old enough", async () => {
      ctx = await make();
      if (!ctx.stores.config.setIfMissingOrNumericLte) {
        throw new Error("ConfigStore must support atomic numeric reservations");
      }
      const setIf = ctx.stores.config.setIfMissingOrNumericLte.bind(ctx.stores.config);

      await expect(setIf("guard", "100", 50)).resolves.toBe(true);
      expect(await ctx.stores.config.get("guard")).toBe("100");
      await expect(setIf("guard", "200", 99)).resolves.toBe(false);
      expect(await ctx.stores.config.get("guard")).toBe("100");
      await expect(setIf("guard", "200", 100)).resolves.toBe(true);
      expect(await ctx.stores.config.get("guard")).toBe("200");

      await ctx.stores.config.set("guard", "not-a-number");
      await expect(setIf("guard", "300", 1_000)).resolves.toBe(false);
      expect(await ctx.stores.config.get("guard")).toBe("not-a-number");
    });
  });
});
