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
  // The internal api_key_id (keys-table UUID) this request authenticated with —
  // NOT key material (the plaintext key is only ever stored as a sha256 hash;
  // Principle 7). It is the same id that appears in the /keys/<id> URL, surfaced
  // here only so the list can offer "filter by this key". undefined on a legacy
  // row that predates the field → the key cell stays non-clickable.
  key_id?: string;
  key_prefix: string; // display prefix only — NEVER plaintext
  // Operator-assigned key NAME, resolved by the backend (api_key_id -> keystore).
  // null when the key is unnamed (or was since deleted) — the view then falls back
  // to key_prefix. Cosmetic label only, never key material (Principle 7).
  key_name: string | null;
  user_id?: string;
  org_id?: string;
  requested_model: string | null;
  task_type: string;
  complexity: string;
  decided_by: 'rules' | 'eval' | 'default' | 'fallback'; // decision layer (classification stage)
  lane: string;
  served_provider: string | null;
  serving_account: ServingAccountView | null;
  final_model: string | null;
  fallback_count: number; // execution fallback count (provider attempts - 1)
  status: 'ok' | 'error';
  latency_ms: number;
  // null = NOT measured (no pricing / usage unknown — e.g. an unpriced model),
  // rendered as '—'. A number is a real cost. Crucially distinct from 0 so an
  // unmeasured request never looks like a free one (#6).
  cost_usd: number | null;
  // Served-completion token counts (see TokenUsageView). Every leaf is null on a
  // legacy/un-stamped record → the cell renders '—'.
  usage: TokenUsageView;
  // True generation throughput (tokens/sec) = output ÷ generation window. null =
  // not measured (non-streaming, or a legacy record) → the cell renders '—'.
  tps: number | null;
  error_class?: string;
}

// Per-request token accounting for the UI (mirrors the gateway's DecisionRecord
// `usage` block, derived for display). Every leaf is `number | null`, where null =
// "not measured" (no usage reported) — kept DISTINCT from a measured 0, exactly
// like the cost null-vs-0 convention (#6). `nonCached`/`total` are DERIVED for the
// view; the gateway is the single source of the raw counts (Principle 1 — we only
// render, never recompute the upstream figures).
export interface TokenUsageView {
  input: number | null; // prompt_tokens (TOTAL input, includes cached)
  output: number | null; // completion_tokens
  cached: number | null; // cache-READ prompt tokens (served from cache)
  cacheCreation: number | null; // cache-WRITE prompt tokens (Anthropic prompt-cache writes)
  // input − cached (clamped ≥0) = input tokens NOT served from cache; null when
  // either side is unmeasured. Derived for the view, never billed.
  nonCached: number | null;
  total: number | null; // input + output when present; null when neither is measured
}

