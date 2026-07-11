import type {
  KeyStore,
  RequestPayload,
  RequestPayloadMeta,
  RequestPayloadPartRecord,
  TelemetryStore,
} from "@helm/core";
import {
  PortalMemorySettingsRequestSchema,
  RequestsQuerySchema,
  StatsQuerySchema,
  toPortalDecisionView,
} from "@helm/shared";
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
  keyStore: Pick<KeyStore, "updateKey">;
  telemetry: Pick<
    TelemetryStore,
    | "aggregate"
    | "queryPage"
    | "getByRequestId"
    | "getApiKeyId"
    | "getPayload"
    | "getPayloadMeta"
    | "getPayloadPart"
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
      memory: {
        mode: identity.caps.memory.mode,
        project_id: identity.caps.memory.projectId,
        project_name: identity.caps.memory.projectName ?? null,
        thread_source: identity.caps.memory.threadSource,
      },
    });
  });

  // The only customer-writable key settings. Scope is forced from the bearer
  // identity and the strict schema rejects every administrator-owned field.
  app.patch("/portal/api/memory-settings", async (c) => {
    const identity = c.get("identity");
    // Root is the management-plane key and must remain memory-inert.
    if (identity.role === "root") {
      return c.json({ error: "root key memory settings are read-only" }, 403);
    }
    const parsed = PortalMemorySettingsRequestSchema.safeParse(
      await c.req.json().catch(() => null),
    );
    if (!parsed.success) {
      return c.json({ error: "invalid memory settings", issues: parsed.error.issues }, 400);
    }
    const patch: Parameters<PortalApiDeps["keyStore"]["updateKey"]>[1] = {
      memoryMode: parsed.data.memory_mode,
      memoryProjectId: parsed.data.memory_project_id,
    };
    if (parsed.data.memory_thread_source !== undefined) {
      patch.memoryThreadSource = parsed.data.memory_thread_source;
    }
    await deps.keyStore.updateKey(identity.keyId, patch);
    return c.json({
      memory: {
        mode: parsed.data.memory_mode,
        project_id: parsed.data.memory_project_id ?? identity.keyId,
        project_name: parsed.data.memory_project_id,
        thread_source: parsed.data.memory_thread_source ?? identity.caps.memory.threadSource,
      },
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
      // Resolve each row's wire provider_model to its PUBLIC alias (NEVER emit the
      // wire id verbatim — 原则 6 / R7) and MERGE rows that resolve to the same
      // label: many distinct wire models map to "other" (unmapped/unstamped), and
      // several wire ids can share one alias — so without merging the doughnut gets
      // multiple same-named slices (duplicate keys → the SPA's keyed {#each} crashes).
      by_model: aggregateByLabel(agg.byModel, (m) =>
        m.servedModel ? (deps.resolveModelLabel?.(m.servedModel) ?? "other") : "other",
      ),
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

  // GET /portal/api/requests/:traceId/payload?part=meta|request|response — the caller's
  // own request/response bodies. Metadata enables lazy loading without exposing the
  // presence of upstream_request; that part stays rejected (supply-chain, §4.3 R7).
  app.get("/portal/api/requests/:traceId/payload", async (c) => {
    const identity = c.get("identity");
    const traceId = c.req.param("traceId");
    const part = c.req.query("part");
    // Whitelist metadata plus the two portal-visible parts. Reject BEFORE touching
    // the store so upstream is never even read for a portal caller.
    if (part !== "meta" && part !== "request" && part !== "response") {
      return c.json({ error: "part must be 'meta', 'request', or 'response'" }, 400);
    }
    if ((await assertOwnsTrace(deps.telemetry, identity.keyId, traceId)) !== "ok") {
      return c.json({ error: "request not found" }, 404);
    }
    if (part === "meta") {
      const meta = await getPortalPayloadMeta(deps, traceId);
      if (!meta) return c.json({ captured: false });
      return c.json({
        captured: true,
        created_at: meta.createdAt.getTime(),
        parts: {
          request: meta.parts.request,
          response: meta.parts.response,
        },
      });
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

async function getPortalPayloadMeta(
  deps: PortalApiDeps,
  requestId: string,
): Promise<RequestPayloadMeta | null> {
  if (deps.telemetry.getPayloadMeta) return deps.telemetry.getPayloadMeta(requestId);
  const payload = await deps.telemetry.getPayload(requestId);
  if (!payload) return null;
  return {
    requestId: payload.requestId,
    createdAt: payload.createdAt,
    parts: {
      request: payload.requestJson !== null,
      response: payload.responseJson !== null,
      upstreamRequest: false,
    },
  };
}

// Resolve each usage row to a public label and merge rows sharing it, so the
// portal's by_model list has EXACTLY ONE entry per label (no duplicate keys, no
// wire-id leak). Sums tokens/requests; cost is null only when NO row in the group
// had a measured cost (COALESCE honesty, matches the store). Ordered by total
// tokens desc so the doughnut renders largest-first, same as the store.
type ModelUsageRow = Awaited<ReturnType<TelemetryStore["aggregate"]>>["byModel"][number];
function aggregateByLabel(
  rows: ModelUsageRow[],
  labelOf: (m: ModelUsageRow) => string,
): Array<{ model: string; requests: number; total_tokens: number; cost_usd: number | null }> {
  const byLabel = new Map<
    string,
    { model: string; requests: number; total_tokens: number; cost_usd: number | null }
  >();
  for (const m of rows) {
    const label = labelOf(m);
    const acc = byLabel.get(label);
    if (acc) {
      acc.requests += m.requests;
      acc.total_tokens += m.totalTokens;
      if (m.costUsd !== null) acc.cost_usd = (acc.cost_usd ?? 0) + m.costUsd;
    } else {
      byLabel.set(label, {
        model: label,
        requests: m.requests,
        total_tokens: m.totalTokens,
        cost_usd: m.costUsd,
      });
    }
  }
  return [...byLabel.values()].sort((a, b) => b.total_tokens - a.total_tokens);
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
