// Admin request-debug API client. The admin UI is a PURE consumer of the
// gateway's /admin/api/* HTTP surface — it imports NO core/gateway business logic
// and re-computes NO classification/routing/cost (CLAUDE.md Principle 1). It only renders
// the trail the backend already recorded.
//
// Real backend contract (apps/gateway/src/routes/admin/requests.ts):
//   GET /admin/api/requests        -> RequestSummary[]  (most recent first;
//                                     { trace_id, lane, status, cost })
//   GET /admin/api/requests/:trace -> raw DecisionRecord (@helm/shared) | 404
//
// Since admin.requests-richfields the DecisionRecord records the real telemetry
// fields (key_prefix, latency_total_ms, fallback_count, cost_breakdown{eval/
// completion}); we map the recorded shape -> the docs/07 UI contract at this
// boundary, reading the real fields and only DERIVING/DEFAULTING for legacy
// (pre-enrichment) records — never fabricating data. See implementation-notes.md
// for the field map.
//
// CLAUDE.md Principle 5: classification fallback (`decided_by`) and execution fallback
// (`provider_attempts`/`fallback_count`) are SEPARATE — they are surfaced as
// distinct UI concepts here and never conflated.
// CLAUDE.md Principle 7: redaction — `key_prefix` is prefix-only (the recorded display
// prefix, e.g. helm_live_ab12, NEVER the plaintext key; '—' when absent);
// `payload_summary` is a summary placeholder, never the full private payload;
// `provider_raw` is redacted.

// ── UI-facing contract (docs/07) ─────────────────────────────────────────────

export interface RequestListItem {
  trace_id: string;
  ts: string; // timestamp
  key_prefix: string; // display prefix only — NEVER plaintext
  user_id?: string;
  org_id?: string;
  requested_model: string | null;
  task_type: string;
  complexity: string;
  decided_by: 'rules' | 'eval' | 'default' | 'fallback'; // decision layer (classification stage)
  lane: string;
  final_model: string | null;
  fallback_count: number; // execution fallback count (provider attempts - 1)
  status: 'ok' | 'error';
  latency_ms: number;
  // null = NOT measured (no pricing / usage unknown — e.g. an unpriced model),
  // rendered as '—'. A number is a real cost. Crucially distinct from 0 so an
  // unmeasured request never looks like a free one (#6).
  cost_usd: number | null;
  error_class?: string;
}

// Redacted per-attempt upstream failure detail (admin-debug-error-detail).
// Present only for an attempt that failed at the upstream; the backend has
// already key-scrubbed `provider_raw` (Principle 7), so this is safe to display.
export interface AttemptErrorDetail {
  upstream_status: number | null; // real upstream HTTP status (e.g. 429); null for timeout/network
  message: string; // redacted, human-readable
  provider_raw: unknown; // upstream error body (redacted), or null
}

export interface ProviderAttempt {
  model: string;
  provider: string;
  outcome: 'success' | 'error' | 'timeout' | 'rate_limited' | 'circuit_open' | 'skipped';
  skip_reason?: string;
  latency_ms: number;
  error_class?: string;
  // Expandable upstream detail for a failed attempt — null when none recorded
  // (ok/skipped rows, or legacy records from before this was captured).
  error_detail: AttemptErrorDetail | null;
}

export interface RequestDetail {
  trace_id: string;
  ts: string;
  request_meta: Record<string, unknown>;
  payload_summary: string; // redacted summary — NOT the full payload
  classifier_output: {
    task_type: string;
    complexity: string;
    confidence: number;
    matched_dimensions: string[];
    constraints: Record<string, boolean>;
  };
  eval_triggered: boolean;
  eval_cache_hit: boolean | null;
  matched_policy: string | null;
  lane_candidates: string[]; // primary + fallback[]
  provider_attempts: ProviderAttempt[];
  response_meta: Record<string, unknown> | null;
  error: {
    error_class: string;
    http_status: number;
    message: string;
    provider_raw: unknown;
  } | null;
  cost_breakdown: {
    routing_usd: number;
    eval_usd: number;
    completion_usd: number;
    total_usd: number;
  };
}