export interface ServingAccountView {
  provider_id: string;
  account: string;
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
  provider: string | null;
  provider_model: string | null;
  serving_account: ServingAccountView | null;
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
  // Request identity/summary (same source as the list row) for the detail "Request
  // summary" card — so an operator can read/copy WHO called and WHAT was asked
  // without bouncing back to the list. key_prefix/key_name are prefix/name only,
  // never the plaintext key (Principle 7); null when the record carries none.
  key_prefix: string | null;
  key_name: string | null;
  requested_model: string | null; // what the client asked for
  served_provider: string | null; // concrete provider that served the request
  serving_account: ServingAccountView | null; // final subscription account, if any
  final_model: string | null; // the served model alias (null = no provider served)
  lane: string; // selected lane ('' on a legacy record)
  status: 'ok' | 'error';
  // Total wall-clock latency (Σ attempt latency, ms); null on a legacy record.
  latency_ms: number | null;
  request_meta: Record<string, unknown>;
  payload_summary: string; // redacted summary — NOT the full payload
  classifier_output: {
    task_type: string;
    complexity: string;
    confidence: number;
    // Which stage produced the verdict above — so the UI can attribute it (a
    // decided_by==='eval' verdict is the EVAL model's output, not Layer-1 rules).
    decided_by: 'rules' | 'eval' | 'default' | 'fallback';
    // The LAYER-1 gate confidence. Differs from `confidence` when eval decided
    // (rules were uncertain → escalated; eval's verdict replaced the rules one).
    // Null on passthrough/legacy records.
    rules_confidence: number | null;
    matched_dimensions: string[];
    constraints: Record<string, boolean>;
  };
  eval_triggered: boolean;
  eval_cache_hit: boolean | null;
  // The internal small-model that ran Layer-2 eval (e.g. 'gpt-4o-mini'); null when
  // eval did not run. A model id, never a key (Principle 7).
  eval_model: string | null;
  // Layer-2 eval call latency (ms); null when eval did not run.
  eval_latency_ms: number | null;
  // WHY routing fell back when eval ran but failed open (e.g. 'eval_timeout');
  // null on rules/eval/default paths. Lets the UI explain the balanced fallback.
  eval_fallback_reason: string | null;
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
  // Served-completion token accounting (see TokenUsageView). Every leaf is null on
  // a legacy/un-stamped record → the card renders '—'.
  usage: TokenUsageView;
  // True generation throughput (tokens/sec) = output ÷ generation window; null = not
  // measured (non-streaming / legacy) → '—'.
  tps: number | null;
  // Served-stream generation window (ms): first→last forwarded chunk. null for
  // non-streaming / legacy. Shown alongside TPS so the operator sees the denominator.
  generation_ms: number | null;
  // Client-perceived time-to-first-token (ms) for a streamed response; null for
  // non-streaming / legacy → '—'.
  ttfb_ms: number | null;
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
  provider_name?: string | null;
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
  // The recorded api_key_id, surfaced per row by GET /admin/api/requests (the
  // redacted record itself omits it — Principle 7 — so the route adds it). The
  // internal key UUID, not key material; used by the SPA to filter by key.
  key_id?: string | null;
  // Operator-assigned key name, joined onto the row by GET /admin/api/requests
  // (api_key_id -> keystore). Absent/null when the key is unnamed or was deleted.
  key_name?: string | null;
  // Enriched telemetry (admin.requests-richfields): Σ attempt latency, execution
  // fallback count, and the eval/completion cost split. Absent on legacy records.
  latency_total_ms?: number;
  fallback_count?: number;
  cost_breakdown?: {
    eval_usd?: number | null;
    completion_usd?: number | null;
    total_usd?: number | null;
  };
  // Served-completion token accounting, stamped by the gateway after the usage
  // tail is parsed (TokenUsageSchema). Each leaf is null when not reported; the
  // whole block is null/absent on a legacy (pre-feature) record.
  usage?: {
    prompt_tokens?: number | null;
    completion_tokens?: number | null;
    cached_tokens?: number | null;
    cache_creation_tokens?: number | null;
  } | null;
  // Served-stream generation window (ms): first→last forwarded chunk, gateway-timed.
  // null/absent for non-streaming responses and legacy records. The true-TPS
  // denominator — paired with usage.completion_tokens to derive tokens/sec.
  generation_ms?: number | null;
  classifier?: {
    task_type?: string;
    complexity?: string;
    confidence?: number;
    decided_by?: string;
    rules_confidence?: number | null;
    eval_cache_hit?: boolean | null;
    eval_model?: string | null;
    eval_latency_ms?: number | null;
    fallback_reason?: string | null;
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
  serving_account?: {
    provider_id?: string | null;
    account?: string | null;
  } | null;
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

function nonEmptyString(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

function aliasPrefix(alias: string | null): string | null {
  if (!alias) return null;
  const slash = alias.indexOf('/');
  return slash > 0 ? alias.slice(0, slash) : null;
}

function normalizeServingAccount(raw: RawDecisionRecord): ServingAccountView | null {
  const providerId = nonEmptyString(raw.serving_account?.provider_id);
  const account = nonEmptyString(raw.serving_account?.account);
  return providerId && account ? { provider_id: providerId, account } : null;
}

function successfulAttempt(raw: RawDecisionRecord, attempts: RawAttempt[]): RawAttempt | null {
  const finalAlias = nonEmptyString(raw.final?.model_alias);
  if (finalAlias) {
    const exact = attempts.find(
      (a) => a.status === 'ok' && a.skipped !== true && a.alias === finalAlias,
    );
    if (exact) return exact;
  }
  return attempts.find((a) => a.status === 'ok' && a.skipped !== true) ?? null;
}

function servedProvider(raw: RawDecisionRecord, attempts: RawAttempt[]): string | null {
  const attempt = successfulAttempt(raw, attempts);
  return (
    nonEmptyString(attempt?.provider_name) ??
    aliasPrefix(nonEmptyString(raw.final?.model_alias)) ??
    aliasPrefix(nonEmptyString(attempt?.alias))
  );
}

// Project the recorded `usage` block -> the UI token view. Reads only the four
// recorded counts (Principle 1 — never recomputes upstream figures); DERIVES
// `nonCached` (input − cached, clamped ≥0) and `total` (input + output) for the
// view. Each leaf is null = "not measured" (kept DISTINCT from a measured 0); a
// legacy/absent `usage` block yields all-null.
function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}
export function toUsage(raw: RawDecisionRecord): TokenUsageView {
  const u = raw.usage ?? undefined;
  const input = num(u?.prompt_tokens);
  const output = num(u?.completion_tokens);
  const cached = num(u?.cached_tokens);
  const cacheCreation = num(u?.cache_creation_tokens);
  // input − cached only when BOTH are measured (else "not measured", not a guess).
  const nonCached = input !== null && cached !== null ? Math.max(0, input - cached) : null;
  // Sum the parts that ARE measured; all-unmeasured stays null (never a fake 0).
  const total = input !== null || output !== null ? (input ?? 0) + (output ?? 0) : null;
  return { input, output, cached, cacheCreation, nonCached, total };
}

// True generation TPS for one request: output tokens ÷ the served-stream generation
// window (seconds). DERIVED for the view (Principle 1 — never recomputes upstream
// figures, only divides two recorded values). null = "not measured" — non-streaming
// (no window) or a legacy record (no generation_ms / no completion count); a zero/
// negative window also yields null (no divide-by-zero), kept DISTINCT from a real 0.
export function computeTps(raw: RawDecisionRecord): number | null {
  const output = num(raw.usage?.completion_tokens);
  const generationMs = num(raw.generation_ms);
  if (output === null || generationMs === null || generationMs <= 0) return null;
  return output / (generationMs / 1000);
}

// Client-perceived time-to-first-token (ms) for a STREAMED response: since each
// attempt's latency is measured at the first-chunk peek and attempts run
// sequentially, the recorded latency_total_ms IS the wall-clock wait until the first
// token. Only meaningful when a generation window was measured (streaming); null for
// non-streaming / legacy → the detail renders '—'.
export function computeTtfbMs(raw: RawDecisionRecord): number | null {
  if (num(raw.generation_ms) === null) return null;
  return typeof raw.latency_total_ms === 'number' ? raw.latency_total_ms : null;
}

// Project the raw DecisionRecord -> the list row (docs/07 list fields). Fields the
// record does not carry are derived or safely defaulted; NEVER fabricated.
export function toListItem(raw: RawDecisionRecord): RequestListItem {
  const attempts = Array.isArray(raw.provider_attempts) ? raw.provider_attempts : [];
  const account = normalizeServingAccount(raw);
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
    // The recorded api_key_id (internal UUID, not key material — Principle 7), for
    // "filter by this key". undefined on a legacy row → the key cell isn't clickable.
    key_id: typeof raw.key_id === 'string' && raw.key_id.length > 0 ? raw.key_id : undefined,
    // Real display prefix from the recorded auth identity — PREFIX ONLY, never the
    // plaintext key (Principle 7). '—' when the record carries none (legacy / unknown).
    key_prefix:
      typeof raw.key_prefix === 'string' && raw.key_prefix.length > 0 ? raw.key_prefix : '—',
    // The key's display NAME when the backend resolved one; null lets the view fall
    // back to the prefix (so an unnamed/deleted key still renders something).
    key_name: typeof raw.key_name === 'string' && raw.key_name.length > 0 ? raw.key_name : null,
    requested_model: raw.requested_model ?? null,
    task_type: raw.classifier?.task_type ?? '',
    complexity: raw.classifier?.complexity ?? '',
    decided_by: normalizeDecidedBy(raw.classifier?.decided_by),
    lane: raw.lane?.selected_lane ?? '',
    served_provider: servedProvider(raw, attempts),
    serving_account: account,
    final_model: raw.final?.model_alias ?? null,
    // Prefer the recorded value; fall back to deriving from attempts for legacy
    // records (Principle 5: execution-stage count, distinct from decided_by).
    fallback_count:
      typeof raw.fallback_count === 'number' ? raw.fallback_count : fallbackCount(attempts),
    status,
    latency_ms:
      typeof raw.latency_total_ms === 'number' ? raw.latency_total_ms : sumLatency(attempts),
    cost_usd: listCost(raw, attempts),
    usage: toUsage(raw),
    // True throughput (output ÷ generation time); null → '—' for non-streaming/legacy.
    tps: computeTps(raw),
    error_class: errorClass ?? undefined,
  };
}

// Project the recorded explanation entries -> displayable dimension labels.
// Entries are strings on simple records, but the rule engine's richer
// ExplanationEntry objects carry the label in `detail` — String(obj) would
// render "[object Object]", so extract the string or drop the entry.
function matchedDimensions(explanation: unknown): string[] {
  if (!Array.isArray(explanation)) return [];
  const out: string[] = [];
  for (const d of explanation) {
    if (typeof d === 'string') out.push(d);
    else if (d && typeof d === 'object' && typeof (d as { detail?: unknown }).detail === 'string')
      out.push((d as { detail: string }).detail);
  }
  return out;
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
  const account = normalizeServingAccount(raw);
  return {
    trace_id: String(raw.trace_id ?? raw.request_id ?? ''),
    // Same source as the list "Time" column (created_at, flattened by the detail
    // endpoint). Legacy records without it stay empty → header shows the
    // "time not recorded" placeholder rather than a fabricated time.
    ts: typeof raw.created_at === 'number' ? new Date(raw.created_at).toISOString() : '',
    // Identity/summary fields, mapped from the same recorded values as the list row
    // (Principle 1 — read, never recompute). PREFIX/NAME only, never plaintext
    // (Principle 7); null when the record carries none (legacy / unnamed / deleted).
    key_prefix:
      typeof raw.key_prefix === 'string' && raw.key_prefix.length > 0 ? raw.key_prefix : null,
    key_name: typeof raw.key_name === 'string' && raw.key_name.length > 0 ? raw.key_name : null,
    requested_model: raw.requested_model ?? null,
    served_provider: servedProvider(raw, attempts),
    serving_account: account,
    final_model: raw.final?.model_alias ?? null,
    lane: raw.lane?.selected_lane ?? '',
    status,
    latency_ms: typeof raw.latency_total_ms === 'number' ? raw.latency_total_ms : null,
    request_meta: buildRequestMeta(raw),
    // The backend does not persist a payload; we render a redaction placeholder so
    // the operator knows it was intentionally withheld (Principle 7).
    payload_summary: 'payload withheld (redacted — only routing metadata is stored)',
    classifier_output: {
      task_type: raw.classifier?.task_type ?? '',
      complexity: raw.classifier?.complexity ?? '',
      confidence: typeof raw.classifier?.confidence === 'number' ? raw.classifier.confidence : 0,
      decided_by: normalizeDecidedBy(raw.classifier?.decided_by),
      rules_confidence:
        typeof raw.classifier?.rules_confidence === 'number'
          ? raw.classifier.rules_confidence
          : null,
      matched_dimensions: matchedDimensions(raw.classifier?.explanation),
      constraints: normalizeConstraints(raw.classifier?.constraints),
    },
    eval_triggered: raw.classifier?.decided_by === 'eval' || evalCacheHit !== null,
    eval_cache_hit: evalCacheHit,
    eval_model:
      typeof raw.classifier?.eval_model === 'string' ? raw.classifier.eval_model : null,
    eval_latency_ms:
      typeof raw.classifier?.eval_latency_ms === 'number' ? raw.classifier.eval_latency_ms : null,
    eval_fallback_reason:
      typeof raw.classifier?.fallback_reason === 'string' ? raw.classifier.fallback_reason : null,
    matched_policy: raw.policy?.matched_policy_id ?? null,
    lane_candidates: Array.isArray(raw.lane?.candidate_chain) ? raw.lane.candidate_chain : [],
    provider_attempts: attempts.map((a) => ({
      model: String(a.alias ?? ''),
      provider:
        nonEmptyString(a.provider_name) ??
        aliasPrefix(nonEmptyString(a.alias)) ??
        nonEmptyString(a.provider_model),
      provider_model: nonEmptyString(a.provider_model),
      serving_account:
        account &&
        a.status === 'ok' &&
        a.skipped !== true &&
        nonEmptyString(a.alias) === nonEmptyString(raw.final?.model_alias)
          ? account
          : null,
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
    // Served-completion token accounting (same source + derivation as the list
    // row), for the detail "Token usage" card. All-null on a legacy record.
    usage: toUsage(raw),
    // True throughput + its denominator + the companion TTFB, for the detail card.
    // All null on a non-streaming / legacy record → each renders '—'.
    tps: computeTps(raw),
    generation_ms: typeof raw.generation_ms === 'number' ? raw.generation_ms : null,
    ttfb_ms: computeTtfbMs(raw),
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
  // Contains search over requested model, served model alias and selected lane /
  // public channel. Kept as `model` for URL/API compatibility.
  model?: string;
  // Exact api_key_id scope (the key detail page's request list). Serialized as
  // `key_id` to match the backend schema.
  keyId?: string;
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
  if (params.keyId) qs.set('key_id', params.keyId);
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
  // The EXACT body forwarded upstream — AFTER memory injection + protocol
  // translation. This is what the model actually received (the inbound `request`
  // is what the client sent). Null/absent when no provider served or pre-feature.
  upstream_request?: unknown;
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
// identity/caps are reconstructed server-side from the ORIGINAL request's key, or —
// when that key was deleted/revoked — from a live root key (409 only if neither
// exists). Either way the browser never handles a plaintext key — Principle 7.
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
