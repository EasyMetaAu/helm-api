import { apiGet } from "./client";

// Portal API response contracts — mirror the /portal/api/* JSON the gateway emits.
// These are customer-safe whitelist projections.

export interface Me {
  key_prefix: string;
  role: string;
  allowed_lanes: string[] | null;
  rate_limit: { rpm: number | null; tpm: number | null };
  budget: {
    requests: number | null;
    tokens: number | null;
    spend_usd: number | null;
    window_seconds: number | null;
    behavior: string;
  };
  memory: { mode: "off" | "observe" | "inject"; project_id: string | null };
}

export interface UsageStats {
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
  };
  series: {
    bucket_start_ms: number;
    requests: number;
    prompt_tokens: number;
    completion_tokens: number;
    cost_usd: number | null;
  }[];
  by_model: {
    model: string | null;
    requests: number;
    total_tokens: number;
    cost_usd: number | null;
  }[];
  budget: Me["budget"];
}

// The portal-projected request row/detail (toPortalDecisionView + created_at).
export interface PortalRequestRow {
  request_id: string;
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
  created_at: number;
}

export type PortalRequestDetail = Omit<PortalRequestRow, "created_at">;

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

export function getMe(): Promise<Me> {
  return apiGet<Me>("/me");
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
  } = {},
): Promise<RequestsPage> {
  const qs = new URLSearchParams();
  if (params.page) qs.set("page", String(params.page));
  if (params.pageSize) qs.set("pageSize", String(params.pageSize));
  if (params.start !== undefined) qs.set("start", String(params.start));
  if (params.end !== undefined) qs.set("end", String(params.end));
  if (params.status) qs.set("status", params.status);
  if (params.model?.trim()) qs.set("model", params.model.trim());
  const q = qs.toString();
  return apiGet<RequestsPage>(`/requests${q ? `?${q}` : ""}`);
}

export function getRequestDetail(
  traceId: string,
): Promise<PortalRequestDetail> {
  return apiGet<PortalRequestDetail>(
    `/requests/${encodeURIComponent(traceId)}`,
  );
}

export function getPayloadPart(
  traceId: string,
  part: "request" | "response",
): Promise<PayloadPart> {
  return apiGet<PayloadPart>(
    `/requests/${encodeURIComponent(traceId)}/payload?part=${part}`,
  );
}
