import type { BudgetStore, KeyStore, MemoryStore, TelemetryStore } from "@helm/core";
import { readWeeklyBudget, runtimeResponseWorkAdmission } from "@helm/core";
import {
  PortalMemorySettingsRequestSchema,
  RequestsQuerySchema,
  StatsQuerySchema,
  toPortalDecisionView,
} from "@helm/shared";
import type { Context, Hono } from "hono";
import type { AppEnv } from "../../app.js";
import {
  type BodyMemoryAdmission,
  memoryAdmissionReleaseGuard,
  RequestAdmissionError,
  readAdmittedRequestBody,
} from "../../runtime/memory-admission.js";
import type { AdminApiDeps } from "../admin/deps.js";
import { type RequestPayloadDeps, registerRequestPayloadRoutes } from "../admin/requests.js";
import { assertOwnsTrace } from "./ownership.js";
import { projectPortalPayload } from "./payload-privacy.js";
import { createPortalDecisionProjection } from "./privacy.js";
import { type PortalReplayWiring, registerPortalReplayRoute } from "./replay.js";

// The self-service portal REST surface (docs/12 §4.2). EVERY handler write-forces
// the scope from `c.get("identity")` (set by authMiddleware) and IGNORES any caller
// key_id/account_id — the exact pattern of registerUsageStatsRoute. Data-isolation
// dimensions NEVER fail open (§8 R5): a missing keyId throws → structured 500, never
// a scopeless read. Memory CRUD is deliberately absent: the SPA calls the existing
// POST /mcp JSON-RPC directly (§4.2 endpoint 6 — zero new backend).
export interface PortalApiDeps {
  replay?: PortalReplayWiring;
  budgetStore?: Pick<BudgetStore, "peek">;
  memoryAdmission?: BodyMemoryAdmission;
  responseWorkAdmission?: RequestPayloadDeps["responseWorkAdmission"];
  memoryStore?: Pick<MemoryStore, "getMemoryAdminStats">;
  pendingRequests?: (keyId: string, query: { requestId?: string; traceId?: string }) => string[];
  keyStore: Pick<KeyStore, "updateKey"> & Partial<Pick<KeyStore, "getById">>;
  apiKeyPools?: AdminApiDeps["apiKeyPools"];
  telemetry: Pick<
    TelemetryStore,
    | "findSessionRefsForKey"
    | "listSessionsByRefs"
    | "hasPayloadBlobReference"
    | "getPayloadBlob"
    | "aggregate"
    | "queryPage"
    | "getByRequestId"
    | "getApiKeyId"
    | "getCreatedAt"
    | "getPayload"
    | "getPayloadMeta"
    | "getPayloadPart"
    | "getPayloadPartEncoded"
    | "getPayloadPartStream"
    | "getSessionRevisionMeta"
    | "getSessionByRef"
    | "listSessionRevisionsPage"
    | "streamSessionRevisionsPage"
  >;
  now?: () => number;
  pseudonymSecret?: string | null;
  contentSettings?: () => { mode: "none" | "session" | "payload"; retentionDays: number };
  // Map a stored served-model value (which is the internal wire `provider_model`,
  // NOT the public alias — see SqliteTelemetryStore) to the PUBLIC lane alias the
  // user is entitled to see (§4.3: the served model already appears in their API
  // response). Without this the usage `by_model` doughnut would leak provider wire
  // model ids / supply-chain naming (原则 6 / R7). Unmappable → "other". Omitted in
  // tests that don't exercise the doughnut; then the raw label is dropped to "other".
  resolveModelLabel?: (wireModel: string) => string | null;
}

