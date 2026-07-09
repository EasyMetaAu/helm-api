import type { RequestPayload, RequestPayloadPartRecord, TelemetryStore } from "@helm/core";
import { RequestsQuerySchema, StatsQuerySchema, toPortalDecisionView } from "@helm/shared";
import type { Hono } from "hono";
import type { AppEnv } from "../../app.js";
import { assertOwnsTrace } from "./ownership.js";

// The self-service portal REST surface (docs/12 §4.2). EVERY handler write-forces
// the scope from `c.get("identity")` (set by authMiddleware) and IGNORES any caller
// key_id/account_id — the exact pattern of registerUsageStatsRoute. Data-isolation
// dimensions NEVER fail open (§8 R5): a missing keyId throws → structured 500, never
// a scopeless read. Memory CRUD is deliberately absent: the SPA calls the existing
// POST /mcp JSON-RPC directly (§4.2 endpoint 6 — zero new backend).
export interface PortalApiDeps {
  telemetry: Pick<
    TelemetryStore,
    "aggregate" | "queryPage" | "getByRequestId" | "getApiKeyId" | "getPayload" | "getPayloadPart"
  >;
  now?: () => number;
  // Map a stored served-model value (which is the internal wire `provider_model`,
  // NOT the public alias — see SqliteTelemetryStore) to the PUBLIC lane alias the
  // user is entitled to see (§4.3: the served model already appears in their API
  // response). Without this the usage `by_model` doughnut would leak provider wire
  // model ids / supply-chain naming (原则 6 / R7). Unmappable → "other". Omitted in
  // tests that don't exercise the doughnut; then the raw label is dropped to "other".
  resolveModelLabel?: (wireModel: string) => string | null;
}

