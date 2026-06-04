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
      eval_cache_hit: null,
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
    latency_total_ms: 1200,
    fallback_count: 0,
    cost_breakdown: { eval_usd: null, completion_usd: 0.004, total_usd: 0.004 },
    memory: null,
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

    it("updateKey edits caps (allowed_lanes / allow_custom_model) and clears with null", async () => {
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
      });
      let got = await ctx.stores.keys.getByHash("h1");
      expect(got?.allowed_lanes).toEqual(["economy", "balanced"]);
      expect(got?.allow_custom_model).toBe(true);
      expect(got?.role).toBe("user"); // never rewritten by updateKey
      // null clears the whitelist back to "no cap"; an omitted field is left untouched.
      await ctx.stores.keys.updateKey("k1", { allowedLanes: null });
      got = await ctx.stores.keys.getByHash("h1");
      expect(got?.allowed_lanes).toBeNull();
      expect(got?.allow_custom_model).toBe(true);
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
      // model matches requested OR served, case-insensitive
      expect(
        (await ctx.stores.telemetry.queryPage({ limit: 50, offset: 0, model: "gpt-4o" })).rows
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
      await ctx.stores.telemetry.insertPayload({
        requestId: "req_1",
        requestJson,
        responseJson,
        createdAt: new Date(5000),
      });
      const got = await ctx.stores.telemetry.getPayload("req_1");
      expect(got?.requestJson).toBe(requestJson);
      expect(got?.responseJson).toBe(responseJson);
      expect(got?.createdAt.getTime()).toBe(5000);
      expect(await ctx.stores.telemetry.getPayload("nope")).toBeNull();
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

    it("keeps raw messages and observations isolated by account for the same thread id", async () => {
      ctx = await make();
      await ctx.stores.memory.ensureThread({ id: "shared-thread", ownerId: "acct-a" });
      await ctx.stores.memory.ensureThread({ id: "shared-thread", ownerId: "acct-b" });
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
  });
});