export function registerPortalApi(app: Hono<AppEnv>, deps: PortalApiDeps): void {
  const projectDecision =
    deps.pseudonymSecret === null ? null : createPortalDecisionProjection(deps.pseudonymSecret);
  const memoryStatsNext = new Map<string, number>();
  const blobResponses = new Map<string, number>();
  const notFound = { error: "request not found", code: "request_not_found" } as const;
  app.use("/portal/api/requests/*", async (c, next) => {
    c.header("cache-control", "no-store");
    await next();
    if (c.res.status === 404) c.res = c.json(notFound, 404);
  });

  app.get("/portal/api/memory/stats", async (c) => {
    const identity = c.get("identity");
    if (!identity.keyId || !identity.accountId) throw new Error("missing memory scope");
    if (!deps.memoryStore?.getMemoryAdminStats)
      return c.json({ error: "memory stats unavailable", code: "memory_unavailable" }, 503);
    const now = (deps.now ?? Date.now)();
    if (memoryStatsNext.size >= 5000)
      for (const [key, expires] of memoryStatsNext) if (expires <= now) memoryStatsNext.delete(key);
    if ((memoryStatsNext.get(identity.keyId) ?? 0) > now || memoryStatsNext.size >= 5000) {
      c.header("retry-after", "10");
      return c.json(
        { error: "memory stats rate limit exceeded", code: "memory_stats_rate_limited" },
        429,
      );
    }
    memoryStatsNext.set(identity.keyId, now + 10_000);
    const stats = await deps.memoryStore.getMemoryAdminStats({
      accountId: identity.accountId,
      projectId: identity.caps.memory.projectId ?? identity.keyId,
      now: new Date((deps.now ?? Date.now)()),
    });
    c.header("cache-control", "no-store");
    return c.json({
      generated_at: stats.generatedAt,
      project_id: identity.caps.memory.projectId ?? identity.keyId,
      shared: identity.caps.memory.projectName != null,
      storage: stats.storage,
      queue: stats.queue,
      leases: { running: stats.queue.running, stale: stats.queue.staleRunning },
      activity: stats.activity,
    });
  });

  // GET /portal/api/me — a SAFE projection of the caller's identity/caps for the
  // account menu + budget bar. NEVER the hash/plaintext/secret_enc (principle 7):
  // authMiddleware already dropped them — identity carries only prefix + caps.
  app.get("/portal/api/me", async (c) => {
    const identity = c.get("identity");
    const b = identity.caps.budget;
    return c.json({
      key_prefix: identity.keyPrefix,
      role: identity.role,
      allowed_lanes: identity.caps.allowedLanes,
      client_policy: identity.caps.clientPolicy ?? null,
      concurrency_limit: identity.caps.concurrencyLimit,
      allow_custom_model: identity.caps.allowCustomModel,
      allow_fast_mode: identity.caps.allowFastMode,
      request_content: {
        mode: identity.caps.requestContentMode ?? deps.contentSettings?.().mode ?? "none",
        retention_days: deps.contentSettings?.().retentionDays ?? null,
      },
      rate_limit: { rpm: identity.caps.rateLimit.rpm, tpm: identity.caps.rateLimit.tpm },
      budget: {
        requests: b.requests,
        tokens: b.tokens,
        spend_usd: b.spendUsd,
        window_seconds: b.weeklyAnchor == null ? b.windowSeconds : 604800,
        weekly_anchor: b.weeklyAnchor ?? null,
        current_cycle: deps.budgetStore
          ? await readWeeklyBudget(deps.budgetStore, identity.keyId, b, (deps.now ?? Date.now)())
          : null,
        behavior: b.weeklyAnchor == null ? b.behavior : "reject",
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
  app.use("/portal/api/memory-settings", memoryAdmissionReleaseGuard());
  app.patch("/portal/api/memory-settings", async (c) => {
    const identity = c.get("identity");
    // Root is the management-plane key and must remain memory-inert.
    if (identity.role === "root") {
      return c.json({ error: "root key memory settings are read-only" }, 403);
    }
    let body: unknown;
    try {
      const admitted =
        deps.memoryAdmission === undefined
          ? null
          : await readAdmittedRequestBody(c.req.raw, deps.memoryAdmission);
      if (admitted) c.set("requestMemoryRelease", admitted.release);
      body = admitted ? JSON.parse(admitted.text) : await c.req.json();
      admitted?.materialized();
    } catch (error) {
      if (error instanceof RequestAdmissionError) {
        c.header("retry-after", "1");
        return c.json({ error: { code: error.code, message: error.message } }, 503);
      }
      body = null;
    }
    const parsed = PortalMemorySettingsRequestSchema.safeParse(body);
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
        cache_hit_rate: t.promptTokens > 0 ? t.cachedTokens / t.promptTokens : null,
      },
      series: agg.series.map((s) => ({
        bucket_start_ms: s.bucketStartMs,
        requests: s.requests,
        prompt_tokens: s.promptTokens,
        completion_tokens: s.completionTokens,
        cached_tokens: s.cachedTokens,
        cache_creation_tokens: s.cacheCreationTokens,
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
        window_seconds: b.weeklyAnchor == null ? b.windowSeconds : 604800,
        weekly_anchor: b.weeklyAnchor ?? null,
        current_cycle: deps.budgetStore
          ? await readWeeklyBudget(deps.budgetStore, identity.keyId, b, (deps.now ?? Date.now)())
          : null,
        behavior: b.weeklyAnchor == null ? b.behavior : "reject",
      },
    });
  });

  // GET /portal/api/requests — the caller's OWN request list, whitelist-projected.
  // apiKeyId write-forced to identity.keyId (a caller ?key_id= is ignored, R5).
  app.get("/portal/api/requests", async (c) => {
    if (!projectDecision)
      return c.json(
        { error: "portal privacy unavailable", code: "portal_privacy_unavailable" },
        503,
      );
    const q = RequestsQuerySchema.parse(c.req.query());
    const identity = c.get("identity");
    const session = c.req.query("session")?.trim();
    if (session && session.length > 256)
      return c.json({ error: "invalid session filter", code: "invalid_session" }, 400);
    const sessionRefs = session
      ? ((await deps.telemetry.findSessionRefsForKey?.(identity.keyId, session)) ?? [])
      : undefined;
    if (sessionRefs && sessionRefs.length > 256)
      return c.json(
        { error: "session filter is too broad", code: "session_filter_too_broad" },
        422,
      );
    const { rows, total } = await deps.telemetry.queryPage({
      limit: q.pageSize,
      offset: (q.page - 1) * q.pageSize,
      startMs: q.start,
      endMs: q.end,
      status: q.status,
      lane: q.lane,
      decidedBy: q.decided_by,
      model: q.model,
      sessionRef: q.session_ref,
      sessionRefs,
      apiKeyId: identity.keyId, // WRITE-FORCED — never q.key_id
    });
    const refs = [
      ...new Set(rows.flatMap((r) => (r.record.session ? [r.record.session.ref] : []))),
    ];
    const sessions = refs.length ? ((await deps.telemetry.listSessionsByRefs?.(refs)) ?? []) : [];
    const labels = new Map(
      sessions
        .filter((session) => session.apiKeyId === identity.keyId)
        .map((session) => [session.sessionRef, session.externalSessionId]),
    );
    return c.json({
      items: rows.map((r) => {
        const safe = projectDecision(r.record);
        return {
          ...toPortalDecisionView(safe),
          decided_by: safe.classifier.decided_by,
          fallback_count: safe.fallback_count,
          stream_outcome: safe.stream_outcome,
          partial: safe.stream_outcome != null && safe.stream_outcome !== "completed",
          serving_provider:
            [...safe.provider_attempts].reverse().find((a) => !a.skipped)?.provider_name ?? null,
          session_ref: safe.session?.ref ?? null,
          session_label: safe.session ? (labels.get(safe.session.ref) ?? null) : null,
          created_at: r.createdAt.getTime(),
        };
      }),
      total,
      page: q.page,
      page_size: q.pageSize,
    });
  });

  const inProgress = (c: Context<AppEnv>, requestId: string) =>
    c.json({ status: "in_progress", request_id: requestId, phase: "telemetry_pending" }, 202);
  const detail = async (c: Context<AppEnv>, requestId: string) => {
    const identity = c.get("identity");
    if ((await assertOwnsTrace(deps.telemetry, identity.keyId, requestId)) !== "ok") {
      if (deps.pendingRequests?.(identity.keyId, { requestId }).length)
        return inProgress(c, requestId);
      return c.json(notFound, 404);
    }
    const rec = await deps.telemetry.getByRequestId(requestId);
    if (!rec) return c.json(notFound, 404);
    if (!projectDecision)
      return c.json(
        { error: "portal privacy unavailable", code: "portal_privacy_unavailable" },
        503,
      );
    const createdAt = await deps.telemetry.getCreatedAt(requestId);
    const safe = projectDecision(rec);
    const ownKey = await deps.keyStore.getById?.(identity.keyId);
    return c.json({
      ...toPortalDecisionView(safe),
      decision: {
        ...safe,
        key_name: ownKey?.name ?? null,
        ...(createdAt ? { created_at: createdAt.getTime() } : {}),
      },
      ...(createdAt ? { created_at: createdAt.getTime() } : {}),
    });
  };
  app.get("/portal/api/requests/by-trace/:clientTraceId", async (c) => {
    const keyId = c.get("identity").keyId;
    const traceId = c.req.param("clientTraceId");
    const page = await deps.telemetry.queryPage({ apiKeyId: keyId, traceId, limit: 2, offset: 0 });
    const pending = deps.pendingRequests?.(keyId, { traceId }) ?? [];
    const ids = new Set([...page.rows.map((r) => r.record.request_id), ...pending]);
    if (page.total > 1 || ids.size > 1)
      return c.json({ error: "client trace id is not unique", code: "ambiguous_trace_id" }, 409);
    const id = [...ids][0];
    return id ? detail(c, id) : c.json(notFound, 404);
  });
  app.get("/portal/api/requests/:traceId", (c) => detail(c, c.req.param("traceId")));

  app.use("/portal/api/requests/:traceId/*", async (c, next) => {
    const requestId = c.req.param("traceId");
    const keyId = c.get("identity").keyId;
    if ((await assertOwnsTrace(deps.telemetry, keyId, requestId)) !== "ok")
      return c.json({ error: "request not found" }, 404);
    c.header("cache-control", "no-store");
    return next();
  });
  app.get("/portal/api/requests/:traceId/payload-blobs/:sha256", async (c) => {
    const requestId = c.req.param("traceId");
    const sha256 = c.req.param("sha256");
    if (
      !/^[a-f0-9]{64}$/.test(sha256) ||
      !(await deps.telemetry.hasPayloadBlobReference?.(requestId, sha256))
    )
      return c.json(notFound, 404);
    const decision = await deps.telemetry.getByRequestId(requestId);
    if (!decision || decision.request_content_mode === "none") return c.json(notFound, 404);
    const keyId = c.get("identity").keyId;
    const active = blobResponses.get(keyId) ?? 0;
    if (active >= 2) {
      c.header("retry-after", "1");
      return c.json({ error: "too many blob responses", code: "blob_concurrency_limited" }, 429);
    }
    const admission = deps.responseWorkAdmission ?? runtimeResponseWorkAdmission();
    const maxBytes = Math.min(16 * 1024 * 1024, Math.floor(admission.capacityBytes / 8));
    const acquired = admission.acquire(maxBytes);
    if (!acquired.ok)
      return c.json({ error: "response capacity unavailable", code: "response_capacity" }, 503);
    blobResponses.set(keyId, active + 1);
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      acquired.lease.release();
      const remaining = (blobResponses.get(keyId) ?? 1) - 1;
      if (remaining) blobResponses.set(keyId, remaining);
      else blobResponses.delete(keyId);
    };
    let transferred = false;
    try {
      const blob = await deps.telemetry.getPayloadBlob?.(sha256, maxBytes);
      if (!blob) return c.json(notFound, 404);
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(blob.bytes));
        },
        pull(controller) {
          controller.close();
          release();
        },
        cancel() {
          release();
        },
      });
      const mime =
        blob.mime && /^image\/[a-z0-9.+-]+$/i.test(blob.mime)
          ? blob.mime
          : "application/octet-stream";
      const response = new Response(body, {
        headers: {
          "content-type": mime,
          "cache-control": "no-store",
          "x-content-type-options": "nosniff",
          "content-security-policy": "default-src 'none'; sandbox",
        },
      });
      transferred = true;
      return response;
    } finally {
      if (!transferred) release();
    }
  });
  registerPortalReplayRoute(app, deps);
  registerRequestPayloadRoutes(
    app,
    {
      ...deps,
      projectPayload: projectPortalPayload,
      authorizeSession: async (requestId, sessionRef) => {
        const keyId = await deps.telemetry.getApiKeyId(requestId);
        const session = await deps.telemetry.getSessionByRef?.(sessionRef);
        return keyId !== null && session?.apiKeyId === keyId;
      },
    } satisfies RequestPayloadDeps,
    "/portal/api/requests",
    true,
  );
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
): Array<{
  model: string;
  requests: number;
  total_tokens: number;
  prompt_tokens: number;
  completion_tokens: number;
  cost_usd: number | null;
}> {
  const byLabel = new Map<
    string,
    {
      model: string;
      requests: number;
      total_tokens: number;
      prompt_tokens: number;
      completion_tokens: number;
      cost_usd: number | null;
    }
  >();
  for (const m of rows) {
    const label = labelOf(m);
    const acc = byLabel.get(label);
    if (acc) {
      acc.requests += m.requests;
      acc.total_tokens += m.totalTokens;
      acc.prompt_tokens += m.promptTokens;
      acc.completion_tokens += m.completionTokens;
      if (m.costUsd !== null) acc.cost_usd = (acc.cost_usd ?? 0) + m.costUsd;
    } else {
      byLabel.set(label, {
        model: label,
        requests: m.requests,
        total_tokens: m.totalTokens,
        prompt_tokens: m.promptTokens,
        completion_tokens: m.completionTokens,
        cost_usd: m.costUsd,
      });
    }
  }
  return [...byLabel.values()].sort((a, b) => b.total_tokens - a.total_tokens);
}
