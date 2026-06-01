import { RequestsQuerySchema } from "@helm/shared";
import type { Hono } from "hono";
import type { AppEnv } from "../../app.js";
import type { AdminApiDeps } from "./deps.js";

// /admin/api/requests — request debugging (TelemetryStore, READ-ONLY). Surfaces
// the docs/07 decision fields: classification stage, matched policy, lane candidate
// chain, provider attempts, cost, error, trace_id.
//
// Both the list and the detail return the full (already-redacted) DecisionRecord:
// it carries NO plaintext key or private payload (Principle 7), so there is nothing to
// strip. The list view in the SPA needs the per-row classification stage
// (`decided_by`), candidate lane, fallback count and cost — all of which live in
// the record — so projecting to a 4-field summary here would force the UI to
// recompute/guess them (and conflate classification vs execution fallback,
// breaking Principle 5). Returning the records keeps the UI a pure consumer (Principle 1).

export function registerRequestsRoutes(app: Hono<AppEnv>, deps: AdminApiDeps): void {
  // GET /requests -> { items: (DecisionRecord & { created_at })[], total, page,
  // pageSize } — a filtered + numbered page, most recent first, already redacted.
  // The query (page/pageSize + date-window/status/decided_by/lane/model filters)
  // is parsed through the shared schema, which is FAIL-OPEN: a malformed param
  // (stale bookmark, hand-typed) coerces to a safe default rather than 5xx-ing a
  // read endpoint. The store pairs each record with its recorded timestamp (a
  // separate column kept out of the redacted record); we flatten it onto the row
  // as `created_at` (epoch ms) for the Debug UI "Time" column (Principle 1).
  // `total` reflects the SAME filters so the UI renders "Page X of Y" without a
  // second round-trip.
  app.get("/admin/api/requests", async (c) => {
    const q = RequestsQuerySchema.parse(c.req.query());
    const { rows, total } = await deps.telemetry.queryPage({
      limit: q.pageSize,
      offset: (q.page - 1) * q.pageSize,
      startMs: q.start,
      endMs: q.end,
      status: q.status,
      decidedBy: q.decided_by,
      lane: q.lane,
      model: q.model,
    });
    return c.json({
      items: rows.map((r) => ({ ...r.record, created_at: r.createdAt.getTime() })),
      total,
      page: q.page,
      pageSize: q.pageSize,
    });
  });

  // GET /requests/:traceId -> RequestDetail (full decision trail) | 404.
  app.get("/admin/api/requests/:traceId", async (c) => {
    const rec = await deps.telemetry.getByRequestId(c.req.param("traceId"));
    if (!rec) return c.json({ error: "request not found" }, 404);
    return c.json(rec);
  });

  // GET /requests/:traceId/payload -> the captured full request/response bodies
  // (admin "System Settings" → capture_payloads). 200 with { captured:true, ... }
  // when present; 200 with { captured:false } when this request was served while
  // capture was OFF (or rows were pruned). The bodies are stored as JSON TEXT;
  // parse them back so the SPA renders structured JSON, falling back to the raw
  // string if it was a non-JSON stream (assembled SSE).
  app.get("/admin/api/requests/:traceId/payload", async (c) => {
    const p = await deps.telemetry.getPayload(c.req.param("traceId"));
    if (!p) return c.json({ captured: false });
    return c.json({
      captured: true,
      request: parseMaybeJson(p.requestJson),
      response: p.responseJson === null ? null : parseMaybeJson(p.responseJson),
      created_at: p.createdAt.getTime(),
    });
  });
}

// Parse stored JSON text back to a value; if it isn't valid JSON (e.g. assembled
// raw SSE for a streamed response), surface the raw string unchanged.
function parseMaybeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
