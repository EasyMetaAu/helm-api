import { PGlite } from "@electric-sql/pglite";
import { DecisionRecordSchema } from "@helm/shared";
import Database from "better-sqlite3";
import { drizzle as sqliteDrizzle } from "drizzle-orm/better-sqlite3";
import { drizzle as pgDrizzle } from "drizzle-orm/pglite";
import { describe, expect, it } from "vitest";
import type { ApplyAsyncMediaCostInput } from "./ports.js";
import type { PgDb } from "./postgres/migrate.js";
import * as pgSchema from "./postgres/schema.js";
import { PgTelemetryStore } from "./postgres/telemetry.js";
import * as sqliteSchema from "./sqlite/schema.js";
import { SqliteTelemetryStore } from "./sqlite/telemetry.js";

const ddl = `CREATE TABLE telemetry (
  id TEXT PRIMARY KEY, request_id TEXT UNIQUE NOT NULL, api_key_id TEXT NOT NULL,
  decision_json JSONB NOT NULL, final_status TEXT, cost_usd DOUBLE PRECISION,
  latency_total_ms INTEGER, prompt_tokens INTEGER, completion_tokens INTEGER,
  cached_tokens INTEGER, cache_creation_tokens INTEGER, served_model TEXT,
  generation_ms INTEGER, created_at BIGINT NOT NULL
)`;

const input: ApplyAsyncMediaCostInput = {
  requestId: "req",
  keyId: "owner",
  kind: "video",
  providerAlias: "ark/seedance-2.5",
  providerName: "ark-main",
  providerModel: "doubao-seedance-2-5-260628",
  providerAccount: "account-a",
  taskCreatedAt: 1000,
  observedAt: 2000,
  completionTokens: 100,
  cost: {
    currency: "CNY",
    amount: 0.25,
    cost_usd: 0.0375,
    basis: "official_list_price",
    verified_on: "2026-11-20",
  },
};

const decision = DecisionRecordSchema.parse({
  request_id: input.requestId,
  trace_id: "trace",
  requested_model: "video-standard",
  classifier: {
    task_type: "passthrough",
    complexity: "passthrough",
    confidence: 1,
    decided_by: "default",
    constraints: {},
    eval_cache_hit: null,
    explanation: [],
  },
  policy: { matched_policy_id: null, reason: "video_generation" },
  lane: { selected_lane: "video", candidate_chain: [input.providerAlias] },
  provider_attempts: [
    {
      alias: input.providerAlias,
      skipped: false,
      skip_reason: null,
      error_class: null,
      latency_ms: 0,
      cost_usd: null,
      status: "ok",
      provider_name: input.providerName,
      provider_model: input.providerModel,
    },
  ],
  final: {
    model_alias: input.providerAlias,
    provider_model: input.providerModel,
    status: "ok",
    error_reason: null,
  },
  serving_account: { provider_id: input.providerName, account: input.providerAccount },
});

async function sqliteFixture() {
  const raw = new Database(":memory:");
  raw.exec(ddl);
  const db = Object.assign(sqliteDrizzle(raw, { schema: sqliteSchema }), {
    $sqlite: raw,
    $vecLoaded: false,
  });
  return {
    store: new SqliteTelemetryStore(db),
    columns: async () => raw.prepare("SELECT cost_usd, completion_tokens FROM telemetry").all(),
    close: () => raw.close(),
  };
}

async function pgFixture() {
  const raw = await PGlite.create();
  await raw.exec(ddl);
  const db = pgDrizzle(raw, { schema: pgSchema });
  return {
    store: new PgTelemetryStore(db as unknown as PgDb),
    columns: async () =>
      (await raw.query("SELECT cost_usd, completion_tokens FROM telemetry")).rows,
    close: () => raw.close(),
  };
}

describe.each([
  ["SQLite", sqliteFixture],
  ["Postgres", pgFixture],
] as const)("%s asynchronous media telemetry", (_name, fixture) => {
  it("conditionally records one owned settlement on the original row", async () => {
    const { store, columns, close } = await fixture();
    try {
      expect(await store.applyAsyncMediaCost?.(input)).toBe(false);
      await store.insert({ decision, apiKeyId: input.keyId, createdAt: new Date(1500) });
      expect(await store.applyAsyncMediaCost?.({ ...input, keyId: "other-key" })).toBe(false);
      expect(await store.applyAsyncMediaCost?.({ ...input, providerModel: "other-model" })).toBe(
        false,
      );
      expect(
        await store.applyAsyncMediaCost?.({ ...input, providerAccount: "other-account" }),
      ).toBe(false);
      expect(await store.applyAsyncMediaCost?.({ ...input, observedAt: 1200 })).toBe(false);
      const writes = await Promise.all([
        store.applyAsyncMediaCost?.(input),
        store.applyAsyncMediaCost?.(input),
      ]);
      expect(writes.filter(Boolean)).toHaveLength(1);
      const row = await store.getByRequestId(input.requestId);
      expect(row?.media_cost).toEqual(input.cost);
      expect(row?.cost_breakdown.total_usd).toBe(input.cost.cost_usd);
      expect(row?.provider_attempts[0]?.cost_usd).toBe(input.cost.cost_usd);
      expect(row?.usage?.completion_tokens).toBe(input.completionTokens);
      expect(await columns()).toEqual([{ cost_usd: 0.0375, completion_tokens: 100 }]);
    } finally {
      await close();
    }
  });
});
