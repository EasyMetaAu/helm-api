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
      // Exact key scope (the key detail page's request list). Omitted in the
      // global Debug list → no api_key_id filter.
      apiKeyId: q.key_id,
    });
    // Resolve each row's recorded api_key_id (key_id) to the key's human NAME so the
    // SPA can show a recognizable label instead of the opaque prefix. The redacted
    // DecisionRecord deliberately omits the key_id (it carries only key_prefix), so the
    // store surfaces it per page row; we join it to the keystore HERE (the route owns
    // keyStore — core stays headless, Principle 1). One list() per page, not per row.
    // The name is cosmetic (no key material — Principle 7); null when the key is
    // unnamed OR was since deleted, so the SPA falls back to the prefix.
    const keys = await deps.keyStore.list();
    const nameById = new Map(keys.map((k) => [k.key_id, k.name]));
    return c.json({
      items: rows.map((r) => ({
        ...r.record,
        created_at: r.createdAt.getTime(),
        key_name: nameById.get(r.apiKeyId) ?? null,
        // The recorded api_key_id (internal UUID), so the SPA can offer "filter by
        // this key". NOT key material — the plaintext key is only ever a sha256
        // hash (Principle 7); this is the same id used in the /keys/<id> URL.
        key_id: r.apiKeyId,
      })),
      total,
      page: q.page,
      pageSize: q.pageSize,
    });
  });

  // GET /requests/:traceId -> RequestDetail (full decision trail) | 404. The
  // DecisionRecord has no timestamp field, so we flatten created_at (epoch ms)
  // onto it exactly like the list endpoint above — the SPA header shows the same
  // request time as the list "Time" column instead of "time not recorded". We also
  // join the recorded api_key_id -> the key's human NAME (same as the list), so the
  // detail's "Request summary" card can show a recognizable label, not just the
  // prefix the record already carries.
  app.get("/admin/api/requests/:traceId", async (c) => {
    const traceId = c.req.param("traceId");
    const rec = await deps.telemetry.getByRequestId(traceId);
    if (!rec) return c.json({ error: "request not found" }, 404);
    const createdAt = await deps.telemetry.getCreatedAt(traceId);
    // Resolve api_key_id -> key name (cosmetic label, no key material — Principle 7).
    // null when the key is unnamed OR was since deleted; the SPA then falls back to
    // the key_prefix carried in the record. The route owns keyStore (Principle 1).
    const apiKeyId = await deps.telemetry.getApiKeyId(traceId);
    const keyName = apiKeyId
      ? ((await deps.keyStore.list()).find((k) => k.key_id === apiKeyId)?.name ?? null)
      : null;
    return c.json({
      ...rec,
      ...(createdAt ? { created_at: createdAt.getTime() } : {}),
      key_name: keyName,
    });
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
      // The EXACT body forwarded upstream (post memory-inject + protocol-translation)
      // — what the model actually received. Null when no provider served / pre-feature.
      upstream_request:
        p.upstreamRequestJson === null ? null : parseMaybeJson(p.upstreamRequestJson),
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
