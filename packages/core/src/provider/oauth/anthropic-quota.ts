import {
  type AnthropicOAuthUsage,
  AnthropicOAuthUsageSchema,
  type OAuthQuotaWindow,
} from "@helm/shared";

// Map Anthropic's OAuth usage-endpoint payload (GET /api/oauth/usage) to the
// providers-page quota windows (Tier 3). Anthropic reports `utilization` as a 0–1
// FRACTION (scaled to a 0–100 percent here) + an ISO `resets_at`. The three windows
// claude-relay-service surfaces map to our keys: five_hour → 5h, seven_day → 7d,
// seven_day_sonnet → 7d-opus. PURE + FAIL-OPEN: an absent window or unparseable
// reset timestamp is skipped/nulled, never thrown.
const WINDOWS = [
  { src: "five_hour", key: "5h" },
  { src: "seven_day", key: "7d" },
  { src: "seven_day_sonnet", key: "7d-opus" },
] as const;

export function anthropicUsageToWindows(
  usage: AnthropicOAuthUsage,
  _nowMs: number,
): OAuthQuotaWindow[] {
  const out: OAuthQuotaWindow[] = [];
  for (const w of WINDOWS) {
    const win = (usage as Record<string, { utilization?: number; resets_at?: string } | undefined>)[
      w.src
    ];
    if (!win || typeof win.utilization !== "number" || !Number.isFinite(win.utilization)) continue;
    // resets_at is ISO-8601; Date.parse → NaN on garbage → null (no countdown).
    const resetMs = typeof win.resets_at === "string" ? Date.parse(win.resets_at) : Number.NaN;
    out.push({
      key: w.key,
      usedPercent: Math.min(100, Math.max(0, win.utilization * 100)),
      resetsAtMs: Number.isFinite(resetMs) ? resetMs : null,
      windowMinutes: null, // Anthropic does not report a window length
    });
  }
  return out;
}

// Parse a raw (untrusted) usage-endpoint body into windows. Returns [] on any Zod
// failure (fail-open — a malformed body must never break the providers page).
export function parseAnthropicUsageBody(body: unknown, nowMs: number): OAuthQuotaWindow[] {
  const parsed = AnthropicOAuthUsageSchema.safeParse(body);
  if (!parsed.success) return [];
  return anthropicUsageToWindows(parsed.data, nowMs);
}
