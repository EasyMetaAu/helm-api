import type { Hono } from "hono";
import type { AppEnv } from "../../app.js";
import type { AdminApiDeps } from "./deps.js";

// /admin/api/requests — request debugging (TelemetryStore, READ-ONLY). Surfaces
// the docs/07 decision fields: 分类层级, 命中策略, lane 候选链, provider 尝试, 成本,
// 错误, trace_id.
//
// Both the list and the detail return the full (already-redacted) DecisionRecord:
// it carries NO plaintext key or private payload (原则7), so there is nothing to
// strip. The list view in the SPA needs the per-row classification stage
// (`decided_by`), candidate lane, fallback count and cost — all of which live in
// the record — so projecting to a 4-field summary here would force the UI to
// recompute/guess them (and conflate classification vs execution fallback,
// breaking 原则5). Returning the records keeps the UI a pure consumer (原则1).

const DEFAULT_LIMIT = 100;

export function registerRequestsRoutes(app: Hono<AppEnv>, deps: AdminApiDeps): void {
  // GET /requests -> DecisionRecord[] (most recent first; already redacted).
  app.get("/admin/api/requests", async (c) => {
    const records = await deps.telemetry.queryRecent(DEFAULT_LIMIT);
    return c.json(records);
  });

  // GET /requests/:traceId -> RequestDetail (full decision trail) | 404.
  app.get("/admin/api/requests/:traceId", async (c) => {
    const rec = await deps.telemetry.getByRequestId(c.req.param("traceId"));
    if (!rec) return c.json({ error: "request not found" }, 404);
    return c.json(rec);
  });
}