export function registerPortalApi(app: Hono<AppEnv>, deps: PortalApiDeps): void {
  // GET /portal/api/me — a SAFE projection of the caller's identity/caps for the
  // account menu + budget bar. NEVER the hash/plaintext/secret_enc (principle 7):
  // authMiddleware already dropped them — identity carries only prefix + caps.
  app.get("/portal/api/me", (c) => {
    const identity = c.get("identity");
    const b = identity.caps.budget;
    return c.json({
      key_prefix: identity.keyPrefix,
      role: identity.role,
      allowed_lanes: identity.caps.allowedLanes,
      rate_limit: { rpm: identity.caps.rateLimit.rpm, tpm: identity.caps.rateLimit.tpm },
      budget: {
        requests: b.requests,
        tokens: b.tokens,
        spend_usd: b.spendUsd,
        window_seconds: b.windowSeconds,
        behavior: b.behavior,
      },
      memory: { mode: identity.caps.memory.mode, project_id: identity.caps.memory.projectId },
    });
  });

  // GET /portal/api/usage/stats — the same aggregate as /v1/usage/stats but透出 the
  // series + byModel the trend/doughnut need (dropped by the /v1 route), plus the
  // budget cap so the UI can render "remaining". Scope write-forced to identity.keyId.
  app.get("/portal/api/usage/stats", async (c) => {
    const q = StatsQuerySchema.parse(c.req.query());
    const identity = c.get("identity");
    const end = q.end ?? deps.now?.() ?? Date.now();
    const start = q.start ?? 0;
    const agg = await deps.telemetry.aggregate(
      start,
      end,
      q.bucket,
      q.tzOffsetMinutes,
      identity.keyId,
    );
    const t = agg.totals;
    const b = identity.caps.budget;
    return c.json({
      object: "usage_stats",
      api_key_id: identity.keyId,
      range: {
        start_ms: start,
        end_ms: end,
        bucket: q.bucket,
        tz_offset_minutes: q.tzOffsetMinutes,
      },
      totals: {
        requests: t.requests,
        ok_count: t.okCount,
        error_count: t.errorCount,
        prompt_tokens: t.promptTokens,
        completion_tokens: t.completionTokens,
        total_tokens: t.promptTokens + t.completionTokens,
        cached_tokens: t.cachedTokens,
        cache_creation_tokens: t.cacheCreationTokens,
        cost_usd: t.totalCostUsd ?? 0,
        avg_latency_ms: t.avgLatencyMs,
        avg_tps: t.avgTps,
      },
      series: agg.series.map((s) => ({
        bucket_start_ms: s.bucketStartMs,
        requests: s.requests,
        prompt_tokens: s.promptTokens,
        completion_tokens: s.completionTokens,
        cost_usd: s.costUsd,
      })),
      by_model: agg.byModel.map((m) => ({
        // NEVER emit m.servedModel verbatim — it is the internal wire provider_model
        // (原则 6 / R7). Resolve to the public alias; unmappable/unstamped → "other".
        model: m.servedModel ? (deps.resolveModelLabel?.(m.servedModel) ?? "other") : "other",
        requests: m.requests,
        total_tokens: m.totalTokens,
        cost_usd: m.costUsd,
      })),
      budget: {
        requests: b.requests,
        tokens: b.tokens,
        spend_usd: b.spendUsd,
        window_seconds: b.windowSeconds,
        behavior: b.behavior,
      },
    });
  });

  // GET /portal/api/requests — the caller's OWN request list, whitelist-projected.
  // apiKeyId write-forced to identity.keyId (a caller ?key_id= is ignored, R5).
  app.get("/portal/api/requests", async (c) => {
    const q = RequestsQuerySchema.parse(c.req.query());
    const identity = c.get("identity");
    const { rows, total } = await deps.telemetry.queryPage({
      limit: q.pageSize,
      offset: (q.page - 1) * q.pageSize,
      startMs: q.start,
      endMs: q.end,
      status: q.status,
      lane: q.lane,
      model: q.model,
      apiKeyId: identity.keyId, // WRITE-FORCED — never q.key_id
    });
    return c.json({
      items: rows.map((r) => ({
        ...toPortalDecisionView(r.record),
        created_at: r.createdAt.getTime(),
      })),
      total,
      page: q.page,
      page_size: q.pageSize,
    });
  });

  // GET /portal/api/requests/:traceId — ownership-gated, whitelist-projected detail.
  app.get("/portal/api/requests/:traceId", async (c) => {
    const identity = c.get("identity");
    const traceId = c.req.param("traceId");
    // OWNERSHIP FIRST (R1) — before any getByRequestId read.
    if ((await assertOwnsTrace(deps.telemetry, identity.keyId, traceId)) !== "ok") {
      return c.json({ error: "request not found" }, 404);
    }
    const rec = await deps.telemetry.getByRequestId(traceId);
    if (!rec) return c.json({ error: "request not found" }, 404);
    return c.json(toPortalDecisionView(rec));
  });

  // GET /portal/api/requests/:traceId/payload?part=request|response — the caller's
  // own request/response bodies. upstream_request is REJECTED (supply-chain, §4.3 R7).
  app.get("/portal/api/requests/:traceId/payload", async (c) => {
    const identity = c.get("identity");
    const traceId = c.req.param("traceId");
    const part = c.req.query("part");
    // Whitelist the two portal-visible parts. Reject BEFORE touching the store so
    // upstream is never even read for a portal caller.
    if (part !== "request" && part !== "response") {
      return c.json({ error: "part must be 'request' or 'response'" }, 400);
    }
    if ((await assertOwnsTrace(deps.telemetry, identity.keyId, traceId)) !== "ok") {
      return c.json({ error: "request not found" }, 404);
    }
    const p = await getPayloadPart(deps, traceId, part);
    if (!p) return c.json({ captured: false });
    return c.json({
      captured: true,
      part,
      value: p.json === null ? null : parseMaybeJson(p.json),
      created_at: p.createdAt.getTime(),
    });
  });
}

// Mirror admin's part reader: prefer the narrow getPayloadPart, fall back to the
// whole-payload read for adapters/doubles that only implement getPayload.
async function getPayloadPart(
  deps: PortalApiDeps,
  requestId: string,
  part: "request" | "response",
): Promise<RequestPayloadPartRecord | null> {
  if (deps.telemetry.getPayloadPart) return deps.telemetry.getPayloadPart(requestId, part);
  const p = await deps.telemetry.getPayload(requestId);
  if (!p) return null;
  return {
    requestId: p.requestId,
    part,
    json: partJson(p, part),
    createdAt: p.createdAt,
  };
}

function partJson(p: RequestPayload, part: "request" | "response"): string | null {
  return part === "request" ? p.requestJson : p.responseJson;
}

function parseMaybeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
