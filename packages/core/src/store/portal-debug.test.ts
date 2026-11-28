import { createHash } from "node:crypto";
import { DecisionRecordSchema } from "@helm/shared";
import { sql } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { PgConfigStore } from "./postgres/config-store.js";
import { createPgliteDb } from "./postgres/migrate.js";
import { PgTelemetryStore } from "./postgres/telemetry.js";
import { SqliteConfigStore } from "./sqlite/config-store.js";
import { createSqliteDb } from "./sqlite/migrate.js";
import { SqliteTelemetryStore } from "./sqlite/telemetry.js";

const decision = (id: string, trace: string, session: string) =>
  DecisionRecordSchema.parse({
    request_id: id,
    trace_id: trace,
    requested_model: "auto",
    protocol: "openai_chat",
    classifier: {
      task_type: "chat",
      complexity: "low",
      confidence: 1,
      decided_by: "rules",
      eval_cache_hit: null,
      constraints: {},
      explanation: [],
    },
    policy: { matched_policy_id: null, reason: "" },
    lane: { selected_lane: "balanced", candidate_chain: [] },
    provider_attempts: [],
    final: { model_alias: null, provider_model: null, status: "ok", error_reason: null },
    session: { ref: session, source: "x-thread-id" },
  });

const drivers = [
  {
    name: "sqlite",
    async make() {
      const db = createSqliteDb(":memory:");
      return {
        telemetry: new SqliteTelemetryStore(db),
        explain: async (query: string) =>
          JSON.stringify(db.$sqlite.prepare(`EXPLAIN QUERY PLAN ${query}`).all()),
        traceExpression: "trace_id",
        config: new SqliteConfigStore(db),
        close: async () => db.$sqlite.close(),
      };
    },
  },
  {
    name: "postgres",
    async make() {
      const db = await createPgliteDb();
      return {
        telemetry: new PgTelemetryStore(db),
        explain: async (query: string) => {
          // Tiny fixtures prefer sequential scans; disable them only to prove
          // the actual predicates are indexable (not a production setting).
          await db.execute(sql.raw("SET enable_seqscan = off"));
          return JSON.stringify(await db.execute(sql.raw(`EXPLAIN ${query}`)));
        },
        traceExpression: "(decision_json ->> 'trace_id')",
        config: new PgConfigStore(db),
        close: () => db.$close(),
      };
    },
  },
];

