import {
  type CodexOAuthUsage,
  CodexOAuthUsageSchema,
  CodexResetResultSchema,
  type OAuthQuotaWindow,
} from "@helm/shared";
import { isRetiredOpenAICodexLimit } from "./models.js";

// Codex (ChatGPT) rate-limit window headers (providers page Tier 3). The Codex
// backend stamps one or more `x-<limit-id>-{primary,secondary}-*` families on
// /responses replies; we scrape them off the live response (PUSH model).
//
// PURE + FAIL-OPEN: malformed/absent headers are skipped (never throw). A window is
// emitted only when its used-percent parses to a finite number — a window with no
// usage signal is meaningless. Absolute `reset-at` epoch seconds win over legacy
// relative `reset-after-seconds`.
type CodexQuotaWindowKind = "primary" | "secondary";

interface CodexQuotaHeaderFamily {
  limitId: string;
  kind: CodexQuotaWindowKind;
  prefix: string;
  key: string;
}

const USED_PERCENT_HEADER = /^x-([a-z0-9]+(?:-[a-z0-9]+)*)-(primary|secondary)-used-percent$/;
const RATE_LIMIT_REACHED_TYPES = [
  "rate_limit_reached",
  "workspace_owner_credits_depleted",
  "workspace_member_credits_depleted",
  "workspace_owner_usage_limit_reached",
  "workspace_member_usage_limit_reached",
] as const;

export type CodexRateLimitReachedType = (typeof RATE_LIMIT_REACHED_TYPES)[number];

export interface CodexCreditsSnapshot {
  hasCredits: boolean;
  unlimited: boolean;
  balance: string | null;
}

export interface CodexIndividualLimitSnapshot {
  limit: string;
  used: string;
  remainingPercent: number;
  resetsAtMs: number | null;
}

export interface CodexAdditionalLimitSnapshot {
  limitId: string;
  limitName: string | null;
}

export interface CodexQuotaDetails {
  windows: OAuthQuotaWindow[];
  additionalLimits: CodexAdditionalLimitSnapshot[];
  credits: CodexCreditsSnapshot | null;
  individualLimit: CodexIndividualLimitSnapshot | null;
  planType: string | null;
  rateLimitReachedType: CodexRateLimitReachedType | null;
}

function stableWindowKey(limitId: string, kind: CodexQuotaWindowKind): string {
  return limitId === "codex" ? kind : `${limitId.replaceAll("-", "_")}-${kind}`;
}

function normalizeLimitId(value: string): string {
  return value.trim().toLowerCase().replaceAll("-", "_");
}

function quotaHeaderFamilies(headers: Headers): CodexQuotaHeaderFamily[] {
  const families = new Map<string, CodexQuotaHeaderFamily>();
  headers.forEach((_value, headerName) => {
    const match = USED_PERCENT_HEADER.exec(headerName.toLowerCase());
    if (!match) return;
    const limitId = match[1];
    const kind = match[2] as CodexQuotaWindowKind;
    if (!limitId) return;
    const key = stableWindowKey(limitId, kind);
    families.set(key, {
      limitId,
      kind,
      prefix: `x-${limitId}-${kind}`,
      key,
    });
  });
  return [...families.values()].sort((a, b) => {
    const aDefault = a.limitId === "codex" ? 0 : 1;
    const bDefault = b.limitId === "codex" ? 0 : 1;
    if (aDefault !== bDefault) return aDefault - bDefault;
    if (a.limitId !== b.limitId) return a.limitId < b.limitId ? -1 : 1;
    return a.kind === b.kind ? 0 : a.kind === "primary" ? -1 : 1;
  });
}