// ── Raw backend shapes (mirror @helm/shared DecisionRecord; admin must not import
//    @helm/core/@helm/shared, so we type just what we read) ────────────────────

interface RawAttempt {
  alias?: string;
  skipped?: boolean;
  skip_reason?: string | null;
  status?: string;
  error_class?: string | null;
  latency_ms?: number;
  cost_usd?: number | null;
  provider_model?: string | null;
  // Redacted upstream failure detail (admin-debug-error-detail). Null/absent on
  // ok/skipped rows and on legacy records.
  error_detail?: {
    upstream_status?: number | null;
    message?: string;
    provider_raw?: unknown;
  } | null;
}

interface RawDecisionRecord {
  request_id?: string;
  trace_id?: string;
  // Epoch ms the gateway recorded the request (store metadata flattened onto the
  // row by GET /admin/api/requests). Absent on legacy records → ts stays ''.
  created_at?: number;
  requested_model?: string;
  // Display prefix only (helm_live_ab12) — the record NEVER carries the plaintext
  // key (Principle 7). Null/absent on legacy (pre-enrichment) records.
  key_prefix?: string | null;
  // Enriched telemetry (admin.requests-richfields): Σ attempt latency, execution
  // fallback count, and the eval/completion cost split. Absent on legacy records.
  latency_total_ms?: number;
  fallback_count?: number;
  cost_breakdown?: {
    eval_usd?: number | null;
    completion_usd?: number | null;
    total_usd?: number | null;
  };
  classifier?: {
    task_type?: string;
    complexity?: string;
    confidence?: number;
    decided_by?: string;
    eval_cache_hit?: boolean | null;
    constraints?: Record<string, unknown>;
    explanation?: unknown[];
  };
  policy?: { matched_policy_id?: string | null; reason?: string };
  lane?: { selected_lane?: string; candidate_chain?: string[] };
  provider_attempts?: RawAttempt[];
  final?: {
    model_alias?: string | null;
    provider_model?: string | null;
    status?: string;
    error_reason?: string | null;
  };
}

const BASE = '/admin/api/requests';

async function asJson<T>(res: Response): Promise<T> {
  if (!res.ok) {
    let detail = '';
    try {
      detail = JSON.stringify(await res.json());
    } catch {
      // body not JSON; keep the status only
    }
    throw new Error(`requests api ${res.status}${detail ? `: ${detail}` : ''}`);
  }
  return (await res.json()) as T;
}

const DECIDED_BY = new Set(['rules', 'eval', 'default', 'fallback']);
function normalizeDecidedBy(v: unknown): RequestListItem['decided_by'] {
  return DECIDED_BY.has(v as string) ? (v as RequestListItem['decided_by']) : 'default';
}

function sumCost(attempts: RawAttempt[]): number {
  return attempts.reduce((acc, a) => acc + (typeof a.cost_usd === 'number' ? a.cost_usd : 0), 0);
}

// List-row cost: a real number when ANY signal carries it (a priced attempt or a
// recorded total), else null = "not measured" (rendered '—', never $0.0000). This
// is the UI side of #6: a streamed call now backfills a real cost, while a request
// against an unpriced model stays honestly unmeasured instead of looking free.
function listCost(raw: RawDecisionRecord, attempts: RawAttempt[]): number | null {
  if (attempts.some((a) => typeof a.cost_usd === 'number')) return sumCost(attempts);
  if (typeof raw.cost_breakdown?.total_usd === 'number') return raw.cost_breakdown.total_usd;
  return null;
}

function sumLatency(attempts: RawAttempt[]): number {
  return attempts.reduce(
    (acc, a) => acc + (typeof a.latency_ms === 'number' ? a.latency_ms : 0),
    0,
  );
}

// Execution-stage fallback count = real (non-skipped) attempts beyond the first.
// Distinct from classification `decided_by` (Principle 5).
function fallbackCount(attempts: RawAttempt[]): number {
  const tried = attempts.filter((a) => a.skipped !== true).length;
  return Math.max(0, tried - 1);
}