describe.each(drivers)("portal debugging store contract $name", ({ make }) => {
  let close: (() => Promise<unknown>) | undefined;
  afterEach(async () => {
    await close?.();
  });
  it("uses indexes for key-scoped trace rows/count and exact session lookup", async () => {
    const ctx = await make();
    close = ctx.close;
    for (const projection of ["request_id", "count(*)"]) {
      const plan = await ctx.explain(
        `SELECT ${projection} FROM telemetry WHERE api_key_id = 'a' AND ${ctx.traceExpression} = 'client'`,
      );
      expect(plan).toContain("idx_telemetry_key_trace");
    }
    expect(
      await ctx.explain(
        "SELECT session_ref FROM sessions WHERE api_key_id = 'a' AND external_session_id = 'label' LIMIT 257",
      ),
    ).toContain("idx_sessions_key_label");
    const direct = await ctx.explain(
      "SELECT session_ref FROM sessions WHERE api_key_id = 'a' AND session_ref = 'ref' LIMIT 1",
    );
    expect(direct).toMatch(/INDEX|Index/);
    expect(direct).not.toMatch(/SCAN sessions|Seq Scan/);
  });

  it("scopes exact client traces and session labels/refs to their key", async () => {
    const ctx = await make();
    close = ctx.close;
    for (const [key, id, trace, ref] of [
      ["a", "ra", "client", "sa"],
      ["b", "rb", "client", "sb"],
      ["a", "ra2", "other", "sa2"],
    ]) {
      await ctx.telemetry.insert({
        decision: decision(id!, trace!, ref!),
        apiKeyId: key!,
        createdAt: new Date(),
      });
      await ctx.telemetry.upsertSessionRevision({
        sessionRef: ref!,
        accountId: "account",
        apiKeyId: key!,
        source: id === "ra2" ? "x-session-key" : "x-thread-id",
        externalSessionId: "same label",
        requestId: id!,
        parentRequestId: null,
        retainCount: 0,
        requestDeltaJson: "[]",
        requestEnvelopeJson: "{}",
        responseJson: null,
        fidelity: "exact",
        createdAt: new Date(),
      });
    }
    const page = await ctx.telemetry.queryPage({
      apiKeyId: "a",
      traceId: "client",
      limit: 2,
      offset: 0,
    });
    expect(page.total).toBe(1);
    expect(page.rows[0]?.record.request_id).toBe("ra");
    expect(
      (await ctx.telemetry.queryPage({ apiKeyId: "b", traceId: "other", limit: 2, offset: 0 }))
        .total,
    ).toBe(0);
    const refs = await ctx.telemetry.findSessionRefsForKey("a", "same label");
    expect(refs.sort()).toEqual(["sa", "sa2"]);
    expect(await ctx.telemetry.findSessionRefsForKey("b", "sa")).toEqual([]);
    const sessions = await ctx.telemetry.queryPage({
      apiKeyId: "a",
      sessionRefs: ["sa2", "sb"],
      limit: 10,
      offset: 0,
    });
    expect(sessions.rows.map((r) => r.record.request_id)).toEqual(["ra2"]);
    expect(
      (await ctx.telemetry.queryPage({ apiKeyId: "a", sessionRefs: [], limit: 10, offset: 0 }))
        .total,
    ).toBe(0);
  });

  it("grants blob access only for bytes actually externalized in that payload", async () => {
    const ctx = await make();
    close = ctx.close;
    const bytes = Buffer.alloc(4096, 7);
    const sha = createHash("sha256").update(bytes).digest("hex");
    const body = JSON.stringify({
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image",
              source: { type: "base64", media_type: "image/png", data: bytes.toString("base64") },
            },
          ],
        },
      ],
    });
    await ctx.telemetry.insertPayload({
      requestId: "owned",
      requestJson: body,
      responseJson: null,
      createdAt: new Date(),
    });
    await ctx.telemetry.insertPayload({
      requestId: "forged",
      requestJson: body.replace(bytes.toString("base64"), `helm-blob:sha256:${sha}`),
      responseJson: null,
      createdAt: new Date(),
    });
    expect(await ctx.telemetry.hasPayloadBlobReference("owned", sha)).toBe(true);
    expect(await ctx.telemetry.getPayloadBlob(sha, 1024)).toBeNull();
    expect(await ctx.telemetry.hasPayloadBlobReference("forged", sha)).toBe(false);
    expect(await ctx.telemetry.hasPayloadBlobReference("missing", sha)).toBe(false);
    await ctx.telemetry.insertPayload({
      requestId: "owned",
      requestJson: "{}",
      responseJson: null,
      createdAt: new Date(),
    });
    expect(await ctx.telemetry.hasPayloadBlobReference("owned", sha)).toBe(false);
    expect(await ctx.telemetry.getPayloadBlob(sha)).not.toBeNull(); // global admin remains available
    await ctx.telemetry.insertPayload({
      requestId: "retained",
      requestJson: body,
      responseJson: null,
      createdAt: new Date(0),
    });
    await ctx.telemetry.prunePayloads(1);
    expect(await ctx.telemetry.hasPayloadBlobReference("retained", sha)).toBe(false);
  });
  it("prunes payload rows and their blob refs across batches while preserving the cutoff", async () => {
    const ctx = await make();
    close = ctx.close;
    const bytes = Buffer.alloc(4096, 9);
    const sha = createHash("sha256").update(bytes).digest("hex");
    const requestJson = JSON.stringify({
      image: {
        type: "image",
        source: { type: "base64", media_type: "image/png", data: bytes.toString("base64") },
      },
    });
    const expired = Array.from({ length: 12 }, (_, i) => `expired-${i}`);
    for (const requestId of [...expired, "cutoff", "later"]) {
      await ctx.telemetry.insertPayload({
        requestId,
        requestJson,
        responseJson: null,
        createdAt: new Date(requestId === "cutoff" ? 100 : requestId === "later" ? 101 : 99),
      });
      expect(await ctx.telemetry.hasPayloadBlobReference(requestId, sha)).toBe(true);
    }
    await ctx.telemetry.prunePayloads(100);
    await ctx.telemetry.prunePayloads(100);
    for (const requestId of expired) {
      expect(await ctx.telemetry.getPayloadMeta(requestId)).toBeNull();
      expect(await ctx.telemetry.hasPayloadBlobReference(requestId, sha)).toBe(false);
    }
    for (const requestId of ["cutoff", "later"]) {
      expect(await ctx.telemetry.getPayloadMeta(requestId)).not.toBeNull();
      expect(await ctx.telemetry.hasPayloadBlobReference(requestId, sha)).toBe(true);
    }
    expect(await ctx.telemetry.getPayloadBlob(sha)).not.toBeNull();
    await ctx.telemetry.prunePayloads(102);
    for (const requestId of ["cutoff", "later"]) {
      expect(await ctx.telemetry.getPayloadMeta(requestId)).toBeNull();
      expect(await ctx.telemetry.hasPayloadBlobReference(requestId, sha)).toBe(false);
    }
    expect(await ctx.telemetry.getPayloadBlob(sha)).toBeNull();
  });

  it("expires replay receipts/rates but preserves live receipts and permanent config", async () => {
    const ctx = await make();
    close = ctx.close;
    await ctx.config.set("permanent", "keep");
    await ctx.config.compareAndSet("receipt", null, "old", 100);
    await ctx.config.compareAndSet("live", null, "live", 200);
    await ctx.config.setIfMissingOrNumericLte("rate", "100", 0, 100);
    expect(
      await ctx.explain(
        "SELECT key FROM config_kv WHERE expires_at <= 100 ORDER BY expires_at LIMIT 1000",
      ),
    ).toContain("idx_config_expiry");
    await ctx.config.pruneExpired(100);
    expect(await ctx.config.get("receipt")).toBeNull();
    expect(await ctx.config.get("rate")).toBeNull();
    expect(await ctx.config.get("live")).toBe("live");
    expect(await ctx.config.get("permanent")).toBe("keep");
    expect(await ctx.config.deleteIfValue("live", "wrong")).toBe(false);
    expect(await ctx.config.deleteIfValue("live", "live")).toBe(true);
  });

  it("atomically claims durable replay receipts and per-key throttles", async () => {
    const ctx = await make();
    close = ctx.close;
    const results = await Promise.all([
      ctx.config.compareAndSet("portal.receipt", null, "first"),
      ctx.config.compareAndSet("portal.receipt", null, "second"),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
    const winner = await ctx.config.get("portal.receipt");
    expect(await ctx.config.compareAndSet("portal.receipt", "wrong", "changed")).toBe(false);
    expect(await ctx.config.get("portal.receipt")).toBe(winner);
    expect(await ctx.config.setIfMissingOrNumericLte("portal.rate.a", "10000", 0)).toBe(true);
    expect(await ctx.config.setIfMissingOrNumericLte("portal.rate.a", "10001", 1)).toBe(false);
    expect(await ctx.config.setIfMissingOrNumericLte("portal.rate.b", "10001", 1)).toBe(true);
  });
});
