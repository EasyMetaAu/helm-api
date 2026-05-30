// Admin request-debug API client. The admin UI is a PURE consumer of the
// gateway's /admin/api/* HTTP surface — it imports NO core/gateway business logic
// and re-computes NO classification/routing/cost (CLAUDE.md 原则1). It only renders
// the trail the backend already recorded.
//
// Real backend contract (apps/gateway/src/routes/admin/requests.ts):
//   GET /admin/api/requests        -> RequestSummary[]  (most recent first;
//                                     { trace_id, lane, status, cost })
//   GET /admin/api/requests/:trace -> raw DecisionRecord (@helm/shared) | 404
//
// The docs/07 列表/详情字段are richer than what the DecisionRecord currently
// records. We map the real shape -> the UI contract at this boundary, DERIVING
// fields from what the record carries and safely DEFAULTING the rest (never
// fabricating data). See implementation-notes.md (2026-05-31) for the field map.
//
// CLAUDE.md 原则5: classification fallback (`decided_by`) and execution fallback
// (`provider_attempts`/`fallback_count`) are SEPARATE — they are surfaced as
// distinct UI concepts here and never conflated.
// CLAUDE.md 原则7: redaction — `key_prefix` is prefix-only (the record carries no
// key, so it surfaces as '—', NEVER plaintext); `payload_summary` is a summary
// placeholder, never the full private payload; `provider_raw` is redacted.

// ── UI-facing contract (docs/07) ─────────────────────────────────────────────

export interface RequestListItem {
  trace_id: string;
  ts: string; // 时间
  key_prefix: string; // display prefix only — NEVER plaintext
  user_id?: string;
  org_id?: string;
  requested_model: string | null;
  task_type: string;
  complexity: string;
  decided_by: 'rules' | 'eval' | 'default' | 'fallback'; // 决策层级 (分类阶段)
  lane: string;
  final_model: string | null;
  fallback_count: number; // 执行兜底次数 (provider attempts - 1)
  status: 'ok' | 'error';
  latency_ms: number;
  cost_usd: number;
  error_class?: string;
}

export interface ProviderAttempt {
  model: string;
  provider: string;
  outcome: 'success' | 'error' | 'timeout' | 'rate_limited' | 'circuit_open' | 'skipped';
  skip_reason?: string;
  latency_ms: number;
  error_class?: string;
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
  error: { error_class: string; http_status: number; message: string; provider_raw: unknown } | null;
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
}

interface RawDecisionRecord {
  request_id?: string;
  trace_id?: string;
  requested_model?: string;
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

function sumLatency(attempts: RawAttempt[]): number {
  return attempts.reduce((acc, a) => acc + (typeof a.latency_ms === 'number' ? a.latency_ms : 0), 0);
}

// Execution-stage fallback count = real (non-skipped) attempts beyond the first.
// Distinct from classification `decided_by` (原则5).
function fallbackCount(attempts: RawAttempt[]): number {
  const tried = attempts.filter((a) => a.skipped !== true).length;
  return Math.max(0, tried - 1);
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

// Project the raw DecisionRecord -> the list row (docs/07 列表字段). Fields the
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
    ts: '', // backend does not record a timestamp yet (placeholder, no fabrication)
    key_prefix: '—', // record carries no key; NEVER plaintext (原则7)
    requested_model: raw.requested_model ?? null,
    task_type: raw.classifier?.task_type ?? '',
    complexity: raw.classifier?.complexity ?? '',
    decided_by: normalizeDecidedBy(raw.classifier?.decided_by),
    lane: raw.lane?.selected_lane ?? '',
    final_model: raw.final?.model_alias ?? null,
    fallback_count: fallbackCount(attempts),
    status,
    latency_ms: sumLatency(attempts),
    cost_usd: sumCost(attempts),
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
// expose only routing-relevant fields — never any private payload (原则7).
function buildRequestMeta(raw: RawDecisionRecord): Record<string, unknown> {
  return {
    requested_model: raw.requested_model ?? null,
    policy_reason: raw.policy?.reason ?? null,
  };
}

export function toDetail(raw: RawDecisionRecord): RequestDetail {
  const attempts = Array.isArray(raw.provider_attempts) ? raw.provider_attempts : [];
  const completion = sumCost(attempts);
  const status = raw.final?.status === 'error' ? 'error' : 'ok';
  const evalCacheHit = raw.classifier?.eval_cache_hit ?? null;
  return {
    trace_id: String(raw.trace_id ?? raw.request_id ?? ''),
    ts: '',
    request_meta: buildRequestMeta(raw),
    // The backend does not persist a payload; we render a redaction placeholder so
    // the operator knows it was intentionally withheld (原则7).
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
    })),
    response_meta:
      status === 'ok'
        ? { model_alias: raw.final?.model_alias ?? null, provider_model: raw.final?.provider_model ?? null }
        : null,
    error:
      status === 'error'
        ? {
            error_class: String(raw.final?.error_reason ?? 'upstream_error'),
            http_status: 0, // backend does not record the upstream http status yet
            message: String(raw.final?.error_reason ?? 'request failed'), // already redacted
            provider_raw: null, // redacted — never surface raw upstream bodies (原则7)
          }
        : null,
    // The backend does not yet split routing/eval self-cost; all recorded cost is
    // completion cost. Fields are kept present + visible (docs/07「含 eval 成本」).
    cost_breakdown: {
      routing_usd: 0,
      eval_usd: 0,
      completion_usd: completion,
      total_usd: completion,
    },
  };
}

// GET /admin/api/requests -> { items, nextCursor? }. The backend currently returns
// a flat most-recent-first array (no cursor); we keep the paginated UI contract
// and leave nextCursor undefined until the backend supports it.
export async function listRequests(_params?: {
  limit?: number;
  cursor?: string;
}): Promise<{ items: RequestListItem[]; nextCursor?: string }> {
  const res = await fetch(BASE, { headers: { accept: 'application/json' } });
  const body = await asJson<unknown>(res);
  const rows = Array.isArray(body)
    ? (body as RawDecisionRecord[])
    : ((body as { items?: RawDecisionRecord[] }).items ?? []);
  const nextCursor =
    !Array.isArray(body) && typeof (body as { nextCursor?: unknown }).nextCursor === 'string'
      ? (body as { nextCursor: string }).nextCursor
      : undefined;
  return { items: rows.map(toListItem), nextCursor };
}

// GET /admin/api/requests/:traceId -> RequestDetail (full trail) | throws on 404.
export async function getRequest(traceId: string): Promise<RequestDetail> {
  const res = await fetch(`${BASE}/${encodeURIComponent(traceId)}`, {
    headers: { accept: 'application/json' },
  });
  const raw = await asJson<RawDecisionRecord>(res);
  return toDetail(raw);
}
