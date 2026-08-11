import type {
  RequestPayload,
  RequestPayloadMeta,
  RequestPayloadPart,
  RequestPayloadPartRecord,
  ResponseWorkAdmission,
  SessionRevisionRecord,
} from "@helm/core";
import {
  restoreSessionRevisionJson,
  runtimeMemoryBudget,
  runtimeResponseWorkAdmission,
} from "@helm/core";
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
  // The query (page/pageSize + date-window/status/decided_by/lane/model-or-route
  // filters) is parsed through the shared schema, which is FAIL-OPEN: a malformed param
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
      sessionRef: q.session_ref,
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
    const sessionRefs = [
      ...new Set(rows.flatMap((row) => (row.record.session ? [row.record.session.ref] : []))),
    ];
    const sessionRows = deps.telemetry.listSessionsByRefs
      ? await deps.telemetry.listSessionsByRefs(sessionRefs)
      : [];
    const sessionLabelByRef = new Map(
      sessionRows.map((session) => [session.sessionRef, session.externalSessionId]),
    );
    return c.json({
      items: rows.map((r) => ({
        ...r.record,
        ...(r.record.session
          ? {
              session: {
                ...r.record.session,
                label: sessionLabelByRef.get(r.record.session.ref),
              },
            }
          : {}),
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
    const sessionRow =
      rec.session && deps.telemetry.getSessionByRef
        ? await deps.telemetry.getSessionByRef(rec.session.ref)
        : null;
    return c.json({
      ...rec,
      ...(rec.session ? { session: { ...rec.session, label: sessionRow?.externalSessionId } } : {}),
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
    const traceId = c.req.param("traceId");
    const part = parsePayloadPart(c.req.query("part"));
    if (part === "invalid") return c.json({ error: "invalid payload part" }, 400);
    if (part === "meta") {
      const meta = await getPayloadMeta(deps, traceId);
      if (!meta) {
        const sessionMeta = await deps.telemetry.getSessionRevisionMeta?.(traceId);
        if (sessionMeta) {
          const decision = await deps.telemetry.getByRequestId(traceId);
          if (decision?.session?.ref !== sessionMeta.sessionRef) {
            return c.json({
              captured: false,
              source: "unavailable",
              reason: "session_unavailable",
            });
          }
          const responseAdmission = deps.responseWorkAdmission ?? runtimeResponseWorkAdmission();
          if (
            sessionMeta.recoveryWireBytes === null ||
            sessionMeta.recoveryWireBytes > sessionRecoveryMaxWireBytes(responseAdmission)
          ) {
            return c.json({
              captured: false,
              source: "unavailable",
              reason: "session_recovery_limited",
            });
          }
          return c.json({
            captured: true,
            source: "session",
            exact: false,
            fidelity: sessionMeta.fidelity,
            created_at: sessionMeta.createdAt.getTime(),
            parts: {
              request: true,
              response: decision?.final.status === "ok" && sessionMeta.responseBodyStored,
              upstream_request: false,
            },
          });
        }
        const recovered = await getSessionRequest(deps, traceId);
        if (recovered.status === "unavailable")
          return c.json({ captured: false, source: "unavailable", reason: recovered.reason });
        try {
          return c.json({
            captured: true,
            source: "session",
            exact: false,
            fidelity: recovered.fidelity,
            created_at: recovered.createdAt.getTime(),
            parts: {
              request: true,
              response: recovered.responseJson !== null,
              upstream_request: false,
            },
          });
        } finally {
          recovered.release();
        }
      }
      return c.json({
        captured: true,
        source: "payload",
        exact: true,
        fidelity: "exact",
        created_at: meta.createdAt.getTime(),
        parts: {
          request: meta.parts.request,
          response: meta.parts.response,
          upstream_request: meta.parts.upstreamRequest,
        },
      });
    }
    if (part !== "full") {
      const exactMeta = await deps.telemetry.getPayloadMeta?.(traceId);
      const partStored =
        exactMeta === undefined ||
        (exactMeta !== null &&
          (part === "request"
            ? exactMeta.parts.request
            : part === "response"
              ? exactMeta.parts.response
              : exactMeta.parts.upstreamRequest));
      const admitted = partStored
        ? await readPayloadWithinResponseWork(
            deps,
            () => getPayloadPart(deps, traceId, part),
            payloadPartWireBytes,
          )
        : ({ status: "missing", value: null } as const);
      if (admitted.status === "limited")
        return c.json({
          captured: false,
          source: "unavailable",
          reason: "payload_recovery_limited",
        });
      const p = admitted.value;
      if (!p) {
        const recovered =
          part === "request" || part === "response" ? await getSessionRequest(deps, traceId) : null;
        if (!recovered)
          return c.json({ captured: false, source: "unavailable", reason: "no_session" });
        if (recovered.status === "unavailable")
          return c.json({ captured: false, source: "unavailable", reason: recovered.reason });
        try {
          const json = part === "request" ? recovered.requestJson : recovered.responseJson;
          if (json === null)
            return c.json({
              captured: false,
              source: "unavailable",
              reason: "response_unavailable",
            });
          return c.json({
            captured: true,
            source: "session",
            exact: false,
            fidelity: recovered.fidelity,
            part,
            value: parseMaybeJson(json),
            created_at: recovered.createdAt.getTime(),
          });
        } finally {
          recovered.release();
        }
      }
      try {
        return c.json({
          captured: true,
          source: "payload",
          exact: true,
          fidelity: "exact",
          part,
          value: p.json === null ? null : parseMaybeJson(p.json),
          created_at: p.createdAt.getTime(),
        });
      } finally {
        admitted.release();
      }
    }

    const exactMeta = await deps.telemetry.getPayloadMeta?.(traceId);
    const admitted =
      exactMeta === null
        ? ({ status: "missing", value: null } as const)
        : await readPayloadWithinResponseWork(
            deps,
            () => deps.telemetry.getPayload(traceId),
            payloadWireBytes,
          );
    if (admitted.status === "limited")
      return c.json({
        captured: false,
        source: "unavailable",
        reason: "payload_recovery_limited",
      });
    const p = admitted.value;
    if (!p) {
      const recovered = await getSessionRequest(deps, traceId);
      if (recovered.status === "unavailable")
        return c.json({ captured: false, source: "unavailable", reason: recovered.reason });
      try {
        return c.json({
          captured: true,
          source: "session",
          exact: false,
          fidelity: recovered.fidelity,
          request: parseMaybeJson(recovered.requestJson),
          response: recovered.responseJson === null ? null : parseMaybeJson(recovered.responseJson),
          upstream_request: null,
          created_at: recovered.createdAt.getTime(),
        });
      } finally {
        recovered.release();
      }
    }
    try {
      return c.json({
        captured: true,
        source: "payload",
        exact: true,
        fidelity: "exact",
        request: parseMaybeJson(p.requestJson),
        response: p.responseJson === null ? null : parseMaybeJson(p.responseJson),
        // The EXACT body forwarded upstream (post memory-inject + protocol-translation)
        // — what the model actually received. Null when no provider served / pre-feature.
        upstream_request:
          p.upstreamRequestJson === null ? null : parseMaybeJson(p.upstreamRequestJson),
        created_at: p.createdAt.getTime(),
      });
    } finally {
      admitted.release();
    }
  });

  // GET /requests/:traceId/session-revisions?after=<seq> — one keyset page of RAW,
  // unreconstructed revision rows. The browser walks the cursor (nextSequence) and
  // rebuilds the transcript client-side via @helm/shared's restoreSessionRevisionJson.
  // Unlike the server-side /payload recovery path (getSessionRequest), this does NOT
  // reserve a whole response-work window: reconstruction never happens server-side, so
  // only ONE byte-bounded page is materialized per request. That is what lets a large
  // transcript that the server refuses to rebuild (session_recovery_limited) still be
  // inspected. `maxBytes` caps a single page; each row is also hard-capped before
  // JSON serialization so one malformed historical revision cannot bypass the bound.
  app.get("/admin/api/requests/:traceId/session-revisions", async (c) => {
    const traceId = c.req.param("traceId");
    // no_session (not a session request at all) is more fundamental than the store's
    // paging capability, so resolve the session ref FIRST.
    const decision = await deps.telemetry.getByRequestId(traceId);
    const sessionRef = decision?.session?.ref;
    if (!sessionRef) return c.json({ captured: false, reason: "no_session" });
    // Streaming variant (NOT the all-or-nothing listSessionRevisionsPage the server-side
    // rebuild uses): every page returns ≥1 row and always advances the cursor, so a large
    // session pages through instead of dead-ending on an empty page.
    const streamPage = deps.telemetry.streamSessionRevisionsPage;
    if (!streamPage) return c.json({ captured: false, reason: "session_unavailable" });
    const afterRaw = c.req.query("after");
    const afterSequence =
      afterRaw !== undefined && /^\d+$/.test(afterRaw) ? Number(afterRaw) : undefined;
    const page = await streamPage.call(deps.telemetry, sessionRef, {
      afterSequence,
      limit: SESSION_REVISION_PAGE_LIMIT,
      maxBytes: SESSION_REVISION_PAGE_MAX_BYTES,
    });
    // `c.json()` can expand escaped strings and holds transient copies; use the shared
    // worst-case JSON allocation multiplier before admitting an individual row.
    const jsonAmplification = runtimeMemoryBudget().jsonAmplification;
    if (
      page.revisions.some(
        (revision) =>
          sessionRevisionWireBytes(revision) * jsonAmplification > SESSION_REVISION_PAGE_MAX_BYTES,
      )
    ) {
      return c.json({ captured: false, reason: "session_recovery_limited" });
    }
    return c.json({
      captured: true,
      sessionRef,
      targetRequestId: traceId,
      nextSequence: page.nextSequence,
      // sequence + createdAt let the browser render the raw request/response pairs
      // by their recorded time; sessionRef/fidelity remain recovery-irrelevant.
      revisions: page.revisions.map((r) => ({
        requestId: r.requestId,
        sequence: r.sequence,
        createdAt: r.createdAt.getTime(),
        parentRequestId: r.parentRequestId,
        retainCount: r.retainCount,
        requestDeltaJson: r.requestDeltaJson,
        requestEnvelopeJson: r.requestEnvelopeJson,
        responseId: r.responseId,
        responseJson: r.responseJson,
      })),
    });
  });
}

// One raw-revision page: `limit` caps rows/page and `maxBytes` caps both the page and
// every returned row. The client drives the cursor across pages, so these are per-page
// bounds, not a whole-transcript budget.
const SESSION_REVISION_PAGE_LIMIT = 100;
const SESSION_REVISION_PAGE_MAX_BYTES = 8 * 1024 * 1024;

async function getSessionRequest(
  deps: AdminApiDeps,
  requestId: string,
): Promise<
  | {
      status: "recovered";
      requestJson: string;
      responseJson: string | null;
      fidelity: string;
      createdAt: Date;
      release: () => void;
    }
  | {
      status: "unavailable";
      reason:
        | "no_session"
        | "session_unavailable"
        | "session_incomplete"
        | "session_recovery_limited";
    }
> {
  const listPage = deps.telemetry.listSessionRevisionsPage;
  const decision = await deps.telemetry.getByRequestId(requestId);
  const sessionRef = decision?.session?.ref;
  if (!sessionRef) return { status: "unavailable", reason: "no_session" };
  if (!listPage) return { status: "unavailable", reason: "session_unavailable" };
  const budget = runtimeMemoryBudget();
  const responseAdmission = deps.responseWorkAdmission ?? runtimeResponseWorkAdmission();
  // ponytail: half a response-work window lets inspection coexist with live API
  // traffic; add metadata-first admission if larger concurrent restores are needed.
  const recoveryMaxWireBytes = sessionRecoveryMaxWireBytes(
    responseAdmission,
    budget.jsonAmplification,
  );
  const meta = await deps.telemetry.getSessionRevisionMeta?.(requestId);
  if (meta) {
    if (meta.sessionRef !== sessionRef)
      return { status: "unavailable", reason: "session_unavailable" };
    if (meta.recoveryWireBytes === null || meta.recoveryWireBytes > recoveryMaxWireBytes)
      return { status: "unavailable", reason: "session_recovery_limited" };
  }
  // Reserve one whole safe recovery window before the adapter materializes even
  // the first page. Reserving after listPage() would let concurrent readers each
  // allocate a large page before either one became visible to the shared budget.
  const acquired = responseAdmission.acquire(recoveryMaxWireBytes);
  if (!acquired.ok) return { status: "unavailable", reason: "session_recovery_limited" };
  const revisions: SessionRevisionRecord[] = [];
  let afterSequence: number | undefined;
  let wireBytes = 0;
  let releaseTransferred = false;
  try {
    for (;;) {
      const remainingBytes = recoveryMaxWireBytes - wireBytes;
      if (remainingBytes <= 0) return { status: "unavailable", reason: "session_recovery_limited" };
      const page = await listPage.call(deps.telemetry, sessionRef, {
        afterSequence,
        limit: 100,
        maxBytes: remainingBytes,
      });
      if (page.limited) return { status: "unavailable", reason: "session_recovery_limited" };
      if (page.revisions.length === 0)
        return { status: "unavailable", reason: "session_unavailable" };
      for (const revision of page.revisions) wireBytes += sessionRevisionWireBytes(revision);
      if (wireBytes > recoveryMaxWireBytes)
        return { status: "unavailable", reason: "session_recovery_limited" };
      revisions.push(...page.revisions);
      const target = page.revisions.find((revision) => revision.requestId === requestId);
      if (target) {
        const recovered = {
          status: "recovered" as const,
          requestJson: restoreSessionRevisionJson(revisions, requestId),
          responseJson: decision.final.status === "ok" ? target.responseJson : null,
          fidelity: target.fidelity,
          createdAt: target.createdAt,
          release: acquired.lease.release,
        };
        releaseTransferred = true;
        return recovered;
      }
      if (page.nextSequence === null)
        return { status: "unavailable", reason: "session_unavailable" };
      if (afterSequence !== undefined && page.nextSequence <= afterSequence)
        return { status: "unavailable", reason: "session_incomplete" };
      afterSequence = page.nextSequence;
    }
  } catch {
    return { status: "unavailable", reason: "session_incomplete" };
  } finally {
    if (!releaseTransferred) acquired.lease.release();
  }
}

function sessionRecoveryMaxWireBytes(
  responseAdmission: ResponseWorkAdmission,
  jsonAmplification = runtimeMemoryBudget().jsonAmplification,
): number {
  return Math.max(1, Math.floor(responseAdmission.capacityBytes / jsonAmplification / 2));
}

function sessionRevisionWireBytes(revision: SessionRevisionRecord): number {
  const values = [
    revision.sessionRef,
    revision.requestId,
    revision.parentRequestId,
    revision.requestDeltaJson,
    revision.requestEnvelopeJson,
    revision.responseId,
    revision.responseJson,
    revision.fidelity,
  ];
  return values.reduce(
    (bytes, value) => bytes + (value === null ? 0 : Buffer.byteLength(value, "utf8")),
    64,
  );
}

type PayloadPartQuery = "full" | "meta" | RequestPayloadPart | "invalid";

function parsePayloadPart(value: string | undefined): PayloadPartQuery {
  if (value === undefined || value === "" || value === "full") return "full";
  if (value === "meta") return "meta";
  if (value === "request" || value === "response" || value === "upstream_request") return value;
  return "invalid";
}

async function getPayloadMeta(
  deps: AdminApiDeps,
  requestId: string,
): Promise<RequestPayloadMeta | null> {
  if (deps.telemetry.getPayloadMeta) return deps.telemetry.getPayloadMeta(requestId);
  const p = await deps.telemetry.getPayload(requestId);
  return p ? metaFromPayload(p) : null;
}

function metaFromPayload(p: RequestPayload): RequestPayloadMeta {
  return {
    requestId: p.requestId,
    createdAt: p.createdAt,
    parts: {
      request: p.requestJson !== null,
      response: p.responseJson !== null,
      upstreamRequest: p.upstreamRequestJson !== null,
    },
  };
}

async function getPayloadPart(
  deps: AdminApiDeps,
  requestId: string,
  part: RequestPayloadPart,
): Promise<RequestPayloadPartRecord | null> {
  if (deps.telemetry.getPayloadPart) return deps.telemetry.getPayloadPart(requestId, part);
  const p = await deps.telemetry.getPayload(requestId);
  if (!p) return null;
  return {
    requestId: p.requestId,
    part,
    json: payloadPartJson(p, part),
    createdAt: p.createdAt,
  };
}

function payloadPartJson(p: RequestPayload, part: RequestPayloadPart): string | null {
  if (part === "request") return p.requestJson;
  if (part === "response") return p.responseJson;
  return p.upstreamRequestJson;
}

function payloadWireBytes(payload: RequestPayload): number {
  return [payload.requestJson, payload.responseJson, payload.upstreamRequestJson].reduce(
    (bytes, value) => bytes + (value === null ? 0 : Buffer.byteLength(value, "utf8")),
    64,
  );
}

function payloadPartWireBytes(payload: RequestPayloadPartRecord): number {
  return 64 + (payload.json === null ? 0 : Buffer.byteLength(payload.json, "utf8"));
}

async function readPayloadWithinResponseWork<T>(
  deps: AdminApiDeps,
  read: () => Promise<T | null>,
  wireBytes: (value: T) => number,
): Promise<
  | { status: "loaded"; value: T; release: () => void }
  | { status: "missing"; value: null }
  | { status: "limited" }
> {
  const admission = deps.responseWorkAdmission ?? runtimeResponseWorkAdmission();
  const maxWireBytes = sessionRecoveryMaxWireBytes(admission);
  const acquired = admission.acquire(maxWireBytes);
  if (!acquired.ok) return { status: "limited" };
  try {
    const value = await read();
    if (value === null) {
      acquired.lease.release();
      return { status: "missing", value: null };
    }
    if (wireBytes(value) > maxWireBytes) {
      acquired.lease.release();
      return { status: "limited" };
    }
    return { status: "loaded", value, release: acquired.lease.release };
  } catch (error) {
    acquired.lease.release();
    throw error;
  }
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
