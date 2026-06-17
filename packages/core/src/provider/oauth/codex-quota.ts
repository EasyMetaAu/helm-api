import {
  type CodexOAuthUsage,
  CodexOAuthUsageSchema,
  CodexResetResultSchema,
  type OAuthQuotaWindow,
} from "@helm/shared";

// Codex (ChatGPT) rate-limit window headers (providers page Tier 3). The Codex
// backend stamps these `x-codex-*` headers on EVERY /responses reply (the same set
// claude-relay-service reads); we scrape them off the live response (PUSH model).
// Two windows — primary + secondary — each: used-percent (0–100), reset-after
// (seconds until the window resets), window-minutes (the window length).
//
// PURE + FAIL-OPEN: malformed/absent headers are skipped (never throw). A window is
// emitted only when its used-percent parses to a finite number — a window with no
// usage signal is meaningless. `resetsAtMs` is absolute (nowMs + reset-after) so the
// UI can render a live countdown without re-reading the capture time.
const WINDOWS = [
  {
    key: "primary",
    used: "x-codex-primary-used-percent",
    reset: "x-codex-primary-reset-after-seconds",
    window: "x-codex-primary-window-minutes",
  },
  {
    key: "secondary",
    used: "x-codex-secondary-used-percent",
    reset: "x-codex-secondary-reset-after-seconds",
    window: "x-codex-secondary-window-minutes",
  },
] as const;

// Parse a finite number from a header value, or null. Header names are
// case-insensitive (Headers.get normalizes), so no case juggling needed.
function num(headers: Headers, name: string): number | null {
  const raw = headers.get(name);
  if (raw === null || raw.trim() === "") return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

export function parseCodexQuotaHeaders(headers: Headers, nowMs: number): OAuthQuotaWindow[] {
  const out: OAuthQuotaWindow[] = [];
  for (const w of WINDOWS) {
    const used = num(headers, w.used);
    if (used === null) continue; // no usage signal → skip this window
    const resetAfter = num(headers, w.reset);
    const windowMinutes = num(headers, w.window);
    out.push({
      key: w.key,
      usedPercent: Math.min(100, Math.max(0, used)),
      resetsAtMs: resetAfter !== null ? Math.round(nowMs + resetAfter * 1000) : null,
      windowMinutes: windowMinutes !== null && windowMinutes > 0 ? Math.round(windowMinutes) : null,
    });
  }
  return out;
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
  for (const w of USAGE_WINDOWS) {
    const win = usage.rate_limit?.[w.src];
    if (!win || typeof win.used_percent !== "number" || !Number.isFinite(win.used_percent)) {
      continue; // no usage signal → skip this window
    }
    const resetsAtMs = Number.isFinite(win.reset_at)
      ? Math.round((win.reset_at as number) * 1000)
      : Number.isFinite(win.reset_after_seconds)
        ? Math.round(nowMs + (win.reset_after_seconds as number) * 1000)
        : null;
    const windowSeconds = win.limit_window_seconds;
    out.push({
      key: w.key,
      usedPercent: Math.min(100, Math.max(0, win.used_percent)),
      resetsAtMs,
      windowMinutes:
        Number.isFinite(windowSeconds) && (windowSeconds as number) > 0
          ? Math.round((windowSeconds as number) / 60)
          : null,
    });
  }
  return out;
}

// Parse a raw (untrusted) usage-endpoint body into windows. Returns [] on any Zod
// failure (fail-open — a malformed body must never break the providers page).
export function parseCodexUsageBody(body: unknown, nowMs: number): OAuthQuotaWindow[] {
  const parsed = CodexOAuthUsageSchema.safeParse(body);
  if (!parsed.success) return [];
  return codexUsageToWindows(parsed.data, nowMs);
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

// ── Reset-credit CONSUME response ────────────────────────────────────────────
// POST .../rate-limit-reset-credits/consume returns `{ code, credit, windows_reset }`.
// We surface only `code` (status) and `windowsReset` (how many windows were
// restored) for the operator toast. FAIL-OPEN parse: a shape drift yields nulls
// rather than throwing — the consume already succeeded (HTTP 2xx) by this point.
export function parseCodexResetResult(body: unknown): {
  code: string | null;
  windowsReset: number | null;
} {
  const parsed = CodexResetResultSchema.safeParse(body);
  if (!parsed.success) return { code: null, windowsReset: null };
  const { code, windows_reset } = parsed.data;
  return {
    code: typeof code === "string" ? code : null,
    windowsReset:
      typeof windows_reset === "number" && Number.isFinite(windows_reset)
        ? Math.floor(windows_reset)
        : null,
  };
}
