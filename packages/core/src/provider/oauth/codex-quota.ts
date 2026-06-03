import type { OAuthQuotaWindow } from "@helm/shared";

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
