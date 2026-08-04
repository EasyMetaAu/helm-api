// Window-length (minutes) inference for OAuth quota windows. Anthropic reports
// windowMinutes:null for every window (anthropic-quota.ts writes null), so its 5h/7d
// lengths must be derived from the window `key`. Codex/xai DO report a real
// windowMinutes we prefer verbatim. Pure — used by usage-period reconstruction to
// slice hour buckets into reset periods.

// Anthropic's two fixed window lengths, in minutes. 5h session window = 300;
// 7d weekly window (and all 7d-<model> scoped variants) = 10080.
export const ANTHROPIC_WINDOW_MINUTES = {
  "5h": 300,
  "7d": 10080,
} as const;

// Resolve a window's length in minutes, or null when it cannot be determined.
// `reported` is the provider-reported windowMinutes (Codex/xai) — preferred when it
// is a usable positive number. Otherwise infer from the key prefix: `5h` -> 300,
// `7d` / `7d-*` -> 10080. An unknown key with no reported length yields null (the
// caller then skips history for that window — it cannot be anchored).
export function windowMinutesForKey(key: string, reported: number | null): number | null {
  if (reported !== null && Number.isFinite(reported) && reported > 0) return reported;
  if (key === "5h") return ANTHROPIC_WINDOW_MINUTES["5h"];
  if (key === "7d" || key.startsWith("7d-")) return ANTHROPIC_WINDOW_MINUTES["7d"];
  return null;
}
