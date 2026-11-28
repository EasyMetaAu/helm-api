import type {
  ClientPolicy,
  DecisionRecord,
  WeeklyBudgetStatus,
} from "@helm/shared";
import { API_BASE, apiError, apiFetch, apiGet, apiPatch } from "./client";

// Portal API response contracts — mirror the /portal/api/* JSON the gateway emits.
// These are customer-safe whitelist projections.

export interface Me {
  key_prefix: string;
  role: "root" | "user";
  allowed_lanes: string[] | null;
  client_policy: ClientPolicy | null;
  rate_limit: { rpm: number | null; tpm: number | null };
  concurrency_limit: number | null;
  allow_custom_model: boolean;
  allow_fast_mode: boolean;
  request_content: {
    mode: "none" | "session" | "payload";
    retention_days: number | null;
  };
  budget: {
    requests: number | null;
    tokens: number | null;
    spend_usd: number | null;
    window_seconds: number | null;
    weekly_anchor: string | null;
    current_cycle: WeeklyBudgetStatus | null;
    behavior: "reject" | "degrade";
  };
  memory: {
    mode: "off" | "observe" | "inject";
    project_id: string | null;
    project_name: string | null;
    thread_source: "header" | "auto";
  };
}

export interface UsageStats {
  object: "usage_stats";
  api_key_id: string;
  range: {
    start_ms: number;
    end_ms: number;
    bucket: "hour" | "day";
    tz_offset_minutes: number;
  };
  totals: {
    requests: number;
    ok_count: number;
    error_count: number;
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
    cached_tokens: number;
    cache_creation_tokens: number;
    cost_usd: number;
    avg_latency_ms: number | null;
    avg_tps: number | null;
    cache_hit_rate: number | null;
  };
  series: {
    bucket_start_ms: number;
    requests: number;
    prompt_tokens: number;
    completion_tokens: number;
    cached_tokens: number;
    cache_creation_tokens: number;
    cost_usd: number | null;
  }[];
  by_model: {
    model: string;
    requests: number;
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
    cost_usd: number | null;
  }[];
  budget: Me["budget"];
}

export type PortalAttemptOutcome =
  | "success"
  | "error"
  | "timeout"
  | "rate_limited"
  | "circuit_open"
  | "skipped";

export type DecidedBy = "rules" | "eval" | "default" | "fallback";
export type StreamOutcome =
  | "completed"
  | "incomplete"
  | "failed"
  | "client_aborted"
  | "truncated"
  | null;

export interface CompactRequest {
  request_id: string;
  trace_id: string;
  requested_model: string;
  served_model: string | null;
  lane: string;
  status: "ok" | "error";
  error_reason: string | null;
  latency_ms: number;
  cost_usd: number | null;
  usage: {
    prompt_tokens: number | null;
    completion_tokens: number | null;
    cached_tokens: number | null;
    cache_creation_tokens: number | null;
  } | null;
  requested_reasoning_effort: string | null;
  reasoning_effort: string | null;
  generation_ms: number | null;
  tps: number | null;
  ttfb_ms: number | null;
  attempts: Array<{ outcome: PortalAttemptOutcome; latency_ms: number }>;
}

export interface PortalRequestRow extends CompactRequest {
  created_at: number;
  decided_by: DecidedBy;
  fallback_count: number;
  stream_outcome: StreamOutcome;
  partial: boolean;
  serving_provider: string | null;
  session_ref: string | null;
  session_label: string | null;
}

export interface PortalRequestDetail extends CompactRequest {
  created_at?: number;
  decision: DecisionRecord & { key_name: string | null; created_at?: number };
}

export interface RequestsPage {
  items: PortalRequestRow[];
  total: number;
  page: number;
  page_size: number;
}

export interface PayloadPart {
  captured: boolean;
  part?: "request" | "response";
  value?: unknown;
  created_at?: number;
}

export interface PayloadMeta {
  captured: boolean;
  source?: "payload" | "session" | "unavailable";
  exact?: boolean;
  fidelity?: string;
  reason?: string;
  created_at?: number;
  parts?: {
    request: boolean;
    response: boolean;
    upstream_request: boolean;
  };
}

export interface MemoryStats {
  generated_at: string;
  project_id: string;
  shared: boolean;
  storage: {
    threads: number;
    messages: number;
    observations: number;
    facts: number;
    activeFacts: number;
    reflections: number;
    activeReflections: number;
  };
  queue: {
    pending: number;
    running: number;
    done: number;
    failed: number;
    open: number;
    staleRunning: number;
    oldestPendingAt: string | null;
    oldestRunningAt: string | null;
    newestDoneAt: string | null;
    newestFailedAt: string | null;
    byType: Array<{ type: string; status: string; count: number }>;
  };
  leases: { running: number; stale: number };
  activity: {
    lastMessageAt: string | null;
    lastObservationAt: string | null;
    lastFactUpdatedAt: string | null;
    lastReflectionUpdatedAt: string | null;
  };
}

export interface PendingRequest {
  status: "in_progress";
  request_id: string;
  phase: "telemetry_pending";
}

export type RequestLookup =
  | {
      status: 200;
      data: Pick<
        PortalRequestDetail,
        "request_id" | "decision" | "created_at"
      > &
        Partial<CompactRequest>;
    }
  | { status: 202; data: PendingRequest };

interface ReplayReceipt {
  source_request_id: string;
  request_id: string | null;
  upstream_status: number | null;
  code?:
    | "client_request_rejected"
    | "replay_payload_unavailable"
    | "replay_outcome_unknown";
}