// Normalize the recorded error_detail -> the UI shape. Absent/null (ok, skipped,
// or legacy records) maps to null. The backend has already redacted the body
// (Principle 7); the UI only displays it, never recomputes.
function attemptErrorDetail(a: RawAttempt): AttemptErrorDetail | null {
  const d = a.error_detail;
  if (!d) return null;
  return {
    upstream_status: typeof d.upstream_status === 'number' ? d.upstream_status : null,
    message: typeof d.message === 'string' ? d.message : '',
    provider_raw: d.provider_raw ?? null,
  };
}

function attemptOutcome(a: RawAttempt): ProviderAttempt['outcome'] {
  if (a.skipped === true) return 'skipped';
  if (a.status === 'ok') return 'success';
  // The record models attempt status as ok|error; richer outcomes
  // (timeout/rate_limited/circuit_open) are carried in error_class when present.
  const ec = a.error_class ?? '';
  if (ec === 'timeout' || ec === 'rate_limited' || ec === 'circuit_open') {
    return ec as ProviderAttempt['outcome'];
  }
  return 'error';
}

// Project the raw DecisionRecord -> the list row (docs/07 list fields). Fields the
// record does not carry are derived or safely defaulted; NEVER fabricated.
export function toListItem(raw: RawDecisionRecord): RequestListItem {
  const attempts = Array.isArray(raw.provider_attempts) ? raw.provider_attempts : [];
  const status: RequestListItem['status'] = raw.final?.status === 'error' ? 'error' : 'ok';
  const errorClass =
    status === 'error'
      ? (raw.final?.error_reason ??
        attempts.filter((a) => a.error_class)[0]?.error_class ??
        undefined)
      : undefined;
  return {
    trace_id: String(raw.trace_id ?? raw.request_id ?? ''),
    // Real recorded timestamp (epoch ms) surfaced by the list endpoint, kept as an
    // ISO string so the row is deterministic/sortable; the view formats it for
    // display. '' when the record carries none (legacy) — never fabricated.
    ts: typeof raw.created_at === 'number' ? new Date(raw.created_at).toISOString() : '',
    // Real display prefix from the recorded auth identity — PREFIX ONLY, never the
    // plaintext key (Principle 7). '—' when the record carries none (legacy / unknown).
    key_prefix:
      typeof raw.key_prefix === 'string' && raw.key_prefix.length > 0 ? raw.key_prefix : '—',
    requested_model: raw.requested_model ?? null,
    task_type: raw.classifier?.task_type ?? '',
    complexity: raw.classifier?.complexity ?? '',
    decided_by: normalizeDecidedBy(raw.classifier?.decided_by),
    lane: raw.lane?.selected_lane ?? '',
    final_model: raw.final?.model_alias ?? null,
    // Prefer the recorded value; fall back to deriving from attempts for legacy
    // records (Principle 5: execution-stage count, distinct from decided_by).
    fallback_count:
      typeof raw.fallback_count === 'number' ? raw.fallback_count : fallbackCount(attempts),
    status,
    latency_ms:
      typeof raw.latency_total_ms === 'number' ? raw.latency_total_ms : sumLatency(attempts),
    cost_usd: listCost(raw, attempts),
    error_class: errorClass ?? undefined,
  };
}

// Project constraints (record<string, unknown> bitmap) -> a boolean view.
function normalizeConstraints(raw: Record<string, unknown> | undefined): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const [k, v] of Object.entries(raw ?? {})) out[k] = v === true;
  return out;
}

// Redacted, non-sensitive request metadata for the detail header. We DELIBERATELY
// expose only routing-relevant fields — never any private payload (Principle 7).
function buildRequestMeta(raw: RawDecisionRecord): Record<string, unknown> {
  return {
    requested_model: raw.requested_model ?? null,
    policy_reason: raw.policy?.reason ?? null,
  };
}

// Map the recorded cost split -> the docs/07 cost breakdown. eval self-cost stays
// SEPARATE from completion (Principle 5). null parts render as 0 (visible, not hidden);
// `completionFallback` is the summed attempt cost for legacy records that predate
// the recorded cost_breakdown.
function buildCostBreakdown(
  raw: RawDecisionRecord,
  completionFallback: number,
): RequestDetail['cost_breakdown'] {
  const cb = raw.cost_breakdown;
  const completion =
    typeof cb?.completion_usd === 'number' ? cb.completion_usd : completionFallback;
  const evalUsd = typeof cb?.eval_usd === 'number' ? cb.eval_usd : 0;
  const total = typeof cb?.total_usd === 'number' ? cb.total_usd : evalUsd + completion;
  // The backend does not bill a separate routing self-cost in the MVP.
  return { routing_usd: 0, eval_usd: evalUsd, completion_usd: completion, total_usd: total };
}