// Parse a finite number from a header value, or null. Header names are
// case-insensitive (Headers.get normalizes), so no case juggling needed.
function num(headers: Headers, name: string): number | null {
  const raw = headers.get(name);
  if (raw === null || raw.trim() === "") return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

function bool(headers: Headers, name: string): boolean | null {
  const raw = headers.get(name)?.trim();
  if (raw === "1" || raw?.toLowerCase() === "true") return true;
  if (raw === "0" || raw?.toLowerCase() === "false") return false;
  return null;
}

function rateLimitReachedType(value: unknown): CodexRateLimitReachedType | null {
  if (typeof value !== "string") return null;
  return RATE_LIMIT_REACHED_TYPES.includes(value.trim() as CodexRateLimitReachedType)
    ? (value.trim() as CodexRateLimitReachedType)
    : null;
}

function headerCredits(headers: Headers): CodexCreditsSnapshot | null {
  const hasCredits = bool(headers, "x-codex-credits-has-credits");
  const unlimited = bool(headers, "x-codex-credits-unlimited");
  if (hasCredits === null || unlimited === null) return null;
  const balance = headers.get("x-codex-credits-balance")?.trim() || null;
  return { hasCredits, unlimited, balance };
}

export function parseCodexQuotaHeaderDetails(headers: Headers, nowMs: number): CodexQuotaDetails {
  const out: OAuthQuotaWindow[] = [];
  for (const family of quotaHeaderFamilies(headers)) {
    const used = num(headers, `${family.prefix}-used-percent`);
    if (used === null) continue; // no usage signal → skip this window
    const resetAt = num(headers, `${family.prefix}-reset-at`);
    const resetAfter = num(headers, `${family.prefix}-reset-after-seconds`);
    const windowMinutes = num(headers, `${family.prefix}-window-minutes`);
    const normalizedLimitId = family.limitId.replaceAll("-", "_");
    const limitName = headers.get(`x-${family.limitId}-limit-name`)?.trim() || null;
    if (isRetiredOpenAICodexLimit(normalizedLimitId, limitName)) continue;
    out.push({
      key: family.key,
      usedPercent: Math.max(0, used),
      resetsAtMs:
        resetAt !== null
          ? Math.round(resetAt * 1000)
          : resetAfter !== null
            ? Math.round(nowMs + resetAfter * 1000)
            : null,
      windowMinutes: windowMinutes !== null && windowMinutes > 0 ? Math.round(windowMinutes) : null,
      ...(family.limitId === "codex"
        ? {}
        : {
            limitId: normalizedLimitId,
            limitName,
          }),
    });
  }
  const additionalLimits = new Map<string, CodexAdditionalLimitSnapshot>();
  for (const window of out) {
    if (!window.limitId) continue;
    additionalLimits.set(window.limitId, {
      limitId: window.limitId,
      limitName: window.limitName ?? null,
    });
  }
  return {
    windows: out,
    additionalLimits: [...additionalLimits.values()],
    credits: headerCredits(headers),
    individualLimit: null,
    planType: headers.get("x-codex-plan-type")?.trim() || null,
    rateLimitReachedType: rateLimitReachedType(headers.get("x-codex-rate-limit-reached-type")),
  };
}

export function parseCodexQuotaHeaders(headers: Headers, nowMs: number): OAuthQuotaWindow[] {
  return parseCodexQuotaHeaderDetails(headers, nowMs).windows;
}

export function selectCodexActiveLimitWindows(
  headers: Headers,
  windows: readonly OAuthQuotaWindow[],
): OAuthQuotaWindow[] {
  const active = headers.get("x-codex-active-limit");
  if (active === null || active.trim() === "") return [...windows];
  const activeLimitId = normalizeLimitId(active);
  return windows.filter((window) => (window.limitId ?? "codex") === activeLimitId);
}

export function codexActiveLimitIdFromProviderRaw(providerRaw: unknown): string | null {
  if (providerRaw === null || typeof providerRaw !== "object" || Array.isArray(providerRaw)) {
    return null;
  }
  const headers = (providerRaw as Record<string, unknown>).headers;
  if (headers === null || typeof headers !== "object" || Array.isArray(headers)) return null;
  const value = (headers as Record<string, unknown>)["x-codex-active-limit"];
  return typeof value === "string" && value.trim() ? normalizeLimitId(value) : null;
}

// ── Active PULL: GET chatgpt.com/backend-api/wham/usage (providers page) ──────
// The same payload the Codex CLI's /status reads — the on-demand counterpart of
// the header PUSH above, so quota renders even for an account that has served no
// traffic yet. Window keys ("primary"/"secondary") match the PUSH path exactly:
// the providers page labels them by windowMinutes (5h / Weekly) either way.
//
// Mapping per window (emitted only when used_percent parses — same rule as the
// headers): `reset_at` (epoch SECONDS, absolute) wins over `reset_after_seconds`
// (relative, anchored at nowMs); `limit_window_seconds` → whole minutes.
const USAGE_WINDOWS = [
  { key: "primary", src: "primary_window" },
  { key: "secondary", src: "secondary_window" },
] as const;

export function codexUsageToWindows(usage: CodexOAuthUsage, nowMs: number): OAuthQuotaWindow[] {
  const out: OAuthQuotaWindow[] = [];
  const appendWindows = (
    rateLimit: CodexOAuthUsage["rate_limit"],
    limitId: string,
    limitName: string | null,
  ): void => {
    for (const w of USAGE_WINDOWS) {
      const win = rateLimit?.[w.src];
      if (!win || typeof win.used_percent !== "number" || !Number.isFinite(win.used_percent)) {
        continue;
      }
      const resetsAtMs = Number.isFinite(win.reset_at)
        ? Math.round((win.reset_at as number) * 1000)
        : Number.isFinite(win.reset_after_seconds)
          ? Math.round(nowMs + (win.reset_after_seconds as number) * 1000)
          : null;
      const windowSeconds = win.limit_window_seconds;
      out.push({
        key: limitId === "codex" ? w.key : `${limitId}-${w.key}`,
        usedPercent: Math.max(0, win.used_percent),
        resetsAtMs,
        windowMinutes:
          Number.isFinite(windowSeconds) && (windowSeconds as number) > 0
            ? Math.ceil((windowSeconds as number) / 60)
            : null,
        ...(limitId === "codex" ? {} : { limitId, limitName }),
      });
    }
  };

  appendWindows(usage.rate_limit, "codex", null);
  for (const additional of usage.additional_rate_limits ?? []) {
    const limitId = additional.metered_feature?.trim().toLowerCase().replaceAll("-", "_");
    if (!limitId) continue;
    const limitName = additional.limit_name?.trim() || null;
    if (isRetiredOpenAICodexLimit(limitId, limitName)) continue;
    appendWindows(additional.rate_limit, limitId, limitName);
  }
  return out;
}

function usageCredits(usage: CodexOAuthUsage): CodexCreditsSnapshot | null {
  const credits = usage.credits;
  if (
    !credits ||
    typeof credits.has_credits !== "boolean" ||
    typeof credits.unlimited !== "boolean"
  ) {
    return null;
  }
  return {
    hasCredits: credits.has_credits,
    unlimited: credits.unlimited,
    balance: typeof credits.balance === "string" ? credits.balance : null,
  };
}

function usageIndividualLimit(
  usage: CodexOAuthUsage,
  nowMs: number,
): CodexIndividualLimitSnapshot | null {
  const limit = usage.spend_control?.individual_limit;
  if (
    !limit ||
    typeof limit.limit !== "string" ||
    typeof limit.used !== "string" ||
    typeof limit.remaining_percent !== "number" ||
    !Number.isFinite(limit.remaining_percent)
  ) {
    return null;
  }
  const resetAtMs = Number.isFinite(limit.reset_at)
    ? Math.round((limit.reset_at as number) * 1000)
    : Number.isFinite(limit.reset_after_seconds)
      ? Math.round(nowMs + (limit.reset_after_seconds as number) * 1000)
      : null;
  return {
    limit: limit.limit,
    used: limit.used,
    remainingPercent: limit.remaining_percent,
    resetsAtMs: resetAtMs,
  };
}

function usageAdditionalLimits(usage: CodexOAuthUsage): CodexAdditionalLimitSnapshot[] {
  const limits = new Map<string, CodexAdditionalLimitSnapshot>();
  for (const additional of usage.additional_rate_limits ?? []) {
    const limitId = additional.metered_feature?.trim().toLowerCase().replaceAll("-", "_");
    if (!limitId) continue;
    const limitName = additional.limit_name?.trim() || null;
    if (isRetiredOpenAICodexLimit(limitId, limitName)) continue;
    limits.set(limitId, {
      limitId,
      limitName,
    });
  }
  return [...limits.values()];
}

export function parseCodexQuotaDetails(body: unknown, nowMs: number): CodexQuotaDetails | null {
  const parsed = CodexOAuthUsageSchema.safeParse(body);
  if (!parsed.success) return null;
  const usage = parsed.data;
  return {
    windows: codexUsageToWindows(usage, nowMs),
    additionalLimits: usageAdditionalLimits(usage),
    credits: usageCredits(usage),
    individualLimit: usageIndividualLimit(usage, nowMs),
    planType:
      typeof usage.plan_type === "string" && usage.plan_type.trim() ? usage.plan_type.trim() : null,
    rateLimitReachedType: rateLimitReachedType(usage.rate_limit_reached_type?.type),
  };
}

// Parse a raw (untrusted) usage-endpoint body into windows. Returns [] on any Zod
// failure (fail-open — a malformed body must never break the providers page).
export function parseCodexUsageBody(body: unknown, nowMs: number): OAuthQuotaWindow[] {
  return parseCodexQuotaDetails(body, nowMs)?.windows ?? [];
}

// ── Rate-limit RESET credits (the "reset usage limit" grant) ─────────────────
// The same /wham/usage body the windows above come from also carries how many
// reset credits the account can consume right now. The providers page reads this
// off the SAME PULL to decide whether the "Reset limit" button is enabled.

// PURE + FAIL-OPEN: returns the available reset-credit count, or null when the
// account holds no such grant (field absent) or the value is not a finite ≥0
// number. null = "unknown / no credits" → the UI disables the reset button.
export function codexResetCreditsFromUsage(usage: CodexOAuthUsage): number | null {
  const n = usage.rate_limit_reset_credits?.available_count;
  return typeof n === "number" && Number.isFinite(n) && n >= 0 ? Math.floor(n) : null;
}

// Parse the count straight from an untrusted usage body (safeParse → null on any
// Zod failure, same fail-open contract as parseCodexUsageBody).
export function parseCodexResetCredits(body: unknown): number | null {
  const parsed = CodexOAuthUsageSchema.safeParse(body);
  if (!parsed.success) return null;
  return codexResetCreditsFromUsage(parsed.data);
}

export type CodexResetCreditOutcome = "reset" | "nothingToReset" | "noCredit" | "alreadyRedeemed";

const RESET_OUTCOMES: Record<
  NonNullable<ReturnType<typeof CodexResetResultSchema.safeParse>["data"]>["code"] & string,
  CodexResetCreditOutcome
> = {
  reset: "reset",
  nothing_to_reset: "nothingToReset",
  no_credit: "noCredit",
  already_redeemed: "alreadyRedeemed",
};

// ── Reset-credit CONSUME response ────────────────────────────────────────────
// POST .../rate-limit-reset-credits/consume returns `{ code, credit, windows_reset }`.
// FAIL-OPEN parse: an unknown body yields nulls. Known backend snake_case codes
// are also projected to the app-server camelCase outcomes.
export function parseCodexResetResult(body: unknown): {
  code: string | null;
  outcome: CodexResetCreditOutcome | null;
  windowsReset: number | null;
} {
  const parsed = CodexResetResultSchema.safeParse(body);
  if (!parsed.success) return { code: null, outcome: null, windowsReset: null };
  const { code, windows_reset } = parsed.data;
  return {
    code: code ?? null,
    outcome: code ? RESET_OUTCOMES[code] : null,
    windowsReset:
      code && typeof windows_reset === "number" && Number.isFinite(windows_reset)
        ? Math.floor(windows_reset)
        : null,
  };
}