export type ReplayResponse =
  | { status: 200; data: ReplayReceipt & { status: "recorded" } }
  | {
      status: 202;
      data: ReplayReceipt & { status: "in_progress" | "recording_pending" };
    }
  | { status: 409; data: ReplayReceipt & { status: "rejected" } }
  | { status: 503; data: ReplayReceipt & { status: "outcome_unknown" } };

export function getMe(): Promise<Me> {
  return apiGet<Me>("/me");
}

export function updateMemorySettings(input: {
  memory_mode: "off" | "observe" | "inject";
  memory_project_id: string | null;
  memory_thread_source: "header" | "auto";
}): Promise<{ memory: Me["memory"] }> {
  return apiPatch<{ memory: Me["memory"] }>("/memory-settings", input);
}

export function getUsage(
  params: {
    bucket?: "hour" | "day";
    start?: number;
    end?: number;
    tz?: number;
  } = {},
): Promise<UsageStats> {
  const qs = new URLSearchParams();
  if (params.bucket) qs.set("bucket", params.bucket);
  if (params.start !== undefined) qs.set("start", String(params.start));
  if (params.end !== undefined) qs.set("end", String(params.end));
  if (params.tz !== undefined) qs.set("tzOffsetMinutes", String(params.tz));
  const q = qs.toString();
  return apiGet<UsageStats>(`/usage/stats${q ? `?${q}` : ""}`);
}

export function getRequests(
  params: {
    page?: number;
    pageSize?: number;
    start?: number;
    end?: number;
    status?: "ok" | "error";
    model?: string;
    lane?: string;
    decided_by?: DecidedBy;
    session_ref?: string;
    session?: string;
  } = {},
): Promise<RequestsPage> {
  const qs = new URLSearchParams();
  if (params.page) qs.set("page", String(params.page));
  if (params.pageSize) qs.set("pageSize", String(params.pageSize));
  if (params.start !== undefined) qs.set("start", String(params.start));
  if (params.end !== undefined) qs.set("end", String(params.end));
  if (params.status) qs.set("status", params.status);
  if (params.model?.trim()) qs.set("model", params.model.trim());
  if (params.lane?.trim()) qs.set("lane", params.lane.trim());
  if (params.decided_by) qs.set("decided_by", params.decided_by);
  if (params.session_ref) qs.set("session_ref", params.session_ref);
  if (params.session) qs.set("session", params.session);
  const q = qs.toString();
  return apiGet<RequestsPage>(`/requests${q ? `?${q}` : ""}`);
}

export function getRequestDetail(
  requestId: string,
  signal?: AbortSignal,
): Promise<RequestLookup> {
  return lookupRequest(`/requests/${encodeURIComponent(requestId)}`, signal);
}

export function getRequestByTrace(trace: string): Promise<RequestLookup> {
  return lookupRequest(`/requests/by-trace/${encodeURIComponent(trace)}`);
}

async function lookupRequest(
  path: string,
  signal?: AbortSignal,
): Promise<RequestLookup> {
  const response = await apiFetch(`${API_BASE}${path}`, {
    headers: { accept: "application/json" },
    signal,
  });
  const data = await response.json().catch(() => null);
  if (
    response.status === 202 &&
    data?.status === "in_progress" &&
    typeof data.request_id === "string"
  ) {
    return { status: 202, data };
  }
  if (response.status === 200) {
    // The decision carries the storage ID even in decision-only responses.
    const requestId = data?.decision?.request_id;
    if (
      typeof requestId === "string" &&
      requestId.length > 0 &&
      (data.request_id === undefined || data.request_id === requestId)
    ) {
      return { status: 200, data: { ...data, request_id: requestId } };
    }
  }
  throw apiError(response, data);
}

export function getMemoryStats(): Promise<MemoryStats> {
  return apiGet<MemoryStats>("/memory/stats");
}

export async function replayRequest(
  requestId: string,
  idempotencyKey: string,
  signal?: AbortSignal,
): Promise<ReplayResponse> {
  const response = await apiFetch(
    `${API_BASE}/requests/${encodeURIComponent(requestId)}/replay`,
    {
      method: "POST",
      headers: {
        accept: "application/json",
        "Idempotency-Key": idempotencyKey,
      },
      signal,
    },
    { keepSessionOnUnauthorized: true },
  );
  const data = await response.json().catch(() => null);
  const { status } = response;
  if (
    (status === 200 && data?.status === "recorded") ||
    (status === 202 &&
      (data?.status === "in_progress" ||
        data?.status === "recording_pending")) ||
    (status === 409 && data?.status === "rejected") ||
    (status === 503 && data?.status === "outcome_unknown")
  ) {
    return { status, data };
  }
  throw apiError(response, data);
}

export function payloadBlobUrl(requestId: string, sha256: string): string {
  return `${API_BASE}/requests/${encodeURIComponent(requestId)}/payload-blobs/${encodeURIComponent(sha256)}`;
}

export function getPayloadPart(
  requestId: string,
  part: "request" | "response",
): Promise<PayloadPart> {
  return apiGet<PayloadPart>(
    `/requests/${encodeURIComponent(requestId)}/payload?part=${part}`,
  );
}

export function getPayloadMeta(requestId: string): Promise<PayloadMeta> {
  return apiGet<PayloadMeta>(
    `/requests/${encodeURIComponent(requestId)}/payload?part=meta`,
  );
}