export function toDetail(raw: RawDecisionRecord): RequestDetail {
  const attempts = Array.isArray(raw.provider_attempts) ? raw.provider_attempts : [];
  const completion = sumCost(attempts);
  const status = raw.final?.status === 'error' ? 'error' : 'ok';
  const evalCacheHit = raw.classifier?.eval_cache_hit ?? null;
  return {
    trace_id: String(raw.trace_id ?? raw.request_id ?? ''),
    // Same source as the list "Time" column (created_at, flattened by the detail
    // endpoint). Legacy records without it stay empty → header shows the
    // "time not recorded" placeholder rather than a fabricated time.
    ts: typeof raw.created_at === 'number' ? new Date(raw.created_at).toISOString() : '',
    request_meta: buildRequestMeta(raw),
    // The backend does not persist a payload; we render a redaction placeholder so
    // the operator knows it was intentionally withheld (Principle 7).
    payload_summary: 'payload withheld (redacted — only routing metadata is stored)',
    classifier_output: {
      task_type: raw.classifier?.task_type ?? '',
      complexity: raw.classifier?.complexity ?? '',
      confidence: typeof raw.classifier?.confidence === 'number' ? raw.classifier.confidence : 0,
      matched_dimensions: Array.isArray(raw.classifier?.explanation)
        ? raw.classifier.explanation.map((d) => String(d))
        : [],
      constraints: normalizeConstraints(raw.classifier?.constraints),
    },
    eval_triggered: raw.classifier?.decided_by === 'eval' || evalCacheHit !== null,
    eval_cache_hit: evalCacheHit,
    matched_policy: raw.policy?.matched_policy_id ?? null,
    lane_candidates: Array.isArray(raw.lane?.candidate_chain) ? raw.lane.candidate_chain : [],
    provider_attempts: attempts.map((a) => ({
      model: String(a.alias ?? ''),
      provider: String(a.provider_model ?? a.alias ?? ''),
      outcome: attemptOutcome(a),
      skip_reason: a.skip_reason ?? undefined,
      latency_ms: typeof a.latency_ms === 'number' ? a.latency_ms : 0,
      error_class: a.error_class ?? undefined,
      error_detail: attemptErrorDetail(a),
    })),
    response_meta:
      status === 'ok'
        ? {
            model_alias: raw.final?.model_alias ?? null,
            provider_model: raw.final?.provider_model ?? null,
          }
        : null,
    error:
      status === 'error'
        ? {
            error_class: String(raw.final?.error_reason ?? 'upstream_error'),
            http_status: 0, // backend does not record the upstream http status yet
            message: String(raw.final?.error_reason ?? 'request failed'), // already redacted
            provider_raw: null, // redacted — never surface raw upstream bodies (Principle 7)
          }
        : null,
    // Cost split from the record (docs/07 "cost breakdown (incl. eval cost)"): eval self-cost is
    // SEPARATE from completion cost (Principle 5). Unknown (null) parts render as 0 so all
    // four lines stay visible; legacy records (no cost_breakdown) fall back to the
    // summed attempts as completion. The backend does not bill a separate routing
    // self-cost, so routing_usd stays 0.
    cost_breakdown: buildCostBreakdown(raw, completion),
  };
}

// Filters + pagination for the request-debug list. `start`/`end` are epoch ms
// (the date-range preset is resolved to an absolute window in the page loader so
// the gateway stays timezone-agnostic); `decidedBy` is the classification-stage
// layer (Principle 5). All fields optional — an omitted field is simply not sent.
export interface RequestsQueryParams {
  page?: number;
  pageSize?: number;
  status?: RequestListItem['status'];
  decidedBy?: RequestListItem['decided_by'];
  lane?: string;
  model?: string;
  start?: number;
  end?: number;
}

