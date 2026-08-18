import type { OAuthQuotaWindow } from "@helm/shared";

const WEEKLY_WINDOW_MINUTES = 7 * 24 * 60;
const MIN_WEEKLY_WINDOW_MS = 6 * 24 * 60 * 60_000;
const MAX_WEEKLY_WINDOW_MS = 8 * 24 * 60 * 60_000;
const MEDIA_ENTITLEMENT_MAX_AGE_MS = 24 * 60 * 60_000;
const WEEKLY_PERIOD_TYPE = "USAGE_PERIOD_TYPE_WEEKLY";
const PAID_MEDIA_TIERS = new Set([
  "supergrok",
  "x_premium",
  "x_premium_plus",
  "supergrok_heavy",
  "supergrok_lite",
  "supergrok_plus",
]);
const RFC3339_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|([+-])(\d{2}):(\d{2}))$/;

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function rfc3339Ms(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const match = RFC3339_PATTERN.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const millisecond = Number((match[7] ?? "").padEnd(3, "0").slice(0, 3));
  const offsetHour = match[8] === "Z" ? 0 : Number(match[10]);
  const offsetMinute = match[8] === "Z" ? 0 : Number(match[11]);
  if (
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > 31 ||
    hour > 23 ||
    minute > 59 ||
    second > 59 ||
    offsetHour > 23 ||
    offsetMinute > 59
  ) {
    return null;
  }

  // Construct the local date in UTC first so invalid calendar dates (for example
  // February 30) can be rejected before applying the RFC 3339 zone offset.
  const local = new Date(0);
  local.setUTCFullYear(year, month - 1, day);
  local.setUTCHours(hour, minute, second, millisecond);
  if (
    local.getUTCFullYear() !== year ||
    local.getUTCMonth() !== month - 1 ||
    local.getUTCDate() !== day ||
    local.getUTCHours() !== hour ||
    local.getUTCMinutes() !== minute ||
    local.getUTCSeconds() !== second ||
    local.getUTCMilliseconds() !== millisecond
  ) {
    return null;
  }
  const offsetSign = match[9] === "-" ? -1 : 1;
  const timestamp = local.getTime() - offsetSign * (offsetHour * 60 + offsetMinute) * 60_000;
  return Number.isSafeInteger(timestamp) ? timestamp : null;
}

function normalizedWeeklyWindow(
  usedPercent: unknown,
  startMs: number | null,
  endMs: number | null,
  nowMs: number,
): OAuthQuotaWindow | null {
  if (
    typeof usedPercent !== "number" ||
    !Number.isFinite(usedPercent) ||
    usedPercent < 0 ||
    startMs === null ||
    endMs === null ||
    startMs >= endMs ||
    endMs - startMs < MIN_WEEKLY_WINDOW_MS ||
    endMs - startMs > MAX_WEEKLY_WINDOW_MS ||
    nowMs < startMs ||
    nowMs >= endMs
  ) {
    return null;
  }
  return {
    key: "7d",
    usedPercent,
    resetsAtMs: endMs,
    windowMinutes: WEEKLY_WINDOW_MINUTES,
  };
}

function officialBillingWindow(body: unknown, nowMs: number): OAuthQuotaWindow | null {
  const config = record(record(body)?.config);
  const period = record(config?.currentPeriod);
  if (!config || !period || period.type !== WEEKLY_PERIOD_TYPE) return null;
  // The endpoint uses proto3 JSON, which omits a zero-valued scalar. The
  // first-party pager therefore interprets an absent percentage as 0%; keep
  // explicit null/string values invalid instead of broad coercion.
  const usedPercent = config.creditUsagePercent === undefined ? 0 : config.creditUsagePercent;
  return normalizedWeeklyWindow(usedPercent, rfc3339Ms(period.start), rfc3339Ms(period.end), nowMs);
}

/**
 * Parse the official Grok Build credits JSON returned by
 * `GET /v1/billing?format=credits`.
 * Malformed, stale, and non-weekly responses return no window. Callers use that
 * as fail-open observability data and fail-closed media entitlement evidence.
 */
export function parseXaiGrokCreditsResponse(
  body: unknown,
  nowMs: number = Date.now(),
): OAuthQuotaWindow[] {
  if (!Number.isSafeInteger(nowMs)) return [];
  const window = officialBillingWindow(body, nowMs);
  return window === null ? [] : [window];
}

/**
 * Grok media requires two independent positive signals: a fresh weekly billing
 * window and an explicit known-paid tier in the current OAuth token. Missing,
 * malformed, stale, free, or unknown-tier evidence fails closed for media only;
 * ordinary xAI text routing remains independent.
 */
export function xaiGrokMediaEntitlementValidUntil(
  snapshot:
    | {
        windows: readonly OAuthQuotaWindow[];
        capturedAt: number;
      }
    | undefined,
  nowMs: number = Date.now(),
  tierHint?: string,
): number | null {
  const normalizedTier = tierHint?.trim().toLowerCase().replaceAll("-", "_");
  if (
    snapshot === undefined ||
    !Number.isSafeInteger(snapshot.capturedAt) ||
    !Number.isSafeInteger(nowMs) ||
    snapshot.capturedAt > nowMs ||
    nowMs - snapshot.capturedAt >= MEDIA_ENTITLEMENT_MAX_AGE_MS ||
    normalizedTier === undefined ||
    !PAID_MEDIA_TIERS.has(normalizedTier)
  ) {
    return null;
  }
  const weeklyReset = snapshot.windows.find(
    (window) =>
      window.key === "7d" &&
      window.windowMinutes === WEEKLY_WINDOW_MINUTES &&
      window.resetsAtMs !== null &&
      window.resetsAtMs > nowMs,
  )?.resetsAtMs;
  return weeklyReset === null || weeklyReset === undefined
    ? null
    : Math.min(snapshot.capturedAt + MEDIA_ENTITLEMENT_MAX_AGE_MS, weeklyReset);
}

export function isXaiGrokMediaEntitled(
  snapshot:
    | {
        windows: readonly OAuthQuotaWindow[];
        capturedAt: number;
      }
    | undefined,
  nowMs: number = Date.now(),
  tierHint?: string,
): boolean {
  return xaiGrokMediaEntitlementValidUntil(snapshot, nowMs, tierHint) !== null;
}
