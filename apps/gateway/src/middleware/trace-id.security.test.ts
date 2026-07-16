import { createSqliteDb, SqliteTelemetryStore } from "@helm/core";
import type { DecisionRecord } from "@helm/shared";
import { describe, expect, it } from "vitest";
import { createApp } from "../app.js";
import { recordServed } from "../routes/payload-capture.js";
import { assertOwnsTrace } from "../routes/portal/ownership.js";
import { createWriteQueue } from "../runtime/write-queue.js";

function decision(requestId: string, traceId: string): DecisionRecord {
  return {
    request_id: requestId,
    trace_id: traceId,
    requested_model: "balanced",
    protocol: "openai_chat",
    key_prefix: null,
    classifier: {
      task_type: "chat",
      complexity: "simple",
      confidence: 1,
      decided_by: "rules",
      rules_confidence: 1,
      eval_cache_hit: null,
      eval_model: null,
      eval_latency_ms: null,
      constraints: {},
      explanation: [],
    },
    policy: { matched_policy_id: null, reason: "test" },
    lane: { selected_lane: "balanced", candidate_chain: ["test"] },
    provider_attempts: [],
    final: {
      model_alias: null,
      provider_model: null,
      status: "error",
      error_reason: "test",
    },
    serving_account: null,
    latency_total_ms: 0,
    fallback_count: 0,
    cost_breakdown: { eval_usd: null, completion_usd: null, total_usd: null },
    memory: null,
    usage: null,
    stream_outcome: null,
    generation_ms: null,
  };
}

describe("internal request id isolation", () => {
  it("keeps telemetry ownership paired with its payload when clients reuse a trace id", async () => {
    const db = createSqliteDb(":memory:");
    const telemetry = new SqliteTelemetryStore(db);
    const writes = createWriteQueue({
      telemetry,
      log: () => {},
      flushIntervalMs: 10_000,
    });
    let sequence = 0;
    const app = createApp({
      logger: { log: () => {} },
      genTraceId: () => `server-request-${++sequence}`,
    });

    app.post("/record/:keyId", async (c) => {
      const requestId = c.get("request_id");
      const traceId = c.get("trace_id");
      const apiKeyId = c.req.param("keyId");
      const requestJson = await c.req.text();

      // Use the real deferred writer. Before the fix, its duplicate-telemetry
      // fallback retained the victim owner while the payload upsert replaced the
      // body under the client-controlled shared id.
      await recordServed(
        {
          telemetry,
          writes,
          redact: (value) => value,
          capturePayloads: () => true,
          now: () => Date.now(),
        },
        {
          requestId,
          apiKeyId,
          decision: decision(requestId, traceId),
          requestJson,
          responseJson: null,
        },
        () => {},
      );
      return c.json({ requestId, traceId });
    });

    const headers = { "X-Request-Id": "client-shared-trace" };
    const victimResponse = await app.request("/record/victim-key", {
      method: "POST",
      headers,
      body: "VICTIM_SECRET_BODY",
    });
    const attackerResponse = await app.request("/record/attacker-key", {
      method: "POST",
      headers,
      body: "ATTACKER_BODY",
    });
    const victim = (await victimResponse.json()) as { requestId: string; traceId: string };
    const attacker = (await attackerResponse.json()) as { requestId: string; traceId: string };
    await writes.flush();

    expect(victimResponse.headers.get("X-Helm-Request-Id")).toBe(victim.requestId);
    expect(attackerResponse.headers.get("X-Helm-Request-Id")).toBe(attacker.requestId);
    expect(victim.traceId).toBe("client-shared-trace");
    expect(attacker.traceId).toBe("client-shared-trace");
    expect(victim.requestId).not.toBe(attacker.requestId);
    expect(await assertOwnsTrace(telemetry, "victim-key", victim.requestId)).toBe("ok");
    expect(await assertOwnsTrace(telemetry, "attacker-key", victim.requestId)).toBe("not_found");
    expect(await telemetry.getByRequestId(victim.requestId)).toMatchObject({
      request_id: victim.requestId,
      trace_id: "client-shared-trace",
    });
    expect((await telemetry.getPayload(victim.requestId))?.requestJson).toBe("VICTIM_SECRET_BODY");
    expect(await assertOwnsTrace(telemetry, "attacker-key", attacker.requestId)).toBe("ok");
    expect((await telemetry.getPayload(attacker.requestId))?.requestJson).toBe("ATTACKER_BODY");

    await writes.stop();
    db.$sqlite.close();
  });
});