// One page of mapped rows + the full filtered total, so the view can render
// "Page X of Y" without a second request.
export interface RequestsPage {
  items: RequestListItem[];
  total: number;
  page: number;
  pageSize: number;
}

// Serialize the filter/pagination params to a querystring, skipping anything
// undefined/empty. `decidedBy` -> `decided_by` to match the backend schema.
function buildRequestsQuery(params: RequestsQueryParams): string {
  const qs = new URLSearchParams();
  if (params.page !== undefined) qs.set('page', String(params.page));
  if (params.pageSize !== undefined) qs.set('pageSize', String(params.pageSize));
  if (params.status) qs.set('status', params.status);
  if (params.decidedBy) qs.set('decided_by', params.decidedBy);
  if (params.lane) qs.set('lane', params.lane);
  if (params.model) qs.set('model', params.model);
  if (params.start !== undefined) qs.set('start', String(params.start));
  if (params.end !== undefined) qs.set('end', String(params.end));
  return qs.toString();
}

// GET /admin/api/requests -> { items, total, page, pageSize }. The backend applies
// the filters + numbered pagination at the SQL layer (time DESC); we map each row
// to the docs/07 UI contract and pass the totals straight through.
export async function listRequests(params: RequestsQueryParams = {}): Promise<RequestsPage> {
  const query = buildRequestsQuery(params);
  const url = query ? `${BASE}?${query}` : BASE;
  const res = await fetch(url, { headers: { accept: 'application/json' } });
  const body = await asJson<{
    items?: RawDecisionRecord[];
    total?: number;
    page?: number;
    pageSize?: number;
  }>(res);
  const rows = Array.isArray(body.items) ? body.items : [];
  return {
    items: rows.map(toListItem),
    total: typeof body.total === 'number' ? body.total : rows.length,
    page: typeof body.page === 'number' ? body.page : (params.page ?? 1),
    pageSize: typeof body.pageSize === 'number' ? body.pageSize : rows.length,
  };
}

// GET /admin/api/requests/:traceId -> RequestDetail (full trail) | throws on 404.
export async function getRequest(traceId: string): Promise<RequestDetail> {
  const res = await fetch(`${BASE}/${encodeURIComponent(traceId)}`, {
    headers: { accept: 'application/json' },
  });
  const raw = await asJson<RawDecisionRecord>(res);
  return toDetail(raw);
}

// The full captured request/response bodies (admin "System Settings" →
// capture_payloads). `captured:false` means this request was served while capture
// was OFF (or the row was pruned by retention) — the UI then shows a clear
// "not recorded" notice instead of the bodies.
export interface RequestPayloadView {
  captured: boolean;
  request?: unknown;
  response?: unknown;
  created_at?: number;
}

// GET /admin/api/requests/:traceId/payload -> the captured bodies. Resolves to
// { captured:false } on any error (missing row / capture off) so the detail page
// degrades gracefully and never white-screens.
export async function getRequestPayload(traceId: string): Promise<RequestPayloadView> {
  try {
    const res = await fetch(`${BASE}/${encodeURIComponent(traceId)}/payload`, {
      headers: { accept: 'application/json' },
    });
    if (!res.ok) return { captured: false };
    return (await res.json()) as RequestPayloadView;
  } catch {
    return { captured: false };
  }
}

// POST /admin/api/requests/:traceId/replay -> { trace_id } | throws. Re-issues the
// (optionally edited) request body through the gateway as an ISOLATED debug re-run
// and returns the NEW trace id so the page can navigate to the recorded result.
// The `request` is the full OpenAI chat body the operator confirmed in the dialog;
// identity/caps are reconstructed server-side from the ORIGINAL request's key (the
// browser never handles a plaintext key — Principle 7).
// `signal` lets the dialog's Cancel abort the wait — the gateway sees the request
// abort and cancels the in-flight upstream run (the route forwards its own signal).
export async function replayRequest(
  traceId: string,
  request: unknown,
  signal?: AbortSignal,
): Promise<{ trace_id: string }> {
  const res = await fetch(`${BASE}/${encodeURIComponent(traceId)}/replay`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ request }),
    signal,
  });
  return asJson<{ trace_id: string }>(res);
}
